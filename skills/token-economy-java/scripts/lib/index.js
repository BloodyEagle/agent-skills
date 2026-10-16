'use strict';
// index.js — индекс проекта: разбор .java (с инкрементальным кэшем) и связи между файлами.
// Связи (A → B = «A зависит от B»):
//   h  наследование: extends / implements / permits
//   i  внедрение зависимости: параметры конструктора, @Autowired / @Inject / @Resource, @Bean-методы, Lombok
//   u  прочее использование типа (поле, вызов, аннотация, generic, статический импорт)

const fs = require('fs');
const path = require('path');
const { listFiles, readText } = require('./fsx');
const { parseJava } = require('./java');

const VERSION = 1; // формат кэша и индекса; при смене разбора увеличить
const CACHE_DIR = '.jv-cache';
const KIND_ORDER = ['h', 'i', 'u'];

function loadJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } }

function saveJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const gi = path.join(path.dirname(p), '.gitignore');
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, '*\n');
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, p);
}

function makeCtx(opts) { return { root: path.resolve(opts.root || '.') }; }

const javaFiles = (ctx) => listFiles(ctx.root, ['.java']).filter((f) => !/(^|\/)(module-info|package-info)\.java$/.test(f));

const SPRING_TEST = new Set(['SpringBootTest', 'WebMvcTest', 'DataJpaTest', 'WebFluxTest', 'JsonTest', 'RestClientTest', 'DataMongoTest', 'JdbcTest', 'TestConfiguration']);

/**
 * Роль файла по аннотациям главного типа: controller, service, repository, config, entity, …
 */
