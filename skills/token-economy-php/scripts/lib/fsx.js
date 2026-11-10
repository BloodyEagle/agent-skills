'use strict';
// fsx.js — список файлов проекта, чтение и запись текста с сохранением UTF-8 / windows-1251 / UTF-16LE/BE,
// BOM и переводов строк. Нужен, потому что многие сайты на Битриксе до сих пор в cp1251.

const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');

const MAX_BYTES = 2 * 1024 * 1024;
const SKIP_DIRS = new Set(['.git', '.idea', '.vscode', 'node_modules', '.bx-cache', '.token-economy']);
// служебные каталоги со сгенерированным или не относящимся к коду содержимым — по режиму проекта
// (пути относительно корня индексации: docroot в Битриксе, корень проекта в остальных режимах).
// vendor/ исключаем только в местах composer: имя «vendor» бывает пространством имён компонентов.
const SKIP_PREFIXES = {
  bitrix: ['vendor/', 'local/vendor/', 'bitrix/vendor/', 'upload/', 'bitrix/cache/', 'bitrix/managed_cache/', 'bitrix/stack_cache/', 'bitrix/backup/', 'bitrix/updates/',
    'bitrix/tmp/', 'bitrix/html_pages/', 'bitrix/js/', 'bitrix/images/', 'bitrix/fonts/', 'bitrix/wizards/', 'bitrix/themes/', 'bitrix/gadgets/'],
  laravel: ['vendor/', 'storage/', 'bootstrap/cache/'],
  generic: ['vendor/'],
  modx: ['vendor/', 'core/vendor/', 'core/cache/', 'core/packages/', 'setup/'],
};

const posix = (p) => String(p).replace(/\\/g, '/');
const inside = (root, abs) => { const rel = path.relative(root, abs); return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); };

/** Путь внутри корня после разрешения ссылок, в том числе у ещё не созданного файла. */
function safePath(root, rel) {
  const abs = path.resolve(root, rel);
  const realRoot = fs.realpathSync(root);
  if (!inside(path.resolve(root), abs) && !inside(realRoot, abs)) throw new Error('путь вне рабочей директории: ' + rel);
  let parent = abs;
  const rest = [];
  for (;;) {
    try {
      const real = path.resolve(fs.realpathSync(parent), ...rest);
      if (!inside(realRoot, real)) throw new Error('путь вне рабочей директории: ' + rel);
      return real;
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      // realpath не разрешил существующую ссылку: нельзя принимать её за новый каталог.
      let st;
      try { st = fs.lstatSync(parent); } catch (err) { if (err.code !== 'ENOENT') throw err; }
      if (st) throw new Error('не удалось разрешить путь: ' + rel);
      const next = path.dirname(parent);
      if (next === parent) throw e;
      rest.unshift(path.basename(parent));
      parent = next;
    }
  }
}

// типичные docroot-каталоги битрикс-деплоя
const DOCROOTS = ['www', 'public_html', 'httpdocs', 'web', 'public', 'htdocs', 'site', 'docroot'];
// bitrix/ и local/ считаются маркерами только с типичными подкаталогами.
const BITRIX_LOCAL_SUBDIRS = ['components', 'templates', 'modules', 'php_interface'];

const isDirAt = (p, name) => { try { return fs.statSync(path.join(p, name)).isDirectory(); } catch (e) { return false; } };

/**
 * Маркер Битрикса в каталоге dir ('' — сам projectRoot): bitrix/ или local/
 * с одним из типичных подкаталогов (components, templates, modules, php_interface).
 * @returns {boolean}
 */
function bitrixMarkerAt(projectRoot, dir) {
  const base = dir ? path.join(projectRoot, dir) : projectRoot;
  if (BITRIX_LOCAL_SUBDIRS.some((s) => isDirAt(path.join(base, 'bitrix'), s))) return true;
  if (isDirAt(base, 'local')) return BITRIX_LOCAL_SUBDIRS.some((s) => isDirAt(path.join(base, 'local'), s));
  return false;
}

/**
 * Корень сайта (document root): текущая папка, если в ней есть маркер Битрикса
 * (bitrix/ или подтверждённый local/); иначе типичная вложенная папка.
 * @returns {string} путь относительно projectRoot ('' — сам projectRoot).
 */
function detectDocroot(projectRoot) {
  if (bitrixMarkerAt(projectRoot, '')) return '';
  for (const d of DOCROOTS) if (bitrixMarkerAt(projectRoot, d)) return d;
  return '';
}

/**
 * Файлы проекта (пути относительно projectRoot): git ls-files (учитывает .gitignore), иначе обход.
 * mode — режим проекта (bitrix | laravel | generic | modx): выбирает список skip-префиксов.
 */
