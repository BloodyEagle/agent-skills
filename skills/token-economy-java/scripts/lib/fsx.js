'use strict';
// fsx.js — список файлов проекта, чтение и запись текста с сохранением кодировки (UTF-8 / windows-1251),
// BOM и переводов строк. Нужен для проектов, где часть файлов осталась не в UTF-8.

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const MAX_BYTES = 2 * 1024 * 1024;
// сборочные и служебные каталоги, где нет исходников проекта
const SKIP_DIRS = new Set(['.git', '.idea', '.vscode', '.gradle', '.mvn', 'node_modules', '.jv-cache', '.settings', '.token-economy']);
// каталоги сборки пропускаем только вне src/: пакет Java может называться build, out, target или bin
const BUILD_DIRS = new Set(['target', 'build', 'out', 'bin']);
const skipSegments = (segs) => {
  for (const seg of segs) {
    if (seg === 'src') return false;
    if (SKIP_DIRS.has(seg) || BUILD_DIRS.has(seg)) return true;
  }
  return false;
};

const posix = (p) => String(p).replace(/\\/g, '/');

/**
 * Файлы проекта (пути относительно root): git ls-files (учитывает .gitignore), иначе обход каталогов.
 * @param {string[]} exts - расширения в нижнем регистре, например ['.java'].
 */
function listFiles(root, exts) {
  let rel = null;
  try {
    const r = cp.spawnSync('git', ['-C', root, 'ls-files', '-co', '--exclude-standard', '-z'], { maxBuffer: 256 * 1024 * 1024 });
    if (r.status === 0) rel = r.stdout.toString('utf8').split('\0').filter(Boolean);
  } catch (e) { rel = null; }
  if (!rel) {
    rel = [];
    (function walk(dir) {
      let ents;
      try { ents = fs.readdirSync(path.join(root, dir), { withFileTypes: true }); } catch (e) { return; }
      for (const e of ents) {
        const p = dir ? dir + '/' + e.name : e.name;
        if (e.isDirectory()) { if (!skipSegments(p.split('/'))) walk(p); } else rel.push(p);
      }
    })('');
  }
  const out = [];
  for (const f0 of rel) {
    const f = posix(f0);
    if (exts && !exts.some((e) => f.toLowerCase().endsWith(e))) continue;
    if (skipSegments(f.split('/').slice(0, -1)) || f.split('/').slice(0, -1).some((seg) => SKIP_DIRS.has(seg))) continue;
    let st;
    try { st = fs.statSync(path.join(root, f)); } catch (e) { continue; }
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

module.exports = { posix, listFiles, readText, encodeText, writeAtomic, MAX_BYTES, SKIP_DIRS };
