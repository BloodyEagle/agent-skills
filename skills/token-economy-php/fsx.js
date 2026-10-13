'use strict';
// fsx.js — список файлов проекта, чтение и запись текста с сохранением кодировки (UTF-8 / windows-1251),
// BOM и переводов строк. Нужен, потому что многие сайты на Битриксе до сих пор в cp1251.

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const MAX_BYTES = 2 * 1024 * 1024;
const SKIP_DIRS = new Set(['.git', '.idea', '.vscode', 'node_modules', '.bx-cache', '.token-economy']);
// каталоги Битрикса со сгенерированным или не относящимся к коду содержимым (пути относительно корня сайта)
// vendor/ исключаем только в местах composer: имя «vendor» бывает пространством имён компонентов
const SKIP_PREFIXES = ['vendor/', 'local/vendor/', 'bitrix/vendor/', 'upload/', 'bitrix/cache/', 'bitrix/managed_cache/', 'bitrix/stack_cache/', 'bitrix/backup/', 'bitrix/updates/',
  'bitrix/tmp/', 'bitrix/html_pages/', 'bitrix/js/', 'bitrix/images/', 'bitrix/fonts/', 'bitrix/wizards/', 'bitrix/themes/', 'bitrix/gadgets/'];

const posix = (p) => String(p).replace(/\\/g, '/');

/**
 * Корень сайта (document root): текущая папка, если в ней есть bitrix/ или local/; иначе типичная вложенная папка.
 * @returns {string} путь относительно projectRoot ('' — сам projectRoot).
 */
function detectDocroot(projectRoot) {
  const has = (d) => fs.existsSync(path.join(projectRoot, d, 'bitrix')) || fs.existsSync(path.join(projectRoot, d, 'local'));
  if (has('')) return '';
  for (const d of ['www', 'public_html', 'httpdocs', 'web', 'public', 'htdocs', 'site', 'docroot']) if (has(d)) return d;
  return '';
}

/**
 * Файлы проекта (пути относительно projectRoot): git ls-files (учитывает .gitignore), иначе обход.
 */
function listFiles(projectRoot, docroot, exts) {
  let rel = null;
  try {
    const r = cp.spawnSync('git', ['-C', projectRoot, 'ls-files', '-co', '--exclude-standard', '-z'], { maxBuffer: 256 * 1024 * 1024 });
    if (r.status === 0) rel = r.stdout.toString('utf8').split('\0').filter(Boolean);
  } catch (e) { rel = null; }
  if (!rel) {
    rel = [];
    (function walk(dir) {
      let ents;
      try { ents = fs.readdirSync(path.join(projectRoot, dir), { withFileTypes: true }); } catch (e) { return; }
      for (const e of ents) {
        const p = dir ? dir + '/' + e.name : e.name;
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
    if (SKIP_PREFIXES.some((s) => inRoot.startsWith(s))) continue;
    let st;
    try { st = fs.statSync(path.join(projectRoot, f)); } catch (e) { continue; }
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
 * Читает файл и определяет кодировку: UTF-8 (в т.ч. чистый ASCII) либо windows-1251.
 * @returns {{text: string, enc: 'utf8'|'ascii'|'cp1251', bom: boolean, eol: 'crlf'|'lf'}}
 */
function readText(abs) {
  const buf = fs.readFileSync(abs);
  let bom = false, body = buf;
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) { bom = true; body = buf.subarray(3); }
  let ascii = true;
  for (let i = 0; i < body.length; i++) if (body[i] > 127) { ascii = false; break; }
  let text, enc;
  if (ascii) { text = body.toString('latin1'); enc = 'ascii'; }
  else {
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(body); enc = 'utf8'; }
    catch (e) { text = cp1251().decode(body); enc = 'cp1251'; }
  }
  const crlf = (text.match(/\r\n/g) || []).length, lf = (text.match(/(?<!\r)\n/g) || []).length;
  return { text, enc, bom, eol: crlf > lf ? 'crlf' : 'lf' };
}

/**
 * Кодирует текст обратно в исходную кодировку; символ вне cp1251 — ошибка (файл не портим).
 */
function encodeText(text, enc, bom) {
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
  } else body = Buffer.from(text, 'utf8');
  return bom ? Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), body]) : body;
}

function writeAtomic(abs, buf) {
  const tmp = abs + '.bxtmp';
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, abs);
}

module.exports = { posix, detectDocroot, listFiles, readText, encodeText, writeAtomic, MAX_BYTES };
