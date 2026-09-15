// graph-tool.js — граф зависимостей TS/Angular с кэшем и точечными запросами.
// Один раз строит graph-deps.json, дальше отвечает на навигационные вопросы
// без обхода репозитория: где определён символ, кто импортирует файл,
// цепочка связей, циклы. Актуальность проверяет сам (mtime) и перестраивает
// инкрементально — только изменённые файлы.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let args = {};
// CLI-режим: node graph-tool.js build file=src/app/a.ts depth=2
for (const a of process.argv.slice(2)) {
  const i = a.indexOf('=');
  if (i === -1) { if (!args.op) args.op = a; }
  else if (a.slice(0, i)) args[a.slice(0, i)] = a.slice(i + 1);
}
// stdin-режим (команды скилла) — читаем пайп, только если op не задан аргументами
if (!args.op && process.stdin.isTTY !== true) {
  try { Object.assign(args, JSON.parse(fs.readFileSync(0, 'utf-8').trim() || '{}')); } catch (e) {}
}

const cwd = process.cwd();
const ROOT = path.resolve(cwd, args.root || 'src');
const GRAPH_FILE = path.join(cwd, 'graph-deps.json');
const CACHE_FILE = path.join(cwd, '.graph-deps-cache.json');
const EXCLUDE = new Set(['node_modules', '.git', 'dist', '.kilocode', '.angular', 'coverage', 'build']);
const NG_KINDS = { Component: 'component', Directive: 'directive', Pipe: 'pipe', Injectable: 'injectable', NgModule: 'ngmodule' };
const KIND_PRI = { component: 5, directive: 4, pipe: 3, injectable: 3, ngmodule: 2, class: 1 };

const emit = (obj) => console.log(JSON.stringify(obj));
const fail = (msg) => { emit({ error: msg }); process.exit(1); };
const toPosix = (p) => path.relative(cwd, p).replace(/\\/g, '/');

/**
 * Собирает .ts файлы проекта (без спеков и .d.ts).
 */
function collectFiles(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!EXCLUDE.has(e.name)) collectFiles(p, acc); }
    else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith('.d.ts')
      && (args.specs || !/\.(spec|test)\.tsx?$/.test(e.name))) acc.push(p);
  }
  return acc;
}

/**
 * JSONC без комментариев (для чтения compilerOptions.paths).
 */
function parseJsonc(text) {
  let out = '', i = 0, str = false;
  while (i < text.length) {
    const c = text[i], n = text[i + 1];
    if (str) {
      out += c;
      if (c === '\\') { out += n || ''; i += 2; continue; }
      if (c === '"') str = false;
      i++; continue;
    }
    if (c === '"') { str = true; out += c; i++; continue; }
    if (c === '/' && n === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i += 2; continue; }
    out += c; i++;
  }
  return JSON.parse(out.replace(/,\s*([}\]])/g, '$1'));
}

/**
 * Резолвер алиасов импортов из tsconfig (paths/baseUrl).
 * @returns {Function|null} spec → массив абсолютных путей-кандидатов.
 */
function loadAliases() {
  try {
    const tsconfig = path.join(cwd, 'tsconfig.json');
    if (!fs.existsSync(tsconfig)) return null;
    const co = parseJsonc(fs.readFileSync(tsconfig, 'utf8')).compilerOptions || {};
    const base = co.baseUrl ? path.resolve(cwd, co.baseUrl) : cwd;
    const entries = Object.entries(co.paths || {}).map(([k, v]) => ({
      pre: k.endsWith('*') ? k.slice(0, -1) : k,
      star: k.endsWith('*'),
      targets: [].concat(v).map((t) => path.resolve(base, t))
    }));
    return (spec) => {
      for (const e of entries) {
        if (e.star) {
          if (spec.startsWith(e.pre) && spec.length > e.pre.length)
            return e.targets.map((t) => t.replace(/\*/g, spec.slice(e.pre.length)));
        } else if (spec === e.pre) return e.targets.slice();
      }
      return null;
    };
  } catch (e) { return null; }
}

/**
 * Разбирает содержимое .ts: импорты, экспорты, объявления с номерами строк.
 */
