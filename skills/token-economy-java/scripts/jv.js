#!/usr/bin/env node
'use strict';
// jv.js — token-economy для Java и Spring Boot 3+. Принимает JSON из stdin (или аргументы key=value, или @файл.json),
// отвечает компактным текстом. Операции: info, search, symbol, deps, rdeps, path, node, stats, outline, impls,
// beans, endpoints, config, entities, table, listeners, sig, read, patch, create, build.

const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { posix, listFiles, readText, encodeText, writeAtomic } = require('./lib/fsx');
const { makeCtx, ensureIndex, buildIndex } = require('./lib/index');
const { buildInfo } = require('./lib/build');
const { parseYaml, parseProperties, show, norm } = require('./lib/config');
const S = require('./lib/spring');
const CF = require('./lib/classfile');

try { process.stdout.setDefaultEncoding('utf8'); } catch (e) { /* ignore */ }

// ---------- аргументы ----------
const args = {};
function fail(msg) { console.log('Ошибка: ' + msg); process.exit(1); }
for (const a of process.argv.slice(2)) {
  const i = a.indexOf('=');
  if (a.startsWith('@')) {
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
const truthy = (v) => v === true || v === 'true' || v === '1';
const ctx = makeCtx({ root: args.root });
const out = (...lines) => console.log(lines.join('\n'));
const short = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const EDGE = { h: 'extends/implements', i: 'inject', u: 'uses' };

function safeAbs(rel) {
  const abs = path.resolve(ctx.root, rel);
  const r = path.relative(ctx.root, abs);
  if (r.startsWith('..') || path.isAbsolute(r)) fail('путь вне рабочей директории: ' + rel);
  return abs;
}

// ---------- поиск узла ----------
function findNode(idx, q) {
  const raw = String(q || '').trim();
  if (!raw) fail('не указан файл или класс');
  const lq = posix(raw).toLowerCase();
  const nodes = idx.nodes;
  const pick = (list) => {
    if (list.length === 1) return list[0];
    if (list.length > 1) fail('«' + raw + '» неоднозначно, уточните:\n' + list.slice(0, 15).map((n) => '  ' + n.p + ' [' + n.kind + ']').join('\n'));
    return null;
  };
  let r = pick(nodes.filter((n) => n.p.toLowerCase() === lq));
  if (r) return r;
  const cls = raw.replace(/[#/]/g, '.').replace(/\.java$/, '');
  const byClass = nodes.filter((n) => n.decls.some((d) => d.f === cls || d.n === cls || d.f.endsWith('.' + cls)));
  if (byClass.length) {
    const top = byClass.filter((n) => n.decls[0] && (n.decls[0].f === cls || n.decls[0].n === cls || n.decls[0].f.endsWith('.' + cls)));
    r = pick(top.length ? top : byClass);
    if (r) return r;
  }
  r = pick(nodes.filter((n) => n.p.toLowerCase().endsWith('/' + lq) || path.posix.basename(n.p).toLowerCase() === lq));
  if (r) return r;
  r = pick(nodes.filter((n) => n.p.toLowerCase().includes(lq)));
  if (r) return r;
  fail('не найдено в индексе: ' + raw);
}

function bfs(idx, start, depth, reverse, only) {
  const nodes = idx.nodes;
  let rev = null;
  if (reverse) {
    rev = new Map();
    for (const n of nodes) for (const [t, k] of n.edges) { if (only && !only.includes(k)) continue; if (!rev.has(t)) rev.set(t, []); rev.get(t).push([n.id, k]); }
  }
  const kids = (id) => (reverse ? rev.get(id) || [] : nodes[id - 1].edges.filter(([, k]) => !only || only.includes(k)));
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

// ---------- конфигурация ----------
function configFiles() {
  return listFiles(ctx.root, ['.yml', '.yaml', '.properties']).filter((f) => /(^|\/)(application|bootstrap)(-[\w.-]+)?\.(ya?ml|properties)$/.test(f));
}

function configEntries() {
  const res = [];
  for (const f of configFiles()) {
    let text;
    try { text = readText(path.join(ctx.root, f)).text; } catch (e) { continue; }
    const base = path.posix.basename(f);
    const fm = /^(?:application|bootstrap)-([\w.-]+)\.(?:ya?ml|properties)$/.exec(base);
    const docs = /\.properties$/.test(base) ? parseProperties(text) : parseYaml(text);
    for (const doc of docs) for (const e of doc.entries) {
      res.push({ key: e.key, nkey: norm(e.key), value: e.value, file: f, line: e.line, profile: fm ? fm[1] : (doc.profile || 'default') });
    }
  }
  return res;
}

function propUsages(idx) {
  const consts = S.constTable(idx);
  const res = [];
  for (const n of idx.nodes) for (const [a, argText, line] of n.props || []) {
    const owner = (() => {
      for (const d of n.decls) {
        if (line < d.l || line > d.e) continue;
        const m = d.mem.find((x) => x.k === 'method' && line >= x.l && line <= x.e);
        return m ? `${d.n}#${m.n}` : d.n;
      }
      return '';
    })();
    const add = (key, kind) => res.push({ key, nkey: norm(key), kind, p: n.p, l: line, owner });
    if (a === 'Value') for (const m of argText.matchAll(/\$\{([^}:]+)(?::[^}]*)?\}/g)) add(m[1].trim(), '@Value');
    else if (a === 'ConfigurationProperties') { const v = S.annArg(argText, 'prefix', 'value'); if (v) add(S.evalStrings(v, '', consts)[0], '@ConfigurationProperties(prefix)'); }
    else if (a === 'ConditionalOnProperty') {
      const prefix = S.annArg(argText, 'prefix');
      const pf = prefix ? S.evalStrings(prefix, '', consts)[0].replace(/\.$/, '') + '.' : '';
      for (const nm of S.evalStrings(S.annArg(argText, 'name', 'value'), '', consts)) add(pf + nm, '@ConditionalOnProperty');
    } else if (a === 'getProperty') add(argText.replace(/"/g, ''), 'getProperty');
  }
  return res;
}

// ---------- операции ----------
const ops = {
  build() {
    const { index, reparsed } = buildIndex(ctx);
    out(`индекс построен: ${index.nodes.length} файлов, разобрано заново: ${reparsed}`);
  },

  info() {
    const idx = ensureIndex(ctx);
    const b = buildInfo(ctx.root);
    const lines = [];
    lines.push(`сборка: ${b.tool}` + (b.modules.length ? `; модули: ${b.modules.join(', ')}` : ''));
    const major = b.boot ? parseInt(b.boot, 10) : null;
    lines.push(`Spring Boot: ${b.boot || 'не найден'}` + (major && major < 3 ? '  (ВНИМАНИЕ: скилл рассчитан на Boot 3+: jakarta.*, Java 17+)' : '') + `; Java: ${b.java || 'не найдена'}`);
    const mains = idx.nodes.filter((n) => n.decls.some((d) => S.hasAnn(d.ann, 'SpringBootApplication')));
    if (mains.length) lines.push('главный класс: ' + mains.map((n) => `${n.decls[0].n} (${n.p})`).join(', '));
    if (b.libs.length) lines.push('зависимости: ' + b.libs.join(', '));
    const files = configFiles();
    const entries = configEntries();
    const profiles = new Set(entries.map((e) => e.profile).filter((p) => p !== 'default'));
    const active = entries.find((e) => e.key === 'spring.profiles.active' || e.key === 'spring.profiles.default');
    lines.push(`конфигурация: ${files.length ? files.join(', ') : 'application.yml / .properties не найдены'}` + (profiles.size ? `; профили: ${[...profiles].join(', ')}` : '') + (active ? `; spring.profiles.active=${active.value}` : ''));
    const kinds = {};
    for (const n of idx.nodes) kinds[n.kind] = (kinds[n.kind] || 0) + 1;
    lines.push(`в индексе файлов: ${idx.nodes.length} (` + Object.entries(kinds).sort((a, c) => c[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ') + ')');
    const enc = {};
    for (const n of idx.nodes) enc[n.enc] = (enc[n.enc] || 0) + 1;
    lines.push('кодировка .java: ' + Object.entries(enc).map(([k, v]) => `${k} ${v}`).join(', ') + (b.encoding ? `; в сборке: ${b.encoding}` : ''));
    if (enc.cp1251) lines.push('ВНИМАНИЕ: есть файлы не в UTF-8. Читай их операцией read, правь операцией patch: штатные инструменты испортят кириллицу.');
    const jx = idx.nodes.filter((n) => n.javax);
    if (jx.length && (major === null || major >= 3)) lines.push(`ВНИМАНИЕ: ${jx.length} файл(ов) используют javax.persistence / servlet / validation (в Boot 3 это jakarta.*): ` + jx.slice(0, 3).map((n) => n.p).join(', ') + (jx.length > 3 ? ' …' : ''));
    out(...lines);
  },

  search() {
    if (!args.query) fail('укажите query');
    const exts = String(args.ext || '.java').split(',').map((e) => (e.startsWith('.') ? e : '.' + e).toLowerCase());
    const flags = truthy(args.ignoreCase) || truthy(args.i) ? 'i' : '';
    let rx;
    try { rx = new RegExp(truthy(args.regex) ? args.query : String(args.query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags); } catch (e) { fail('некорректное регулярное выражение'); }
    const sub = posix(args.path || '').replace(/^\/+|\/+$/g, '');
    const limit = Number(args.limit) || 30;
    const files = listFiles(ctx.root, exts).filter((rel) => !sub || rel === sub || rel.startsWith(sub + '/'));
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
    const q = q0.replace(/::|#/g, '.');
    const lq = q.toLowerCase();
    const idx = ensureIndex(ctx);
    const hits = [];
    const dot = q.lastIndexOf('.');
    const [qc, qm] = dot > 0 && /^[A-Z]/.test(q.slice(q.lastIndexOf('.', dot - 1) + 1)) && /^[a-zA-Z_]/.test(q.slice(dot + 1)) && !/^[A-Z]/.test(q.slice(dot + 1)) ? [q.slice(0, dot), q.slice(dot + 1)] : [null, null];
    for (const n of idx.nodes) for (const d of n.decls) {
      if (!qc && (d.f.toLowerCase() === lq || d.n.toLowerCase() === lq || d.f.toLowerCase().endsWith('.' + lq))) hits.push([d.f, d.k, n.p, d.l, d.e]);
      if (qc) {
        if (!(d.f.toLowerCase() === qc.toLowerCase() || d.n.toLowerCase() === qc.toLowerCase() || d.f.toLowerCase().endsWith('.' + qc.toLowerCase()))) continue;
        for (const m of d.mem) if (m.n === qm) hits.push([`${d.n}#${m.n}`, m.k, n.p, m.l, m.e]);
      } else if (!q.includes('.')) {
        for (const m of d.mem) if (m.n === q && m.k !== 'enumconst') hits.push([`${d.n}#${m.n}`, m.k, n.p, m.l, m.e]); // члены — с учётом регистра
      }
    }
    const ents = S.entities(idx, lq).filter((r) => r.table && r.table.toLowerCase().replace(' (по умолчанию)', '') === lq);
    for (const r of ents) hits.push([`${r.d.n} (таблица ${r.table.replace(' (по умолчанию)', '')})`, r.kind, r.n.p, r.d.l, r.d.e]);
    if (!hits.length) return out(`${q0}: не найдено среди классов проекта` + (/^[a-z]+\.[a-z]/.test(q0) ? '; для классов библиотек используйте sig' : ''));
    const uniq = hits.filter((h, i) => hits.findIndex((x) => x[0] === h[0] && x[2] === h[2] && x[3] === h[3]) === i);
    uniq.slice(0, 20).forEach(([name, kind, p, l, e]) => console.log(`${name}  ${kind}  ${p}:${l}-${e}`));
    if (uniq.length > 20) console.log(`… ещё ${uniq.length - 20}`);
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
    const lines = [`${n.p}  [${n.kind}]  ${n.loc} строк  ${n.enc}` + (n.mod ? `  модуль ${n.mod}` : '')];
    for (const d of n.decls) lines.push(`  ${d.k} ${d.f}  ${d.l}-${d.e}`);
    const up = bfs(idx, n.id, 1, false), down = bfs(idx, n.id, 1, true);
    lines.push('использует:', ...(up.length ? fmtEdges(up, 40) : ['  -']), 'используют его:', ...(down.length ? fmtEdges(down, 40) : ['  -']));
    out(...lines);
  },

  stats() {
    const idx = ensureIndex(ctx);
    const kinds = {};
    let edges = 0;
    const cnt = new Map();
    for (const n of idx.nodes) {
      kinds[n.kind] = (kinds[n.kind] || 0) + 1;
      edges += n.edges.length;
      for (const [t] of n.edges) cnt.set(t, (cnt.get(t) || 0) + 1);
    }
    const lines = [`файлов: ${idx.nodes.length}  связей: ${edges}`, '  ' + Object.entries(kinds).sort((a, c) => c[1] - a[1]).map(([k, v]) => `${k}: ${v}`).join('  '), 'самые востребованные:'];
    [...cnt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).forEach(([id, c]) => lines.push(`  ${c}  ${idx.nodes[id - 1].p}`));
    out(...lines);
  },

  outline() {
    const idx = ensureIndex(ctx);
    const n = findNode(idx, args.file || args.target);
    const lines = [`${n.p}  [${n.kind}]  (${n.loc} строк, ${n.enc})`];
    if (n.pkg) lines.push('package ' + n.pkg);
    const showFields = args.fields === undefined || truthy(args.fields);
    const annText = (list, withArgs) => (list || []).map((a) => '@' + a[0] + (withArgs && a[1] ? '(' + short(a[1], 40) + ')' : '')).join(' ');
    const renderDecl = (d, depth, label) => {
      const pad = '  '.repeat(depth);
      let hdr = `${(d.mods || []).filter((x) => x !== 'public').join(' ')} ${d.k} ${d.n}`.trim();
      if (d.comps) hdr += '(' + d.comps.map((p) => `${p.t} ${p.n}`).join(', ') + ')';
      if (d.extT) hdr += ' extends ' + d.extT.join(', ');
      if (d.implT) hdr += ' implements ' + d.implT.join(', ');
      lines.push((`L${d.l}-${d.e}`.padEnd(10)) + pad + (label || '') + hdr + (d.ann.length ? '  ' + annText(d.ann, true) : ''));
      if (d.k === 'enum') { const cs = d.mem.filter((m) => m.k === 'enumconst').map((m) => m.n); if (cs.length) lines.push(' '.repeat(10) + pad + '  ' + cs.slice(0, 30).join(', ')); }
      if (d.di && depth === 0) { const inj = [...new Set(d.di.map(S.baseName))].filter((t) => t && !S.TRIVIAL.has(t)); if (inj.length) lines.push(' '.repeat(10) + pad + '  inject: ' + inj.join(', ')); }
      for (const m of d.mem) {
        if (m.k === 'enumconst') continue;
        if (m.k === 'field') { if (!showFields) continue; lines.push(`L${m.l}`.padEnd(10) + pad + '  ' + (m.ann ? annText(m.ann, false) + ' ' : '') + (m.mods && m.mods.includes('static') ? 'static ' : '') + m.t + ' ' + m.n); continue; }
        lines.push(`L${m.l}-${m.e}`.padEnd(10) + pad + '  ' + (m.ann ? annText(m.ann, true) + ' ' : '') + short(m.sig, 150));
      }
    };
    for (const d of n.decls) renderDecl(d, d.f.split('.').length - (n.pkg ? n.pkg.split('.').length : 0) - 1, '');
    if (truthy(args.inherit)) { // поля и методы предков из проекта
      const seen = new Set();
      let cur = n.decls[0];
      for (let i = 0; i < 5 && cur && cur.ext && cur.ext[0]; i++) {
        const r = S.declByName(idx, cur.ext[0]);
        if (!r || seen.has(r[1].f)) break;
        seen.add(r[1].f);
        lines.push(`  -- унаследовано от ${r[1].n} (${r[0].p}:${r[1].l})`);
        for (const m of r[1].mem.filter((x) => x.k === 'method' && !(x.mods || []).includes('private')).slice(0, 40)) lines.push(`L${m.l}-${m.e}`.padEnd(10) + '  ' + short(m.sig, 150));
        cur = r[1];
      }
    }
    out(...lines);
  },

  impls() {
    const name = args.name || args.file;
    if (!name) fail('укажите name: интерфейс или класс');
    const idx = ensureIndex(ctx);
    const n = findNode(idx, name);
    const depth = Math.max(1, Math.min(Number(args.depth) || 3, 6));
    const items = bfs(idx, n.id, depth, true, ['h']);
    if (!items.length) return out(`${n.p}: наследников и реализаций в проекте нет`);
    out(`${n.decls[0] ? n.decls[0].f : n.p}: наследники и реализации — ${items.length}`, ...items.slice(0, 60).map(([lvl, m]) => {
      const d = m.decls[0];
      return `${lvl} ${d ? d.n : m.p}  [${m.kind}${d && (d.mods || []).includes('abstract') ? ', abstract' : ''}]  ${m.p}`;
    }), ...(items.length > 60 ? [`… ещё ${items.length - 60}`] : []));
  },

  beans() {
    const idx = ensureIndex(ctx);
    const rows = S.beans(idx, args.query);
    if (!rows.length) return out('бинов не найдено' + (args.query ? ` по запросу «${args.query}»` : ''));
    const lines = [];
    for (const r of rows.slice(0, 70)) lines.push(`${r.text}  ${r.p}:${r.l}` + (r.inj.length ? `  ← ${r.inj.join(', ')}` : ''));
    if (rows.length > 70) lines.push(`… ещё ${rows.length - 70} (уточните query)`);
    out(...lines);
  },

  endpoints() {
    const idx = ensureIndex(ctx);
    const rows = S.endpoints(idx, args.query);
    if (!rows.length) return out('эндпоинтов не найдено' + (args.query ? ` по запросу «${args.query}»` : ''));
    const lines = rows.slice(0, 80).map((r) => `${r.http} ${r.path}  → ${r.cls}#${r.method}(${short(r.params, 80)})` + (r.client ? '  [client]' : '') + (r.sec ? `  [${r.sec}]` : '') + `  ${r.p}:${r.l}`);
    if (rows.length > 80) lines.push(`… ещё ${rows.length - 80} (уточните query)`);
    out(...lines);
  },

  config() {
    const entries = configEntries();
    const idx = ensureIndex(ctx);
    const q = String(args.query || '').trim();
    if (!q) {
      const profiles = {};
      const prefixes = {};
      for (const e of entries) { profiles[e.profile] = (profiles[e.profile] || 0) + 1; const p = e.key.split(/[.[]/).slice(0, 2).join('.'); prefixes[p] = (prefixes[p] || 0) + 1; }
      return out(`файлы: ${configFiles().join(', ') || 'нет'}`, `ключей: ${entries.length}; профили: ` + Object.entries(profiles).map(([k, v]) => `${k} (${v})`).join(', '),
        'префиксы: ' + Object.entries(prefixes).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => `${k} (${v})`).join(', '), 'уточните query: часть ключа');
    }
    const nq = norm(q);
    const defs = entries.filter((e) => e.nkey.includes(nq));
    const uses = propUsages(idx).filter((u) => u.nkey.includes(nq) || nq.includes(u.nkey));
    if (!defs.length && !uses.length) return out(`«${q}»: в конфигурации и коде не найдено`);
    const lines = [];
    defs.sort((a, b) => a.key.localeCompare(b.key) || a.profile.localeCompare(b.profile)).slice(0, 40)
      .forEach((e) => lines.push(`${e.key} = ${show(e.key, e.value)}  [${e.profile}]  ${e.file}:${e.line}`));
    if (defs.length > 40) lines.push(`… ещё ключей: ${defs.length - 40}`);
    if (uses.length) {
      lines.push('используется:');
      uses.slice(0, 20).forEach((u) => lines.push(`  ${u.kind} ${u.key}  ${u.owner}  ${u.p}:${u.l}`));
      if (uses.length > 20) lines.push(`  … ещё ${uses.length - 20}`);
    }
    out(...lines);
  },

  entities() {
    const idx = ensureIndex(ctx);
    const rows = S.entities(idx, args.query);
    if (!rows.length) return out('сущностей не найдено' + (args.query ? ` по запросу «${args.query}»` : ''));
    if (!args.query && rows.length > 12) {
      return out(...rows.map((r) => `${r.d.n}  ${r.kind}${r.table ? '  таблица ' + r.table : ''}  ${r.n.p}`).slice(0, 80), 'уточните query для полей и репозиториев');
    }
    const lines = [];
    for (const r of rows.slice(0, 8)) {
      lines.push(`${r.d.n}  ${r.kind}${r.table ? '  таблица ' + r.table : ''}  ${r.n.p}:${r.d.l}-${r.d.e}`);
      for (const f of S.entityFields(idx, r.d, 0)) lines.push('  ' + f);
      for (const rp of r.repos) {
        lines.push(`  репозиторий: ${rp.d.n} (${(rp.d.extT || [])[0]})  ${rp.n.p}:${rp.d.l}`);
        for (const m of rp.d.mem.filter((x) => x.k === 'method').slice(0, 15)) {
          const qa = (m.ann || []).find((a) => a[0] === 'Query' || a[0] === 'NamedQuery');
          lines.push(`    ${short(m.sig, 100)}` + (qa ? `  @${qa[0]}(${short(qa[1], 90)})` : ''));
        }
      }
    }
    if (rows.length > 8) lines.push(`… ещё сущностей: ${rows.length - 8}`);
    out(...lines);
  },

  table() {
    const q = String(args.name || args.query || '').trim();
    if (!q) fail('укажите name: имя таблицы БД');
    const lq = q.toLowerCase();
    const idx = ensureIndex(ctx);
    const lines = [];
    for (const r of S.entities(idx, lq).filter((x) => x.table && x.table.toLowerCase().replace(' (по умолчанию)', '') === lq)) {
      lines.push(`${q}  (JPA: ${r.d.n}, ${r.n.p}:${r.d.l}-${r.d.e})`);
      S.entityFields(idx, r.d, 0).slice(0, 40).forEach((f) => lines.push('  ' + f));
    }
    const strip = (s) => s.replace(/[`"\[\]]/g, '').split('.').pop().toLowerCase();
    const sql = listFiles(ctx.root, ['.sql']).filter((f) => /(^|\/)(db|migration|migrations|flyway|sql)\//i.test(f) || /schema|data\.sql$/i.test(f));
    const creates = [], alters = [];
    for (const rel of sql) {
      const text = readText(path.join(ctx.root, rel)).text;
      const reC = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"\[\]\w.]+)\s*\(/gi;
      let m;
      while ((m = reC.exec(text))) {
        if (strip(m[1]) !== lq) continue;
        let depth = 1, i = reC.lastIndex;
        const start = i;
        while (i < text.length && depth > 0) { if (text[i] === '(') depth++; else if (text[i] === ')') depth--; i++; }
        const parts = [];
        let d = 0, cur = '';
        for (const ch of text.slice(start, i - 1)) { if (ch === '(') d++; if (ch === ')') d--; if (ch === ',' && d === 0) { parts.push(cur); cur = ''; } else cur += ch; }
        parts.push(cur);
        const cols = [], keys = [];
        for (const p of parts.map((x) => x.trim()).filter(Boolean)) {
          if (/^(PRIMARY|UNIQUE|KEY|INDEX|CONSTRAINT|FOREIGN|CHECK)\b/i.test(p)) keys.push(short(p.replace(/\s+/g, ' '), 70));
          else { const c = /^[`"\[]?(\w+)[`"\]]?\s+([A-Za-z]+(?:\([^)]*\))?)([^,]*)$/.exec(p.replace(/\s+/g, ' ')); if (c) cols.push(c[1] + ' ' + c[2] + (/PRIMARY KEY/i.test(c[3]) ? ' PK' : '') + (/NOT NULL/i.test(c[3]) ? ' not null' : '') + (/UNIQUE/i.test(c[3]) ? ' unique' : '')); }
        }
        creates.push(`SQL: ${rel}:${text.slice(0, m.index).split('\n').length}`, '  колонки: ' + cols.join(', '), ...(keys.length ? ['  ключи: ' + keys.slice(0, 10).join('; ')] : []));
      }
      const reA = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?([`"\[\]\w.]+)\s+([^;]{0,100})/gi;
      while ((m = reA.exec(text))) if (strip(m[1]) === lq) alters.push(`  ${rel}:${text.slice(0, m.index).split('\n').length}  ${short(m[2].replace(/\s+/g, ' ').trim(), 80)}`);
    }
    lines.push(...creates);
    if (alters.length) lines.push('изменения (ALTER):', ...alters.slice(0, 12));
    const lb = listFiles(ctx.root, ['.xml', '.yaml', '.yml']).filter((f) => /(changelog|liquibase|db)/i.test(f));
    const lbHits = [];
    for (const rel of lb) {
      const ls = readText(path.join(ctx.root, rel)).text.split(/\r?\n/);
      ls.forEach((l, i) => { const m = /tableName\s*[=:]\s*["']?([\w.]+)/.exec(l); if (m && m[1].toLowerCase() === lq && lbHits.length < 8) lbHits.push(`  ${rel}:${i + 1}  ${short(l.trim(), 80)}`); });
    }
    if (lbHits.length) lines.push('Liquibase:', ...lbHits);
    if (!lines.length) return out(`таблица ${q}: не найдена ни в JPA-сущностях, ни в SQL-миграциях`);
    out(...lines);
  },

  listeners() {
    const idx = ensureIndex(ctx);
    const rows = S.listeners(idx, args.query);
    if (!rows.length) return out('слушателей и публикаций не найдено' + (args.query ? ` по запросу «${args.query}»` : ''));
    const lines = rows.slice(0, 60).map((r) => `${r.text}  ${r.p}:${r.l}`);
    if (rows.length > 60) lines.push(`… ещё ${rows.length - 60} (уточните query)`);
    out(...lines);
  },

  sig() {
    let target = String(args.name || args.class || '').trim();
    if (!target) fail('укажите name: полное имя класса (org.springframework.web.client.RestClient), можно с членом через # или .');
    let member = args.member || null;
    if (target.includes('#')) { [target, member] = target.split('#'); }
    let found = null;
    const tryFind = (fqn) => CF.findClass(ctx.root, fqn, { jars: args.jars, jar: args.jar });
    if (!target.includes('.')) { // короткое имя: берём полное из импортов проекта
      const idx = ensureIndex(ctx);
      const raw = JSON.parse(fs.readFileSync(path.join(ctx.root, '.jv-cache', 'cache.json'), 'utf8')).files;
      for (const f of Object.values(raw)) { const imp = (f.d.imports || []).find((x) => x.endsWith('.' + target)); if (imp) { target = imp; break; } }
      if (!target.includes('.')) fail('для короткого имени нужен импорт этого класса в проекте; укажите полное имя');
    }
    found = tryFind(target);
    if (!found && member === null) { // последний сегмент может быть методом: pkg.Class.method
      const cut = target.lastIndexOf('.');
      const alt = tryFind(target.slice(0, cut));
      if (alt) { found = alt; member = target.slice(cut + 1); target = target.slice(0, cut); }
    }
    if (!found) {
      if (/^javax?\./.test(target)) {
        const r = cp.spawnSync('javap', ['-public', target], { encoding: 'utf8' });
        if (r.status === 0 && r.stdout) return out(r.stdout.trim().split('\n').map((l) => l.replace(/^\s+/, '  ')).join('\n'));
        return out(`${target}: класс JDK; jar в локальных репозиториях нет, а javap недоступен`);
      }
      return out(`${target}: не найден в jar локальных репозиториев (Maven ~/.m2, Gradle ~/.gradle, JV_JARS) и в target/classes. Соберите проект или передайте "jars":"путь"`);
    }
    let cf;
    try { cf = CF.parseClass(found.bytes); } catch (e) { fail('не удалось разобрать class-файл: ' + e.message); }
    const lines = CF.describe(cf, { member, all: truthy(args.all) });
    const jarName = path.basename(found.jar);
    out(`${cf.name.replace(/\//g, '.')}  ${jarName}` + (found.others.length ? `  (есть ещё версии: ${found.others.slice(0, 3).map((x) => path.basename(x)).join(', ')})` : '') + (cf.major < 61 ? '' : ''),
      ...lines.slice(0, 120), ...(lines.length > 120 ? [`… ещё ${lines.length - 120} (уточните member)`] : []));
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
    let enc = args.enc === 'cp1251' ? 'cp1251' : 'utf8';
    if (!args.enc && /[^\x00-\x7F]/.test(text)) {
      const idx = ensureIndex(ctx);
      const c = { utf8: 0, cp1251: 0 };
      for (const n of idx.nodes) if (c[n.enc] !== undefined) c[n.enc]++;
      if (c.cp1251 > c.utf8) enc = 'cp1251';
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
    const norm2 = (s) => String(s).replace(/\r\n/g, '\n').replace(/\n/g, eol);
    const oldS = norm2(args.old), newS = norm2(args.new);
    if (!oldS) fail('old не должен быть пустым');
    const parts = cur.text.split(oldS);
    const count = parts.length - 1;
    if (count === 0) fail('old не найден в файле (проверьте пробелы, табуляцию и переводы строк; прочитайте фрагмент операцией read)');
    if (count > 1 && !truthy(args.all)) {
      const ls = [];
      let pos = 0;
      for (let i = 0; i < Math.min(count, 5); i++) { pos = cur.text.indexOf(oldS, pos); ls.push(cur.text.slice(0, pos).split('\n').length); pos += oldS.length; }
      fail(`old встречается ${count} раз (строки ${[...new Set(ls)].join(', ')}); расширьте фрагмент или передайте "all":true`);
    }
    const result = parts.join(newS);
    let enc = cur.enc;
    if (enc === 'ascii' && /[^\x00-\x7F]/.test(result)) enc = args.enc === 'cp1251' ? 'cp1251' : 'utf8';
    let buf;
    try { buf = encodeText(result, enc, cur.bom); } catch (e) { fail('запись отменена, файл не тронут: ' + e.message); }
    writeAtomic(abs, buf);
    out(`OK: ${posix(path.relative(ctx.root, abs))}, замен: ${count}, первая со строки ${cur.text.slice(0, cur.text.indexOf(oldS)).split('\n').length}, кодировка ${enc}, EOL ${cur.eol}`);
  }
};

function relations(reverse) {
  if (!args.file) fail('укажите file');
  const idx = ensureIndex(ctx);
  const n = findNode(idx, args.file);
  const depth = Math.max(1, Math.min(Number(args.depth) || 1, 5));
  const items = bfs(idx, n.id, depth, reverse);
  out(`${n.p} [${n.kind}]: ${reverse ? 'используют' : 'использует'} — ${items.length} (глубина ${depth})`, ...fmtEdges(items, 60));
}

// ---------- самопроверка ----------
// selftest — проверки чистых функций на встроенных примерах; индекс проекта не нужен: jv.js selftest
ops.selftest = function () {
  const bad = [];
  let total = 0;
  const chk = (name, cond, extra) => {
    total++;
    console.log((cond ? 'ok    ' : 'FAIL  ') + name + (cond ? '' : '  [' + String(extra === undefined ? '' : extra).replace(/\s+/g, ' ').slice(0, 300) + ']'));
    if (!cond) bad.push(name);
  };
  const { parseJava } = require('./lib/java');

  // конфигурация: yaml/properties/секреты
  const yml = parseYaml([
    'spring:',
    '  datasource:',
    '    url: jdbc:postgresql://db/app',
    '    password: s3cret',
    '---',
    'spring:',
    '  config.activate.on-profile: dev',
    '  datasource.url: jdbc:h2:mem:dev',
    ''
  ].join('\n'));
  const base = (yml[0] && yml[0].entries) || [];
  chk('yaml: вложенные ключи', base.some((e) => e.key === 'spring.datasource.url' && e.value === 'jdbc:postgresql://db/app'), JSON.stringify(yml));
  chk('yaml: второй документ с профилем', yml.length === 2 && yml[1].profile === 'dev', JSON.stringify(yml));
  const props = parseProperties('a.b=1\nc.d: два\n');
  chk('properties: «=» и «:»', props[0].entries.length === 2 && props[0].entries[1].value === 'два', JSON.stringify(props));
  chk('секреты: маскирование', show('spring.datasource.password', 's3cret') === '***' && show('spring.datasource.password', '${DB_PASS}') === '${DB_PASS}');
  chk('norm: relaxed binding', norm('spring.datasource.password') === 'spring.datasource.password' && norm('TRACE-ID') === 'traceid' && norm('my-key') === 'mykey');

  // разбор Java
  const src = [
    'package demo;',
    '',
    '@RestController',
    '@RequestMapping("/api/users")',
    'public class UserController {',
    '    private final UserService service;',
    '',
    '    @GetMapping("/{id}")',
    '    public User get(@PathVariable Long id) { return service.find(id); }',
    '',
    '    @PostMapping',
    '    public User create(@RequestBody User u) { return service.save(u); }',
    '}'
  ].join('\n');
  const j = parseJava(src);
  const js = JSON.stringify(j);
  const d = (j.decls || []).find((x) => x.n === 'UserController');
  chk('java: класс с аннотациями', !!d && S.hasAnn(d.ann, 'RestController') && S.annArg((S.ann(d.ann, 'RequestMapping') || [])[1] || '', 'value') === '"/api/users"', js.slice(0, 300));
  chk('java: методы с аннотациями', !!d && d.mem.some((m) => m.n === 'get' && S.hasAnn(m.ann, 'GetMapping')) && d.mem.some((m) => m.n === 'create' && S.hasAnn(m.ann, 'PostMapping')), js.slice(0, 300));
  chk('java: поле', !!d && d.mem.some((m) => m.n === 'service' && m.k === 'field'), js.slice(0, 300));

  // spring-хелперы
  const sa = S.splitArgs('value = "/api", produces = "application/json"');
  chk('spring: splitArgs', sa.length === 2 && sa[0].k === 'value' && sa[0].v === '"/api"' && sa[1].k === 'produces', JSON.stringify(sa));
  chk('spring: annArg', S.annArg('"/api/{id}"', 'value') === '"/api/{id}"' && S.annArg('path = "/x"', 'value', 'path') === '"/x"');
  chk('spring: evalExpr/evalStrings', S.evalExpr('"api" + "/users"', '', new Map()) === 'api/users' && S.evalStrings('{ "a", "b" }', '', new Map()).join('|') === 'a|b');
  chk('spring: baseName', S.baseName('List<org.foo.User>') === 'List' && S.baseName('org.foo.User...') === 'org.foo.User');

  if (bad.length) {
    console.log('\nпровалено: ' + bad.join(', '));
    process.exit(1);
  }
  console.log('\nвсе проверки пройдены (' + total + ')');
};

if (!args.op) fail('укажите op: ' + Object.keys(ops).join(' | '));
if (!ops[args.op]) fail('неизвестный op: ' + args.op);
try { ops[args.op](); } catch (e) { fail(e.message); }
