#!/usr/bin/env node
'use strict';
// bx.js — token-economy для PHP, 1С-Битрикс и Laravel (8 … 13). Принимает JSON из stdin (или аргументы key=value),
// отвечает компактным текстом. Операции: info, search, symbol, deps, rdeps, path, node, stats, outline,
// component, events, lang, route, table, routes, model, container, blade, console, read, patch, create, build.

const fs = require('fs');
const path = require('path');
const { posix, listFiles, readText, encodeText, writeAtomic } = require('./lib/fsx');
const { makeCtx, ensureIndex, buildIndex, docPath, CACHE_DIR } = require('./lib/index');
const { classify, pcreToRegExp, resolveInclude } = require('./lib/bitrix');
const { parsePhp, parseLang, parseUrlRewrite, parseComponentParams } = require('./lib/php');
const {
  composerFramework, composerNamespace, structureVersion, modelTable, viewNameToDoc, routeUriToRegExp,
} = require('./lib/laravel');

try { process.stdout.setDefaultEncoding('utf8'); } catch (e) { /* ignore */ }

// ---------- аргументы ----------
const args = {};
for (const a of process.argv.slice(2)) {
  const i = a.indexOf('=');
  if (a.startsWith('@')) { // @путь/payload.json — параметры из файла (UTF-8): удобно для кириллицы и многострочных правок
    try { Object.assign(args, JSON.parse(fs.readFileSync(a.slice(1), 'utf8').replace(/^\uFEFF/, ''))); } catch (e) { fail('не удалось прочитать ' + a.slice(1) + ': ' + e.message); }
  } else if (i > 0) args[a.slice(0, i)] = a.slice(i + 1);
  else if (!args.op) args.op = a;
}
if (!args.op && process.stdin.isTTY !== true) {
  try {
    const raw = fs.readFileSync(0, 'utf8').replace(/^\uFEFF/, '').trim();
    if (raw) Object.assign(args, JSON.parse(raw));
  } catch (e) { fail('не удалось разобрать JSON из stdin: ' + e.message); }
}
const truthy = (v) => v === true || v === 'true' || v === '1' || v === 'Y';
const ctx = makeCtx({ root: args.root, core: truthy(args.core) });

function fail(msg) { console.log('Ошибка: ' + msg); process.exit(1); }
const out = (...lines) => console.log(lines.join('\n'));
const short = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const EDGE = { x: 'component', t: 'template', i: 'include', c: 'class', f: 'function', l: 'lang', e: 'event handler', m: 'module' };

function safeAbs(rel) {
  const abs = path.resolve(ctx.root, rel);
  const r = path.relative(ctx.root, abs);
  if (r.startsWith('..') || path.isAbsolute(r)) fail('путь вне рабочей директории: ' + rel);
  return abs;
}

