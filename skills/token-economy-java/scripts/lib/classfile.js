'use strict';
// classfile.js — сигнатуры классов библиотек без JDK и без декомпиляции: поиск jar в локальных репозиториях
// (Maven ~/.m2, Gradle ~/.gradle, каталоги из JV_JARS), чтение .class из архива и разбор членов класса.
// Код библиотек не исполняется.

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

// ---------- zip ----------
function readTail(fd, size) {
  const len = Math.min(size, 65557 + 22);
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, size - len);
  return buf;
}

/**
 * Центральный каталог jar: [{name, method, csize, usize, off}].
 */
function zipEntries(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size < 22) return [];
    const tail = readTail(fd, size);
    let e = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { e = i; break; }
    if (e < 0) return [];
    const count = tail.readUInt16LE(e + 10), cdSize = tail.readUInt32LE(e + 12), cdOff = tail.readUInt32LE(e + 16);
    if (cdOff === 0xffffffff) return []; // zip64 не поддерживается
    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOff);
    const out = [];
    let p = 0;
    for (let i = 0; i < count && p + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) break;
      const method = cd.readUInt16LE(p + 10), csize = cd.readUInt32LE(p + 20), usize = cd.readUInt32LE(p + 24);
      const nl = cd.readUInt16LE(p + 28), el = cd.readUInt16LE(p + 30), cl = cd.readUInt16LE(p + 32), off = cd.readUInt32LE(p + 42);
      out.push({ name: cd.toString('utf8', p + 46, p + 46 + nl), method, csize, usize, off });
      p += 46 + nl + el + cl;
    }
    return out;
  } finally { fs.closeSync(fd); }
}

function zipRead(file, entry) {
  const fd = fs.openSync(file, 'r');
  try {
    const h = Buffer.alloc(30);
    fs.readSync(fd, h, 0, 30, entry.off);
    const nl = h.readUInt16LE(26), el = h.readUInt16LE(28);
    const data = Buffer.alloc(entry.csize);
    fs.readSync(fd, data, 0, entry.csize, entry.off + 30 + nl + el);
    return entry.method === 0 ? data : zlib.inflateRawSync(data);
  } finally { fs.closeSync(fd); }
}

// ---------- поиск jar ----------
function jarRoots(root, extra) {
  const roots = [];
  const home = os.homedir();
  const add = (p) => { if (p && fs.existsSync(p) && !roots.includes(p)) roots.push(p); };
  for (const p of String(extra || process.env.JV_JARS || '').split(path.delimiter)) add(p.trim());
  let m2 = path.join(home, '.m2', 'repository');
  try {
    const s = fs.readFileSync(path.join(home, '.m2', 'settings.xml'), 'utf8');
    const lm = /<localRepository>([^<]+)<\/localRepository>/.exec(s);
    if (lm) m2 = lm[1].trim();
  } catch (e) { /* settings.xml нет */ }
  add(m2);
  add(path.join(process.env.GRADLE_USER_HOME || path.join(home, '.gradle'), 'caches', 'modules-2', 'files-2.1'));
  add(path.join(root, 'lib'));
  return roots;
}

function collectJars(dir, acc, depth) {
  if (depth > 9) return;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collectJars(p, acc, depth + 1);
    else if (/\.jar$/i.test(e.name) && !/-(sources|javadoc|tests|test-sources)\.jar$/i.test(e.name)) acc.push(p);
  }
}

/**
 * Индекс «пакет → jar» с кэшем в .jv-cache/jars.json (jar перечитывается только при изменении).
 */
function jarIndex(root, extra) {
  const cacheFile = path.join(root, '.jv-cache', 'jars.json');
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch (e) { cache = {}; }
  const jars = [];
  for (const r of jarRoots(root, extra)) collectJars(r, jars, 0);
  const fresh = {};
  let changed = false;
  for (const j of jars) {
    let st;
    try { st = fs.statSync(j); } catch (e) { continue; }
    const c = cache[j];
    if (c && c.m === st.mtimeMs && c.s === st.size) { fresh[j] = c; continue; }
    let pkgs = [];
    try {
      const set = new Set();
      for (const en of zipEntries(j)) if (en.name.endsWith('.class')) { const i = en.name.lastIndexOf('/'); set.add(i < 0 ? '' : en.name.slice(0, i)); }
      pkgs = [...set];
    } catch (e) { pkgs = []; }
    fresh[j] = { m: st.mtimeMs, s: st.size, pkgs };
    changed = true;
  }
  if (changed || Object.keys(cache).length !== Object.keys(fresh).length) {
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      const gi = path.join(path.dirname(cacheFile), '.gitignore');
      if (!fs.existsSync(gi)) fs.writeFileSync(gi, '*\n');
      fs.writeFileSync(cacheFile, JSON.stringify(fresh));
    } catch (e) { /* кэш не критичен */ }
  }
  return fresh;
}