function roleOf(d, p) {
  const names = d.ann.map((a) => a[0]);
  if (/(^|\/)src\/test\//.test(p) || names.some((n) => SPRING_TEST.has(n))) return 'test';
  const has = (...xs) => xs.some((x) => names.includes(x));
  if (has('RestController', 'Controller')) return 'controller';
  if (has('ControllerAdvice', 'RestControllerAdvice')) return 'advice';
  if (has('Repository') || (d.k === 'interface' && (d.extT || []).some((t) => /Repository\s*</.test(t)))) return 'repository';
  if (has('Service')) return 'service';
  if (has('SpringBootApplication', 'Configuration', 'AutoConfiguration', 'EnableAutoConfiguration')) return 'config';
  if (has('Entity', 'Embeddable', 'MappedSuperclass')) return 'entity';
  if (has('ConfigurationProperties')) return 'properties';
  if (has('FeignClient', 'HttpExchange')) return 'client';
  if (has('Mapper')) return 'mapper';
  if (has('Component')) return 'component';
  return d.k;
}

function buildIndex(ctx) {
  const files = javaFiles(ctx);
  const cacheFile = path.join(ctx.root, CACHE_DIR, 'cache.json');
  let cache = loadJson(cacheFile) || {};
  if (cache.v !== VERSION) cache = {};
  const old = cache.files || {};
  const fresh = {};
  let reparsed = 0;
  // модули сборки: ближайший каталог с pom.xml / build.gradle
  const buildDirs = new Set(listFiles(ctx.root, ['pom.xml', 'build.gradle', 'build.gradle.kts']).map((f) => path.posix.dirname(f)));
  const moduleOf = (p) => {
    let d = path.posix.dirname(p);
    while (true) {
      if (buildDirs.has(d)) return d === '.' ? '' : d;
      if (d === '.' || d === '/' || !d) return '';
      d = path.posix.dirname(d);
    }
  };

  const nodes = [];
  files.forEach((rel, i) => {
    const st = fs.statSync(path.join(ctx.root, rel));
    const c = old[rel];
    let data;
    if (c && c.m === st.mtimeMs && c.s === st.size) data = c.d;
    else {
      const { text, enc } = readText(path.join(ctx.root, rel));
      data = { enc, ...parseJava(text) };
      reparsed++;
    }
    fresh[rel] = { m: st.mtimeMs, s: st.size, d: data };
    nodes.push({ id: i + 1, p: rel, m: st.mtimeMs, sz: st.size, raw: data });
  });

  // индекс типов: полное имя → id файла (вложенные типы тоже)
  const typeIdx = new Map();
  for (const n of nodes) for (const d of n.raw.decls) if (!typeIdx.has(d.f)) typeIdx.set(d.f, n.id);

  const lookupFqn = (fqn) => { // a.b.Outer.Inner.member → ближайший известный тип
    let f = fqn;
    for (;;) {
      const id = typeIdx.get(f);
      if (id) return id;
      const cut = f.lastIndexOf('.');
      if (cut < 0) return null;
      f = f.slice(0, cut);
    }
  };

  const resolver = (raw) => {
    const explicit = new Map();
    for (const imp of raw.imports) explicit.set(imp.slice(imp.lastIndexOf('.') + 1), imp);
    return (name) => {
      if (!name) return null;
      const first = name.split('.')[0];
      if (name.includes('.') && /^[a-z]/.test(first)) return lookupFqn(name); // полное имя пакета
      const head = first;
      if (explicit.has(head)) return lookupFqn(explicit.get(head) + name.slice(head.length));
      const same = typeIdx.get((raw.pkg ? raw.pkg + '.' : '') + head);
      if (same) return same;
      for (const w of raw.wild) { const id = typeIdx.get(w + '.' + head); if (id) return id; }
      return null;
    };
  };

  const typeNames = (text) => { // имена типов в тексте вроде Map<String, List<UserDto>>
    const out = [];
    for (const m of String(text).matchAll(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/g)) if (/^[A-Z]/.test(m[0]) || /^[a-z].*\.[A-Z]/.test(m[0])) out.push(m[0]);
    return out;
  };

  const out = nodes.map((n) => {
    const r = n.raw;
    const resolve = resolver(r);
    const edges = new Map();
    const add = (id, k) => {
      if (!id || id === n.id) return;
      const cur = edges.get(id);
      if (!cur || KIND_ORDER.indexOf(k) < KIND_ORDER.indexOf(cur)) edges.set(id, k);
    };
    for (const h of r.hier) add(resolve(h), 'h');
    for (const d of r.decls) for (const t of d.di || []) for (const nm of typeNames(t)) add(resolve(nm), 'i');
    for (const nm of r.refs) add(resolve(nm), 'u');
    for (const imp of r.imports) add(lookupFqn(imp), 'u');
    for (const st of r.statics) add(lookupFqn(st.slice(0, st.lastIndexOf('.'))), 'u');
    const main = r.decls[0];
    const node = {
      id: n.id, p: n.p, m: n.m, sz: n.sz, enc: r.enc, loc: r.loc, pkg: r.pkg,
      kind: main ? roleOf(main, n.p) : 'file', mod: moduleOf(n.p),
      decls: r.decls, edges: [...edges.entries()].sort((a, b) => a[0] - b[0])
    };
    if (r.props.length) node.props = r.props;
    if (r.pub.length) node.pub = r.pub;
    if (r.snd.length) node.snd = r.snd;
    if (r.imports.some((x) => x.startsWith('javax.persistence') || x.startsWith('javax.servlet') || x.startsWith('javax.validation') || x.startsWith('javax.annotation.Post'))) node.javax = true;
    return node;
  });
  const index = { v: VERSION, nodes: out };
  saveJson(path.join(ctx.root, CACHE_DIR, 'index.json'), index);
  saveJson(cacheFile, { v: VERSION, files: fresh });
  return { index, reparsed };
}

/**
 * Актуальный индекс: пересобирается сам, если изменился список файлов, их размер или время.
 */
function ensureIndex(ctx) {
  const idx = loadJson(path.join(ctx.root, CACHE_DIR, 'index.json'));
  if (idx && idx.v === VERSION) {
    const files = javaFiles(ctx);
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

module.exports = { makeCtx, ensureIndex, buildIndex, CACHE_DIR, loadJson, javaFiles };
