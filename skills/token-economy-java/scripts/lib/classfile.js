'use strict';
// classfile.js — сигнатуры классов библиотек без JDK и без декомпиляции: поиск jar в локальных репозиториях
// (Maven ~/.m2, Gradle ~/.gradle, каталоги из JV_JARS), чтение .class из архива и разбор членов класса.
// Код библиотек не исполняется.

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { safePath, writeAtomic } = require('./fsx');

// ---------- zip ----------
const MAX_DIRECTORY_BYTES = 64 * 1024 * 1024;
const MAX_CLASS_BYTES = 16 * 1024 * 1024;
const zipError = (reason) => { throw new Error('некорректный jar/ZIP: ' + reason); };
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let bit = 0; bit < 8; bit++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0);
  return n >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const b of bytes) crc = CRC_TABLE[(crc ^ b) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function readAt(fd, size, off, len) {
  if (!Number.isSafeInteger(off) || !Number.isSafeInteger(len) || off < 0 || len < 0 || off > size || len > size - off) zipError('данные за границей файла');
  const buf = Buffer.alloc(len);
  let done = 0;
  while (done < len) {
    const n = fs.readSync(fd, buf, done, len - done, off + done);
    if (!n) zipError('обрезанные данные');
    done += n;
  }
  return buf;
}

/**
 * Центральный каталог jar: [{name, method, csize, usize, off, flags, crc, end}].
 */
function zipEntries(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size < 22) zipError('нет EOCD');
    const len = Math.min(size, 65557), tail = readAt(fd, size, size - len, len);
    let e = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { e = i; break; }
    }
    if (e < 0) zipError('не найден EOCD или обрезан комментарий');
    const count = tail.readUInt16LE(e + 10), cdSize = tail.readUInt32LE(e + 12), cdOff = tail.readUInt32LE(e + 16);
    if (tail.readUInt16LE(e + 4) || tail.readUInt16LE(e + 6) || tail.readUInt16LE(e + 8) !== count) zipError('многотомные архивы не поддерживаются');
    if (count === 0xffff || cdOff === 0xffffffff || cdSize === 0xffffffff) zipError('ZIP64 не поддерживается');
    const end = size - tail.length + e;
    if (cdOff > end || cdSize !== end - cdOff || count * 46 > cdSize) zipError('неверные границы центрального каталога');
    if (cdSize > MAX_DIRECTORY_BYTES) zipError('центральный каталог больше 64 MiB');
    const cd = readAt(fd, size, cdOff, cdSize), out = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) zipError('обрезанная запись центрального каталога');
      const flags = cd.readUInt16LE(p + 8), method = cd.readUInt16LE(p + 10), crc = cd.readUInt32LE(p + 16);
      const csize = cd.readUInt32LE(p + 20), usize = cd.readUInt32LE(p + 24);
      const nl = cd.readUInt16LE(p + 28), el = cd.readUInt16LE(p + 30), cl = cd.readUInt16LE(p + 32), off = cd.readUInt32LE(p + 42);
      const next = p + 46 + nl + el + cl;
      if (next > cd.length || off > cdOff - 30 || csize > cdOff - off - 30) zipError('запись выходит за границы архива');
      if (cd.readUInt16LE(p + 34) || csize === 0xffffffff || usize === 0xffffffff) zipError('ZIP64/многотомная запись не поддерживается');
      out.push({ name: cd.toString('utf8', p + 46, p + 46 + nl), method, csize, usize, off, flags, crc, end: cdOff });
      p = next;
    }
    if (p !== cd.length) zipError('лишние данные в центральном каталоге');
    return out;
  } finally { fs.closeSync(fd); }
}