function parseFile(content) {
  content = content.replace(/^\uFEFF/, '');
  const specifiers = [], entities = [], exports = [];
  let reexportAll = false, m;
  const lineAt = (idx) => content.slice(0, idx).split('\n').length;

  // Импорты и реэкспорты (включая динамические import()); многострочные поддержаны
  const reImps = [
    /import\s+[^;'"]*?from\s*['"]([^'"]+)['"]/g,
    /import\s*['"]([^'"]+)['"]/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /export\s+[^;'"]*?from\s*['"]([^'"]+)['"]/g
  ];
  for (const re of reImps) while ((m = re.exec(content))) specifiers.push(m[1]);
  if (/export\s*\*\s*from/.test(content)) reexportAll = true;

  const reExp = /export\s*\{([^}]*)\}/g;
  while ((m = reExp.exec(content)))
    for (const part of m[1].split(',')) {
      const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop().trim();
      if (name && name !== '*') exports.push(name);
    }

  const reDecl = /(?:^|\n)[ \t]*(export\s+)?(?:default\s+)?(?:abstract\s+)?(class|interface|enum|type|function|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  while ((m = reDecl.exec(content))) {
    const kind = m[2] === 'let' || m[2] === 'var' ? 'const' : m[2];
    entities.push({ name: m[3], kind, line: lineAt(m.index) });
    if (m[1]) exports.push(m[3]);
  }

  // Angular-декораторы: вид сущности + селектор
  const reNg = /@(Component|Directive|Pipe|Injectable|NgModule)\s*\(([\s\S]{0,1500}?)\)\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g;
  while ((m = reNg.exec(content))) {
    const sel = m[2].match(/selector\s*:\s*['"`]([^'"`]+)['"`]/);
    entities.push({ name: m[3], kind: NG_KINDS[m[1]], line: lineAt(m.index), ...(sel ? { selector: sel[1] } : {}) });
    exports.push(m[3]);
  }

  return {
    specifiers: [...new Set(specifiers)],
    entities,
    exports: [...new Set(exports)],
    reexportAll,
    loc: content.split('\n').length
  };
}

/**
 * Превращает спецификатор импорта в файл проекта либо имя внешнего пакета.
 */
function resolveSpec(spec, fromAbs, fileSet, alias) {
  let bases;
  if (spec.startsWith('.')) bases = [path.resolve(path.dirname(fromAbs), spec)];
  else {
    const hits = alias ? alias(spec) : null;
    if (!hits) return { external: spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0] };
    bases = hits;
  }
  for (const b of bases)
    for (const v of [b, b + '.ts', b + '.tsx', path.join(b, 'index.ts')])
      if (fileSet.has(v)) return { file: v };
  return null; // стили, ассеты, html — вне графа
}

/**
 * Главный "род" узла: component > directive > pipe > injectable > ngmodule > class > barrel.
 */
function nodeKind(n) {
  let best = null, pri = -1;
  for (const e of n.entities) {
    const p = KIND_PRI[e.kind] || 0;
    if (p > pri) { pri = p; best = e.kind; }
  }
  if (best) return best;
  if (n.reexportAll) return 'barrel';
  return n.entities.length ? n.entities[0].kind : 'file';
}

/**
 * Циклические группы — алгоритм Тарьяна.
 */
function tarjan(nodes) {
  const n = nodes.length;
  const idx = new Array(n + 1).fill(-1), low = new Array(n + 1).fill(0), on = new Array(n + 1).fill(false);
  const stack = [], sccs = [];
  let cnt = 0;
  const strong = (v) => {
    idx[v] = low[v] = cnt++;
    stack.push(v); on[v] = true;
    for (const w of nodes[v - 1].imports) {
      if (idx[w] < 0) { strong(w); low[v] = Math.min(low[v], low[w]); }
      else if (on[w]) low[v] = Math.min(low[v], idx[w]);
    }
    if (low[v] === idx[v]) {
      const comp = [];
      let w;
      do { w = stack.pop(); on[w] = false; comp.push(w); } while (w !== v);
      if (comp.length > 1) sccs.push(comp.map((id) => nodes[id - 1].path).sort());
    }
  };
  for (let i = 1; i <= n; i++) if (idx[i] < 0) strong(i);
  return sccs;
}

/**
 * Строит граф с инкрементальным кэшем (парсятся только изменённые файлы).
 */
function buildGraph(files) {
  const t0 = Date.now();
  files = (files || collectFiles(ROOT)).sort();
  if (!files.length) fail('Не найдено .ts файлов в ' + (args.root || 'src'));

  const fileSet = new Set(files);
  const alias = loadAliases();
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch (e) {}
  const newCache = {};
  let reparsed = 0;

  const nodes = files.map((f, i) => {
    const rel = toPosix(f);
    const st = fs.statSync(f);
    const c = cache[rel];
    let data;
    if (c && c.mtime === st.mtimeMs && c.size === st.size) data = c.data;
    else { data = parseFile(fs.readFileSync(f, 'utf8')); reparsed++; }
    newCache[rel] = { mtime: st.mtimeMs, size: st.size, data };
    return { id: i + 1, path: rel, ...data };
  });
  const idByAbs = new Map(files.map((f, i) => [f, i + 1]));

  const externals = new Set();
  for (const n of nodes) {
    n.imports = [];
    n.external = [];
    const abs = path.join(cwd, n.path);
    for (const spec of n.specifiers) {
      const r = resolveSpec(spec, abs, fileSet, alias);
      if (r && r.file) n.imports.push(idByAbs.get(r.file));
      else if (r && r.external) { n.external.push(r.external); externals.add(r.external); }
    }
    n.imports = [...new Set(n.imports)].sort((a, b) => a - b);
    n.external = [...new Set(n.external)].sort();
    delete n.specifiers;
    n.kind = nodeKind(n);
  }

  const symbols = {}, selectors = {};
  for (const n of nodes) {
    for (const e of n.entities) {
      (symbols[e.name] = symbols[e.name] || []).push(n.id);
      if (e.selector) selectors[e.selector] = n.id;
    }
    for (const ex of n.exports) if (!symbols[ex]) symbols[ex] = [n.id];
  }

  const cycles = tarjan(nodes);
  const graph = {
    version: 1,
    root: args.root || 'src',
    files: nodes,
    symbols, selectors,
    externals: [...externals].sort(),
    cycles,
    stats: {
      files: nodes.length,
      edges: nodes.reduce((s, n) => s + n.imports.length, 0),
      externalPackages: externals.size,
      cycles: cycles.length
    }
  };
  fs.writeFileSync(GRAPH_FILE, JSON.stringify(graph));
  fs.writeFileSync(CACHE_FILE, JSON.stringify(newCache));
  return { graph, reparsed, ms: Date.now() - t0 };
}

/**
 * Отдаёт актуальный граф: при изменении/удалении файлов перестраивает сам.
 */
function ensureGraph() {
  let graph = null;
  try { graph = JSON.parse(fs.readFileSync(GRAPH_FILE, 'utf8')); } catch (e) {}
  const files = collectFiles(ROOT);
  let stale = !graph || graph.version !== 1
    || graph.root !== (args.root || 'src')
    || files.length !== graph.files.length;
  if (!stale) {
    const gm = fs.statSync(GRAPH_FILE).mtimeMs;
    for (const f of files) if (fs.statSync(f).mtimeMs > gm) { stale = true; break; }
  }
  return stale ? buildGraph(files) : { graph, reparsed: 0 };
}

/**
 * Ищет узел по id / пути / имени файла; при неоднозначности — список кандидатов.
 */
function findNode(graph, q) {
  q = String(q).replace(/\\/g, '/');
  if (/^\d+$/.test(q)) {
    const byId = graph.files.find((f) => f.id === +q);
    if (byId) return { node: byId };
  }
  const qs = q.toLowerCase();
  let list = graph.files.filter((f) => f.path === q || f.path.endsWith('/' + q));
  if (!list.length) list = graph.files.filter((f) => f.path.toLowerCase() === qs || f.path.toLowerCase().endsWith('/' + qs));
  if (!list.length) {
    const base = path.posix.basename(qs, path.posix.extname(qs));
    list = graph.files.filter((f) => {
      const b = path.posix.basename(f.path.toLowerCase());
      return b === qs || b.replace(/\.(ts|tsx)$/, '') === base;
    });
  }
  if (!list.length) list = graph.files.filter((f) => f.path.toLowerCase().includes(qs));
  if (!list.length) return { error: 'Файл не найден в графе: ' + q };
  if (list.length > 1) return { ambiguous: list.slice(0, 15).map((f) => f.path + ' [' + f.kind + ']') };
  return { node: list[0] };
}

function reverseIndex(graph) {
  const rev = new Map();
  for (const f of graph.files)
    for (const t of f.imports) {
      if (!rev.has(t)) rev.set(t, []);
      rev.get(t).push(f.id);
    }
  return rev;
}

/**
 * BFS по графу до depth: список {file, kind, level} без повторов.
 */
function walk(graph, startId, depth, reverse) {
  const rev = reverse ? reverseIndex(graph) : null;
  const children = (id) => (reverse ? rev.get(id) || [] : graph.files[id - 1].imports);
  const seen = new Set([startId]);
  const frontier = [[startId, 0]];
  const out = [];
  while (frontier.length) {
    const [id, d] = frontier.shift();
    if (d >= depth) continue;
    for (const c of children(id)) {
      if (seen.has(c)) continue;
      seen.add(c);
      const f = graph.files[c - 1];
      out.push({ file: f.path, kind: f.kind, level: d + 1 });
      frontier.push([c, d + 1]);
    }
  }
  return out;
}

// ---------- диспетчер ----------
const op = args.op;
if (!op) fail('Укажите op: build | node | deps | rdeps | symbol | selector | path | cycles | stats');

if (op === 'build') {
  const { graph, reparsed, ms } = buildGraph(null);
  emit({ built: true, ...graph.stats, reparsed, ms });
  process.exit(0);
}

const { graph } = ensureGraph();
const byId = (id) => graph.files[id - 1];

if (op === 'stats') {
  const rev = reverseIndex(graph);
  emit({
    ...graph.stats,
    topImported: graph.files
      .map((f) => ({ file: f.path, kind: f.kind, importers: (rev.get(f.id) || []).length }))
      .sort((a, b) => b.importers - a.importers).slice(0, 10)
  });
  process.exit(0);
}

if (op === 'cycles') {
  emit({ count: graph.cycles.length, cycles: graph.cycles.slice(0, 20) });
  process.exit(0);
}

if (op === 'symbol') {
  if (!args.name) fail('Укажите payload.name');
  const ids = graph.symbols[args.name];
  if (!ids) { emit({ name: args.name, definedIn: [] }); process.exit(0); }
  emit({
    name: args.name,
    definedIn: [...new Set(ids)].map((id) => {
      const f = byId(id);
      const e = f.entities.find((x) => x.name === args.name);
      return { file: f.path, kind: e ? e.kind : f.kind, ...(e && e.line ? { line: e.line } : {}), ...(e && e.selector ? { selector: e.selector } : {}) };
    })
  });
  process.exit(0);
}

if (op === 'selector') {
  if (!args.selector) fail('Укажите payload.selector');
  const id = graph.selectors[args.selector];
  emit(id
    ? { selector: args.selector, file: byId(id).path, kind: byId(id).kind }
    : { selector: args.selector, file: null });
  process.exit(0);
}

if (op === 'path') {
  if (!args.from || !args.to) fail('Укажите payload.from и payload.to');
  const a = findNode(graph, args.from), b = findNode(graph, args.to);
  if (a.error) fail(a.error);
  if (b.error) fail(b.error);
  if (a.ambiguous || b.ambiguous) { emit({ ambiguous: true, matches: a.ambiguous || b.ambiguous }); process.exit(0); }
  const prev = new Map([[a.node.id, null]]);
  const queue = [a.node.id];
  while (queue.length) {
    const cur = queue.shift();
    if (cur === b.node.id) break;
    for (const nxt of graph.files[cur - 1].imports)
      if (!prev.has(nxt)) { prev.set(nxt, cur); queue.push(nxt); }
  }
  if (!prev.has(b.node.id)) { emit({ from: a.node.path, to: b.node.path, chain: null }); process.exit(0); }
  const chain = [];
  for (let cur = b.node.id; cur != null; cur = prev.get(cur)) chain.unshift(graph.files[cur - 1].path);
  emit({ from: a.node.path, to: b.node.path, chain });
  process.exit(0);
}

if (op === 'node' || op === 'deps' || op === 'rdeps') {
  if (!args.file) fail('Укажите payload.file');
  const r = findNode(graph, args.file);
  if (r.error) fail(r.error);
  if (r.ambiguous) { emit({ ambiguous: true, matches: r.ambiguous }); process.exit(0); }
  const n = r.node;

  if (op === 'node') {
    const rev = reverseIndex(graph);
    emit({
      file: n.path, id: n.id, kind: n.kind, loc: n.loc,
      entities: n.entities.slice(0, 50),
      ...(n.entities.length > 50 ? { entitiesTruncated: n.entities.length - 50 } : {}),
      ...(n.reexportAll ? { reexportAll: true } : {}),
      imports: n.imports.map((id) => ({ file: byId(id).path, kind: byId(id).kind })),
      importedBy: (rev.get(n.id) || []).slice(0, 30).map((id) => ({ file: byId(id).path, kind: byId(id).kind })),
      ...(n.external.length ? { external: n.external } : {})
    });
    process.exit(0);
  }

  const depth = Math.min(Math.max(args.depth || 1, 1), 5);
  const list = walk(graph, n.id, depth, op === 'rdeps').slice(0, 60);
  emit(op === 'deps'
    ? { file: n.path, kind: n.kind, importsTotal: walk(graph, n.id, depth, false).length, imports: list, ...(n.external.length ? { external: n.external } : {}) }
    : { file: n.path, kind: n.kind, importedByTotal: walk(graph, n.id, depth, true).length, importedBy: list });
  process.exit(0);
}

fail('Неизвестный op: ' + op);