// ---------- поиск узла ----------
function findNode(idx, q, allowList) {
  const rawQ = String(q || '').trim();
  q = posix(rawQ);
  if (!q) fail('не указан файл / класс / компонент');
  const lq = q.toLowerCase();
  const clsQ = rawQ.replace(/\//g, '\\').replace(/^\\+/, '').toLowerCase(); // Vendor\Mod\Class
  const nodes = idx.nodes;
  const pick = (list) => {
    if (list.length === 1) return list[0];
    if (list.length > 1) {
      if (allowList) return list;
      fail('«' + q + '» неоднозначно, уточните:\n' + list.slice(0, 15).map((n) => '  ' + n.p + ' [' + n.kind + ']').join('\n'));
    }
    return null;
  };
  let r = pick(nodes.filter((n) => n.p.toLowerCase() === lq || n.d.toLowerCase() === lq));
  if (r) return r;
  r = pick(nodes.filter((n) => n.view && n.view.name.toLowerCase() === lq)); // Blade: layouts.app
  if (r) return r;
  if (/^[\w.-]+:[\w.-]+$/.test(q)) { // идентификатор компонента ns:name
    r = pick(nodes.filter((n) => n.comp && n.comp.id.toLowerCase() === lq && !n.lang && (n.comp.part === 'class.php' || n.comp.part === 'component.php')));
    if (r) return r;
  }
  const bare = clsQ;
  const byClass = nodes.filter((n) => (n.decls || []).some((d) => d.fqn.toLowerCase() === bare || d.name.toLowerCase() === bare));
  if (byClass.length) {
    const main = byClass.filter((n) => !dbVariant(n.p)); // варианты под MSSQL/Oracle отбрасываем
    r = pick(main.length ? main : byClass);
    if (r) return r;
  }
  r = pick(nodes.filter((n) => n.p.toLowerCase().endsWith('/' + lq) || n.d.toLowerCase().endsWith('/' + lq)));
  if (r) return r;
  r = pick(nodes.filter((n) => path.posix.basename(n.p).toLowerCase() === lq));
  if (r) return r;
  r = pick(nodes.filter((n) => n.p.toLowerCase().includes(lq)));
  if (r) return r;
  fail('не найдено в индексе: ' + q + (ctx.core ? '' : ' (ядро Битрикса не индексируется; добавьте "core":true)'));
}

function bfs(idx, start, depth, reverse) {
  const nodes = idx.nodes;
  let rev = null;
  if (reverse) {
    rev = new Map();
    for (const n of nodes) for (const [t, k] of n.edges) { if (!rev.has(t)) rev.set(t, []); rev.get(t).push([n.id, k]); }
  }
  const kids = (id) => (reverse ? rev.get(id) || [] : nodes[id - 1].edges);
  const seen = new Set([start]);
  const res = [];
  let frontier = [[start, 0]];
  while (frontier.length) {
    const next = [];
    for (const [id, d] of frontier) {
      if (d >= depth) continue;
      for (const [c, k] of kids(id)) {
        if (seen.has(c)) continue;
        seen.add(c);
        res.push([d + 1, nodes[c - 1], k]);
        next.push([c, d + 1]);
      }
    }
    frontier = next;
  }
  return res;
}

const fmtEdges = (items, limit) => {
  const lines = items.slice(0, limit).map(([lvl, n, k]) => `${lvl} ${n.p} [${n.kind}] (${EDGE[k]})`);
  if (items.length > limit) lines.push(`… ещё ${items.length - limit}`);
  return lines;
};

// ---------- наследование (в старом API методы часто в базовых CAll*-классах) ----------
const dbVariant = (p) => /\/classes\/(mssql|oracle)\//.test(p);

function declMap(idx) {
  const m = new Map();
  for (const n of idx.nodes) for (const d of n.decls || []) { const k = d.fqn.toLowerCase(); if (!m.has(k)) m.set(k, []); m.get(k).push([n, d]); }
  return m;
}
function pickDecl(list) {
  if (!list) return null;
  const f = list.filter(([n]) => !dbVariant(n.p));
  return (f.length ? f : list)[0];
}
function ancestors(dm, d) { // цепочка предков [[узел, объявление], …] до 6 уровней
  const res = [], seen = new Set();
  let cur = d;
  for (let i = 0; i < 6; i++) {
    let b = null;
    for (const c of cur.extc || []) { for (const cand of c.split('|')) { b = pickDecl(dm.get(cand)); if (b) break; } if (b) break; }
    if (!b || seen.has(b[1])) break;
    seen.add(b[1]);
    res.push(b);
    cur = b[1];
  }
  return res;
}

// ---------- Laravel: вспомогательные ----------

// сбор всех Laravel-данных индекса с привязкой к файлам
function laravelScan(idx) {
  const routes = [], models = [], binds = [], ctxBinds = [], migs = [], cmds = [], sched = [], views = [];
  for (const n of idx.nodes) {
    if (n.routes) for (const r of n.routes) routes.push({ ...r, p: n.p });
    if (n.models) for (const m of n.models) models.push({ ...m, node: n });
    if (n.binds) for (const b of n.binds) binds.push({ ...b, p: n.p });
    if (n.ctxBinds) for (const b of n.ctxBinds) ctxBinds.push({ ...b, p: n.p });
    if (n.migs) for (const m of n.migs) migs.push({ ...m, p: n.p });
    if (n.cmds) for (const c of n.cmds) cmds.push({ ...c, p: n.p });
    if (n.sched) for (const s of n.sched) sched.push({ ...s, p: n.p });
    if (n.views) for (const v of n.views) views.push({ name: v[0], line: v[1], ctx: v[2] || '', p: n.p });
  }
  return { routes, models, binds, ctxBinds, migs, cmds, sched, views };
}

// имя класса «как написано» (Comment) → [узел, объявление]: импорты файла, namespace, глобально
function resolveClassNode(idx, fromNode, asWritten) {
  if (!asWritten || asWritten === '?') return null;
  const shortName = asWritten.split('\\').pop().toLowerCase();
  const cands = new Set();
  if (asWritten.includes('\\')) cands.add(asWritten.replace(/^\\/, '').toLowerCase());
  if (fromNode && fromNode.imports) for (const [full] of fromNode.imports) {
    if (full.split('\\').pop().toLowerCase() === shortName) cands.add(full.toLowerCase());
  }
  if (fromNode && fromNode.ns) cands.add((fromNode.ns + '\\' + asWritten).toLowerCase());
  cands.add(asWritten.toLowerCase());
  for (const n of idx.nodes) for (const d of n.decls || []) if (cands.has(d.fqn.toLowerCase())) return [n, d];
  for (const n of idx.nodes) for (const d of n.decls || []) if (d.name.toLowerCase() === shortName) return [n, d];
  return null;
}

const keysOnly = (arr) => (arr || []).map((x) => (Array.isArray(x) ? x[0] : x));

// ---------- операции ----------
const ops = {
  build() {
    const { index, reparsed } = buildIndex(ctx);
    out(`индекс построен: ${index.nodes.length} файлов, разобрано заново: ${reparsed}`);
  },

  info() {
    const idx = ensureIndex(ctx);
    const dr = path.join(ctx.root, ctx.docroot);
    const cust = idx.nodes.filter((n) => n.o === 'custom');
    const enc = { utf8: 0, cp1251: 0, ascii: 0 };
    for (const n of cust) enc[n.enc] = (enc[n.enc] || 0) + 1;
    const lines = [];
    const isBx = fs.existsSync(path.join(dr, 'bitrix')) || fs.existsSync(path.join(dr, 'local'));
    if (ctx.laravel) {
      const fw = composerFramework(ctx.root);
      const sv = structureVersion(ctx.root);
      lines.push(`проект Laravel${fw ? ' ' + fw : ''} (composer.json)${sv ? ', структура ' + sv + (sv === '11+' ? ' (bootstrap/app.php)' : ' (app/Http/Kernel.php)') : ''}`);
      lines.push('пространство имён: ' + composerNamespace(ctx.root));
      const d = laravelScan(idx);
      const rf = new Map();
      for (const r of d.routes) rf.set(r.p, (rf.get(r.p) || 0) + 1);
      lines.push(`маршруты: ${d.routes.length}` + (rf.size ? ' (' + [...rf.entries()].map(([p, c]) => p.replace('routes/', '') + ': ' + c).join(', ') + ')' : ''));
      const locales = [...new Set(idx.nodes.filter((n) => n.langlv).map((n) => n.langlv.code))];
      lines.push(`модели: ${d.models.length}, миграций: ${d.migs.length}, views: ${idx.nodes.filter((n) => n.view).length}, провайдеры: ${idx.nodes.filter((n) => n.kind === 'provider').length}, локали: ${locales.join(', ') || 'нет'}`);
      if (d.cmds.length || d.sched.length) lines.push(`команды: ${d.cmds.length}, расписание: ${d.sched.length} (op=console)`);
    } else {
      lines.push(`корень сайта: ${ctx.docroot || '.'}${isBx ? '' : '  (признаков Битрикса нет: bitrix/ и local/ не найдены)'}`);
    }
    let ver = null;
    try {
      const v = fs.readFileSync(path.join(dr, 'bitrix/modules/main/classes/general/version.php'), 'latin1');
      const m = /SM_VERSION["']\s*,\s*["']([\d.]+)/.exec(v);
      if (m) ver = m[1];
    } catch (e) { /* ядра может не быть */ }
    if (ver) lines.push('версия Битрикса: ' + ver);
    try {
      const s = fs.readFileSync(path.join(dr, 'bitrix/.settings.php'), 'latin1');
      const m = /['"]utf_mode['"]\s*=>\s*(?:array\s*\(|\[)\s*['"]value['"]\s*=>\s*(true|false)/.exec(s);
      if (m) lines.push('utf_mode: ' + m[1] + '  (bitrix/.settings.php)');
    } catch (e) { /* нет файла */ }
    try {
      const s = fs.readFileSync(path.join(dr, 'bitrix/php_interface/dbconn.php'), 'latin1');
      if (/define\s*\(\s*["']BX_UTF["']\s*,\s*true/i.test(s)) lines.push('BX_UTF: true  (dbconn.php)');
    } catch (e) { /* нет файла */ }
    let withNs = 0, legacy = 0;
    for (const n of cust) { if ((n.decls || []).length) { if (n.ns) withNs++; else legacy++; } }
    if (ctx.laravel) lines.push(`стиль кода: файлов с классами в namespace ${withNs}, глобальные классы ${legacy}`);
    else lines.push(`стиль кода: файлов с классами в namespace (D7) ${withNs}, с глобальными классами (старое API) ${legacy}`);
    lines.push(`кодировка PHP-файлов проекта: utf8 ${enc.utf8}, cp1251 ${enc.cp1251}, только ASCII ${enc.ascii}`);
    if (enc.cp1251 > 0) lines.push('ВНИМАНИЕ: есть файлы в cp1251. Читай их операцией read, правь операцией patch: штатные инструменты испортят кириллицу.');
    const ls = (dir) => { try { return fs.readdirSync(path.join(dr, dir), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch (e) { return []; } };
    const tpls = [...ls('local/templates').map((n) => 'local/templates/' + n), ...ls('bitrix/templates').map((n) => 'bitrix/templates/' + n)];
    if (tpls.length) lines.push('шаблоны сайта: ' + tpls.join(', '));
    const mods = [...ls('local/modules').map((n) => 'local/modules/' + n), ...ls('bitrix/modules').filter((n) => n.includes('.')).map((n) => 'bitrix/modules/' + n)];
    if (mods.length) lines.push('свои модули: ' + mods.join(', '));
    const nsList = [];
    for (const base of ['local/components', 'bitrix/components']) {
      for (const ns of ls(base)) { if (ns === 'bitrix') continue; nsList.push(`${base}/${ns} (${ls(base + '/' + ns).length})`); }
    }
    if (nsList.length) lines.push('свои компоненты: ' + nsList.join(', '));
    const files = ['local/php_interface/init.php', 'bitrix/php_interface/init.php', 'local/php_interface/dbconn.php', 'bitrix/php_interface/dbconn.php', 'urlrewrite.php', 'local/routes']
      .filter((f) => fs.existsSync(path.join(dr, f)));
    if (ctx.laravel) {
      const lf = ['routes/web.php', 'routes/api.php', 'routes/console.php', 'app/Models', 'app/Providers', 'app/Console/Kernel.php', 'app/Http/Kernel.php', 'bootstrap/app.php', 'database/migrations', 'resources/views', 'lang', 'config/app.php', 'composer.json']
        .filter((f) => fs.existsSync(path.join(ctx.root, f)));
      if (lf.length) lines.push('найдено: ' + lf.join(', '));
    } else if (files.length) lines.push('найдено: ' + files.join(', '));
    lines.push(`в индексе файлов: ${idx.nodes.length} (${cust.length} своих)${ctx.core ? '' : '; ядро не индексируется ("core":true включит его)'}`);
    out(...lines);
  },

  search() {
    if (!args.query) fail('укажите query');
    const exts = String(args.ext || '.php').split(',').map((e) => (e.startsWith('.') ? e : '.' + e).toLowerCase());
    const flags = truthy(args.ignoreCase) || truthy(args.i) ? 'i' : '';
    let rx;
    try { rx = new RegExp(truthy(args.regex) ? args.query : String(args.query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags); } catch (e) { fail('некорректное регулярное выражение'); }
    const sub = posix(args.path || '').replace(/^\/+|\/+$/g, '');
    const limit = Number(args.limit) || 30;
    const files = listFiles(ctx.root, ctx.docroot, exts).filter((rel) => (ctx.core || classify(docPath(ctx, rel)).origin !== 'core') && (!sub || rel === sub || rel.startsWith(sub + '/')));
    let total = 0, shown = 0, nfiles = 0, cur = null;
    const lines = [];
    for (const rel of files) {
      let text;
      try { text = readText(path.join(ctx.root, rel)).text; } catch (e) { continue; }
      if (text.includes('\0')) continue;
      let hit = false;
      const ls = text.split(/\r?\n/);
      for (let i = 0; i < ls.length; i++) {
        const m = rx.exec(ls[i]);
        if (!m) continue;
        total++; hit = true;
        if (shown < limit) {
          if (cur !== rel) { lines.push(rel); cur = rel; }
          let t = ls[i].trim();
          if (t.length > 120) { const pos = Math.max(t.indexOf(m[0]) - 40, 0); t = (pos ? '…' : '') + t.slice(pos, pos + 120) + '…'; }
          lines.push(`  ${i + 1}: ${t}`);
          shown++;
        }
      }
      if (hit) nfiles++;
    }
    if (!total) return out(`«${args.query}»: совпадений нет (просмотрено файлов: ${files.length})`);
    lines.push(`-- совпадений: ${total}, файлов: ${nfiles}` + (shown < total ? `, показано ${shown}` : ''));
    out(...lines);
  },

  symbol() {
    const q0 = String(args.name || '').trim();
    if (!q0) fail('укажите name');
    const q = q0.replace(/^\\/, '').toLowerCase();
    const [qc, qm] = q.includes('::') ? q.split('::') : [null, null];
    const idx = ensureIndex(ctx);
    const dm = qc ? declMap(idx) : null;
    let hits = [];
    for (const n of idx.nodes) {
      for (const d of n.decls || []) {
        const fq = d.fqn.toLowerCase(), nm = d.name.toLowerCase();
        if (!qc && (fq === q || nm === q || fq.endsWith('\\' + q))) hits.push([d.fqn, d.kind, n.p, d.line, d.end]);
        if (d.table && d.table.toLowerCase() === q) hits.push([d.fqn + ' (таблица ' + d.table + ')', d.kind, n.p, d.line, d.end]);
        if (qc) {
          if (!(nm === qc || fq === qc || fq.endsWith('\\' + qc))) continue;
          const own = (d.members || []).find((m) => m.n.toLowerCase() === qm);
          if (own) { hits.push([d.name + '::' + own.n, own.k, n.p, own.l, own.e]); continue; }
          for (const [bn, bd] of ancestors(dm, d)) { // метод унаследован от базового класса
            const m = (bd.members || []).find((x) => x.n.toLowerCase() === qm);
            if (m) { hits.push([`${bd.name}::${m.n}  (унаследован классом ${d.name})`, m.k, bn.p, m.l, m.e]); break; }
          }
        } else if (!q.includes('\\')) {
          for (const m of d.members || []) if (m.n.toLowerCase() === q) hits.push([d.name + '::' + m.n, m.k, n.p, m.l, m.e]);
        }
      }
      for (const f of n.funcs || []) if (!qc && (f.n.toLowerCase() === q || f.f.toLowerCase() === q)) hits.push([f.f, 'function', n.p, f.l, f.e]);
      for (const [c, l] of n.consts || []) if (!qc && c.toLowerCase() === q) hits.push([c, 'const', n.p, l, l]);
    }
    if (!truthy(args.all)) { // варианты под MSSQL/Oracle скрываем, если есть основной
      const main = hits.filter((h) => !dbVariant(h[2]));
      if (main.length) hits = main;
    }
    hits = hits.filter((h, i) => hits.findIndex((x) => x[0] === h[0] && x[2] === h[2] && x[3] === h[3]) === i); // без повторов
    if (!hits.length) return out(`${q0}: не найдено` + (ctx.core ? '' : ' (ядро Битрикса не индексируется; "core":true включит его)'));
    hits.slice(0, 20).forEach(([name, kind, p, l, e]) => console.log(`${name}  ${kind}  ${p}:${l}-${e}`));
    if (hits.length > 20) console.log(`… ещё ${hits.length - 20}`);
  },

  deps() { relations(false); },
  rdeps() { relations(true); },

  path() {
    if (!args.from || !args.to) fail('укажите from и to');
    const idx = ensureIndex(ctx);
    const a = findNode(idx, args.from), b = findNode(idx, args.to);
    const prev = new Map([[a.id, null]]);
    const queue = [a.id];
    while (queue.length) {
      const cur = queue.shift();
      if (cur === b.id) break;
      for (const [t] of idx.nodes[cur - 1].edges) if (!prev.has(t)) { prev.set(t, cur); queue.push(t); }
    }
    if (!prev.has(b.id)) return out(`цепочки ${a.p} → ${b.p} нет`);
    const chain = [];
    for (let c = b.id; c != null; c = prev.get(c)) chain.unshift(idx.nodes[c - 1].p);
    out(chain.join(' → '));
  },

  node() {
    const idx = ensureIndex(ctx);
    const n = findNode(idx, args.file);
    const lines = [`${n.p}  [${n.kind}]  ${n.loc} строк  ${n.enc}${n.o === 'core' ? '  (ядро)' : ''}`];
    for (const d of n.decls || []) lines.push(`  ${d.kind} ${d.fqn}  ${d.line}-${d.end}`);
    for (const f of n.funcs || []) lines.push(`  function ${f.f}  ${f.l}-${f.e}`);
    if (n.comps) lines.push('  компоненты: ' + n.comps.map(([id, t, l]) => `${id}${t ? '/' + t : ''}@${l}`).join(', '));
    if (n.mods) lines.push('  модули: ' + n.mods.map(([id]) => id).join(', '));
    if (n.events) lines.push(`  обработчиков событий: ${n.events.length}`);
    if (n.langs) lines.push('  lang: ' + keysOnly(n.langs).join(','));
    if (n.view) {
      lines.push('  view: ' + n.view.name);
      if (n.ext) lines.push('  extends: ' + keysOnly(n.ext).join(', '));
      if (n.inc) lines.push('  includes: ' + keysOnly(n.inc).join(', '));
      if (n.comp) lines.push('  components: ' + keysOnly(n.comp).join(', '));
      if (n.yld) lines.push('  yield: ' + keysOnly(n.yld).join(', '));
      if (n.vars) lines.push('  vars: ' + n.vars.join(', '));
    }
    if (n.routes) lines.push('  маршрутов: ' + n.routes.length + ' (op=routes)');
    if (n.binds) lines.push('  привязок контейнера: ' + n.binds.length + (n.ctxBinds ? ', контекстных: ' + n.ctxBinds.length : '') + ' (op=container)');
    if (n.models) lines.push('  модели: ' + n.models.map((m) => m.cls).join(', ') + ' (op=model)');
    if (n.migs) lines.push('  миграции: ' + n.migs.map((m) => m.op + ' ' + m.t).join('; ') + ' (op=model)');
    if (n.cmds) lines.push('  команды: ' + n.cmds.map((c) => c.sig).join(', '));
    if (n.sched) lines.push('  расписание: ' + n.sched.length + ' (op=console)');
    if (n.views) lines.push('  рендерит views: ' + n.views.slice(0, 8).map((v) => v[0]).join(', '));
    lines.push('использует:', ...(fmtEdges(bfs(idx, n.id, 1, false), 40).length ? fmtEdges(bfs(idx, n.id, 1, false), 40) : ['  -']));
    lines.push('используют его:', ...(fmtEdges(bfs(idx, n.id, 1, true), 40).length ? fmtEdges(bfs(idx, n.id, 1, true), 40) : ['  -']));
    out(...lines);
  },

  stats() {
    const idx = ensureIndex(ctx);
    const kinds = {}, enc = {};
    let edges = 0;
    const cnt = new Map();
    for (const n of idx.nodes) {
      const k = n.kind.split(' ')[0];
      kinds[k] = (kinds[k] || 0) + 1;
      enc[n.enc] = (enc[n.enc] || 0) + 1;
      edges += n.edges.length;
      for (const [t] of n.edges) cnt.set(t, (cnt.get(t) || 0) + 1);
    }
    const lines = [`файлов: ${idx.nodes.length}  связей: ${edges}`, '  ' + Object.entries(kinds).map(([k, v]) => `${k}: ${v}`).join('  '), '  кодировки: ' + Object.entries(enc).map(([k, v]) => `${k} ${v}`).join(', ')];
    lines.push('самые востребованные:');
    [...cnt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).forEach(([id, c]) => lines.push(`  ${c}  ${idx.nodes[id - 1].p}`));
    const ev = idx.nodes.reduce((s, n) => s + (n.events ? n.events.length : 0), 0);
    if (ev) lines.push(`обработчиков событий: ${ev} (операция events)`);
    if (ctx.laravel) {
      const d = laravelScan(idx);
      lines.push(`Laravel: маршрутов ${d.routes.length}, моделей ${d.models.length}, views ${idx.nodes.filter((n) => n.view).length}, миграций ${d.migs.length}, команд ${d.cmds.length}, расписание ${d.sched.length}`);
    }
    out(...lines);
  },

  outline() {
    const idx = ensureIndex(ctx);
    const n = findNode(idx, args.file || args.target);
    const lines = [`${n.p}  [${n.kind}]  (${n.loc} строк, ${n.enc})`];
    if (n.ns) lines.push('namespace ' + n.ns);
    for (const d of n.decls || []) {
      const hdr = `${(d.mods || []).join(' ')} ${d.kind} ${d.name}`.trim() + (d.ext.length ? ' extends ' + d.ext.join(', ') : '') + (d.impl.length ? ' implements ' + d.impl.join(', ') : '');
      lines.push(`L${d.line}-${d.end}`.padEnd(10) + hdr);
      if (d.table) lines.push('          таблица ' + d.table + (d.fields ? '; поля: ' + d.fields.join(', ') : ''));
      for (const m of d.members || []) {
        lines.push(`L${m.l}-${m.e}`.padEnd(10) + '  ' + (m.k === 'method' ? short(m.sig, 150) : m.k === 'const' ? 'const ' + m.n : 'case ' + m.n));
      }
      if (truthy(args.inherit)) { // методы предков: в старом API основные методы лежат в CAll*-классах
        const dm = declMap(idx);
        for (const [bn, bd] of ancestors(dm, d)) {
          lines.push(`  -- унаследовано от ${bd.name} (${bn.p}:${bd.line})`);
          const ms = (bd.members || []).filter((m) => m.k === 'method' && m.v !== 'private');
          ms.slice(0, 40).forEach((m) => lines.push(`L${m.l}-${m.e}`.padEnd(10) + '  ' + short(m.sig, 150)));
          if (ms.length > 40) lines.push(`  … ещё ${ms.length - 40}`);
        }
      }
    }
    for (const f of n.funcs || []) lines.push(`L${f.l}-${f.e}`.padEnd(10) + short(f.sig, 150));
    for (const [c, l] of n.consts || []) lines.push(`L${l}`.padEnd(10) + 'const ' + c);
    if (!(n.decls || []).length && !(n.funcs || []).length) lines.push('(объявлений классов и функций нет — шаблон или страница)');
    if (n.comps) lines.push('компоненты: ' + n.comps.map(([id, t, l]) => `${id}${t ? ' [' + t + ']' : ''} L${l}`).join('; '));
    if (n.mods) lines.push('модули: ' + n.mods.map(([id, l]) => `${id} L${l}`).join(', '));
    if (n.ark) lines.push('$arResult: ' + n.ark.join(', '));
    if (n.apk) lines.push('$arParams: ' + n.apk.join(', '));
    if (n.events) lines.push('события: ' + n.events.map((e) => `${e.m}:${e.e} L${e.l}`).join('; '));
    if (n.langs && !n.view) lines.push('lang: ' + n.langs.join(', '));
    // Laravel
    if (n.view) {
      lines.push('view ' + n.view.name);
      if (n.ext) lines.push('  extends: ' + n.ext.map(([v, l]) => v + ' L' + l).join(', '));
      if (n.inc) lines.push('  includes: ' + n.inc.map(([v, l]) => v + ' L' + l).join(', '));
      if (n.comp) lines.push('  components: ' + n.comp.map(([v, l]) => v + ' L' + l).join(', '));
      if (n.each) lines.push('  @each: ' + n.each.map(([v, l]) => v + ' L' + l).join(', '));
      if (n.yld) lines.push('  yield: ' + keysOnly(n.yld).join(', '));
      if (n.sec) lines.push('  section: ' + keysOnly(n.sec).join(', '));
      if (n.vars) lines.push('  vars: ' + n.vars.join(', '));
      if (n.langs) lines.push('  @lang: ' + keysOnly(n.langs).join(', '));
    }
    if (n.routes) {
      lines.push('маршруты (' + n.routes.length + '):');
      for (const r of n.routes.slice(0, 30)) lines.push(`  L${r.l}  ${r.v} ${r.u} → ${r.a}${r.n ? ' [' + r.n + ']' : ''}${r.mw && r.mw.length ? ' (' + r.mw.join(',') + ')' : ''}`);
      if (n.routes.length > 30) lines.push('  … ещё ' + (n.routes.length - 30));
    }
    if (n.binds || n.ctxBinds) {
      for (const b of n.binds || []) lines.push(`  L${b.l}  ${b.k} ${b.a} → ${b.i}`);
      for (const b of n.ctxBinds || []) lines.push(`  L${b.l}  when ${b.a} needs ${b.need} → ${b.give}`);
    }
    if (n.models) for (const m of n.models) {
      lines.push(`модель ${m.fqn} — таблица ${m.table || modelTable(m.cls)}${m.table ? '' : ' (по соглашению)'}`);
      if (m.fillable.length) lines.push('  fillable: ' + m.fillable.join(', '));
      for (const rl of m.rels) lines.push(`  L${rl.l}  ${rl.t} ${rl.m} → ${rl.r}`);
    }
    if (n.migs) for (const m of n.migs) {
      lines.push(`миграция ${m.op} ${m.t}  L${m.l}`);
      if (m.cols.length) lines.push('  колонки: ' + m.cols.slice(0, 20).join(', '));
      if (m.fks.length) lines.push('  ключи: ' + m.fks.join('; '));
    }
    if (n.cmds) for (const c of n.cmds) lines.push(`команда ${c.sig}${c.desc ? ' — ' + short(c.desc, 60) : ''}  L${c.l}`);
    if (n.sched) for (const s of n.sched) lines.push(`расписание ${s.cmd} ${s.freq}  L${s.l}`);
    if (n.views) lines.push('рендерит views: ' + n.views.map(([v, l]) => v + ' L' + l).slice(0, 10).join(', '));
    if (n.routeRefs) lines.push('ссылки на маршруты: ' + keysOnly(n.routeRefs).slice(0, 10).join(', '));
    if (n.langRefs) lines.push('lang-ключи: ' + keysOnly(n.langRefs).slice(0, 10).join(', '));
    out(...lines);
  },

  component() {
    const idx = ensureIndex(ctx);
    const q = String(args.id || args.name || '').trim().toLowerCase();
    if (!q) fail('укажите id компонента (например bitrix:news.list)');
    const match = (cid) => cid.toLowerCase() === q || (!q.includes(':') && cid.toLowerCase().endsWith(':' + q));
    const own = idx.nodes.filter((n) => n.comp && match(n.comp.id));
    const overs = idx.nodes.filter((n) => n.over && match(n.over.id));
    const calls = [];
    for (const n of idx.nodes) for (const [cid, tpl, l] of n.comps || []) if (match(cid)) calls.push([n.p, l, cid, tpl]);
    if (!own.length && !overs.length && !calls.length) return out(`компонент ${args.id || args.name}: в индексе не найден` + (ctx.core ? '' : ' (компоненты bitrix:* из ядра не индексируются; "core":true включит их)'));
    const id = (own[0] && own[0].comp.id) || (overs[0] && overs[0].over.id) || (calls[0] && calls[0][2]);
    const lines = [id];
    const nonLang = own.filter((n) => !n.lang);
    if (nonLang.length) {
      const dir = nonLang[0].p.replace(/\/(?:class|component|\.parameters|\.description|ajax|component_epilog)\.php$|\/templates\/.*$|\/lang\/.*$/, '');
      lines.push('расположение: ' + dir);
      const parts = [...new Set(nonLang.filter((n) => !n.comp.tpl).map((n) => n.comp.part))].sort();
      lines.push('файлы: ' + parts.join(', ') + (nonLang.some((n) => n.langs) ? '; lang: ' + [...new Set(nonLang.flatMap((n) => n.langs || []))].join(',') : ''));
      const pf = nonLang.find((n) => n.comp.part === '.parameters.php');
      if (pf) {
        try {
          const keys = parseComponentParams(readText(path.join(ctx.root, pf.p)).text);
          if (keys.length) lines.push(`параметры (${keys.length}): ` + keys.slice(0, 60).join(', ') + (keys.length > 60 ? ' …' : ''));
        } catch (e) { /* нет параметров */ }
      }
      const cls = nonLang.find((n) => n.comp.part === 'class.php');
      if (cls && cls.decls) lines.push('класс: ' + cls.decls.map((d) => d.fqn + (d.ext.length ? ' extends ' + d.ext.join(', ') : '')).join('; '));
    } else lines.push('исходники компонента в индексе нет (ядро или не включён core)');
    const tpls = [];
    for (const n of nonLang) if (n.comp.tpl) tpls.push([n.comp.tpl, 'компонент', n.p]);
    for (const n of overs.filter((x) => !x.lang)) tpls.push([n.over.tpl, 'переопределён @' + n.over.site, n.p]);
    if (tpls.length) {
      lines.push('шаблоны:');
      tpls.filter((t) => /\/template\.php$/.test(t[2])).sort().forEach((t) => lines.push(`  ${t[0]}  [${t[1]}]  ${t[2]}`));
      const extra = tpls.filter((t) => !/\/template\.php$/.test(t[2])).map((t) => path.posix.basename(t[2]) + '@' + t[0]);
      if (extra.length) lines.push('  прочие файлы шаблонов: ' + [...new Set(extra)].slice(0, 20).join(', '));
    }
    if (calls.length) {
      lines.push(`вызовы (${calls.length}):`);
      calls.slice(0, 30).forEach(([p, l, , t]) => lines.push(`  ${p}:${l}${t ? '  [' + t + ']' : ''}`));
      if (calls.length > 30) lines.push(`  … ещё ${calls.length - 30}`);
    }
    out(...lines);
  },

  events() {
    const idx = ensureIndex(ctx);
    const q = String(args.query || '').toLowerCase();
    const rows = [];
    for (const n of idx.nodes) {
      for (const e of n.events || []) rows.push({ key: `${e.m}:${e.e}`, kind: e.k, cb: e.c, p: n.p, l: e.l });
      for (const f of n.fires || []) rows.push({ key: `${f.m}:${f.e}`, kind: 'fires', cb: '', p: n.p, l: f.l });
    }
    const sel = rows.filter((r) => !q || r.key.toLowerCase().includes(q) || r.cb.toLowerCase().includes(q) || r.p.toLowerCase().includes(q));
    if (!sel.length) return out('событий не найдено' + (q ? ` по запросу «${args.query}»` : ''));
    if (!q && sel.length > 60) {
      const g = new Map();
      for (const r of sel) { const e = g.get(r.key) || [0, 0]; if (r.kind === 'fires') e[1]++; else e[0]++; g.set(r.key, e); }
      out(`всего записей: ${sel.length}; события (обработчиков / вызовов GetModuleEvents):`, ...[...g.entries()].sort().slice(0, 80).map(([k, [h, f]]) => `  ${k}  ${h}${f ? ' / ' + f : ''}`), 'уточните query (часть события, класса или пути)');
      return;
    }
    sel.sort((a, b) => a.key.localeCompare(b.key));
    out(...sel.slice(0, 60).map((r) => `${r.key}  ${r.kind}  ${short(r.cb, 90)}  ${r.p}:${r.l}`.replace(/  {2,}/g, '  ')), ...(sel.length > 60 ? [`… ещё ${sel.length - 60}`] : []));
  },

  lang() {
    const idx = ensureIndex(ctx);
    const q = String(args.query || args.key || '').trim();
    if (!q) fail('укажите query: ключ или текст сообщения');
    const lq = q.toLowerCase();
    const defs = new Map(); // ключ → [[код, значение, файл, строка]]
    const used = new Map();
    for (const n of idx.nodes) {
      if (n.lang) for (const [k, v, l] of n.mess || []) { if (!defs.has(k)) defs.set(k, []); defs.get(k).push([n.lang.code, v, n.p, l]); }
      if (n.langlv) for (const [k, v, l] of n.mess || []) { const key = n.langlv.group + '.' + k; if (!defs.has(key)) defs.set(key, []); defs.get(key).push([n.langlv.code, v, n.p, l]); } // Laravel: lang/<код>/<group>.php
      for (const [k, l] of n.msgs || []) { if (!used.has(k)) used.set(k, []); used.get(k).push(`${n.p}:${l}`); }
      for (const [k, l] of n.langRefs || []) { if (!used.has(k)) used.set(k, []); used.get(k).push(`${n.p}:${l}`); } // __('key') в коде
      if (n.view) for (const [k, l] of n.langs || []) { if (!used.has(k)) used.set(k, []); used.get(k).push(`${n.p}:${l}`); } // @lang в Blade
    }
    let keys = [...defs.keys()].filter((k) => k.toLowerCase() === lq);
    if (!keys.length) keys = [...defs.entries()].filter(([, v]) => v.some((x) => x[1].toLowerCase().includes(lq))).map(([k]) => k);
    if (!keys.length) keys = [...defs.keys()].filter((k) => k.toLowerCase().includes(lq));
    if (!keys.length) {
      const u = [...used.entries()].filter(([k]) => k.toLowerCase() === lq);
      return out(`«${q}»: в языковых файлах не найдено` + (u.length ? `; используется: ${u[0][1].slice(0, 5).join(', ')}` : ''));
    }
    const lines = [];
    for (const k of keys.slice(0, 15)) {
      lines.push(k);
      for (const [code, v, p, l] of defs.get(k).sort()) lines.push(`  ${code}: ${v}  (${p}:${l})`);
      const u = used.get(k) || [];
      lines.push('  используется в: ' + (u.length ? u.slice(0, 6).join(', ') + (u.length > 6 ? ` … ещё ${u.length - 6}` : '') : 'в проиндексированном коде нет'));
    }
    if (keys.length > 15) lines.push(`… ещё ключей: ${keys.length - 15}`);
    out(...lines);
  },

  route() {
    let url = String(args.url || '').trim();
    if (!url) fail('укажите url');
    if (ctx.laravel) { // Laravel: URL → маршрут → контроллер → view
      const idx = ensureIndex(ctx);
      const d = laravelScan(idx);
      url = url.replace(/^https?:\/\/[^/]+/i, '').split('?')[0].split('#')[0];
      if (!url.startsWith('/')) url = '/' + url;
      const lines = [url];
      const hits = [];
      for (const r of d.routes) { const rx = routeUriToRegExp(r.u); if (rx && rx.test(url)) hits.push(r); }
      if (!hits.length) {
        lines.push('маршрут не найден (просмотрено ' + d.routes.length + '); каталог — op=routes');
        out(...lines);
        return;
      }
      const r = hits[0];
      lines.push(`маршрут: ${r.v} ${r.u} → ${r.a}${r.n ? '  [' + r.n + ']' : ''}${r.mw && r.mw.length ? '  (' + r.mw.join(',') + ')' : ''}  (${r.p}:${r.l})`);
      if (hits.length > 1) lines.push('  … также подходят: ' + hits.slice(1, 4).map((h) => h.v + ' ' + h.u).join('; '));
      const am = /^(.*)@(.+)$/.exec(r.a || '');
      const ctrlName = am ? am[1] : (/^[A-Z]/.test(r.a || '') ? r.a : null); // invokable-контроллер без метода
      if (ctrlName) {
        const methodName = am ? am[2] : '__invoke';
        const ctrlShort = ctrlName.split('\\').pop();
        for (const n of idx.nodes) {
          if (!(n.decls || []).some((x) => x.name === ctrlShort)) continue;
          const dd = n.decls.find((x) => x.name === ctrlShort);
          const meth = (dd.members || []).find((m) => m.n === methodName);
          lines.push(`контроллер: ${dd.fqn} (${n.p}:${meth ? meth.l + '-' + meth.e : dd.line})`);
          if (meth) lines.push('  ' + short(meth.sig, 150));
          for (const v of d.views) if (v.ctx === ctrlShort + '::' + methodName) lines.push(`  рендерит view: ${v.name}  →  ${viewNameToDoc(v.name).slice(1)}  (${v.p}:${v.line})`);
          break;
        }
      }
      out(...lines);
      return;
    }
    url = url.replace(/^https?:\/\/[^/]+/i, '').split('?')[0].split('#')[0];
    if (!url.startsWith('/')) url = '/' + url;
    const dr = path.join(ctx.root, ctx.docroot);
    const lines = [url];
    const cands = [];
    if (url.endsWith('/')) cands.push(url + 'index.php');
    else { cands.push(url + '/index.php'); cands.push(url.endsWith('.php') ? url : url + '.php'); }
    const exist = cands.filter((c) => fs.existsSync(path.join(dr, c)));
    if (exist.length) lines.push('физический файл: ' + exist.map((c) => (ctx.prefix + c.slice(1))).join(', ') + '  (urlrewrite не применяется)');
    else lines.push('физического файла нет (проверено: ' + cands.join(', ') + ')');
    const rf = path.join(dr, 'urlrewrite.php');
    if (fs.existsSync(rf)) {
      const rules = parseUrlRewrite(readText(rf).text);
      const hits = [];
      rules.forEach((r, i) => { const rx = pcreToRegExp(r.c); if (rx && rx.test(url)) hits.push([i, r]); });
      if (hits.length) {
        lines.push(exist.length ? 'правила urlrewrite.php, подходящие по условию:' : 'urlrewrite.php (срабатывает первое подходящее):');
        hits.slice(0, 5).forEach(([i, r]) => lines.push(`  #${i + 1} ${r.c} → ${r.p || '-'}${r.id ? '  ID ' + r.id : ''}${r.r ? '  RULE ' + r.r : ''}  (urlrewrite.php:${r.l})`));
        if (hits.length > 5) lines.push(`  … ещё ${hits.length - 5}`);
      } else lines.push('urlrewrite.php: подходящих правил нет (' + rules.length + ' правил проверено)');
    } else lines.push('urlrewrite.php не найден');
    lines.push('(маршруты D7 в local/routes и правила .htaccess не проверяются)');
    out(...lines);
  },

  read() {
    const f = args.file;
    if (!f) fail('укажите file');
    const abs = safeAbs(f);
    if (!fs.existsSync(abs)) fail('файл не найден: ' + f);
    const { text, enc } = readText(abs);
    const ls = text.split(/\r?\n/);
    const off = Math.max(Number(args.offset) || 1, 1);
    const lim = Number(args.limit) || 200;
    const part = ls.slice(off - 1, off - 1 + lim);
    out(`${posix(path.relative(ctx.root, abs))}  (${ls.length} строк, ${enc})`, ...part.map((l, i) => `${off + i}: ${l}`), ...(off - 1 + lim < ls.length ? [`… ещё строк: ${ls.length - (off - 1 + lim)}`] : []));
  },

  table() {
    const q = String(args.name || args.query || '').trim();
    if (!q) fail('укажите name: имя таблицы БД');
    const lq = q.toLowerCase();
    const idx = ensureIndex(ctx);
    const lines = [];
    for (const n of idx.nodes) for (const d of n.decls || []) {
      if (d.table && d.table.toLowerCase() === lq) lines.push(`${d.table}  (D7 ORM: ${d.fqn}, ${n.p}:${d.line}-${d.end})`, '  поля: ' + (d.fields || []).join(', '));
    }
    if (ctx.laravel) { // Eloquent-модель и миграции
      const d = laravelScan(idx);
      for (const m of d.models.filter((x) => (x.table || modelTable(x.cls)).toLowerCase() === lq)) {
        lines.push(`${q}  (Eloquent: ${m.fqn}, ${m.node.p}:${m.l})`, '  fillable: ' + (m.fillable.join(', ') || '—'), '  связей: ' + m.rels.length + ' (op=model name=' + m.cls + ')');
      }
      for (const mg of d.migs.filter((x) => x.t.toLowerCase() === lq).sort((a, b) => (a.p < b.p ? -1 : 1))) {
        lines.push(`${mg.t}  (${mg.op === 'create' ? 'создание' : mg.op === 'alter' ? 'изменение' : mg.op}, ${mg.p}:${mg.l})`, '  колонки: ' + (mg.cols.join(', ') || '—'));
        if (mg.fks.length) lines.push('  внешние ключи: ' + mg.fks.join('; '));
      }
    }
    // старое API: схема в install/db/<СУБД>/install.sql модулей
    const sqlFiles = listFiles(ctx.root, ctx.docroot, ['.sql'])
      .filter((rel) => /\/install\/db\//i.test('/' + rel) && (ctx.core || classify(docPath(ctx, rel)).origin !== 'core'))
      .sort((a, b) => (/\/mysql\//i.test(b) ? 1 : 0) - (/\/mysql\//i.test(a) ? 1 : 0) || a.localeCompare(b));
    const names = new Set();
    let found = false;
    for (const rel of sqlFiles) {
      if (found && !/\/mysql\//i.test(rel)) break;
      const text = readText(path.join(ctx.root, rel)).text;
      const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"\[]?(\w+)[`"\]]?\s*\(/gi;
      let m;
      while ((m = re.exec(text))) {
        names.add(m[1]);
        if (m[1].toLowerCase() !== lq) continue;
        let depth = 1, i = re.lastIndex;
        const start = i;
        while (i < text.length && depth > 0) { if (text[i] === '(') depth++; else if (text[i] === ')') depth--; i++; }
        const body = text.slice(start, i - 1);
        const parts = [];
        let d = 0, cur = '';
        for (const ch of body) { if (ch === '(') d++; if (ch === ')') d--; if (ch === ',' && d === 0) { parts.push(cur); cur = ''; } else cur += ch; }
        parts.push(cur);
        const cols = [], keys = [];
        for (const p of parts.map((x) => x.trim()).filter(Boolean)) {
          if (/^(PRIMARY|UNIQUE|KEY|INDEX|CONSTRAINT|FOREIGN|FULLTEXT)\b/i.test(p)) keys.push(short(p.replace(/\s+/g, ' '), 70));
          else { const c = /^[`"\[]?(\w+)[`"\]]?\s+([A-Za-z]+(?:\([^)]*\))?)/.exec(p); if (c) cols.push(c[1] + ' ' + c[2]); }
        }
        const ln = text.slice(0, m.index).split('\n').length;
        lines.push(`${m[1]}  (SQL: ${rel}:${ln})`, '  колонки: ' + cols.join(', '));
        if (keys.length) lines.push('  ключи: ' + keys.slice(0, 12).join('; '));
        found = true;
      }
    }
    if (!lines.length) {
      const like = [...names].filter((n) => n.toLowerCase().includes(lq));
      for (const n of idx.nodes) for (const d of n.decls || []) if (d.table && d.table.toLowerCase().includes(lq)) like.push(d.table);
      return out(`таблица ${q}: схема не найдена` + (like.length ? '; похожие: ' + [...new Set(like)].slice(0, 15).join(', ') : ''));
    }
    // где таблица встречается в коде (SQL-запросы старого API)
    const hits = [];
    for (const rel of listFiles(ctx.root, ctx.docroot, ['.php'])) {
      if (!ctx.core && classify(docPath(ctx, rel)).origin === 'core') continue;
      let text;
      try { text = readText(path.join(ctx.root, rel)).text; } catch (e) { continue; }
      const pos = text.toLowerCase().indexOf(lq);
      if (pos >= 0) hits.push(`${rel}:${text.slice(0, pos).split('\n').length}`);
      if (hits.length >= 8) break;
    }
    if (hits.length) lines.push('встречается в: ' + hits.join(', '));
    out(...lines);
  },

  // ---------- Laravel ----------

  routes() {
    if (!ctx.laravel) fail('routes: операция для Laravel-проектов');
    const idx = ensureIndex(ctx);
    const d = laravelScan(idx);
    if (!d.routes.length) return out('маршруты не найдены (routes/*.php)');
    let sel = d.routes;
    const u = args.uri ? String(args.uri).toLowerCase() : null;
    const nm = args.name ? String(args.name).toLowerCase() : null;
    const cl = args.controller ? String(args.controller).toLowerCase() : null;
    if (u) sel = sel.filter((r) => r.u.toLowerCase().includes(u));
    if (nm) sel = sel.filter((r) => (r.n || '').toLowerCase().includes(nm));
    if (cl) sel = sel.filter((r) => (r.a || '').toLowerCase().includes(cl));
    const flt = [u && 'uri', nm && 'name', cl && 'controller'].filter(Boolean).join(', ');
    const lines = [`маршруты: ${d.routes.length}, показано ${sel.length}` + (flt ? ' (фильтры: ' + flt + ')' : '')];
    let cur = null;
    for (const r of sel.slice(0, 100)) {
      if (r.p !== cur) { cur = r.p; lines.push(r.p + ':'); }
      lines.push(`  ${r.v.padEnd(7)} ${r.u}  ${r.a}` + (r.n ? `  [${r.n}]` : '') + (r.mw && r.mw.length ? `  (${r.mw.join(',')})` : '') + `  L${r.l}`);
    }
    if (sel.length > 100) lines.push(`… ещё ${sel.length - 100}; уточните uri=, name=, controller=`);
    if (!sel.length) lines.push('  по фильтру ничего не найдено');
    out(...lines);
  },

  model() {
    if (!ctx.laravel) fail('model: операция для Laravel-проектов');
    const idx = ensureIndex(ctx);
    const d = laravelScan(idx);
    const tableOf = (m) => m.table || modelTable(m.cls);
    const lines = [];
    if (args.name || args.table) {
      const q = String(args.name || args.table);
      const lq = q.toLowerCase();
      let found = d.models.filter((m) => m.cls.toLowerCase() === lq || m.fqn.toLowerCase() === lq || m.fqn.toLowerCase().endsWith('\\' + lq));
      if (!found.length || args.table) {
        const byTable = d.models.filter((m) => tableOf(m).toLowerCase() === lq);
        if (byTable.length) found = byTable;
      }
      if (!found.length) {
        const like = [...new Set(d.models.map(tableOf).filter((t) => t.includes(lq)).concat(d.models.map((m) => m.cls).filter((c) => c.toLowerCase().includes(lq))))];
        return out(`модель «${q}» не найдена` + (like.length ? '; похожие: ' + like.slice(0, 10).join(', ') : ''));
      }
      for (const m of found.slice(0, 3)) {
        const n = m.node;
        lines.push(`${m.fqn}${m.ext ? ' extends ' + m.ext : ''}  (${n.p}:${m.l})`);
        lines.push(`  таблица: ${tableOf(m)}${m.table ? ' (явно $table)' : ' (по соглашению)'}`);
        for (const mg of d.migs.filter((x) => x.t === tableOf(m)).sort((a, b) => (a.p < b.p ? -1 : 1))) {
          lines.push(`  ${mg.op === 'create' ? 'создание' : mg.op === 'alter' ? 'изменение' : mg.op}: ${mg.p.replace(/^.*\//, '')}:${mg.l}`);
          if (mg.cols.length) lines.push('    колонки: ' + mg.cols.slice(0, 30).join(', ') + (mg.cols.length > 30 ? ' …' : ''));
          if (mg.fks.length) lines.push('    внешние ключи: ' + mg.fks.join('; '));
        }
        if (m.pk) lines.push('  primaryKey: ' + m.pk);
        if (m.fillable.length) lines.push('  fillable: ' + m.fillable.join(', '));
        if (Object.keys(m.casts).length) lines.push('  casts: ' + Object.entries(m.casts).map(([k, v]) => k + '=' + v).join(', '));
        if (m.hidden.length) lines.push('  hidden: ' + m.hidden.join(', '));
        if (m.appends.length) lines.push('  appends: ' + m.appends.join(', '));
        if (m.rels.length) {
          lines.push('  связи:');
          for (const rl of m.rels) {
            const res = resolveClassNode(idx, n, rl.r);
            lines.push(`    ${rl.t.padEnd(13)} ${rl.m} → ${rl.r}${res ? '  (' + res[0].p + ')' : ''}${rl.fk ? '  fk: ' + rl.fk : ''}  L${rl.l}`);
          }
        }
        const back = [];
        for (const m2 of d.models) {
          if (m2 === m) continue;
          for (const rl of m2.rels) {
            const res = resolveClassNode(idx, m2.node, rl.r);
            if (res && res[1].fqn.toLowerCase() === m.fqn.toLowerCase()) back.push(`${m2.cls}::${rl.m} (${rl.t})  (${m2.node.p}:${rl.l})`);
          }
        }
        if (back.length) { lines.push('  обратные связи:'); for (const b of back.slice(0, 20)) lines.push('    ' + b); }
        if (m.scopes.length) lines.push('  scopes: ' + m.scopes.join(', '));
        const ritems = bfs(idx, n.id, 1, true);
        if (ritems.length) lines.push('  используется из: ' + ritems.slice(0, 8).map(([, nn]) => nn.p).join(', ') + (ritems.length > 8 ? ' …' : ''));
      }
      out(...lines);
      return;
    }
    if (!d.models.length) return out('модели Eloquent не найдены (app/Models, extends Model)');
    lines.push(`модели Eloquent: ${d.models.length}`);
    for (const m of d.models.slice(0, 60)) {
      lines.push(`  ${m.fqn} — таблица ${tableOf(m)}${m.table ? '' : ' (по соглашению)'}, связей ${m.rels.length}, fillable ${m.fillable.length}  (${m.node.p}:${m.l})`);
    }
    if (d.models.length > 60) lines.push(`… ещё ${d.models.length - 60}`);
    out(...lines);
  },

  container() {
    if (!ctx.laravel) fail('container: операция для Laravel-проектов');
    const idx = ensureIndex(ctx);
    const d = laravelScan(idx);
    const lines = [];
    const matchType = (x, q) => { const s = String(x).toLowerCase(); return s === q || s.split('\\').pop() === q; };
    if (args.type) {
      const q = String(args.type).replace(/^\\/, '').toLowerCase();
      lines.push(`${args.type} в контейнере:`);
      let any = false;
      for (const b of d.binds.filter((b) => matchType(b.a, q))) { any = true; lines.push(`  ${b.k}: ${b.a} → ${b.i}  (${b.p}:${b.l})`); }
      for (const b of d.ctxBinds.filter((b) => matchType(b.a, q))) { any = true; lines.push(`  контекстно: when ${b.a} needs ${b.need} → give ${b.give}  (${b.p}:${b.l})`); }
      const qShort = String(args.type).split('\\').pop().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const injectors = [];
      for (const n of idx.nodes) for (const dd of n.decls || []) {
        const ctor = (dd.members || []).find((m) => m.n === '__construct');
        if (!ctor) continue;
        if (new RegExp('(?:^|[(,|\\s?])' + qShort + '\\s*\\$').test(ctor.sig)) injectors.push(`${dd.fqn}  (${n.p}:${ctor.l})`);
      }
      if (injectors.length) {
        lines.push('  получают через конструктор:');
        for (const x of injectors.slice(0, 25)) lines.push('    ' + x);
        if (injectors.length > 25) lines.push(`    … ещё ${injectors.length - 25}`);
      }
      if (!any && !injectors.length) lines.push('  явных привязок и инжекций не найдено (разрешится автосвязыванием, если класс конкретный)');
      out(...lines);
      return;
    }
    if (!d.binds.length && !d.ctxBinds.length) return out('привязок контейнера не найдено (app/Providers, bootstrap/app.php)');
    const byFile = new Map();
    for (const b of d.binds) { if (!byFile.has(b.p)) byFile.set(b.p, []); byFile.get(b.p).push(b); }
    lines.push(`Laravel-контейнер: привязок ${d.binds.length}, контекстных ${d.ctxBinds.length}`);
    for (const [p, bs] of byFile) {
      lines.push(p + ':');
      for (const b of bs.slice(0, 30)) lines.push(`  ${b.k} ${b.a} → ${b.i}  L${b.l}`);
      if (bs.length > 30) lines.push(`  … ещё ${bs.length - 30}`);
    }
    for (const b of d.ctxBinds.slice(0, 20)) lines.push(`when ${b.a} needs ${b.need} → ${b.give}  (${b.p}:${b.l})`);
    out(...lines);
  },

  blade() {
    if (!ctx.laravel) fail('blade: операция для Laravel-проектов');
    const idx = ensureIndex(ctx);
    if (args.name) {
      const n = findNode(idx, args.name);
      const lines = [`${n.view ? n.view.name : args.name} — ${n.p}  [${n.kind}]  (${n.loc} строк, ${n.enc})`];
      if (n.ext) lines.push('расширяет: ' + n.ext.map(([v, l]) => v + ' L' + l).join(', '));
      if (n.inc) lines.push('включает: ' + n.inc.map(([v, l]) => v + ' L' + l).join(', '));
      if (n.comp) lines.push('компоненты: ' + n.comp.map(([v, l]) => v + ' L' + l).join(', '));
      if (n.each) lines.push('@each: ' + n.each.map(([v, l]) => v + ' L' + l).join(', '));
      if (n.yld) lines.push('@yield: ' + keysOnly(n.yld).join(', '));
      if (n.sec) lines.push('@section: ' + keysOnly(n.sec).join(', '));
      if (n.vars) lines.push('переменные: ' + n.vars.join(', '));
      if (n.langs) lines.push('@lang: ' + keysOnly(n.langs).join(', '));
      const kids = idx.nodes.filter((x) => (x.ext || []).some(([v]) => v === (n.view ? n.view.name : args.name)));
      if (kids.length) lines.push('расширяют (' + kids.length + '): ' + kids.slice(0, 12).map((k) => (k.view ? k.view.name : k.p)).join(', ') + (kids.length > 12 ? ' …' : ''));
      const renders = [];
      for (const x of idx.nodes) for (const v of x.views || []) if (v[0] === (n.view ? n.view.name : args.name)) renders.push(`${x.p}:${v[1]}${v[2] ? '  (' + v[2] + ')' : ''}`);
      if (renders.length) {
        lines.push('рендерится из (' + renders.length + '):');
        for (const r0 of renders.slice(0, 20)) lines.push('  ' + r0);
        if (renders.length > 20) lines.push('  … ещё ' + (renders.length - 20));
      } else lines.push('вызовов view() не найдено');
      out(...lines);
      return;
    }
    const views = idx.nodes.filter((n) => n.view);
    if (!views.length) return out('Blade-шаблоны не найдены (resources/views/**/*.blade.php)');
    const lines = [`views: ${views.length}`];
    const extCount = new Map(), rendered = new Set(), extended = new Set(), included = new Set();
    for (const n of idx.nodes) {
      for (const [v] of n.ext || []) extCount.set(v, (extCount.get(v) || 0) + 1);
      for (const [v] of n.ext || []) extended.add(v);
      for (const arr of [n.inc, n.comp, n.each]) for (const [v] of arr || []) included.add(v);
      for (const v of n.views || []) rendered.add(v[0]);
    }
    const top = [...extCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    if (top.length) {
      lines.push('самые расширяемые:');
      for (const [v, c] of top) lines.push(`  ${v} — ${c}`);
    }
    const orphans = views.filter((n) => !rendered.has(n.view.name) && !extended.has(n.view.name) && !included.has(n.view.name));
    if (orphans.length) {
      lines.push('нигде не используются (' + orphans.length + '): ' + orphans.slice(0, 15).map((n) => n.view.name).join(', ') + (orphans.length > 15 ? ' …' : ''));
      lines.push('  (мусор или рендер через Route::view/return view() в неиндексируемых местах)');
    }
    out(...lines);
  },

  console() {
    if (!ctx.laravel) fail('console: операция для Laravel-проектов');
    const idx = ensureIndex(ctx);
    const d = laravelScan(idx);
    const lines = [];
    if (!d.cmds.length && !d.sched.length) return out('команды и расписание не найдены (app/Console/Commands, routes/console.php, Kernel::schedule)');
    if (d.cmds.length) {
      lines.push(`команды (${d.cmds.length}):`);
      for (const c of d.cmds) lines.push(`  ${c.sig}  ${c.cls ? c.cls + '  (' + c.p + ':' + c.l + ')' : '(' + c.p + ':' + c.l + ')'}${c.desc ? '  — ' + short(c.desc, 60) : ''}`);
    }
    if (d.sched.length) {
      lines.push(`расписание (${d.sched.length}):`);
      for (const s of d.sched) {
        let cmd = s.cmd;
        if (/::class$/.test(cmd)) {
          const cc = d.cmds.find((x) => x.cls === cmd.replace(/::class$/, ''));
          if (cc) cmd = cc.sig;
        }
        lines.push(`  ${cmd}  ${s.freq}  (${s.p}:${s.l})`);
      }
    }
    out(...lines);
  },

  create() {
    const f = args.file;
    if (!f || args.text === undefined) fail('нужны file и text');
    const abs = safeAbs(f);
    if (fs.existsSync(abs)) fail('файл уже существует: ' + f + ' (для правки используйте patch)');
    const text = String(args.text).replace(/\r\n/g, '\n');
    let enc = args.enc;
    if (enc !== 'utf8' && enc !== 'cp1251') {
      enc = 'utf8';
      if (/[^\x00-\x7F]/.test(text)) { // кодировку берём по большинству файлов проекта
        const idx = ensureIndex(ctx);
        const c = { utf8: 0, cp1251: 0 };
        for (const n of idx.nodes) if (n.o === 'custom' && c[n.enc] !== undefined) c[n.enc]++;
        if (c.cp1251 > c.utf8) enc = 'cp1251';
      }
    }
    let buf;
    try { buf = encodeText(args.eol === 'crlf' ? text.replace(/\n/g, '\r\n') : text, enc, false); } catch (e) { fail('запись отменена: ' + e.message); }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    writeAtomic(abs, buf);
    out(`OK: создан ${posix(path.relative(ctx.root, abs))}, кодировка ${enc}`);
  },

  patch() {
    const f = args.file;
    if (!f || args.old === undefined || args.new === undefined) fail('нужны file, old, new');
    const abs = safeAbs(f);
    if (!fs.existsSync(abs)) fail('файл не найден: ' + f);
    const cur = readText(abs);
    if (cur.text.includes('\0')) fail('бинарный файл');
    const eol = cur.eol === 'crlf' ? '\r\n' : '\n';
    const norm = (s) => String(s).replace(/\r\n/g, '\n').replace(/\n/g, eol);
    const oldS = norm(args.old), newS = norm(args.new);
    if (!oldS) fail('old не должен быть пустым');
    const parts = cur.text.split(oldS);
    const count = parts.length - 1;
    if (count === 0) fail('old не найден в файле (проверьте пробелы, табуляцию и переводы строк; прочитайте фрагмент операцией read)');
    if (count > 1 && !truthy(args.all)) {
      const lines = [];
      let pos = 0;
      for (let i = 0; i < Math.min(count, 5); i++) { pos = cur.text.indexOf(oldS, pos); lines.push(cur.text.slice(0, pos).split('\n').length); pos += oldS.length; }
      fail(`old встречается ${count} раз (строки ${[...new Set(lines)].join(', ')}); расширьте фрагмент или передайте "all":true`);
    }
    const result = parts.join(newS);
    let enc = cur.enc;
    if (enc === 'ascii' && /[^\x00-\x7F]/.test(result)) {
      if (args.enc === 'utf8' || args.enc === 'cp1251') enc = args.enc;
      else {
        const idx = ensureIndex(ctx);
        const c = { utf8: 0, cp1251: 0 };
        for (const n of idx.nodes) if (n.o === 'custom' && c[n.enc] !== undefined) c[n.enc]++;
        enc = c.cp1251 > c.utf8 ? 'cp1251' : 'utf8';
      }
    }
    let buf;
    try { buf = encodeText(result, enc, cur.bom); } catch (e) { fail('запись отменена, файл не тронут: ' + e.message); }
    writeAtomic(abs, buf);
    const line = cur.text.slice(0, cur.text.indexOf(oldS)).split('\n').length;
    out(`OK: ${posix(path.relative(ctx.root, abs))}, замен: ${count}, первая со строки ${line}, кодировка ${enc}, EOL ${cur.eol}`);
  }
};

function relations(reverse) {
  if (!args.file) fail('укажите file');
  const idx = ensureIndex(ctx);
  const n = findNode(idx, args.file);
  const depth = Math.max(1, Math.min(Number(args.depth) || 1, 5));
  const items = bfs(idx, n.id, depth, reverse);
  out(`${n.p} [${n.kind}]: ${reverse ? 'используют' : 'использует'} — ${items.length} (глубина ${depth})`, ...fmtEdges(items, 60));
  if (!reverse && n.mods) console.log('модули: ' + n.mods.map(([id]) => id).join(', '));
}

// ---------- самопроверка ----------
// selftest — проверки чистых функций на встроенных примерах; индекс проекта не нужен: bx.js selftest
ops.selftest = function () {
  const bad = [];
  let total = 0;
  const chk = (name, cond, extra) => {
    total++;
    console.log((cond ? 'ok    ' : 'FAIL  ') + name + (cond ? '' : '  [' + String(extra === undefined ? '' : extra).replace(/\s+/g, ' ').slice(0, 300) + ']'));
    if (!cond) bad.push(name);
  };

  // разбор PHP
  const php = [
    '<?php',
    'namespace Demo\\Mod;',
    '',
    'use Bitrix\\Main\\Loader;',
    '',
    'class Api',
    '{',
    '    public static function run(int $id): string',
    '    {',
    '        Loader::includeModule("iblock"); // комментарий',
    '        return "ок";',
    '    }',
    '',
    '    private function hidden()',
    '    {',
    '        return 1;',
    '    }',
    '}'
  ].join('\n');
  const p = parsePhp(php);
  const js = JSON.stringify(p);
  const api = (p.decls || []).find((d) => d.name === 'Api');
  chk('php: namespace и use', p.ns === 'Demo\\Mod' && (p.imports || []).length === 1, js.slice(0, 300));
  chk('php: класс и fqn', !!api && api.kind === 'class' && api.fqn === 'Demo\\Mod\\Api', js.slice(0, 300));
  chk('php: методы', !!api && ['run', 'hidden'].every((n) => (api.members || []).some((m) => m.n === n && m.k === 'method')), js.slice(0, 300));

  // Битрикс-структуры
  const lang = parseLang('<?php $MESS["WELCOME"] = "Привет, мир!";');
  chk('lang: ключи MESS', lang.length === 1 && lang[0][0] === 'WELCOME' && lang[0][1] === 'Привет, мир!', JSON.stringify(lang));
  const rules = parseUrlRewrite('<?php $arUrlRewrite = array(array("CONDITION" => "#^/catalog/(.*)#i", "RULE" => "/catalog/index.php", "ID" => "", "PATH" => "/catalog/index.php"));');
  chk('urlrewrite: правило', rules.length === 1 && rules[0].c === '#^/catalog/(.*)#i' && rules[0].p === '/catalog/index.php', JSON.stringify(rules));
  const params = parseComponentParams('<?php $arParameters = array("PARAMETERS" => array("SHOW_TITLE" => array("NAME" => "Показывать заголовок"), "CACHE_TIME" => array("DEFAULT" => 3600)));');
  chk('parameters: ключи верхнего уровня', params.join(',') === 'SHOW_TITLE,CACHE_TIME', JSON.stringify(params));

  // классификация путей и вспомогательные
  const c1 = classify('/local/components/demo/list/templates/.default/template.php');
  chk('bitrix: компонент и шаблон', c1.origin === 'custom' && c1.comp && c1.comp.id === 'demo:list' && c1.comp.tpl === '.default', JSON.stringify(c1));
  const c2 = classify('/bitrix/modules/main/classes/general/version.php');
  const c3 = classify('/local/news/lang/ru/detail.php');
  chk('bitrix: ядро и языковой файл', c2.origin === 'core' && c3.lang && c3.lang.code === 'ru', JSON.stringify([c2, c3]));
  chk('bitrix: resolveInclude', resolveInclude({b: 'dir', r: 'include.php'}, '/local/news/list.php') === '/local/news/include.php');
  const rx = pcreToRegExp('#^/catalog/(.*)#i');
  chk('bitrix: pcre → RegExp', !!rx && rx.test('/Catalog/12') && !rx.test('/other'));

  // Laravel
  const lv = require('./lib/laravel');
  const routesSrc = [
    '<?php',
    'use App\\Http\\Controllers\\UserController;',
    'Route::get("/", function () { return view("welcome"); });',
    'Route::middleware(["auth"])->prefix("admin")->group(function () {',
    '    Route::get("/users", [UserController::class, "index"])->name("users.index");',
    '    Route::resource("posts", \\App\\Http\\Controllers\\PostController::class)->only(["index", "show"]);',
    '});',
  ].join('\n');
  const lr = lv.parseLaravelPhp(routesSrc);
  const rs = JSON.stringify(lr);
  chk('laravel: маршрут с группой', (lr.routes || []).some((r) => r.u === '/admin/users' && r.a === 'UserController@index' && r.n === 'users.index' && r.mw.includes('auth')), rs.slice(0, 300));
  const ctrlSrc = [
    '<?php',
    'Route::controller(UserController::class)->group(function () {',
    "    Route::get('/profile', 'edit')->name('profile.edit');",
    '});',
  ].join('\n');
  const lcc = lv.parseLaravelPhp(ctrlSrc);
  chk('laravel: Route::controller()', (lcc.routes || []).some((r) => r.a === 'UserController@edit' && r.n === 'profile.edit'), JSON.stringify(lcc).slice(0, 300));
  chk('laravel: resource only', (lr.routes || []).filter((r) => r.res === 'posts').length === 2 && (lr.routes || []).some((r) => r.u === '/admin/posts/{post}'), rs.slice(0, 300));
  chk('laravel: view() в действии-замыкании', (lr.views || []).some((v) => v[0] === 'welcome'), rs.slice(0, 300));
  const modelSrc = [
    '<?php',
    'namespace App\\Models;',
    'use Illuminate\\Database\\Eloquent\\Model;',
    'class Category extends Model {',
    '    protected $fillable = ["name", "slug"];',
    '    public function posts() { return $this->hasMany(Post::class); }',
    '    public function scopeActive($q) {}',
    '}',
  ].join('\n');
  const lm = lv.parseLaravelPhp(modelSrc);
  chk('laravel: модель', (lm.models || []).length === 1 && lm.models[0].table === null && lm.models[0].fillable.join(',') === 'name,slug' && lm.models[0].rels.length === 1 && lm.models[0].rels[0].r === 'Post' && lm.models[0].scopes.join(',') === 'active', JSON.stringify(lm).slice(0, 300));
  chk('laravel: имя таблицы по соглашению', lv.modelTable('OrderItem') === 'order_items' && lv.modelTable('Category') === 'categories' && lv.modelTable('Person') === 'people');
  const migSrc = [
    '<?php',
    'Schema::create("posts", function (Blueprint $table) {',
    '    $table->id();',
    '    $table->string("title");',
    '    $table->foreignId("user_id")->constrained();',
    '});',
  ].join('\n');
  const lmg = lv.parseLaravelPhp(migSrc);
  chk('laravel: миграция', (lmg.migs || []).length === 1 && lmg.migs[0].t === 'posts' && lmg.migs[0].cols.some((c) => c.startsWith('title string')) && lmg.migs[0].fks.length === 1, JSON.stringify(lmg).slice(0, 300));
  const bl = lv.parseBlade("@extends('layouts.app')\n@include('partials.nav')\n@section('content'){{ $user->name }}@endsection\n@lang('auth.failed')");
  chk('laravel: blade', bl.ext[0][0] === 'layouts.app' && bl.inc[0][0] === 'partials.nav' && bl.vars.includes('user') && bl.langs[0][0] === 'auth.failed', JSON.stringify(bl));
  const ll = lv.parseLaravelLang('<?php return ["failed" => "Неверный логин", "nested" => ["k" => "v"]];');
  chk('laravel: языковой файл', ll.length === 2 && ll[0][0] === 'failed' && ll[1][0] === 'nested.k', JSON.stringify(ll));
  const bindSrc = '<?php $this->app->singleton(PaymentGateway::class, StripeGateway::class); $this->app->when(ReportBuilder::class)->needs("$limit")->give(10);';
  const lb = lv.parseLaravelPhp(bindSrc);
  chk('laravel: контейнер', (lb.binds || []).length === 1 && lb.binds[0].k === 'singleton' && lb.binds[0].a === 'PaymentGateway' && lb.binds[0].i === 'StripeGateway' && (lb.ctxBinds || []).length === 1, JSON.stringify(lb).slice(0, 300));
  const lrx = lv.routeUriToRegExp('/users/{user}/posts/{post?}');
  chk('laravel: сопоставление URL', !!lrx && lrx.test('/users/5/posts') && lrx.test('/users/5/posts/9') && !lrx.test('/users/5/x/9'));
  const lv2 = lv.laravelClassify('/app/Http/Controllers/Admin/UserController.php');
  const lv3 = lv.laravelClassify('/resources/views/layouts/app.blade.php');
  const lv4 = lv.laravelClassify('/lang/ru/auth.php');
  chk('laravel: классификация путей', lv2.tag === 'controller' && lv3.tag === 'view' && lv3.view.name === 'layouts.app' && lv4.tag === 'lang-lv' && lv4.langlv.group === 'auth', JSON.stringify([lv2, lv3, lv4]));
  const sch = lv.parseLaravelPhp('<?php Schedule::command("app:sync")->dailyAt("02:00")->withoutOverlapping();');
  chk('laravel: расписание', (sch.sched || []).length === 1 && sch.sched[0].cmd === 'app:sync' && sch.sched[0].freq.includes("dailyAt('02:00')"), JSON.stringify(sch).slice(0, 300));

  if (bad.length) {
    console.log('\nпровалено: ' + bad.join(', '));
    process.exit(1);
  }
  console.log('\nвсе проверки пройдены (' + total + ')');
};

if (!args.op) fail('укажите op: ' + Object.keys(ops).join(' | '));
if (!ops[args.op]) fail('неизвестный op: ' + args.op);
try { ops[args.op](); } catch (e) { fail(e.message); }