function zipRead(file, entry) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size, end = Math.min(size, entry.end);
    if (entry.flags & 1) zipError('зашифрованная запись не поддерживается');
    if (entry.method !== 0 && entry.method !== 8) zipError('неподдерживаемый метод сжатия ' + entry.method);
    if (entry.csize > MAX_CLASS_BYTES || entry.usize > MAX_CLASS_BYTES) zipError('class-файл больше 16 MiB');
    const h = readAt(fd, end, entry.off, 30);
    if (h.readUInt32LE(0) !== 0x04034b50 || h.readUInt16LE(6) !== entry.flags || h.readUInt16LE(8) !== entry.method) zipError('неверный локальный заголовок');
    const nl = h.readUInt16LE(26), el = h.readUInt16LE(28);
    const name = readAt(fd, end, entry.off + 30, nl).toString('utf8');
    if (name !== entry.name) zipError('имя локальной записи не совпадает с каталогом');
    if (!(entry.flags & 8) && (h.readUInt32LE(14) !== entry.crc || h.readUInt32LE(18) !== entry.csize || h.readUInt32LE(22) !== entry.usize)) zipError('размеры локальной записи не совпадают с каталогом');
    const data = readAt(fd, end, entry.off + 30 + nl + el, entry.csize);
    let bytes;
    try { bytes = entry.method === 0 ? data : zlib.inflateRawSync(data, { maxOutputLength: MAX_CLASS_BYTES }); }
    catch (e) { zipError('повреждённые сжатые данные или превышен предел 16 MiB'); }
    if (bytes.length !== entry.usize) zipError('неверный распакованный размер');
    if (crc32(bytes) !== entry.crc) zipError('не совпадает CRC32');
    return bytes;
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
  const cacheFile = safePath(root, path.join('.jv-cache', 'jars.json'));
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch (e) { cache = {}; }
  if (!cache || typeof cache !== 'object' || Array.isArray(cache)) cache = {};
  const jars = [];
  for (const r of jarRoots(root, extra)) collectJars(r, jars, 0);
  const fresh = {};
  let changed = false, warnings = 0;
  const warn = (j, reason) => { if (warnings++ < 5) console.error('Предупреждение: пропущен ' + path.basename(j) + ': ' + reason); };
  for (const j of jars) {
    let st;
    try { st = fs.statSync(j); } catch (e) { continue; }
    const c = cache[j];
    if (c && c.m === st.mtimeMs && c.s === st.size && Array.isArray(c.pkgs) && c.pkgs.every((p) => typeof p === 'string') && c.pkgs.length) { fresh[j] = c; continue; }
    let pkgs = [], error;
    try {
      const set = new Set();
      for (const en of zipEntries(j)) if (en.name.endsWith('.class')) { const i = en.name.lastIndexOf('/'); set.add(i < 0 ? '' : en.name.slice(0, i)); }
      pkgs = [...set];
    } catch (e) { error = e.message; warn(j, error); }
    fresh[j] = { m: st.mtimeMs, s: st.size, pkgs, ...(error ? { error } : {}) };
    changed = true;
  }
  if (changed || Object.keys(cache).length !== Object.keys(fresh).length) {
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      const gi = safePath(root, path.join(path.dirname(cacheFile), '.gitignore'));
      if (!fs.existsSync(gi)) writeAtomic(gi, '*\n');
      writeAtomic(cacheFile, JSON.stringify(fresh));
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
  let firstError = null, warnings = 0;
  const failed = (file, e) => {
    if (!firstError) firstError = path.basename(file) + ': ' + e.message;
    if (warnings++ < 5) console.error('Предупреждение: пропущен ' + path.basename(file) + ': ' + e.message);
  };
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
      if (en) {
        const bytes = zipRead(h.jar, en);
        describe(parseClass(bytes), { all: true }); // плохая Signature не должна блокировать следующую версию
        return { jar: h.jar, bytes, others: hits.filter((x) => x !== h).map((x) => x.jar) };
      }
    } catch (e) { failed(h.jar, e); }
  }
  // каталоги с классами проекта
  for (const d of [path.join(root, 'target', 'classes'), path.join(root, 'build', 'classes', 'java', 'main')]) {
    for (let cut = parts.length - 1; cut >= 1; cut--) {
      const f = path.join(d, ...parts.slice(0, cut), parts.slice(cut).join('$') + '.class');
      if (!fs.existsSync(f)) continue;
      try {
        safePath(root, f);
        if (fs.statSync(f).size > MAX_CLASS_BYTES) throw new Error('class-файл больше 16 MiB');
        const bytes = fs.readFileSync(f);
        describe(parseClass(bytes), { all: true });
        return { jar: path.relative(root, d), bytes, others: [] };
      } catch (e) { failed(f, e); }
    }
  }
  if (firstError) throw new Error('не удалось разобрать class-файл ' + fqn + ': ' + firstError);
  return null;
}