const verKey = (p) => (p.match(/\d+/g) || []).map(Number);
function cmpVer(a, b) {
  const x = verKey(a), y = verKey(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (y[i] || 0) - (x[i] || 0); if (d) return d; }
  return 0;
}

/**
 * Находит байты .class: [{jar, bytes}] по полному имени; вложенные классы: a.b.Outer.Inner → a/b/Outer$Inner.
 */
function findClass(root, fqn, opts) {
  const parts = fqn.replace(/\//g, '.').split('.');
  const idx = jarIndex(root, opts && opts.jars);
  const hits = [];
  for (let cut = parts.length - 1; cut >= 1 && !hits.length; cut--) {
    const pkg = parts.slice(0, cut).join('/');
    const cls = parts.slice(cut).join('$');
    for (const [jar, info] of Object.entries(idx)) {
      if (opts && opts.jar && !jar.toLowerCase().includes(String(opts.jar).toLowerCase())) continue;
      if (!info.pkgs.includes(pkg)) continue;
      hits.push({ jar, entry: pkg + '/' + cls + '.class', pkg, cls });
    }
  }
  hits.sort((a, b) => cmpVer(a.jar, b.jar));
  for (const h of hits) {
    try {
      const en = zipEntries(h.jar).find((x) => x.name === h.entry);
      if (en) return { jar: h.jar, bytes: zipRead(h.jar, en), others: hits.filter((x) => x !== h).map((x) => x.jar) };
    } catch (e) { /* следующий jar */ }
  }
  // каталоги с классами проекта
  for (const d of [path.join(root, 'target', 'classes'), path.join(root, 'build', 'classes', 'java', 'main')]) {
    for (let cut = parts.length - 1; cut >= 1; cut--) {
      const f = path.join(d, ...parts.slice(0, cut), parts.slice(cut).join('$') + '.class');
      if (fs.existsSync(f)) return { jar: path.relative(root, d), bytes: fs.readFileSync(f), others: [] };
    }
  }
  return null;
}

// ---------- разбор class-файла ----------
function parseClass(buf) {
  let p = 0;
  const u1 = () => buf[p++];
  const u2 = () => { const v = buf.readUInt16BE(p); p += 2; return v; };
  const u4 = () => { const v = buf.readUInt32BE(p); p += 4; return v; };
  if (u4() !== 0xCAFEBABE) throw new Error('не class-файл');
  u2(); const major = u2();
  const n = u2();
  const cp = new Array(n);
  for (let i = 1; i < n; i++) {
    const tag = u1();
    switch (tag) {
      case 1: { const len = u2(); cp[i] = { t: 1, v: buf.toString('utf8', p, p + len) }; p += len; break; }
      case 3: case 4: p += 4; cp[i] = { t: tag }; break;
      case 5: case 6: p += 8; cp[i] = { t: tag }; i++; break;
      case 7: cp[i] = { t: 7, n: u2() }; break;
      case 8: case 16: case 19: case 20: p += 2; cp[i] = { t: tag }; break;
      case 9: case 10: case 11: case 12: case 17: case 18: p += 4; cp[i] = { t: tag }; break;
      case 15: p += 3; cp[i] = { t: tag }; break;
      default: throw new Error('неизвестный тег пула констант ' + tag);
    }
  }
  const utf = (i) => (cp[i] ? cp[i].v : '');
  const cls = (i) => (cp[i] && cp[i].t === 7 ? utf(cp[i].n) : '');
  const access = u2(), thisC = cls(u2()), superIdx = u2(), superC = superIdx ? cls(superIdx) : '';
  const ifaces = [];
  for (let c = u2(), i = 0; i < c; i++) ifaces.push(cls(u2()));
  const attrs = (n0) => {
    const r = {};
    for (let i = 0; i < n0; i++) {
      const name = utf(u2()), len = u4(), start = p;
      if (name === 'Signature') r.sig = utf(buf.readUInt16BE(start));
      else if (name === 'Deprecated') r.dep = true;
      else if (name === 'Exceptions') { const c = buf.readUInt16BE(start); r.exc = []; for (let k = 0; k < c; k++) r.exc.push(cls(buf.readUInt16BE(start + 2 + k * 2))); }
      else if (name === 'MethodParameters') { const c = buf[start]; r.params = []; for (let k = 0; k < c; k++) r.params.push(utf(buf.readUInt16BE(start + 1 + k * 4))); }
      else if (name === 'PermittedSubclasses') { const c = buf.readUInt16BE(start); r.perm = []; for (let k = 0; k < c; k++) r.perm.push(cls(buf.readUInt16BE(start + 2 + k * 2))); }
      p = start + len;
    }
    return r;
  };
  const members = () => {
    const list = [];
    for (let c = u2(), i = 0; i < c; i++) {
      const acc = u2(), name = utf(u2()), desc = utf(u2());
      list.push({ acc, name, desc, ...attrs(u2()) });
    }
    return list;
  };
  const fields = members();
  const methods = members();
  const ca = attrs(u2());
  return { major, access, name: thisC, superName: superC, ifaces, fields, methods, ...ca };
}

// ---------- типы: дескрипторы и generic-сигнатуры ----------
const BASE = { B: 'byte', C: 'char', D: 'double', F: 'float', I: 'int', J: 'long', S: 'short', Z: 'boolean', V: 'void' };
const shortName = (internal) => { const s = internal.slice(internal.lastIndexOf('/') + 1); return s.replace(/\$/g, '.'); };

/** Разбор одного типа из строки (дескриптор или Signature) с позиции pos → {text, pos}. */
function readType(s, pos) {
  const c = s[pos];
  if (BASE[c]) return { text: BASE[c], pos: pos + 1 };
  if (c === '[') { const r = readType(s, pos + 1); return { text: r.text + '[]', pos: r.pos }; }
  if (c === 'T') { const e = s.indexOf(';', pos); return { text: s.slice(pos + 1, e), pos: e + 1 }; }
  if (c === 'L') {
    let i = pos + 1, text = '', name = '';
    while (i < s.length) {
      const ch = s[i];
      if (ch === ';') { text += shortName(name); return { text, pos: i + 1 }; }
      if (ch === '<') {
        text += shortName(name);
        name = '';
        const args = [];
        i++;
        while (s[i] !== '>') {
          if (s[i] === '*') { args.push('?'); i++; continue; }
          let prefix = '';
          if (s[i] === '+') { prefix = '? extends '; i++; } else if (s[i] === '-') { prefix = '? super '; i++; }
          const r = readType(s, i);
          args.push(prefix + r.text);
          i = r.pos;
        }
        text += '<' + args.join(', ') + '>';
        i++;
        continue;
      }
      if (ch === '.') { text += shortName(name) + '.'; name = ''; i++; continue; }
      name += ch;
      i++;
    }
  }
  return { text: '?', pos: pos + 1 };
}

function readTypeParams(s, pos) { // <T:Ljava/lang/Object;U::Ljava/lang/Comparable<TU;>;> → ['T', 'U extends Comparable<U>']
  const out = [];
  if (s[pos] !== '<') return { params: out, pos };
  pos++;
  while (s[pos] !== '>') {
    const colon = s.indexOf(':', pos);
    const name = s.slice(pos, colon);
    pos = colon;
    const bounds = [];
    while (s[pos] === ':') {
      pos++;
      if (s[pos] === ':') continue;
      const r = readType(s, pos);
      if (r.text !== 'Object') bounds.push(r.text);
      pos = r.pos;
    }
    out.push(bounds.length ? name + ' extends ' + bounds.join(' & ') : name);
  }
  return { params: out, pos: pos + 1 };
}

function methodSig(m, clsName, flags) {
  const src = m.sig || m.desc;
  const tp = readTypeParams(src, 0);
  let pos = tp.pos + 1; // после «(»
  const params = [];
  while (src[pos] !== ')') { const r = readType(src, pos); params.push(r.text); pos = r.pos; }
  const ret = readType(src, pos + 1).text;
  const varargs = (m.acc & 0x0080) !== 0;
  const names = m.params || [];
  const ptxt = params.map((t, i) => {
    let tt = t;
    if (varargs && i === params.length - 1 && tt.endsWith('[]')) tt = tt.slice(0, -2) + '...';
    const nm = names[i] && !/^arg\d+$/.test(names[i]) ? ' ' + names[i] : '';
    return tt + nm;
  });
  const mods = [];
  if (m.acc & 0x0008) mods.push('static');
  if (m.acc & 0x0400) mods.push('abstract');
  if (m.acc & 0x0010 && !flags.iface) mods.push('final');
  if (m.acc & 0x0020) mods.push('synchronized');
  const gen = tp.params.length ? '<' + tp.params.join(', ') + '> ' : '';
  const isCtor = m.name === '<init>';
  const head = (m.acc & 0x0004 ? 'protected ' : '') + mods.join(' ') + (mods.length ? ' ' : '');
  const exc = m.exc && m.exc.length ? ' throws ' + m.exc.map(shortName).join(', ') : '';
  return (m.dep ? '@Deprecated ' : '') + head + gen + (isCtor ? shortName(clsName) : ret + ' ' + m.name) + '(' + ptxt.join(', ') + ')' + exc;
}

/**
 * Читаемое описание класса: заголовок и публичные/protected члены.
 * @param {{member?: string, all?: boolean}} opts
 */
function describe(cf, opts) {
  const isIface = (cf.access & 0x0200) !== 0, isEnum = (cf.access & 0x4000) !== 0, isAnn = (cf.access & 0x2000) !== 0;
  const kind = isAnn ? '@interface' : isIface ? 'interface' : isEnum ? 'enum' : cf.record ? 'record' : 'class';
  let header = (cf.access & 0x0400 && !isIface ? 'abstract ' : '') + (cf.access & 0x0010 && !isEnum ? 'final ' : '') + kind + ' ' + shortName(cf.name);
  if (cf.sig) {
    const tp = readTypeParams(cf.sig, 0);
    let pos = tp.pos;
    if (tp.params.length) header += '<' + tp.params.join(', ') + '>';
    const sup = readType(cf.sig, pos); pos = sup.pos;
    const ifs = [];
    while (pos < cf.sig.length) { const r = readType(cf.sig, pos); ifs.push(r.text); pos = r.pos; }
    if (!isIface && sup.text !== 'Object' && !isEnum) header += ' extends ' + sup.text;
    if (ifs.length) header += (isIface ? ' extends ' : ' implements ') + ifs.join(', ');
  } else {
    if (!isIface && cf.superName && cf.superName !== 'java/lang/Object' && !isEnum) header += ' extends ' + shortName(cf.superName);
    if (cf.ifaces.length) header += (isIface ? ' extends ' : ' implements ') + cf.ifaces.map(shortName).join(', ');
  }
  if (cf.perm) header += ' permits ' + cf.perm.map(shortName).join(', ');
  const lines = [(cf.dep ? '@Deprecated ' : '') + header];
  const want = (acc) => (acc & 0x0001) || (acc & 0x0004) || opts.all;
  const q = opts.member ? opts.member.toLowerCase() : null;
  for (const f of cf.fields) {
    if (!want(f.acc) || (f.acc & 0x1000)) continue;
    if (q && f.name.toLowerCase() !== q) continue;
    const t = readType(f.sig || f.desc, 0).text;
    lines.push('  ' + (f.acc & 0x0008 ? 'static ' : '') + (f.acc & 0x0010 ? 'final ' : '') + t + ' ' + f.name);
  }
  for (const m of cf.methods) {
    if (!want(m.acc) || (m.acc & 0x1000) || (m.acc & 0x0040) || m.name === '<clinit>') continue;
    if (q && m.name.toLowerCase() !== q && !(q === shortName(cf.name).toLowerCase() && m.name === '<init>')) continue;
    lines.push('  ' + methodSig(m, cf.name, { iface: isIface }));
  }
  return lines;
}

module.exports = { findClass, parseClass, describe, zipEntries, jarIndex };
