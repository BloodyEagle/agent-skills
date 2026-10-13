#!/usr/bin/env node
'use strict';
// bx.js — token-economy для PHP и 1С-Битрикс. Принимает JSON из stdin (или аргументы key=value),
// отвечает компактным текстом. Операции: info, search, symbol, deps, rdeps, path, node, stats,
// outline, component, events, lang, route, read, patch, create, build.

const fs = require('fs');
const path = require('path');
const { posix, listFiles, readText, encodeText, writeAtomic } = require('./lib/fsx');
const { makeCtx, ensureIndex, buildIndex, docPath, CACHE_DIR } = require('./lib/index');
const { classify, pcreToRegExp } = require('./lib/bitrix');
const { parseUrlRewrite, parseComponentParams } = require('./lib/php');

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
const EDGE = { x: 'component', t: 'template', i: 'include', c: 'class', f: 'function', l: 'lang', e: 'event handler' };

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
  if (/^[\w.-]+:[\w.-]+$/.test(q)) { // идентификатор компонента ns:name
    r = pick(nodes.filter((n) => n.comp && n.comp.id.toLowerCase() === lq && !n.lang && (n.comp.part === 'class.php' || n.comp.part === 'component.php')));
    if (r) return r;
  }
  const bare = clsQ;
  const byClass = nodes.filter((n) => (n.decls || []).some((d) => d.fqn.toLowerCase() === bare || d.name.toLowerCase() === bare));
  if (byClass.length) { r = pick(byClass); if (r) return r; }
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
    lines.push(`корень сайта: ${ctx.docroot || '.'}${isBx ? '' : '  (признаков Битрикса нет: bitrix/ и local/ не найдены)'}`);
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
    if (files.length) lines.push('найдено: ' + files.join(', '));
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
    const hits = [];
    for (const n of idx.nodes) {
      for (const d of n.decls || []) {
        const fq = d.fqn.toLowerCase(), nm = d.name.toLowerCase();
        if (!qc && (fq === q || nm === q || fq.endsWith('\\' + q))) hits.push([d.fqn, d.kind, n.p, d.line, d.end]);
        if (d.table && d.table.toLowerCase() === q) hits.push([d.fqn + ' (таблица ' + d.table + ')', d.kind, n.p, d.line, d.end]);
        for (const m of d.members || []) {
          const mn = m.n.toLowerCase();
          if (qc ? (nm === qc || fq === qc || fq.endsWith('\\' + qc)) && mn === qm : (mn === q && !q.includes('\\'))) hits.push([d.name + '::' + m.n, m.k, n.p, m.l, m.e]);
        }
      }
      for (const f of n.funcs || []) if (!qc && (f.n.toLowerCase() === q || f.f.toLowerCase() === q)) hits.push([f.f, 'function', n.p, f.l, f.e]);
      for (const [c, l] of n.consts || []) if (!qc && c.toLowerCase() === q) hits.push([c, 'const', n.p, l, l]);
    }
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
    if (n.langs) lines.push('  lang: ' + n.langs.join(','));
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
    }
    for (const f of n.funcs || []) lines.push(`L${f.l}-${f.e}`.padEnd(10) + short(f.sig, 150));
    for (const [c, l] of n.consts || []) lines.push(`L${l}`.padEnd(10) + 'const ' + c);
    if (!(n.decls || []).length && !(n.funcs || []).length) lines.push('(объявлений классов и функций нет — шаблон или страница)');
    if (n.comps) lines.push('компоненты: ' + n.comps.map(([id, t, l]) => `${id}${t ? ' [' + t + ']' : ''} L${l}`).join('; '));
    if (n.mods) lines.push('модули: ' + n.mods.map(([id, l]) => `${id} L${l}`).join(', '));
    if (n.ark) lines.push('$arResult: ' + n.ark.join(', '));
    if (n.apk) lines.push('$arParams: ' + n.apk.join(', '));
    if (n.events) lines.push('события: ' + n.events.map((e) => `${e.m}:${e.e} L${e.l}`).join('; '));
    if (n.langs) lines.push('lang: ' + n.langs.join(', '));
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
      for (const [k, l] of n.msgs || []) { if (!used.has(k)) used.set(k, []); used.get(k).push(`${n.p}:${l}`); }
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

if (!args.op) fail('укажите op: ' + Object.keys(ops).join(' | '));
if (!ops[args.op]) fail('неизвестный op: ' + args.op);
try { ops[args.op](); } catch (e) { fail(e.message); }