// ---------- разбор class-файла ----------
function parseClass(buf) {
  const bad = (reason) => { throw new Error('некорректный class-файл: ' + reason); };
  if (!Buffer.isBuffer(buf)) bad('ожидается буфер');
  let p = 0;
  const need = (len) => { if (len > buf.length - p) bad('обрезанные данные на позиции ' + p); };
  const skip = (len) => { need(len); p += len; };
  const u1 = () => { need(1); return buf[p++]; };
  const u2 = () => { need(2); const v = buf.readUInt16BE(p); p += 2; return v; };
  const u4 = () => { need(4); const v = buf.readUInt32BE(p); p += 4; return v; };
  if (u4() !== 0xCAFEBABE) bad('неверная magic-последовательность');
  u2(); const major = u2();
  const n = u2();
  if (!n) bad('пустой пул констант');
  const cp = new Array(n);
  for (let i = 1; i < n; i++) {
    const tag = u1();
    switch (tag) {
      case 1: { const len = u2(); need(len); cp[i] = { t: 1, v: buf.toString('utf8', p, p + len) }; p += len; break; }
      case 3: case 4: skip(4); cp[i] = { t: tag }; break;
      case 5: case 6: if (i + 1 >= n) bad('нет второго слота long/double'); skip(8); cp[i] = { t: tag }; i++; break;
      case 7: cp[i] = { t: 7, n: u2() }; break;
      case 8: case 16: case 19: case 20: skip(2); cp[i] = { t: tag }; break;
      case 9: case 10: case 11: case 12: case 17: case 18: skip(4); cp[i] = { t: tag }; break;
      case 15: skip(3); cp[i] = { t: tag }; break;
      default: bad('неизвестный тег пула констант ' + tag);
    }
  }
  const utf = (i) => { if (!cp[i] || cp[i].t !== 1) bad('неверная UTF-8 ссылка #' + i); return cp[i].v; };
  const cls = (i) => { if (!cp[i] || cp[i].t !== 7) bad('неверная ссылка на класс #' + i); return utf(cp[i].n); };
  const access = u2(), thisC = cls(u2()), superIdx = u2(), superC = superIdx ? cls(superIdx) : '';
  const ifaces = [];
  for (let c = u2(), i = 0; i < c; i++) ifaces.push(cls(u2()));
  const attrs = (n0) => {
    const r = {};
    for (let i = 0; i < n0; i++) {
      const name = utf(u2()), len = u4(), start = p;
      need(len);
      const size = (expected) => { if (len !== expected) bad('неверная длина атрибута ' + name); };
      if (name === 'Signature') { size(2); r.sig = utf(u2()); }
      else if (name === 'Deprecated') { size(0); r.dep = true; }
      else if (name === 'Exceptions' || name === 'PermittedSubclasses') {
        if (len < 2) bad('обрезанный атрибут ' + name);
        const c = u2(); size(2 + c * 2);
        const list = [];
        for (let k = 0; k < c; k++) list.push(cls(u2()));
        r[name === 'Exceptions' ? 'exc' : 'perm'] = list;
      } else if (name === 'MethodParameters') {
        if (len < 1) bad('обрезанный атрибут ' + name);
        const c = u1(); size(1 + c * 4); r.params = [];
        for (let k = 0; k < c; k++) { const ni = u2(); r.params.push(ni ? utf(ni) : ''); u2(); }
      }
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
  if (p !== buf.length) bad('лишние данные после атрибутов класса');
  return { major, access, name: thisC, superName: superC, ifaces, fields, methods, ...ca };
}

// ---------- типы: дескрипторы и generic-сигнатуры ----------
const BASE = { B: 'byte', C: 'char', D: 'double', F: 'float', I: 'int', J: 'long', S: 'short', Z: 'boolean', V: 'void' };
const shortName = (internal) => { const s = internal.slice(internal.lastIndexOf('/') + 1); return s.replace(/\$/g, '.'); };

function signatureError(pos, reason) {
  throw new Error('некорректная сигнатура Signature на позиции ' + pos + ': ' + reason);
}

const typeName = (s) => s.length > 0 && !/[.;\[<>:\s()^]/.test(s) && s.split('/').every(Boolean);

/** Разбор одного типа из строки (дескриптор или Signature) с позиции pos → {text, pos, kind}. */
function readType(s, pos, depth = 0) {
  if (typeof s !== 'string' || pos >= s.length) signatureError(pos, 'ожидается тип, строка оборвана');
  if (depth > 128) signatureError(pos, 'слишком глубокая вложенность типов (предел 128)');
  const c = s[pos];
  if (BASE[c]) return { text: BASE[c], pos: pos + 1, kind: c };
  if (c === '[') {
    let end = pos;
    while (s[end] === '[') end++;
    if (end - pos > 255) signatureError(pos, 'больше 255 измерений массива');
    const r = readType(s, end, depth + 1);
    if (r.kind === 'V') signatureError(end, 'массив void недопустим');
    return { text: r.text + '[]'.repeat(end - pos), pos: r.pos, kind: c };
  }
  if (c === 'T') {
    const end = s.indexOf(';', pos + 1), name = s.slice(pos + 1, end);
    if (end < 0) signatureError(pos, 'не закрыта переменная типа: ожидается «;»');
    if (!typeName(name) || name.includes('/')) signatureError(pos, 'неверное имя переменной типа');
    return { text: name, pos: end + 1, kind: c };
  }
  if (c !== 'L') signatureError(pos, 'ожидается тип');
  let i = pos + 1, text = '';
  for (;;) {
    const start = i;
    while (i < s.length && s[i] !== '<' && s[i] !== ';' && s[i] !== '.') i++;
    const name = s.slice(start, i);
    if (!typeName(name) || (text && name.includes('/'))) signatureError(start, 'неверное имя класса');
    text += shortName(name);
    if (s[i] === '<') {
      const args = [];
      i++;
      if (s[i] === '>') signatureError(i, 'пустой список аргументов типа');
      while (s[i] !== '>') {
        if (i >= s.length) signatureError(i, 'не закрыты аргументы типа: ожидается «>»');
        if (s[i] === '*') { args.push('?'); i++; continue; }
        let prefix = '';
        if (s[i] === '+') { prefix = '? extends '; i++; } else if (s[i] === '-') { prefix = '? super '; i++; }
        const r = readType(s, i, depth + 1);
        if (!['L', 'T', '['].includes(r.kind)) signatureError(i, 'аргумент должен быть ссылочным типом');
        args.push(prefix + r.text);
        i = r.pos;
      }
      text += '<' + args.join(', ') + '>';
      i++;
    }
    if (s[i] === ';') return { text, pos: i + 1, kind: c };
    if (s[i] !== '.') signatureError(i, 'не закрыт класс: ожидается «;»');
    text += '.';
    i++;
  }
}

function readTypeParams(s, pos) { // <T:Ljava/lang/Object;U::Ljava/lang/Comparable<TU;>;> → ['T', 'U extends Comparable<U>']
  const out = [];
  if (s[pos] !== '<') return { params: out, pos };
  pos++;
  if (s[pos] === '>') signatureError(pos, 'пустой список параметров типа');
  while (s[pos] !== '>') {
    if (pos >= s.length) signatureError(pos, 'не закрыты параметры типа');
    const colon = s.indexOf(':', pos), name = s.slice(pos, colon);
    if (colon <= pos || !typeName(name) || name.includes('/')) signatureError(pos, 'ожидается имя параметра и «:»');
    pos = colon + 1;
    const bounds = [];
    // ClassBound может быть пустым, в том числе перед следующим параметром.
    const nextColon = s.indexOf(':', pos), nextEnd = s.indexOf(';', pos);
    const nextParam = nextColon >= pos && (nextEnd < 0 || nextColon < nextEnd);
    if (['L', 'T', '['].includes(s[pos]) && !nextParam) {
      const r = readType(s, pos);
      if (r.text !== 'Object') bounds.push(r.text);
      pos = r.pos;
    }
    while (s[pos] === ':') {
      const r = readType(s, ++pos);
      if (!['L', 'T', '['].includes(r.kind)) signatureError(pos, 'граница должна быть ссылочным типом');
      if (r.text !== 'Object') bounds.push(r.text);
      pos = r.pos;
    }
    out.push(bounds.length ? name + ' extends ' + bounds.join(' & ') : name);
  }
  return { params: out, pos: pos + 1 };
}

function methodSig(m, clsName, flags) {
  const src = m.sig !== undefined ? m.sig : m.desc;
  const tp = readTypeParams(src, 0);
  if (src[tp.pos] !== '(') signatureError(tp.pos, 'ожидается «(» метода');
  let pos = tp.pos + 1;
  const params = [];
  while (src[pos] !== ')') {
    const r = readType(src, pos);
    if (r.kind === 'V') signatureError(pos, 'параметр void недопустим');
    params.push(r.text);
    pos = r.pos;
  }
  const result = readType(src, pos + 1), ret = result.text;
  pos = result.pos;
  const thrown = [];
  while (src[pos] === '^' && m.sig !== undefined) {
    const r = readType(src, ++pos);
    if (r.kind !== 'L' && r.kind !== 'T') signatureError(pos, 'throws требует класс или переменную типа');
    thrown.push(r.text);
    pos = r.pos;
  }
  if (pos !== src.length) signatureError(pos, 'лишние данные после метода');
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
  const exceptions = thrown.length ? thrown : (m.exc || []).map(shortName);
  const exc = exceptions.length ? ' throws ' + exceptions.join(', ') : '';
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
  if (cf.sig !== undefined) {
    const tp = readTypeParams(cf.sig, 0);
    let pos = tp.pos;
    if (tp.params.length) header += '<' + tp.params.join(', ') + '>';
    const sup = readType(cf.sig, pos);
    if (sup.kind !== 'L') signatureError(pos, 'родитель должен быть классом');
    pos = sup.pos;
    const ifs = [];
    while (pos < cf.sig.length) {
      const r = readType(cf.sig, pos);
      if (r.kind !== 'L') signatureError(pos, 'интерфейс должен быть классом');
      ifs.push(r.text);
      pos = r.pos;
    }
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
    const src = f.sig !== undefined ? f.sig : f.desc, r = readType(src, 0);
    if (r.pos !== src.length || r.kind === 'V' || (f.sig !== undefined && !['L', 'T', '['].includes(r.kind))) signatureError(r.pos, 'неверный тип поля или лишние данные');
    const t = r.text;
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