function listFiles(projectRoot, docroot, exts, mode) {
  const prefixes = SKIP_PREFIXES[mode] || SKIP_PREFIXES.generic;
  let rel = null;
  try {
    const r = cp.spawnSync('git', ['-C', projectRoot, 'ls-files', '-co', '--exclude-standard', '-z'], { maxBuffer: 256 * 1024 * 1024 });
    if (r.status === 0) rel = r.stdout.toString('utf8').split('\0').filter(Boolean);
  } catch (e) { rel = null; }
  if (!rel || !rel.length) { // git недоступен, проект вне репозитория — или все файлы под .gitignore: идём обходом
    rel = [];
    (function walk(dir) {
      let ents;
      try { ents = fs.readdirSync(path.join(projectRoot, dir), { withFileTypes: true }); } catch (e) { return; }
      for (const e of ents) {
        const p = dir ? dir + '/' + e.name : e.name;
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p); } else rel.push(p);
      }
    })('');
  }
  const out = [];
  const prefix = docroot ? docroot + '/' : '';
  for (const f0 of rel) {
    const f = posix(f0);
    if (exts && !exts.some((e) => f.toLowerCase().endsWith(e))) continue;
    if (f.split('/').some((seg) => SKIP_DIRS.has(seg))) continue;
    const inRoot = prefix ? (f.startsWith(prefix) ? f.slice(prefix.length) : null) : f;
    if (inRoot === null && docroot) continue;
    if (prefixes.some((s) => inRoot.startsWith(s))) continue;
    let st;
    try { st = fs.statSync(safePath(projectRoot, f)); } catch (e) { continue; }
    if (st.isFile() && st.size <= MAX_BYTES) out.push(f);
  }
  return out.sort();
}

// ---------- кодировки ----------
let cp1251Dec = null, cp1251Enc = null;
function cp1251() {
  if (!cp1251Dec) {
    cp1251Dec = new TextDecoder('windows-1251');
    cp1251Enc = new Map();
    for (let b = 0; b < 256; b++) cp1251Enc.set(cp1251Dec.decode(Uint8Array.of(b)), b);
  }
  return cp1251Dec;
}

/**
 * Читает UTF-16LE/BE по BOM, затем UTF-8 (в т.ч. ASCII), иначе windows-1251.
 * @returns {{text: string, enc: 'utf8'|'ascii'|'cp1251'|'utf16le'|'utf16be', bom: boolean, eol: 'crlf'|'lf'}}
 */
function readText(abs) {
  const buf = fs.readFileSync(abs);
  let bom = false, body = buf, text, enc;
  if (buf.length >= 2 && ((buf[0] === 0xFF && buf[1] === 0xFE) || (buf[0] === 0xFE && buf[1] === 0xFF))) {
    bom = true;
    enc = buf[0] === 0xFF ? 'utf16le' : 'utf16be';
    try { text = new TextDecoder(enc === 'utf16le' ? 'utf-16le' : 'utf-16be', { fatal: true, ignoreBOM: true }).decode(buf.subarray(2)); }
    catch (e) { throw new Error('некорректный UTF-16: ' + abs); }
  } else {
    if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) { bom = true; body = buf.subarray(3); }
    let ascii = true;
    for (let i = 0; i < body.length; i++) if (body[i] > 127) { ascii = false; break; }
    if (ascii) { text = body.toString('latin1'); enc = 'ascii'; }
    else {
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body); enc = 'utf8'; }
      catch (e) { text = cp1251().decode(body); enc = 'cp1251'; }
    }
  }
  const crlf = (text.match(/\r\n/g) || []).length, lf = (text.match(/(?<!\r)\n/g) || []).length;
  return { text, enc, bom, eol: crlf > lf ? 'crlf' : 'lf' };
}

/**
 * Кодирует текст обратно в исходную кодировку; символ вне cp1251 — ошибка (файл не портим).
 */
function encodeText(text, enc, bom) {
  enc = String(enc).toLowerCase().replace(/-/g, '');
  if (enc === 'utf16le' || enc === 'utf16be') {
    const body = Buffer.from(text, 'utf16le');
    if (enc === 'utf16be') body.swap16();
    return bom ? Buffer.concat([Buffer.from(enc === 'utf16be' ? [0xFE, 0xFF] : [0xFF, 0xFE]), body]) : body;
  }
  let body;
  if (enc === 'cp1251') {
    cp1251();
    const bytes = [];
    for (const ch of text) { // по символам Unicode, а не по половинкам суррогатных пар
      const b = cp1251Enc.get(ch);
      if (b === undefined) throw new Error('символ «' + ch + '» (U+' + ch.codePointAt(0).toString(16).toUpperCase() + ') нельзя записать в cp1251');
      bytes.push(b);
    }
    body = Buffer.from(bytes);
  } else if (enc === 'utf8' || enc === 'ascii') body = Buffer.from(text, 'utf8');
  else throw new Error('неподдерживаемая кодировка: ' + enc);
  return bom ? Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), body]) : body;
}

function writeAtomic(abs, buf, opts = {}) {
  if (opts.root) abs = safePath(opts.root, abs);
  // wx защищает от подложенного tmp; nonce разделяет параллельные запуски и записи в одном процессе.
  const tmp = abs + '.' + process.pid + '.' + crypto.randomBytes(12).toString('hex') + '.bxtmp';
  let owned = false;
  try {
    const fd = fs.openSync(tmp, 'wx');
    owned = true;
    try { fs.writeFileSync(fd, buf); } finally { fs.closeSync(fd); }
    if (opts.root) safePath(opts.root, abs);
    if (opts.create) fs.linkSync(tmp, abs); // атомарно не перезаписывает появившийся файл
    else fs.renameSync(tmp, abs);
  } finally {
    if (owned) { try { fs.unlinkSync(tmp); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
  }
}

module.exports = { posix, safePath, detectDocroot, bitrixMarkerAt, DOCROOTS, listFiles, readText, encodeText, writeAtomic, MAX_BYTES, SKIP_PREFIXES };
