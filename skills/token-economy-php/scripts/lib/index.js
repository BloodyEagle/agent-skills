'use strict';
// index.js — индекс проекта: разбор файлов (с инкрементальным кэшем) и связи между ними.
// Связи (A → B = «A использует B»):
//   c  класс/интерфейс/трейт (new, ::, extends, implements, use)     f  функция, объявленная в проекте
//   i  require/include со статически вычисляемым путём               x  вызов IncludeComponent → файл компонента
//   t  шаблон компонента (по имени шаблона из вызова)                l  языковой файл (lang/ru/<тот же путь>)
//   e  обработчик события, указанный строкой (класс, функция, 'Класс::метод') в AddEventHandler / registerEventHandler
//   m  модуль: CModule::IncludeModule('x') / Loader::includeModule('x') → include.php модуля

const fs = require('fs');
const path = require('path');
const { posix, detectDocroot, listFiles, readText } = require('./fsx');
const { parsePhp, parseLang } = require('./php');
const { classify, resolveInclude } = require('./bitrix');
const { detectLaravel, laravelClassify, parseBlade, parseLaravelPhp, parseLaravelLang, viewNameToDoc } = require('./laravel');

const VERSION = 2; // формат кэша и индекса; при смене разбора увеличить
const CACHE_DIR = '.bx-cache';
const KIND_ORDER = ['x', 't', 'i', 'c', 'e', 'm', 'f', 'l'];

function loadJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } }

function saveJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const gi = path.join(path.dirname(p), '.gitignore');
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, '*\n');
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, p);
}

/**
 * Контекст проекта: корень, корень сайта, префикс путей, режим core.
 */
function makeCtx(opts) {
  const root = path.resolve(opts.root || '.');
  const docroot = opts.docroot !== undefined ? opts.docroot : detectDocroot(root);
  return { root, docroot, prefix: docroot ? docroot + '/' : '', core: !!opts.core, laravel: detectLaravel(root) };
}

const docPath = (ctx, rel) => '/' + (ctx.prefix ? rel.slice(ctx.prefix.length) : rel);

function candidateFiles(ctx) {
  return listFiles(ctx.root, ctx.docroot, ['.php']).filter((rel) => ctx.core || classify(docPath(ctx, rel)).origin !== 'core');
}

function parseOne(ctx, rel, cl) {
  const { text, enc, eol } = readText(path.join(ctx.root, rel));
  const base = { enc, eol };
  if (cl.view) return { ...base, ...parseBlade(text) }; // Blade-шаблон: директивы и переменные
  if (cl.langlv) return { ...base, loc: text.split('\n').length, mess: parseLaravelLang(text) }; // lang/<locale>/<group>.php
  if (cl.lang) return { ...base, loc: text.split('\n').length, mess: parseLang(text) };
  const d = parsePhp(text);
  if (ctx.laravel) {
    const lr = parseLaravelPhp(text); // маршруты, привязки, модели, миграции, view()/route()/__()
    for (const k of ['routes', 'binds', 'ctxBinds', 'models', 'migs', 'views', 'routeRefs', 'langRefs', 'cmds', 'sched']) if (lr[k]) d[k] = lr[k];
  }
  return { ...base, ...d };
}

function buildIndex(ctx) {
  const files = candidateFiles(ctx);
  const cacheFile = path.join(ctx.root, CACHE_DIR, 'cache.json');
  let cache = loadJson(cacheFile) || {};
  if (cache.v !== VERSION) cache = {};
  const old = cache.files || {};
  const fresh = {};
  const nodes = [];
  let reparsed = 0;
  files.forEach((rel, i) => {
    const st = fs.statSync(path.join(ctx.root, rel));
    const doc = docPath(ctx, rel);
    let cl = classify(doc);
    if (ctx.laravel) { // Laravel-структура: теги видов, модели, маршруты… перекрывают битрикс-классификацию
      const lv = laravelClassify(doc);
      if (lv.tag) {
        cl.tag = lv.tag;
        if (lv.view) cl.view = lv.view;
        if (lv.langlv) { cl.langlv = lv.langlv; cl.lang = null; } // не битрикс-языковой файл
      }
    }
    const c = old[rel];
    let data;
    if (c && c.m === st.mtimeMs && c.s === st.size) data = c.d;
    else { data = parseOne(ctx, rel, cl); reparsed++; }
    fresh[rel] = { m: st.mtimeMs, s: st.size, d: data };
    nodes.push({ id: i + 1, p: rel, d: doc, m: st.mtimeMs, sz: st.size, o: cl.origin, cl, raw: data });
  });

  // индексы
  const classIdx = new Map(), funcIdx = new Map(), pathIdx = new Map(), langByBase = new Map(), langByGroup = new Map();
  const put = (map, key, id) => { const a = map.get(key); if (a) { if (!a.includes(id)) a.push(id); } else map.set(key, [id]); };
  const comps = new Map(); // id компонента → {main: [id файлов], tpl: Map(имя шаблона → [id файлов])}
  const comp = (cid) => { const k = cid.toLowerCase(); if (!comps.has(k)) comps.set(k, { main: [], tpl: new Map() }); return comps.get(k); };
  for (const n of nodes) {
    pathIdx.set(n.d.toLowerCase(), n.id);
    const r = n.raw;
    for (const d of r.decls || []) put(classIdx, d.fqn.toLowerCase(), n.id);
    for (const f of r.funcs || []) put(funcIdx, f.f.toLowerCase(), n.id);
    if (n.cl.lang) put(langByBase, (n.cl.lang.dir + '/' + n.cl.lang.rest).toLowerCase(), { id: n.id, code: n.cl.lang.code });
    if (n.cl.langlv) put(langByGroup, n.cl.langlv.group.toLowerCase(), { id: n.id, code: n.cl.langlv.code });
    const c = n.cl.comp;
    if (c && !n.cl.lang) {
      if (c.part === 'class.php' || c.part === 'component.php') comp(c.id).main.push(n.id);
      else if (c.tpl && /\/template\.php$/.test(c.part)) put(comp(c.id).tpl, c.tpl.toLowerCase(), n.id);
    }
    const o = n.cl.over;
    if (o && !n.cl.lang && o.part === 'template.php') put(comp(o.id).tpl, o.tpl.toLowerCase(), n.id);
  }

  // у классов, объявленных под разные СУБД (classes/mysql, mssql, oracle), берём основной вариант
  const prefer = (ids) => { const f = ids.filter((id) => !/\/classes\/(mssql|oracle)\//.test(nodes[id - 1].p)); return f.length ? f : ids; };

  // связи
  for (const n of nodes) {
    const r = n.raw, edges = new Map();
    const add = (id, k) => {
      if (!id || id === n.id) return;
      const cur = edges.get(id);
      if (!cur || KIND_ORDER.indexOf(k) < KIND_ORDER.indexOf(cur)) edges.set(id, k);
    };
    if (!n.cl.lang && !n.cl.langlv) {
      for (const ref of r.refs || []) { for (const cand of ref.split('|')) { const ids = classIdx.get(cand); if (ids) { prefer(ids).slice(0, 3).forEach((id) => add(id, 'c')); break; } } }
      for (const call of r.calls || []) { for (const cand of call) { const ids = funcIdx.get(cand); if (ids) { ids.slice(0, 2).forEach((id) => add(id, 'f')); break; } } }
      for (const inc of r.incs || []) {
        const target = resolveInclude(inc, n.d);
        if (target) add(pathIdx.get(target.toLowerCase()), 'i');
      }
      for (const ev of r.events || []) { // обработчик строкой: 'Vendor\\Mod\\Class', Class::class, "Class::method", "имя_функции"
        const names = [];
        for (const m of String(ev.c).matchAll(/([A-Za-z_\\][\w\\]*)::class|['"]([A-Za-z_\\][\w\\]*)(?:::\w+)?['"]|([A-Za-z_\\][\w\\]*)::\w+$/g)) names.push(m[1] || m[2] || m[3]);
        for (const nm of names) {
          const key = nm.replace(/\\+/g, '\\').replace(/^\\/, '').toLowerCase();
          const ids = classIdx.get(key) || funcIdx.get(key);
          if (ids) { prefer(ids).slice(0, 2).forEach((id) => add(id, 'e')); break; }
        }
      }
      for (const [mid] of r.mods || []) { // подключение модуля → его include.php
        const low = String(mid).toLowerCase();
        add(pathIdx.get('/local/modules/' + low + '/include.php') || pathIdx.get('/bitrix/modules/' + low + '/include.php'), 'm');
      }
      for (const [cid, tpl] of r.comps || []) {
        if (cid === '?') continue;
        const cc = comps.get(cid.toLowerCase());
        if (!cc) continue;
        cc.main.forEach((id) => add(id, 'x'));
        if (tpl !== '?') (cc.tpl.get((tpl || '.default').toLowerCase()) || []).forEach((id) => add(id, 't'));
      }
      const langs = langByBase.get(n.d.toLowerCase());
      if (langs) {
        n.langs = langs.map((l) => l.code).sort();
        const pick = langs.find((l) => l.code === 'ru') || langs[0];
        add(pick.id, 'l');
      }
      if (ctx.laravel) {
        // view('name') и связи Blade → родительские шаблоны
        const viewNames = new Set();
        for (const [vn] of r.views || []) viewNames.add(vn);
        if (n.cl.view) for (const arr of [r.ext, r.inc, r.comp, r.each]) for (const [vn] of arr || []) viewNames.add(vn);
        for (const vn of viewNames) add(pathIdx.get(viewNameToDoc(vn).toLowerCase()), 't');
        // __('group.key') в коде и @lang('group.key') в Blade → файл локали (приоритетно ru)
        const langKeys = new Set();
        for (const [key] of r.langRefs || []) langKeys.add(key);
        if (n.cl.view) for (const [key] of r.langs || []) langKeys.add(key);
        for (const key of langKeys) {
          const g = langByGroup.get(key.split('.')[0].toLowerCase());
          if (g) { const pick = g.find((l) => l.code === 'ru') || g[0]; add(pick.id, 'l'); }
        }
      }
    }
    n.edges = [...edges.entries()].sort((a, b) => a[0] - b[0]);
  }

  // компактные узлы
  const out = nodes.map((n) => {
    const r = n.raw;
    const kind = n.cl.tag || ((r.decls && r.decls.length) ? r.decls[0].kind : (/^\/(bitrix|local)\//.test(n.d) ? 'php' : 'page'));
    const node = { id: n.id, p: n.p, d: n.d, m: n.m, sz: n.sz, o: n.o, kind, enc: r.enc, eol: r.eol, loc: r.loc, edges: n.edges };
    if (n.langs) node.langs = n.langs;
    if (n.cl.comp) node.comp = n.cl.comp;
    if (n.cl.over) node.over = n.cl.over;
    if (n.cl.module) node.module = n.cl.module;
    if (n.cl.view) node.view = n.cl.view;
    if (n.cl.lang) { node.lang = n.cl.lang; node.mess = r.mess; return node; }
    if (n.cl.langlv) { node.langlv = n.cl.langlv; node.mess = r.mess; return node; }
    for (const k of ['ns', 'decls', 'funcs', 'consts', 'comps', 'mods', 'events', 'fires', 'msgs', 'ark', 'apk']) {
      if (r[k] && (Array.isArray(r[k]) ? r[k].length : r[k])) node[k] = r[k];
    }
    // Laravel: данные разбора и директивы Blade (imports — для разрешения имён в операциях)
    for (const k of ['routes', 'binds', 'ctxBinds', 'models', 'migs', 'views', 'routeRefs', 'langRefs', 'cmds', 'sched', 'ext', 'inc', 'comp', 'each', 'sec', 'yld', 'langs', 'vars', 'imports']) {
      if (r[k] && (Array.isArray(r[k]) ? r[k].length : r[k])) node[k] = r[k];
    }
    return node;
  });
  const index = { v: VERSION, core: ctx.core, docroot: ctx.docroot, laravel: ctx.laravel, nodes: out };
  saveJson(path.join(ctx.root, CACHE_DIR, 'index.json'), index);
  saveJson(cacheFile, { v: VERSION, files: fresh });
  return { index, reparsed };
}

/**
 * Актуальный индекс: перестраивается сам, если изменился список файлов, их размер/время или режим core.
 */
function ensureIndex(ctx) {
  const idx = loadJson(path.join(ctx.root, CACHE_DIR, 'index.json'));
  if (idx && idx.v === VERSION && idx.core === ctx.core && idx.docroot === ctx.docroot && !!idx.laravel === ctx.laravel) {
    const files = candidateFiles(ctx);
    const have = new Map(idx.nodes.map((n) => [n.p, n]));
    let ok = files.length === have.size;
    if (ok) {
      for (const rel of files) {
        const n = have.get(rel);
        let st;
        try { st = fs.statSync(path.join(ctx.root, rel)); } catch (e) { ok = false; break; }
        if (!n || n.m !== st.mtimeMs || n.sz !== st.size) { ok = false; break; }
      }
    }
    if (ok) return idx;
  }
  return buildIndex(ctx).index;
}

module.exports = { makeCtx, ensureIndex, buildIndex, docPath, CACHE_DIR, loadJson };
