#!/usr/bin/env node
'use strict';
/*
 * token-economy-kt — экономия токенов в проектах на Kotlin / Android.
 * Индексный анализ исходников без чтения файлов целиком: навигация, граф связей,
 * манифест, Compose-функции, ресурсы, ViewBinding, сигнатуры из jar/aar.
 * Только стандартная библиотека Node.js, без зависимостей.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');

const VERSION = '1.1.0';
const CACHE_DIR = '.kt-cache';
const SKIP_DIRS = new Set(['.git', '.gradle', 'build', 'out', '.idea', '.kotlin', '.kilo', 'node_modules', CACHE_DIR, '.jv-cache']);
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.jar', '.aar', '.class', '.zip', '.apk', '.aab', '.so', '.ttf', '.otf', '.bin', '.jks', '.keystore', '.prof', '.wav', '.mp3', '.mp4', '.webm']);

// ---------- кодировки ----------

const dec1251 = (() => { try { return new TextDecoder('windows-1251'); } catch (e) { return null; } })();

function decodeCp1251(buf) {
  if (dec1251) return dec1251.decode(buf);
  let s = '';
  for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
  return s;
}

const enc1251map = (() => {
  try {
    const bytes = Buffer.alloc(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    const decoded = decodeCp1251(bytes);
    const m = new Map();
    for (let i = 0; i < 256; i++) if (!m.has(decoded[i])) m.set(decoded[i], i);
    return m;
  } catch (e) { return null; }
})();

function encodeCp1251(str) {
  const bytes = [];
  for (const ch of str) {
    const b = enc1251map ? enc1251map.get(ch) : undefined;
    bytes.push(b === undefined ? 63 : b);
  }
  return Buffer.from(bytes);
}

function isValidUtf8(buf) {
  const n = buf.length;
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (b < 0x80) continue;
    let need = 0;
    if ((b & 0xE0) === 0xC0) need = 1;
    else if ((b & 0xF0) === 0xE0) need = 2;
    else if ((b & 0xF8) === 0xF0) need = 3;
    else return false;
    if (i + need >= n) return false;
    for (let j = 1; j <= need; j++) if ((buf[i + j] & 0xC0) !== 0x80) return false;
    i += need;
  }
  return true;
}

// Чтение файла с определением кодировки, BOM и перевода строк.
function readSmart(fp) {
  const buf = fs.readFileSync(fp);
  let enc = 'utf-8', bom = false, start = 0;
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) { enc = 'utf-8'; bom = true; start = 3; }
  else if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) { enc = 'utf-16le'; bom = true; start = 2; }
  else if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) { enc = 'utf-16be'; bom = true; start = 2; }
  else if (!isValidUtf8(buf)) enc = 'cp1251';
  let text;
  if (enc === 'utf-8') text = buf.slice(start).toString('utf8');
  else if (enc === 'cp1251') text = decodeCp1251(buf);
  else if (enc === 'utf-16le') text = buf.slice(start).toString('utf16le');
  else {
    const swapped = Buffer.from(buf.slice(start));
    swapped.swap16();
    text = swapped.toString('utf16le');
  }
  if (bom && text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/(?<!\r)\n/g) || []).length;
  return { buf, text, enc, bom, eol: crlf > lf ? 'crlf' : 'lf', lines: text.split('\n').length };
}

// ---------- аргументы командной строки ----------

function parseArgs(argv) {
  const p = {};
  for (const a of argv) {
    if (a.startsWith('@')) {
      const fp = path.resolve(a.slice(1));
      Object.assign(p, JSON.parse(fs.readFileSync(fp, 'utf8')));
      continue;
    }
    const eq = a.indexOf('=');
    if (eq < 0) { p[a] = true; continue; }
    p[a.slice(0, eq)] = a.slice(eq + 1);
  }
  return p;
}

function pbool(p, key, def) {
  const v = p[key];
  if (v === undefined) return def;
  if (v === true || v === 'true' || v === '1') return true;
  return false;
}

function pint(p, key, def) {
  const v = parseInt(p[key], 10);
  return Number.isFinite(v) ? v : def;
}

function die(msg) { process.stderr.write('Ошибка: ' + msg + '\n'); process.exit(1); }

function insideDir(root, p) {
  const r = path.resolve(root);
  const q = path.resolve(p);
  return q === r || q.startsWith(r + path.sep);
}

// ---------- обход файловой системы ----------

function walkFiles(root, relDir, out) {
  const dir = relDir ? path.join(root, relDir) : root;
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return; }
  for (const name of names.sort()) {
    const rel = relDir ? relDir + '/' + name : name;
    let st;
    try { st = fs.statSync(path.join(dir, name)); } catch (e) { continue; }
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name) || (name.startsWith('.') && name !== '.')) continue;
      walkFiles(root, rel, out);
    } else if (st.isFile()) {
      const ext = path.extname(name).toLowerCase();
      if (BINARY_EXT.has(ext) || st.size > 3 * 1024 * 1024) continue;
      out.push({ rel, size: st.size, mtime: Math.round(st.mtimeMs) });
    }
  }
}

// Классификация файла проекта по его пути.
function classifyFile(rel) {
  const base = path.posix.basename(rel);
  const ext = path.posix.extname(rel).toLowerCase();
  if (ext === '.kt') return 'kt';
  if (ext === '.java') return 'java';
  if (ext === '.xml') {
    if (base === 'AndroidManifest.xml') return 'manifest';
    if (/\/res\/layout[^\/]*\//.test('/' + rel)) return 'layout';
    if (/\/res\/navigation\//.test('/' + rel)) return 'nav';
    if (/\/res\/(values|values-)[^\/]*\//.test('/' + rel)) return 'values';
    return 'xml';
  }
  if (ext === '.toml') return 'toml';
  if (/^(build|settings)\.gradle(\.kts)?$/.test(base)) return 'gradle';
  if (/\.gradle(\.kts)?$/.test(base)) return 'gradle';
  if (/\.properties$/.test(base)) return 'props';
  return 'text';
}

// ---------- Gradle ----------

function parseSettingsGradle(text) {
  const modules = [];
  const re = /include\s*\(([^)]*)\)/g;
  let m;
  while ((m = re.exec(text))) {
    for (const part of m[1].split(',')) {
      const mm = /['"]([^'"]+)['"]/.exec(part);
      if (mm) modules.push(mm[1]);
    }
  }
  const rn = /rootProject\.name\s*=\s*['"]([^'"]+)['"]/.exec(text);
  return { modules, rootName: rn ? rn[1] : null };
}

function gradleModuleDir(name) { return name.replace(/^:/, '').replace(/:/g, '/'); }

function parseToml(text) {
  const out = { versions: {}, libraries: {}, plugins: {} };
  let section = null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const sec = /^\[(\w[\w-]*)\]$/.exec(line);
    if (sec) { section = sec[1]; continue; }
    const kv = /^([\w.-]+)\s*=\s*(.+)$/.exec(line);
    if (!kv) continue;
    const k = kv[1], v = kv[2];
    if (section === 'versions') out.versions[k] = v.replace(/^['"]|['"]$/g, '');
    else if (section === 'libraries') {
      const lib = {};
      const g = /group\s*=\s*"([^"]+)"/.exec(v); if (g) lib.group = g[1];
      const n = /name\s*=\s*"([^"]+)"/.exec(v); if (n) lib.name = n[1];
      const vr = /version\.ref\s*=\s*"([^"]+)"/.exec(v); if (vr) lib.versionRef = vr[1];
      const vv = /version\s*=\s*"([^"]+)"/.exec(v); if (vv && !vr) lib.version = vv[1];
      out.libraries[k] = lib;
    } else if (section === 'plugins') {
      const pl = {};
      const id = /id\s*=\s*"([^"]+)"/.exec(v); if (id) pl.id = id[1];
      const vr = /version\.ref\s*=\s*"([^"]+)"/.exec(v); if (vr) pl.versionRef = vr[1];
      const vv = /version\s*=\s*"([^"]+)"/.exec(v); if (vv && !vr) pl.version = vv[1];
      out.plugins[k] = pl;
    }
  }
  return out;
}

function blockText(text, headerRe) {
  const m = headerRe.exec(text);
  if (!m) return null;
  const start = text.indexOf('{', m.index + m[0].length);
  if (start < 0) return null;
  let d = 0;
  for (let j = start; j < text.length; j++) {
    const c = text[j];
    if (c === '{') d++;
    else if (c === '}') { d--; if (d === 0) return text.slice(start + 1, j); }
  }
  return null;
}

function parseModuleGradle(text) {
  const info = {};
  const grab = (re) => { const m = re.exec(text); return m ? m[1] : null; };
  info.compileSdk = grab(/compileSdk(?:Version)?\s*=?\s*(?:sdk\(\s*)?(\d+)/);
  info.minSdk = grab(/minSdk(?:Version)?\s*=?\s*(\d+)/);
  info.targetSdk = grab(/targetSdk(?:Version)?\s*=?\s*(\d+)/);
  info.namespace = grab(/namespace\s*=\s*['"]([^'"]+)['"]/) || grab(/namespace\s+['"]([^'"]+)['"]/);
  info.applicationId = grab(/applicationId\s*=\s*['"]([^'"]+)['"]/) || grab(/applicationId\s+['"]([^'"]+)['"]/);
  const bf = blockText(text, /\bbuildFeatures\b/);
  info.compose = bf ? /\bcompose\s*=?\s*true/.test(bf) : /compose\s*=\s*true/.test(text);
  info.viewBinding = bf ? /\bviewBinding\s*=?\s*true/.test(bf) : /viewBinding\s*=\s*true/.test(text);
  const bt = blockText(text, /\bbuildTypes\b/);
  info.buildTypes = bt ? [...bt.matchAll(/(\w+)\s*\{/g)].map(x => x[1]) : null;
  const pf = blockText(text, /\bproductFlavors\b/);
  info.flavors = pf ? [...pf.matchAll(/^\s{4,}(\w+)\s*\{/gm)].map(x => x[1]) : null;
  info.plugins = [...text.matchAll(/alias\(\s*libs\.plugins\.([\w.]+)\s*\)/g)].map(x => x[1]);
  const ids = [...text.matchAll(/id\s*\(\s*"([\w.]+)"\s*\)\s*version\s*"([^"]+)"/g)];
  for (const x of ids) { if (!info.plugins.includes(x[1])) info.plugins.push(x[1]); info['v_' + x[1]] = x[2]; }
  info.projectDeps = [...text.matchAll(/project\s*\(\s*['"]([^'"]+)['"]/g)].map(x => x[1]);
  info.deps = [...text.matchAll(/\b(implementation|api|ksp|kapt|compileOnly|runtimeOnly|testImplementation|androidTestImplementation|debugImplementation|coreLibraryDesugaring)\s*\(([^)]*)\)/g)].map(x => x[2].trim());
  return info;
}

function parseWrapperProps(text) {
  const m = /gradle-([\d.]+)-\w+\.zip/.exec(text);
  return m ? m[1] : null;
}

// ---------- XML ----------

function xmlAttrs(s) {
  const out = {};
  for (const m of s.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

function parseManifestXml(text) {
  const man = { permissions: [], features: [], application: null, components: [] };
  for (const m of text.matchAll(/<uses-permission\b([^>]*?)\/>/g)) {
    const a = xmlAttrs(m[1]);
    if (a['android:name']) man.permissions.push(a['android:name']);
  }
  for (const m of text.matchAll(/<uses-feature\b([^>]*?)\/>/g)) {
    const a = xmlAttrs(m[1]);
    if (a['android:name']) man.features.push(a['android:name']);
  }
  const appM = /<application\b([^>]*)>/.exec(text);
  if (appM) man.application = { attrs: xmlAttrs(appM[1]) };
  for (const tag of ['activity', 'activity-alias', 'service', 'receiver', 'provider']) {
    const re = new RegExp('<' + tag + '(?![\\w-])\\b([^>]*?)(\\/?)>', 'g');
    let m;
    while ((m = re.exec(text))) {
      const attrs = xmlAttrs(m[1]);
      const selfClose = m[2] === '/';
      let filters = [];
      if (!selfClose) {
        const closeIdx = text.indexOf('</' + tag + '>', m.index);
        if (closeIdx > m.index) {
          const region = text.slice(m.index, closeIdx);
          for (const f of region.matchAll(/<intent-filter\b([^>]*?)>([\s\S]*?)<\/intent-filter>/g)) {
            const body = f[2];
            const actions = [...body.matchAll(/<action\b([^>]*?)\/>/g)].map(x => xmlAttrs(x[1])['android:name']).filter(Boolean);
            const categories = [...body.matchAll(/<category\b([^>]*?)\/>/g)].map(x => xmlAttrs(x[1])['android:name']).filter(Boolean);
            const datas = [];
            for (const d of body.matchAll(/<data\b([^>]*?)\/>/g)) datas.push(xmlAttrs(d[1]));
            filters.push({ actions, categories, datas });
          }
        }
      }
      man.components.push({ tag, attrs, filters, line: lineOfText(text, m.index) });
    }
  }
  return man;
}

function lineOfText(text, pos) {
  let line = 1;
  for (let i = 0; i < pos && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}

function parseLayoutXml(text) {
  const rootM = /<([\w.]+)\b/.exec(text);
  const ids = [];
  const strings = [];
  for (const m of text.matchAll(/@(\+?)([\w.]+)\/([\w.]+)/g)) {
    if (m[2] === 'id' || m[2] === '+id') ids.push(m[3]);
    else if (m[2] === 'string') strings.push(m[3]);
  }
  return { root: rootM ? rootM[1] : null, ids: [...new Set(ids)], strings: [...new Set(strings)] };
}

function unescapeRes(s) {
  return String(s)
    .replace(/[ \t]*\n[ \t]*/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\n/g, ' ').replace(/\\t/g, ' ')
    .replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

function parseValuesXml(text) {
  const out = { strings: [], plurals: [], arrays: [], dims: [], strMap: {} };
  for (const m of text.matchAll(/<string\s+name="([\w.\-]+)"([^>]*)>([\s\S]*?)<\/string>/g)) {
    out.strings.push(m[1]);
    out.strMap[m[1]] = {
      value: unescapeRes(m[3]),
      translatable: !/translatable\s*=\s*"false"/.test(m[2] || '')
    };
  }
  for (const m of text.matchAll(/<plurals\s+name="([\w.\-]+)"/g)) out.plurals.push(m[1]);
  for (const m of text.matchAll(/<(integer|string)-array\s+name="([\w.\-]+)"/g)) out.arrays.push(m[3]);
  for (const m of text.matchAll(/<dimen\s+name="([\w.\-]+)"/g)) out.dims.push(m[1]);
  return out;
}

function localeOfValuesRel(rel) {
  const m = /(?:^|\/)values(?:-([^/]+))?\/[^/]+$/.exec(String(rel).replace(/\\/g, '/'));
  return m ? (m[1] || 'default') : 'default';
}

// локаль-квалификатор (en, en-rGB, b+es), а не конфигурация (night, land, w600dp)
function isLocaleQualifier(q) {
  return /^[a-z]{2,3}(-r[A-Z]{2}|-b\+.+)?$/.test(q);
}

function parseNavXml(text) {
  const rootM = /<navigation\b([^>]*)>/.exec(text);
  const rootAttrs = rootM ? xmlAttrs(rootM[1]) : {};
  const destinations = [];
  const destMatches = [...text.matchAll(/<(fragment|activity|custom)\b([^>]*?)(\/?)>/g)];
  for (let i = 0; i < destMatches.length; i++) {
    const m = destMatches[i];
    const a = xmlAttrs(m[2]);
    const dest = {
      kind: m[1], id: a['android:id'] ? a['android:id'].replace(/^@\+?id\//, '') : null,
      name: a['android:name'] || null, label: a['android:label'] || null, actions: []
    };
    if (m[3] !== '/') {
      // действия объявлены внутри тега назначения
      const start = m.index + m[0].length;
      const end = i + 1 < destMatches.length ? destMatches[i + 1].index : text.length;
      for (const am of text.slice(start, end).matchAll(/<action\b([^>]*?)\/?>/g)) {
        const aa = xmlAttrs(am[1]);
        const dest2 = (aa['app:destination'] || '').replace(/^@\+?id\//, '');
        if (dest2) dest.actions.push({ id: (aa['android:id'] || '').replace(/^@\+?id\//, ''), dest: dest2 });
      }
    }
    destinations.push(dest);
  }
  const deepLinks = [...text.matchAll(/<deepLink\b([^>]*?)\/>/g)].map(x => xmlAttrs(x[1]));
  return { start: rootAttrs['app:startDestination'] || null, destinations, deepLinks };
}

function layoutBindingClass(layoutName) {
  const parts = layoutName.split(/[-_.]/);
  let s = '';
  for (const p of parts) s += p.charAt(0).toUpperCase() + p.slice(1);
  return s + 'Binding';
}

// ---------- санитайзер Kotlin/Java ----------
// Комментари и содержимое строк/шаблонов заменяются на пробелы, позиции и
// переводы строк сохраняются 1:1, чтобы номера строк оставались верными.

function sanitize(src) {
  const n = src.length;
  const out = src.split('');
  const blank = (ch) => ch === '\n' ? '\n' : ' ';
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') { out[i] = ' '; i++; }
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      out[i] = ' '; out[i + 1] = ' '; i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { out[i] = blank(src[i]); i++; }
      if (i < n) { out[i] = ' '; out[i + 1] = ' '; i += 2; }
      continue;
    }
    if (c === '"') {
      if (src[i + 1] === '"' && src[i + 2] === '"') {
        out[i] = ' '; out[i + 1] = ' '; out[i + 2] = ' '; i += 3;
        while (i < n && !(src[i] === '"' && src[i + 1] === '"' && src[i + 2] === '"')) { out[i] = blank(src[i]); i++; }
        if (i < n) { out[i] = ' '; out[i + 1] = ' '; out[i + 2] = ' '; i += 3; }
        continue;
      }
      out[i] = ' '; i++;
      while (i < n && src[i] !== '"') {
        if (src[i] === '\\') { out[i] = ' '; if (i + 1 < n) out[i + 1] = blank(src[i + 1]); i += 2; continue; }
        if (src[i] === '$' && src[i + 1] === '{') {
          out[i] = ' '; out[i + 1] = ' '; i += 2;
          let d = 0;
          while (i < n) {
            if (src[i] === '{') { d++; out[i] = ' '; i++; continue; }
            if (src[i] === '}') {
              out[i] = ' '; i++;
              if (d === 0) break; else d--;
              continue;
            }
            out[i] = blank(src[i]); i++;
          }
          continue;
        }
        out[i] = blank(src[i]); i++;
      }
      if (i < n) { out[i] = ' '; i++; }
      continue;
    }
    if (c === "'") {
      out[i] = ' '; i++;
      while (i < n && src[i] !== "'") {
        if (src[i] === '\\') { out[i] = ' '; if (i + 1 < n) out[i + 1] = blank(src[i + 1]); i += 2; continue; }
        out[i] = blank(src[i]); i++;
      }
      if (i < n) { out[i] = ' '; i++; }
      continue;
    }
    i++;
  }
  return out.join('');
}

function computeDepths(t) {
  const n = t.length;
  const brace = new Int32Array(n);
  const nest = new Int32Array(n);
  let b = 0, k = 0;
  for (let i = 0; i < n; i++) {
    brace[i] = b;
    nest[i] = b + k;
    const c = t[i];
    if (c === '{') b++;
    else if (c === '}') { if (b > 0) b--; }
    else if (c === '(' || c === '[') k++;
    else if (c === ')' || c === ']') { if (k > 0) k--; }
  }
  return { brace, nest };
}

function buildLineStarts(t) {
  const starts = [0];
  for (let i = 0; i < t.length; i++) if (t[i] === '\n') starts.push(i + 1);
  return starts;
}

function lineOf(starts, pos) {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= pos) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}

// ---------- парсер Kotlin ----------

const KT_MODS = new Set(['private', 'public', 'internal', 'protected', 'abstract', 'open', 'final', 'data', 'sealed',
  'inner', 'value', 'enum', 'expect', 'actual', 'annotation', 'inline', 'suspend', 'operator', 'infix', 'tailrec',
  'external', 'override', 'lateinit', 'const', 'companion', 'crossinline', 'noinline', 'vararg', 'reified', 'fun']);

function backwardModsAnnos(t, raw, pos) {
  // Идём назад от позиции ключевого слова: собираем модификаторы и аннотации.
  let i = pos;
  const mods = [];
  const annos = [];
  const skipWs = () => { while (i > 0 && /[\s;]/.test(t[i - 1])) i--; };
  skipWs();
  let guard = 0;
  while (i > 0 && guard++ < 200) {
    if (t[i - 1] === ')') {
      // аннотация с аргументами: ... @Name(...) 
      let d = 0, j = i - 1;
      while (j >= 0) {
        const c = t[j];
        if (c === ')') d++;
        else if (c === '(') { d--; if (d === 0) break; }
        j--;
      }
      if (j < 0) break;
      let wend = j;
      let wstart = wend;
      while (wstart > 0 && /[\w.]/.test(t[wstart - 1])) wstart--;
      if (wstart === wend || t[wstart - 1] !== '@') break;
      annos.unshift({ name: '@' + t.slice(wstart, wend), raw: raw.slice(wstart - 1, i).replace(/\s+/g, ' ').trim() });
      i = wstart - 1;
      skipWs();
      continue;
    }
    // слово
    let wend = i;
    let wstart = wend;
    while (wstart > 0 && /[\w]/.test(t[wstart - 1])) wstart--;
    if (wstart === wend) break;
    const word = t.slice(wstart, wend);
    if (t[wstart - 1] === '@') {
      annos.unshift({ name: '@' + word, raw: '@' + word });
      i = wstart - 1;
      skipWs();
      continue;
    }
    if (KT_MODS.has(word)) { mods.unshift(word); i = wstart; skipWs(); continue; }
    break;
  }
  return { mods, annos, start: i };
}

function matchBraceForward(brace, t, openPos) {
  // brace[i] — глубина ДО символа i, значит парная '}' имеет глубину на 1 больше открывающей
  const target = brace[openPos] + 1;
  for (let j = openPos + 1; j < t.length; j++) {
    if (t[j] === '}' && brace[j] === target) return j;
  }
  return -1;
}

function splitTop(s, sep) {
  const parts = [];
  let d = 0, start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(' || c === '[' || c === '{' || c === '<') d++;
    else if (c === ')' || c === ']' || c === '}' || c === '>') { if (d > 0) d--; }
    else if (c === sep && d === 0) { parts.push(s.slice(start, i)); start = i + 1; }
  }
  if (start < s.length) parts.push(s.slice(start));
  return parts.filter(x => x.trim() !== '');
}

function identAt(t, i) {
  let j = i;
  while (j < t.length && /[\w]/.test(t[j])) j++;
  return { id: t.slice(i, j), end: j };
}

function skipWs(t, i) { while (i < t.length && /\s/.test(t[i])) i++; return i; }

function skipAngles(t, i) {
  // t[i] === '<' — пропускает сбалансированные <...>
  if (t[i] !== '<') return i;
  let d = 0;
  while (i < t.length) {
    if (t[i] === '<') d++;
    else if (t[i] === '>') { d--; if (d === 0) return i + 1; }
    i++;
  }
  return i;
}

function skipParens(t, i) {
  if (t[i] !== '(') return i;
  let d = 0;
  while (i < t.length) {
    if (t[i] === '(') d++;
    else if (t[i] === ')') { d--; if (d === 0) return i + 1; }
    i++;
  }
  return i;
}

function parseKtParams(s) {
  const parts = splitTop(s, ',');
  const out = [];
  for (const part of parts) {
    const p = part.trim();
    if (!p) continue;
    const annos = [...p.matchAll(/@([\w.]+)/g)].map(x => '@' + x[1]);
    // отрезаем модификаторы и выравниваем "name : Type = default"
    const m = /^(?:@[\w.]+(?:\([^)]*\))?\s+)*(?:(?:\w+)\s+)*(`[\w]+`|[\w]+)\s*:\s*([^=]+?)(?:\s*=\s*(.*))?$/.exec(p.replace(/\s+/g, ' ').trim());
    if (!m) continue;
    let kind = 'param';
    const valRe = /\b(val|var)\s+/.exec(p.replace(/\s+/g, ' '));
    if (valRe) kind = valRe[1];
    let name = m[1].replace(/`/g, '');
    let type = m[2].trim();
    const def = m[3] !== undefined ? m[3].trim() : null;
    // name может содержать receiver (extension property в скобках не бывает — пропускаем)
    if (name.includes('.')) {
      const seg = name.split('.');
      name = seg[seg.length - 1];
    }
    if (type.includes(' by ')) type = type.split(' by ')[0].trim();
    const typeClean = type.replace(/\s+/g, '');
    const baseType = typeClean.split('<')[0].split('?')[0].replace(/\.$/, '');
    out.push({ name, type, baseType, default: def, kind, annos });
  }
  return out;
}

function parseSupertypes(s) {
  const out = [];
  for (const part of splitTop(s, ',')) {
    let seg = part.trim();
    if (!seg) continue;
    // убираем аргументы конструктора: Base(args) -> Base
    const po = seg.indexOf('(');
    if (po >= 0 && seg.indexOf('<') < 0) seg = seg.slice(0, po).trim() || seg;
    else if (po >= 0 && seg.indexOf('<') >= 0 && seg.indexOf('<') < po) {
      const close = skipAngles(seg, seg.indexOf('<'));
      seg = (seg.slice(0, po).trim() + ' ' + seg.slice(close)).trim();
      const po2 = seg.indexOf('(');
      if (po2 >= 0) seg = seg.slice(0, po2).trim();
    }
    if (seg === '') continue;
    const simple = seg.split('<')[0].split('?')[0];
    const last = simple.split('.').pop().trim();
    if (last) out.push({ raw: seg, simple: last });
  }
  return out;
}

// Признак начала новой декларации на следующей строке (для остановки сканирования заголовков)
const DECL_START_RE = /^\s*(?:@[\w.]|fun\b|val\b|var\b|class\b|interface\b|object\b|companion\b|init\b|constructor\b|typealias\b|private\b|internal\b|protected\b|public\b|override\b|suspend\b|inline\b|operator\b|infix\b|abstract\b|open\b|final\b|const\b|lateinit\b|sealed\b|data\b|value\b|inner\b|enum\b|expect\b|actual\b|annotation\b|tailrec\b|external\b|crossinline\b|noinline\b|vararg\b|reified\b)/;

// Разбор одной декларации. Возвращает { decl, end } — end: позиция после тела.
function parseKtDeclAt(t, raw, ctx, pos, kw, matches, mi, to) {
  const { brace, nest, starts } = ctx;
  const nextMatchPos = (mi + 1 < matches.length) ? matches[mi + 1].pos : -1;
  const back = backwardModsAnnos(t, raw, pos);
  const lineStart = lineOf(starts, pos);
  const mk = (o) => Object.assign({ mods: back.mods, annos: back.annos, lineStart, lineEnd: lineStart }, o);

  if (kw === 'typealias') {
    const m = /typealias\s+(\w+)([\s\S]*?)(?:\n|$)/.exec(t.slice(pos, Math.min(t.length, pos + 400)));
    if (!m) return null;
    const eq = m[2].indexOf('=');
    const target = eq >= 0 ? m[2].slice(eq + 1).trim() : '';
    const nl = t.indexOf('\n', pos);
    return { decl: mk({ kind: 'typealias', name: m[1], target }), end: nl < 0 ? to : nl + 1 };
  }

  const isCompanion = back.mods.includes('companion') && kw === 'object';
  let kind = null;
  let i = pos + kw.length;

  if (kw === 'fun interface') { kind = 'interface'; i = pos + kw.length; }
  else if (kw === 'interface') kind = 'interface';
  else if (kw === 'object') kind = 'object';
  else if (kw === 'class') kind = back.mods.includes('enum') ? 'enum' : 'class';

  if (kind) {
    i = skipWs(t, i);
    // object без имени (object : Listener {}) — анонимный, пропускаем тело
    const nameM = identAt(t, i);
    if (!nameM.id && !isCompanion) {
      const bs = t.indexOf('{', pos);
      if (bs >= 0 && nest[bs] === nest[pos]) {
        const be = matchBraceForward(brace, t, bs);
        return { decl: null, end: be < 0 ? to : be + 1 };
      }
      return { decl: null, end: pos };
    }
    const name = nameM.id || 'Companion';
    i = skipWs(t, nameM.end);
    if (t[i] === '<') i = skipAngles(t, i);
    i = skipWs(t, i);
    let ctorParams = [];
    let ctorAnnos = null; // аннотации первичного конструктора: class X @Inject constructor(...)
    // аннотации и 'constructor' перед параметрами первичного конструктора: class X @Inject constructor(...)
    let j2 = i;
    while (t[j2] === '@') {
      const nm = identAt(t, j2 + 1);
      if (nm.id) (ctorAnnos = ctorAnnos || []).push('@' + nm.id);
      j2 = skipWs(t, nm.end);
      if (t[j2] === '(') j2 = skipParens(t, j2);
      j2 = skipWs(t, j2);
    }
    const consW = identAt(t, j2);
    if (consW.id === 'constructor') j2 = skipWs(t, consW.end);
    let ctorEnd = i;
    if (t[j2] === '(') {
      const close = skipParens(t, j2);
      ctorParams = parseKtParams(t.slice(j2 + 1, close - 1));
      ctorEnd = close;
      j2 = skipWs(t, close);
    }
    let supertypes = [];
    let headerEnd = j2;
    if (t[j2] === ':') {
      const j = j2 + 1;
      let d = 0, k2 = j;
      while (k2 < to && k2 < t.length) {
        const c = t[k2];
        if (c === '(' || c === '[') d++;
        else if (c === ')' || c === ']') { if (d > 0) d--; }
        else if (c === '{' && d === 0) break;
        else if (c === '\n' && d === 0 && DECL_START_RE.test(t.slice(k2 + 1))) break;
        k2++;
      }
      supertypes = parseSupertypes(t.slice(j, k2));
      headerEnd = k2;
    } else if (t[j2] !== '{') {
      // без супертипов: заголовок кончается на этой строке
      const nl = t.indexOf('\n', j2);
      headerEnd = (nl >= 0 && nl < to) ? nl : Math.max(j2, ctorEnd);
    }
    // окно тела: до следующей декларации ЗА пределами заголовка
    // (в заголовке может быть keyword 'constructor' — его пропускаем)
    let winEnd = to;
    for (let q = mi + 1; q < matches.length; q++) {
      if (matches[q].pos > headerEnd) { winEnd = matches[q].pos; break; }
    }
    let bs = -1;
    for (let q = headerEnd; q < winEnd && q < t.length; q++) {
      if (t[q] === '{' && nest[q] === nest[pos]) { bs = q; break; }
    }
    let bodyEnd = -1;
    const hasBody = bs >= 0;
    if (hasBody) {
      bodyEnd = matchBraceForward(brace, t, bs);
      if (bodyEnd < 0 || bodyEnd >= to) { bodyEnd = -1; }
    }
    let members = [];
    let entries = [];
    const lineEnd = hasBody && bodyEnd > 0 ? lineOf(starts, bodyEnd) : lineStart;
    if (hasBody && bodyEnd > 0) {
      if (kind === 'enum') {
        // записи enum до ';' на базовой глубине
        let j = bs + 1, d = 0, semi = -1;
        while (j < bodyEnd) {
          const c = t[j];
          if (c === '(' || c === '[' || c === '{' || c === '<') d++;
          else if (c === ')' || c === ']' || c === '}' || c === '>') { if (d > 0) d--; }
          else if (c === ';' && d === 0) { semi = j; break; }
          j++;
        }
        const region = semi > 0 ? t.slice(bs + 1, semi) : '';
        if (region.trim()) {
          for (const e of splitTop(region, ',')) {
            const em = /^\s*(\w+)/.exec(e);
            if (em) entries.push({ name: em[1], line: lineOf(starts, bs + 1 + e.length) });
          }
        }
        if (semi > 0) {
          const sub = parseKtRegion(t, raw, ctx, semi + 1, bodyEnd, nest[semi + 1], null);
          members = sub.decls;
        }
      } else {
        const sub = parseKtRegion(t, raw, ctx, bs + 1, bodyEnd, nest[bs + 1] > 0 ? nest[bs + 1] : nest[pos] + 1, null);
        members = sub.decls;
      }
    }
    const decl = mk({
      kind, name, ctorParams, ctorAnnos: ctorAnnos || [], supertypes, members, entries,
      hasBody: hasBody && bodyEnd > 0, lineEnd
    });
    const end = hasBody && bodyEnd > 0 ? bodyEnd + 1 : winEnd;
    return { decl, end };
  }

  if (kw === 'fun') {
    // fun interface уже разобран выше; здесь обычная функция
    i = skipWs(t, pos + 3);
    if (t[i] === '<') i = skipAngles(t, i);
    i = skipWs(t, i);
    // сигнатура до '(' (имя + receiver), с учётом <> у receiver
    let sigEnd = i;
    let lastParen = -1;
    let j = i;
    while (j < to && j < t.length) {
      const c = t[j];
      if (c === '(') { lastParen = j; break; }
      if (c === '<') { j = skipAngles(t, j); continue; }
      if (c === '{' || c === '\n') break;
      j++;
    }
    if (lastParen < 0) return { decl: null, end: nextMatchPos > 0 ? nextMatchPos : to };
    const sigText = t.slice(i, lastParen).trim();
    const parts = sigText.split('.');
    const name = (parts[parts.length - 1] || '').replace(/`/g, '');
    const receiver = parts.length > 1 ? parts.slice(0, -1).join('.').replace(/<[^>]*>/g, '').trim() : null;
    if (!name) return { decl: null, end: nextMatchPos > 0 ? nextMatchPos : to };
    const pclose = skipParens(t, lastParen);
    const params = parseKtParams(t.slice(lastParen + 1, pclose - 1));
    const winEnd = nextMatchPos > 0 ? nextMatchPos : to;
    // возвращаемый тип: после ')' до '{' / '=' на нулевой глубине
    let k = skipWs(t, pclose);
    let ret = null;
    let b = k;
    if (t[k] === ':') {
      let d = 0, e = k + 1;
      while (e < winEnd && e < t.length) {
        const c = t[e];
        if (c === '(' || c === '[') d++;
        else if (c === ')' || c === ']') { if (d > 0) d--; }
        else if (d === 0 && (c === '{' || c === '=')) break;
        else if (d === 0 && c === '\n' && DECL_START_RE.test(t.slice(e + 1))) break;
        e++;
      }
      ret = t.slice(k + 1, e).replace(/\s+/g, ' ').trim();
      const w = ret.indexOf(' where ');
      if (w >= 0) ret = ret.slice(0, w).trim();
      b = e;
    } else {
      // без типа: возможно 'where' перед телом; стоп — новая декларация
      while (b < winEnd && b < t.length) {
        const c = t[b];
        if (c === '\n' && nest[b] === nest[pos] && DECL_START_RE.test(t.slice(b + 1))) break;
        if (c === '{' && nest[b] === nest[pos]) break;
        if (c === '=' && nest[b] === nest[pos]) break;
        b++;
      }
    }
    let bodyEnd = -1, hasBody = false;
    if (b < winEnd && b < t.length && t[b] === '{' && nest[b] === nest[pos]) {
      const be = matchBraceForward(brace, t, b);
      if (be > 0 && be < to) { bodyEnd = be; hasBody = true; }
    }
    const lineEnd = hasBody ? lineOf(starts, bodyEnd) : (winEnd < t.length ? lineOf(starts, Math.max(0, winEnd - 1)) : lineStart);
    const decl = mk({
      kind: 'fun', name, receiver, params, ret, suspend: back.mods.includes('suspend'),
      composable: back.annos.some(a => a.name === '@Composable'),
      preview: back.annos.some(a => a.name === '@Preview'),
      hasBody, lineEnd
    });
    return { decl, end: hasBody ? bodyEnd + 1 : (nextMatchPos > 0 ? nextMatchPos : to) };
  }

  if (kw === 'val' || kw === 'var') {
    i = skipWs(t, pos + kw.length);
    let nameEnd = i;
    while (nameEnd < to && nameEnd < t.length && /[\w.]/.test(t[nameEnd])) nameEnd++;
    let nameRaw = t.slice(i, nameEnd);
    const parts = nameRaw.split('.');
    const name = (parts[parts.length - 1] || '').replace(/`/g, '');
    const receiver = parts.length > 1 ? parts.slice(0, -1).join('.') : null;
    let j = skipWs(t, nameEnd);
    let type = null;
    if (t[j] === ':') {
      let e = j + 1;
      while (e < to && e < t.length && !'={\n'.includes(t[e])) e++;
      type = t.slice(j + 1, e).replace(/\s+/g, ' ').trim();
      j = e;
    }
    const baseType = type ? type.split('<')[0].split('?')[0].trim() : null;
    const lineEnd = nextMatchPos > 0 ? lineOf(starts, Math.max(0, nextMatchPos - 1)) : lineStart;
    const decl = mk({
      kind: 'prop', name, receiver, type, baseType, mutable: kw === 'var',
      lateinit: back.mods.includes('lateinit'), delegateTo: null, lineEnd
    });
    // конец: до следующей декларации (инициализаторы с лямбдами поглощаются)
    return { decl, end: nextMatchPos > 0 ? nextMatchPos : to };
  }

  if (kw === 'constructor') {
    const po = t.indexOf('(', pos);
    if (po < 0) return { decl: null, end: nextMatchPos > 0 ? nextMatchPos : to };
    const pc = skipParens(t, po);
    const params = parseKtParams(t.slice(po + 1, pc - 1));
    const bs = t.indexOf('{', pc);
    const hasBody = bs >= 0 && bs < to && nest[bs] === nest[pos];
    let lineEnd = lineStart;
    let end = nextMatchPos > 0 ? nextMatchPos : to;
    if (hasBody) {
      const be = matchBraceForward(brace, t, bs);
      if (be > 0 && be < to) { lineEnd = lineOf(starts, be); end = be + 1; }
    } else {
      // delegation: this(...) / super(...) — до конца строки
      const nl = t.indexOf('\n', pc);
      end = nl > 0 ? nl + 1 : end;
    }
    return { decl: mk({ kind: 'ctor', name: 'constructor', params, hasBody, lineEnd }), end };
  }

  if (kw === 'init') {
    const bs = t.indexOf('{', pos);
    if (bs >= 0 && bs < to) {
      const be = matchBraceForward(brace, t, bs);
      if (be > 0 && be < to) return { decl: mk({ kind: 'init', name: 'init', hasBody: true, lineEnd: lineOf(starts, be) }), end: be + 1 };
    }
    return { decl: null, end: nextMatchPos > 0 ? nextMatchPos : to };
  }

  return null;
}

// Разбор уровня (тело файла или тела классов).
function parseKtRegion(t, raw, ctx, from, to, base, owner) {
  const { nest } = ctx;
  const decls = [];
  const re = /\b(fun\s+interface|class|interface|object|fun|val|var|typealias|constructor|init)\b/g;
  const matches = [];
  re.lastIndex = from;
  let m;
  while ((m = re.exec(t))) {
    if (m.index >= to) break;
    if (nest[m.index] !== base) continue;
    matches.push({ pos: m.index, kw: m[1] });
  }
  for (let mi = 0; mi < matches.length; mi++) {
    const { pos, kw } = matches[mi];
    const nextMatchPos = mi + 1 < matches.length ? matches[mi + 1].pos : -1;
    const r = parseKtDeclAt(t, raw, ctx, pos, kw, matches, mi, to);
    if (!r) continue;
    if (r.decl) decls.push(r.decl);
    // пропускаем совпадения внутри поглощённой области
    while (mi + 1 < matches.length && matches[mi + 1].pos < r.end) mi++;
  }
  return { decls };
}

function parseKotlin(raw) {
  const t = sanitize(raw);
  const { brace, nest } = computeDepths(t);
  const starts = buildLineStarts(t);
  const ctx = { t, raw, brace, nest, starts };
  const pkgM = /\bpackage\s+([\w.]+)/.exec(t);
  const imports = [...t.matchAll(/\bimport\s+([\w.]+?)(?:\s+as\s+(\w+))?(?=\s|$)/g)].map(x => ({ name: x[1], alias: x[2] || null }));
  const top = parseKtRegion(t, raw, ctx, 0, t.length, 0, null);
  return { package: pkgM ? pkgM[1] : '', imports, decls: top.decls, sanitized: t, starts, brace, nest };
}

// ---------- парсер Java (базовая поддержка смешанных проектов) ----------

function parseJava(raw) {
  const t = sanitize(raw);
  const { brace, nest } = computeDepths(t);
  const starts = buildLineStarts(t);
  const ctx = { t, raw, brace, nest, starts };
  const pkgM = /\bpackage\s+([\w.]+)/.exec(t);
  const imports = [...t.matchAll(/\bimport\s+(static\s+)?([\w.]+?);/g)].map(x => ({ name: x[2], static: !!x[1] }));
  const decls = [];

  function scanRegion(from, to, base, prefix) {
    const out = [];
    const re = /\b(class|interface|enum|record)\b/g;
    re.lastIndex = from;
    let m;
    const matches = [];
    while ((m = re.exec(t))) {
      if (m.index >= to) break;
      if (nest[m.index] !== base) continue;
      matches.push({ pos: m.index, kw: m[1] });
    }
    for (let mi = 0; mi < matches.length; mi++) {
      const { pos, kw } = matches[mi];
      const nextPos = mi + 1 < matches.length ? matches[mi + 1].pos : -1;
      let i = skipWs(t, pos + kw.length);
      const nm = identAt(t, i);
      if (!nm.id) continue;
      const name = nm.id;
      i = skipWs(t, nm.end);
      let supertypes = [];
      let d = 0, k = i;
      while (k < to && k < t.length) {
        const c = t[k];
        if (c === '(' || c === '[') d++;
        else if (c === ')' || c === ']') { if (d > 0) d--; }
        else if (c === '{' && d === 0) break;
        k++;
      }
      const header = t.slice(i, k);
      const supMatch = /\b(extends|implements)\s+([\w.,\s<>?\[\]]+)/.exec(header);
      if (supMatch) supertypes = parseSupertypes(supMatch[2]);
      const bs = k;
      if (t[bs] !== '{') continue;
      const be = matchBraceForward(brace, t, bs);
      if (be < 0 || be >= to) continue;
      let members = [];
      if (kw === 'enum') {
        let semi = -1, dd = 0;
        for (let z = bs + 1; z < be; z++) {
          const c = t[z];
          if ('([{<'.includes(c)) dd++;
          else if (')]}>'  .includes(c)) { if (dd > 0) dd--; }
          else if (c === ';' && dd === 0) { semi = z; break; }
        }
        if (semi > 0) members = scanJavaMembers(bs, be, semi);
      } else members = scanJavaMembers(bs, be, -1);
      out.push({
        kind: kw === 'enum' ? 'enum' : kw, name, ctorParams: [], supertypes, members,
        mods: [], annos: [], entries: [], hasBody: true,
        lineStart: lineOf(starts, pos), lineEnd: lineOf(starts, be)
      });
      while (mi + 1 < matches.length && matches[mi + 1].pos < be) mi++;
    }
    return out;
  }

  function scanJavaMembers(bodyStart, bodyEnd, memberFrom) {
    const from = memberFrom > 0 ? memberFrom + 1 : bodyStart + 1;
    const out = [];
    const base = nest[from] > 0 ? nest[from] : 1;
    let i = from;
    while (i < bodyEnd) {
      while (i < bodyEnd && /[\s;]/.test(t[i])) i++;
      if (i >= bodyEnd) break;
      // заголовок члена: до ';' / '{' / '}' на нулевой глубине (скобки сигнатуры пропускаем)
      let j = i;
      let d = 0;
      while (j < bodyEnd) {
        const c = t[j];
        if (d === 0 && (c === ';' || c === '{' || c === '}')) break;
        if (c === '(' || c === '[') d++;
        else if (c === ')' || c === ']') { if (d > 0) d--; }
        j++;
      }
      if (j >= bodyEnd) break;
      let header = t.slice(i, j).replace(/\s+/g, ' ').trim();
      if (header) {
        const annos = [...header.matchAll(/@([\w.]+)/g)].map(x => '@' + x[1]);
        const clean = header
          .replace(/@[\w.]+(\([^)]*\))?/g, ' ')
          .replace(/\b(public|protected|private|static|final|abstract|synchronized|native|strictfp|default|transient|volatile)\b/g, ' ')
          .replace(/throws\s+[\w.,\s]+$/, '')
          .replace(/\s+/g, ' ').trim();
        const line = lineOf(starts, i);
        if (t[j] === ';' || t[j] === '}') {
          const eq = clean.indexOf('=');
          const fld = eq >= 0 ? clean.slice(0, eq) : clean;
          const parts = fld.trim().split(/\s+/);
          if (parts.length >= 2) {
            out.push({ kind: 'prop', name: parts[parts.length - 1], type: parts.slice(0, -1).join(' '), baseType: parts[0].split('<')[0].split('[')[0], annos, mods: [], lineStart: line, lineEnd: line });
          }
        } else {
          const po = clean.indexOf('(');
          if (po > 0) {
            const pc2 = clean.lastIndexOf(')');
            const before = clean.slice(0, po).trim().split(/\s+/);
            const name = before[before.length - 1];
            const ret = before.length > 1 ? before.slice(0, -1).join(' ') : null;
            const params = pc2 > po ? splitTop(clean.slice(po + 1, pc2), ',').map(p => {
              const seg = p.trim().split(/\s+/);
              return { name: seg.length > 1 ? seg[seg.length - 1] : 'arg', type: seg.length > 1 ? seg.slice(0, -1).join(' ') : seg[0], baseType: (seg.length > 1 ? seg[0] : '').split('<')[0].split('[')[0] };
            }) : [];
            out.push({ kind: 'fun', name, receiver: null, params, ret, annos, mods: [], lineStart: line, lineEnd: line, java: true });
          } else out.push({ kind: 'block', name: '<init>', annos, mods: [], lineStart: line, lineEnd: line });
        }
      }
      if (t[j] === '{') {
        const be = matchBraceForward(brace, t, j);
        i = be > 0 && be < bodyEnd ? be + 1 : j + 1;
      } else i = j + 1;
    }
    return out;
  }

  decls.push(...scanRegion(0, t.length, 0, ''));
  return { package: pkgM ? pkgM[1] : '', imports, decls, sanitized: t, starts, brace, nest };
}

// ---------- сборка индекса ----------

function collectClasses(parsed, fileRel, module, out) {
  const walk = (decls, prefix) => {
    for (const d of decls) {
      if (d.kind && ['class', 'interface', 'object', 'enum', 'companion'].includes(d.kind)) {
        const path = prefix ? prefix + '.' + d.name : d.name;
        const fq = (parsed.package ? parsed.package + '.' : '') + path;
        const annos = (d.annos || []).map(a => a.name);
        const role = detectRole(d, annos);
        out.push({
          file: fileRel, module, pkg: parsed.package, name: d.name, path, fq,
          kind: d.kind === 'companion' ? 'object' : d.kind, role,
          abstract: (d.mods || []).includes('abstract') || d.kind === 'interface',
          data: (d.mods || []).includes('data'), sealed: (d.mods || []).includes('sealed'),
          annos, annoRaw: (d.annos || []).map(a => a.raw || a.name),
          ctorAnnos: d.ctorAnnos || [],
          supertypes: (d.supertypes || []).map(s => s.simple),
          ctorParams: d.ctorParams || [],
          lineStart: d.lineStart, lineEnd: d.lineEnd
        });
        walk(d.members || [], path);
      }
    }
  };
  walk(parsed.decls, '');
}

function detectRole(d, annos) {
  if (annos.includes('@Dao')) return 'dao';
  if (annos.includes('@Entity')) return 'entity';
  if (annos.includes('@Module')) return 'di';
  if (annos.includes('@HiltAndroidApp')) return 'application';
  const sup = (d.supertypes || []).map(s => s.simple);
  const endsAny = (suf) => sup.some(s => s.endsWith(suf));
  if (endsAny('Activity')) return 'activity';
  if (endsAny('Fragment')) return 'fragment';
  if (endsAny('ViewModel')) return 'viewmodel';
  if (sup.some(s => s === 'Service' || s.endsWith('IntentService') || s === 'LifecycleService')) return 'service';
  if (endsAny('BroadcastReceiver')) return 'receiver';
  if (endsAny('ContentProvider')) return 'provider';
  if (endsAny('RoomDatabase')) return 'database';
  if (endsAny('Application')) return 'application';
  if ((d.members || []).some(m => m.kind === 'fun' && (m.annos || []).some(a => /^@(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|HTTP|Multipart|FormUrlEncoded)$/.test(a.name)))) return 'api';
  if (d.name && d.name.endsWith('Repository')) return 'repository';
  if (sup.some(s => s.endsWith('Repository'))) return 'repository';
  if (d.name && /UseCase$/.test(d.name)) return 'usecase';
  if (d.name && /Impl$/.test(d.name)) return 'impl';
  return null;
}

function moduleOfRel(rel, modules) {
  let best = null;
  for (const m of modules) {
    if (!m.dir) continue;
    if (rel === m.dir || rel.startsWith(m.dir + '/')) {
      if (!best || m.dir.length > best.dir.length) best = m;
    }
  }
  return best ? best.name : '';
}

function buildIndex(root, fileList) {
  const parsedFiles = [];   // {rel, cls, module, enc, bom, eol, lines, parsed}
  const gradleTexts = [];
  let settingsText = null, settingsRel = null;
  let tomlText = null;
  let wrapperText = null;
  const xmlInfo = { manifests: [], layouts: [], values: [], navs: [] };
  const filesMeta = [];
  const modules = [];

  for (const f of fileList) {
    const rel = f.rel;
    const cls = classifyFile(rel);
    if (cls === 'text') {
      filesMeta.push({ rel, cls, enc: null, lines: null, module: null });
      continue;
    }
    let rd;
    try { rd = readSmart(path.join(root, rel)); } catch (e) { continue; }
    filesMeta.push({ rel, cls, enc: rd.enc, bom: rd.bom, lines: rd.lines, module: null });
    if (cls === 'gradle') {
      const base = path.posix.basename(rel);
      if (base.startsWith('settings.')) { settingsText = rd.text; settingsRel = rel; }
      else gradleTexts.push({ rel, text: rd.text });
    } else if (cls === 'toml') tomlText = rd.text;
    else if (cls === 'props') {
      if (rel.endsWith('gradle-wrapper.properties')) wrapperText = rd.text;
    } else if (cls === 'kt' || cls === 'java') {
      parsedFiles.push({ rel, cls, text: rd.text, enc: rd.enc, eol: rd.eol, lines: rd.lines });
    } else if (cls === 'manifest' || cls === 'layout' || cls === 'values' || cls === 'nav' || cls === 'xml') {
      xmlInfo.all = xmlInfo.all || [];
      xmlInfo.all.push({ rel, cls, text: rd.text });
    }
  }

  // модули
  const settingsParsed = settingsText ? parseSettingsGradle(settingsText) : { modules: [] };
  if (settingsParsed.modules.length) {
    for (const name of settingsParsed.modules) modules.push({ name, dir: gradleModuleDir(name) });
  } else {
    // без settings: модули = каталоги с build.gradle
    for (const g of gradleTexts) {
      const d = path.posix.dirname(g.rel);
      if (d === '.') modules.push({ name: '', dir: '' });
      else modules.push({ name: ':' + d.replace(/\//g, ':'), dir: d });
    }
    if (!modules.length) modules.push({ name: '', dir: '' });
  }

  // build.gradle по модулям + namespace
  const toml = tomlText ? parseToml(tomlText) : null;
  for (const m of modules) {
    const cand = m.dir ? [m.dir + '/build.gradle.kts', m.dir + '/build.gradle'] : ['build.gradle.kts', 'build.gradle'];
    let bg = null;
    for (const g of gradleTexts) if (cand.includes(g.rel)) { bg = g; break; }
    m.build = bg ? parseModuleGradle(bg.text) : null;
    m.namespace = (m.build && m.build.namespace) || null;
  }

  // XML
  for (const x of xmlInfo.all || []) {
    const mod = moduleOfRel(x.rel, modules);
    if (x.cls === 'manifest') {
      const parsed = parseManifestXml(x.text);
      xmlInfo.manifests.push({ rel: x.rel, module: mod, ...parsed });
    } else if (x.cls === 'layout') {
      const name = path.posix.basename(x.rel).replace(/\.xml$/, '');
      const parsed = parseLayoutXml(x.text);
      xmlInfo.layouts.push({ rel: x.rel, module: mod, name, bindingClass: layoutBindingClass(name), ...parsed });
    } else if (x.cls === 'values') {
      const parsed = parseValuesXml(x.text);
      xmlInfo.values.push({ rel: x.rel, module: mod, locale: localeOfValuesRel(x.rel), ...parsed });
    } else if (x.cls === 'nav') {
      const parsed = parseNavXml(x.text);
      xmlInfo.navs.push({ rel: x.rel, module: mod, ...parsed });
    }
  }

  // namespace из манифеста, если gradle не задан
  for (const m of modules) {
    if (!m.namespace) {
      const man = xmlInfo.manifests.find(mm => mm.module === m.name);
      const pkgAttr = man ? /package\s*=\s*"([^"]+)"/.exec(man.text || '') : null;
      if (pkgAttr) m.namespace = pkgAttr[1];
    }
  }

  // парсинг kt/java
  const classes = [];
  const functions = []; // верхнеуровневые функции (в т.ч. @Composable)
  const ktByRel = new Map();
  for (const f of parsedFiles) {
    const mod = moduleOfRel(f.rel, modules);
    f.module = mod;
    const parsed = f.cls === 'kt' ? parseKotlin(f.text) : parseJava(f.text);
    ktByRel.set(f.rel, parsed);
    collectClasses(parsed, f.rel, mod, classes);
    if (f.cls === 'kt') {
      for (const d of parsed.decls) {
        if (d.kind === 'fun') {
          functions.push({
            file: f.rel, module: mod, name: d.name, receiver: d.receiver || null,
            suspend: !!d.suspend, composable: !!d.composable, preview: !!d.preview,
            params: d.params || [], ret: d.ret || null,
            mods: d.mods || [], lineStart: d.lineStart, lineEnd: d.lineEnd
          });
        } else if (d.kind === 'prop') {
          functions.push({
            file: f.rel, module: mod, prop: true, name: d.name, receiver: d.receiver || null,
            type: d.type || null, mods: d.mods || [], lineStart: d.lineStart, lineEnd: d.lineEnd
          });
        }
      }
    }
  }

  // Room-таблицы: @Entity(tableName = "...") или имя класса
  const tables = [];
  for (const c of classes) {
    if (c.role === 'entity') {
      let table = c.name;
      for (const raw of c.annoRaw) {
        const m = /tableName\s*=\s*"([^"]+)"/.exec(raw);
        if (m) { table = m[1]; break; }
      }
      tables.push({ table, cls: c.name, file: c.file, line: c.lineStart });
    }
  }

  // маршруты навигации из исходников (compose) и nav-xml
  const routes = [];
  for (const f of parsedFiles) {
    if (f.cls !== 'kt') continue;
    for (const m of f.text.matchAll(/composable\s*\(\s*"([^"]+)"\s*[,)]/g)) routes.push({ route: m[1], file: f.rel, kind: 'compose' });
    for (const m of f.text.matchAll(/startDestination\s*=\s*"([^"]+)"/g)) routes.push({ route: m[1], file: f.rel, kind: 'start' });
  }
  for (const n of xmlInfo.navs) {
    if (n.start) routes.push({ route: n.start.replace(/^@\+?id\//, ''), file: n.rel, kind: 'nav-start' });
    for (const d of n.destinations) if (d.id) routes.push({ route: d.id, file: n.rel, kind: 'nav-dest' });
  }

  // вызовы navigate(): compose (строка-маршрут) и view-based (R.id.destId)
  const navCalls = [];
  for (const f of parsedFiles) {
    if (f.cls !== 'kt') continue;
    for (const m of f.text.matchAll(/(?<!\w)navigate\s*\(\s*"([^"]+)"/g)) {
      navCalls.push({ target: m[1], file: f.rel, line: lineOfText(f.text, m.index) });
    }
    for (const m of f.text.matchAll(/(?<!\w)navigate\s*\(\s*R\.id\.(\w+)/g)) {
      navCalls.push({ target: m[1], file: f.rel, line: lineOfText(f.text, m.index), resId: true });
    }
  }

  const data = {
    root,
    gradle: {
      wrapper: wrapperText ? parseWrapperProps(wrapperText) : null,
      toml,
      settingsRel,
      rootName: settingsParsed.rootName
    },
    modules,
    filesMeta,
    files: parsedFiles.map(f => ({
      rel: f.rel, cls: f.cls, module: f.module, enc: f.enc, eol: f.eol, lines: f.lines,
      package: ktByRel.get(f.rel).package,
      imports: ktByRel.get(f.rel).imports,
      decls: ktByRel.get(f.rel).decls
    })),
    xml: xmlInfo,
    classes,
    functions,
    tables,
    routes,
    navCalls,
    edges: [],
    warnings: []
  };

  buildEdges(data, ktByRel);
  buildWarnings(data);
  return data;
}

function addEdge(edges, seen, from, to, type, line) {
  if (!from || !to || from === to) return;
  const key = from + '|' + to + '|' + type;
  const prev = seen.get(key);
  if (prev === undefined) { seen.set(key, line); edges.push({ from, to, type, line }); }
  else if (line < prev) { seen.set(key, line); const e = edges.find(x => x.from === from && x.to === to && x.type === type); if (e) e.line = line; }
}

function buildEdges(data, ktByRel) {
  const edges = [];
  const seen = new Map();
  const classByName = new Map();
  for (const c of data.classes) {
    if (!classByName.has(c.name)) classByName.set(c.name, []);
    classByName.get(c.name).push(c);
  }

  for (const c of data.classes) {
    // extends/implements
    for (const st of c.supertypes) {
      const targets = classByName.get(st);
      if (!targets) continue;
      for (const tgt of targets) {
        const type = (tgt.kind === 'interface' && c.kind !== 'interface') || (c.kind === 'class' && tgt.kind === 'class') ? (tgt.kind === 'interface' ? 'implements' : 'extends') : (tgt.kind === 'interface' ? 'implements' : 'extends');
        addEdge(edges, seen, c.file, tgt.file, tgt.kind === 'interface' ? 'implements' : 'extends', c.lineStart);
      }
    }
    // inject: параметры конструктора + @Inject-поля + @Provides/@Binds параметры DI-модулей
    for (const p of c.ctorParams) {
      const targets = classByName.get(p.baseType);
      if (targets) for (const tgt of targets) addEdge(edges, seen, c.file, tgt.file, 'inject', c.lineStart);
    }
    const decl = findDecl(data, c);
    if (decl) {
      const isModule = (c.annos || []).includes('@Module');
      for (const mem of decl.members || []) {
        if (mem.kind === 'prop' && (mem.annos || []).some(a => a.name === '@Inject') && mem.baseType) {
          const targets = classByName.get(mem.baseType);
          if (targets) for (const tgt of targets) addEdge(edges, seen, c.file, tgt.file, 'inject', mem.lineStart);
        }
        if (isModule && mem.kind === 'fun' && (mem.annos || []).some(a => a.name === '@Provides' || a.name === '@Binds')) {
          for (const pp of mem.params || []) {
            const targets = classByName.get(pp.baseType);
            if (targets) for (const tgt of targets) addEdge(edges, seen, c.file, tgt.file, 'inject', mem.lineStart);
          }
        }
      }
    }
  }

  // uses: упоминания классов проекта в других файлах
  for (const f of data.files) {
    if (f.cls !== 'kt' && f.cls !== 'java') continue;
    const parsed = ktByRel.get(f.rel);
    const t = parsed.sanitized;
    for (const [name, targets] of classByName) {
      if (!t.includes(name)) continue;
      const re = new RegExp('\\b' + name.replace(/\$/g, '\\$') + '\\b', 'g');
      let m;
      while ((m = re.exec(t))) {
        for (const tgt of targets) {
          if (tgt.file !== f.rel) addEdge(edges, seen, f.rel, tgt.file, 'uses', lineOf(parsed.starts, m.index));
        }
        break; // достаточно первого вхождения для пары
      }
    }
  }

  // calls: вызовы верхнеуровневых функций (Compose)
  for (const f of data.files) {
    if (f.cls !== 'kt') continue;
    const parsed = ktByRel.get(f.rel);
    const t = parsed.sanitized;
    for (const fn of data.functions) {
      if (fn.prop || !fn.name) continue;
      // вызов функции: с аргументами Name( — или trailing-lambda Compose: Name {
      const re = new RegExp('(?<![.\\w])' + fn.name.replace(/\$/g, '\\$') + '\\s*[(\\{]', 'g');
      let m;
      while ((m = re.exec(t))) {
        if (fn.file !== f.rel) addEdge(edges, seen, f.rel, fn.file, 'calls', lineOf(parsed.starts, m.index));
        break;
      }
    }
  }

  // binding: использование классов ViewBinding
  for (const L of data.xml.layouts) {
    for (const f of data.files) {
      if (f.cls !== 'kt' && f.cls !== 'java') continue;
      const parsed = ktByRel.get(f.rel);
      const re = new RegExp('\\b' + L.bindingClass + '\\b');
      if (re.test(parsed.sanitized)) addEdge(edges, seen, f.rel, L.rel, 'binding', null);
    }
  }

  // layout-id: R.id.x в исходниках
  data.layoutIdUses = [];
  for (const L of data.xml.layouts) {
    for (const id of L.ids) {
      for (const f of data.files) {
        if (f.cls !== 'kt' && f.cls !== 'java') continue;
        const parsed = ktByRel.get(f.rel);
        const re = new RegExp('R\\.id\\.' + id + '\\b');
        const m = re.exec(parsed.sanitized);
        if (m) data.layoutIdUses.push({ id, layout: L.rel, file: f.rel, line: lineOf(parsed.starts, m.index) });
      }
    }
  }

  data.edges = edges;
}

function findDecl(data, c) {
  const f = data.files.find(x => x.rel === c.file);
  if (!f) return null;
  let decl = null;
  const segs = c.path.split('.');
  let list = f.decls;
  for (let i = 0; i < segs.length; i++) {
    decl = (list || []).find(d => d.name === segs[i] && ['class', 'interface', 'object', 'enum', 'companion'].includes(d.kind));
    if (!decl) return null;
    list = decl.members;
  }
  return decl;
}

function buildWarnings(data) {
  const warns = [];
  const declaredComps = new Set();
  for (const man of data.xml.manifests) {
    const mod = data.modules.find(m => m.name === man.module);
    const ns = (mod && mod.namespace) || '';
    for (const comp of man.components) {
      let cn = comp.attrs['android:name'] || '';
      if (!cn) continue;
      if (cn.startsWith('.')) cn = ns + cn;
      else if (!cn.includes('.')) cn = ns + '.' + cn;
      if (cn.startsWith('androidx.') || cn.startsWith('android.')) { declaredComps.add(cn); continue; }
      declaredComps.add(cn);
      const hasFilter = comp.filters.length > 0;
      const explicit = comp.attrs['android:exported'];
      const exported = explicit === 'true' || (explicit === undefined && hasFilter);
      const perm = comp.attrs['android:permission'];
      const isLauncher = comp.filters.some(f => f.actions.includes('android.intent.action.MAIN') && f.categories.includes('android.intent.category.LAUNCHER'));
      if (exported && !perm && !isLauncher && comp.tag !== 'provider') {
        warns.push(`manifest: ${comp.tag} ${cn} exported без permission (${man.rel})`);
      }
      if (explicit === 'true' && !hasFilter && comp.tag === 'activity') {
        warns.push(`manifest: ${comp.tag} ${cn} exported=true без intent-filter (${man.rel})`);
      }
    }
  }
  // Activity/Service/Receiver-классы, не объявленные в манифесте
  for (const c of data.classes) {
    if (['activity', 'service', 'receiver', 'provider'].includes(c.role)) {
      const fq = c.fq;
      if (data.xml.manifests.length && !declaredComps.has(fq)) {
        warns.push(`${c.fq} (${c.role}) не найден в манифесте`);
      }
    }
  }
  data.warnings = warns;
}

function loadIndex(root) {
  const cachePath = path.join(root, CACHE_DIR, 'index.json');
  const fileList = [];
  walkFiles(root, '', fileList);
  const meta = {};
  for (const f of fileList) meta[f.rel] = f.size + ':' + f.mtime;
  let cached = null;
  try {
    const j = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (j.version === VERSION && JSON.stringify(j.meta) === JSON.stringify(meta)) cached = j;
  } catch (e) { /* кэша нет или битый — пересобираем */ }
  if (cached) { cached.data.root = root; return cached.data; }
  const data = buildIndex(root, fileList);
  try {
    fs.mkdirSync(path.join(root, CACHE_DIR), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify({ version: VERSION, meta, data }));
  } catch (e) { /* кэш не критичен */ }
  return data;
}

// ---------- общие помощники операций ----------

function resolveFileArg(data, val) {
  if (!val) return null;
  const v = String(val).replace(/\\/g, '/').replace(/^\.\//, '');
  const pool = [
    ...data.files.map(f => f.rel),
    ...data.xml.manifests.map(x => x.rel),
    ...data.xml.layouts.map(x => x.rel),
    ...data.xml.navs.map(x => x.rel),
    ...data.xml.values.map(x => x.rel)
  ];
  let hit = pool.find(x => x === v);
  if (!hit) hit = pool.find(x => x.endsWith('/' + v));
  if (!hit) hit = pool.find(x => x.endsWith(v));
  if (!hit) hit = pool.find(x => x.includes(v));
  return hit || null;
}

function findClasses(data, name) {
  return data.classes.filter(c => c.name === name || c.fq === name || c.path === name);
}

function trimTo(s, n) {
  if (s === null || s === undefined) return '';
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function annoShort(a) { return trimTo(a.raw || a.name, 90); }

function funSigLine(d) {
  const params = (d.params || []).map(pp => {
    let s = pp.name;
    if (pp.type) s += ': ' + pp.type;
    if (pp.default !== undefined && pp.default !== null && pp.default !== '') s += ' = …';
    return s;
  }).join(', ');
  let s = d.name + '(' + params + ')';
  if (d.ret) s += ': ' + d.ret;
  return s;
}

// ---------- info ----------

function opInfo(data, p, out) {
  const g = data.gradle;
  const L = [];
  const rootName = g.rootName ? ` "${g.rootName}"` : '';
  L.push(`Проект: ${data.root}${rootName}`);
  L.push(`Сборка: Gradle ${g.wrapper || 'не определена (wrapper не найден)'}, модулей: ${data.modules.length}`);
  const v = g.toml ? g.toml.versions : {};
  const ver = [];
  if (v.agp) ver.push('AGP ' + v.agp);
  if (v.kotlin) ver.push('Kotlin ' + v.kotlin);
  if (v.ksp) ver.push('KSP ' + v.ksp);
  if (v.hilt) ver.push('Hilt ' + v.hilt);
  if (v.composeBom) ver.push('Compose BOM ' + v.composeBom);
  if (v.room) ver.push('Room ' + v.room);
  if (v.retrofit) ver.push('Retrofit ' + v.retrofit);
  if (ver.length) L.push('Версии: ' + ver.join(' | '));

  for (const m of data.modules) {
    const b = m.build || {};
    const mName = m.name || '(корень)';
    let s = `${mName} — ${m.namespace ? 'namespace ' + m.namespace + ', ' : ''}`;
    const sdk = [];
    if (b.compileSdk) sdk.push('compileSdk ' + b.compileSdk);
    if (b.minSdk) sdk.push('minSdk ' + b.minSdk);
    if (b.targetSdk) sdk.push('targetSdk ' + b.targetSdk);
    s += sdk.join(', ');
    const feats = [];
    if (b.compose) feats.push('compose');
    if (b.viewBinding) feats.push('viewBinding');
    if (feats.length) s += '; ' + feats.join(', ');
    if (b.buildTypes && b.buildTypes.length) s += '; buildTypes: ' + b.buildTypes.join(', ');
    if (b.flavors && b.flavors.length) s += '; flavors: ' + b.flavors.join(', ');
    if (b.projectDeps && b.projectDeps.length) s += '; модули: ' + b.projectDeps.join(', ');
    if (b.deps && b.deps.length) s += `; зависимостей: ${b.deps.length}`;
    L.push(s);
  }

  // манифест
  for (const man of data.xml.manifests) {
    const comps = {};
    for (const c of man.components) comps[c.tag] = (comps[c.tag] || 0) + 1;
    const compStr = Object.entries(comps).map(([k, n]) => `${k} ${n}`).join(', ');
    L.push(`Манифест (${man.rel}): ${compStr || 'компонентов нет'};` + (man.permissions.length ? ` разрешения: ${man.permissions.map(x => x.replace('android.permission.', '')).join(', ')}` : ' разрешений нет'));
  }

  // состав по ролям
  const roles = {};
  for (const c of data.classes) {
    const r = c.role || c.kind;
    roles[r] = (roles[r] || 0) + 1;
  }
  const roleOrder = ['activity', 'fragment', 'viewmodel', 'service', 'receiver', 'provider', 'application', 'repository', 'impl', 'dao', 'entity', 'database', 'di', 'api', 'usecase', 'interface', 'class', 'object', 'enum'];
  const roleStr = roleOrder.filter(r => roles[r]).map(r => `${r} ${roles[r]}`).join(', ');
  const others = Object.keys(roles).filter(r => !roleOrder.includes(r)).map(r => `${r} ${roles[r]}`);
  L.push('Состав: ' + [...roleStr.split(', ').filter(Boolean), ...others].join(', '));

  const composables = data.functions.filter(f => !f.prop && f.composable);
  const previews = composables.filter(f => f.preview);
  const topFuns = data.functions.filter(f => !f.prop);
  const topProps = data.functions.filter(f => f.prop);
  L.push(`Функции: верхнеуровневых ${topFuns.length} (composable ${composables.length}, preview ${previews.length}), top-свойств ${topProps.length}`);

  if (data.xml.layouts.length) L.push(`Layouts: ${data.xml.layouts.length} (${data.xml.layouts.map(x => x.name).slice(0, 8).join(', ')})`);
  const stringCount = new Set(data.xml.values.flatMap(x => x.strings)).size;
  if (stringCount) L.push(`Ресурсы: строк ${stringCount}, id представлений ${new Set(data.xml.layouts.flatMap(x => x.ids)).size}`);
  if (data.tables.length) L.push('Таблицы БД (Room): ' + data.tables.map(t => t.table).join(', '));
  if (data.routes.length) L.push('Маршруты: ' + [...new Set(data.routes.map(r => r.route))].slice(0, 10).join(', '));

  // кодировки
  const encStat = {};
  for (const f of data.filesMeta) {
    if (!f.enc) continue;
    encStat[f.enc] = (encStat[f.enc] || 0) + 1;
  }
  const encStr = Object.entries(encStat).map(([k, n]) => `${k} ${n}`).join(', ');
  L.push('Кодировки: ' + encStr);
  const nonUtf8 = data.filesMeta.filter(f => f.enc && f.enc !== 'utf-8');
  for (const f of nonUtf8) L.push(`⚠ ${f.rel} не в UTF-8 (${f.enc}) — правки только через read/patch/create`);

  for (const w of data.warnings) L.push('⚠ ' + w);
  out.push(L.join('\n'));
}

// ---------- search ----------

function opSearch(data, p, out) {
  const query = p.query || p.q;
  if (!query) die('search: нужен query=');
  let exts = String(p.ext || '.kt').split(',').map(x => x.trim()).filter(Boolean).map(e => e.startsWith('.') ? e : '.' + e);
  const pathFilter = p.path ? String(p.path).replace(/\\/g, '/') : null;
  const max = pint(p, 'limit', 30);
  const forceRegex = pbool(p, 'regex', false);

  const candidates = data.filesMeta.filter(f => {
    const ext = path.posix.extname(f.rel).toLowerCase();
    if (exts.length && !exts.includes(ext)) return false;
    if (pathFilter && !f.rel.includes(pathFilter)) return false;
    return true;
  });

  let results = [];
  let usedRegex = forceRegex;
  const tryPass = (regexMode) => {
    const res = [];
    let re = null;
    if (regexMode) {
      try { re = new RegExp(query, 'g'); } catch (e) { die('search: некорректная регулярка'); }
    }
    for (const f of candidates) {
      let rd;
      try { rd = readSmart(path.join(data.root, f.rel)); } catch (e) { continue; }
      const text = rd.text;
      const lines = text.split('\n');
      let count = 0;
      if (re) {
        for (let i = 0; i < lines.length; i++) {
          re.lastIndex = 0;
          const mm = re.exec(lines[i]);
          if (mm) { res.push({ rel: f.rel, line: i + 1, text: lines[i].trim() }); count++; if (res.length >= max) return res; }
        }
      } else {
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(query)) {
            res.push({ rel: f.rel, line: i + 1, text: lines[i].trim() });
            count++;
            if (res.length >= max) return res;
          }
        }
      }
    }
    return res;
  };

  if (forceRegex) results = tryPass(true);
  else {
    results = tryPass(false);
    if (!results.length && /[\\^$.*+?()[\]{}|]/.test(query)) {
      results = tryPass(true);
      usedRegex = true;
    }
  }

  if (!results.length) { out.push('Совпадений нет.'); return; }
  const byFile = new Map();
  for (const r of results) {
    if (!byFile.has(r.rel)) byFile.set(r.rel, []);
    byFile.get(r.rel).push(r);
  }
  const L = [];
  for (const [rel, rs] of byFile) {
    L.push(rel);
    for (const r of rs) L.push(`  ${r.line}: ${trimTo(r.text, 160)}`);
  }
  L.push(`Совпадений: ${results.length}${results.length >= max ? ' (достигнут лимит ' + max + ')' : ''}${usedRegex ? ' [regex]' : ''}`);
  out.push(L.join('\n'));
}

// ---------- outline ----------

function outlineDecl(data, L, decl, indent, showFields, visited) {
  const pad = ' '.repeat(indent);
  const range = `[${decl.lineStart}-${decl.lineEnd}]`;
  if (decl.kind === 'typealias') {
    L.push(`${pad}typealias ${decl.name} = ${trimTo(decl.target || '', 60)} ${range}`);
    return;
  }
  if (decl.kind === 'fun') {
    for (const a of decl.annos || []) L.push(`${pad}${annoShort(a)}`);
    const tags = [];
    if (decl.composable) tags.push('composable');
    if (decl.preview) tags.push('preview');
    if (decl.suspend) tags.push('suspend');
    for (const m of decl.mods || []) if (['override', 'abstract', 'open', 'operator', 'private', 'internal', 'protected', 'inline'].includes(m)) tags.push(m);
    const tag = tags.length ? `  {${tags.join(', ')}}` : '';
    L.push(`${pad}fun ${decl.receiver ? decl.receiver + '.' : ''}${funSigLine(decl)} ${range}${tag}`);
    return;
  }
  if (decl.kind === 'prop') {
    if (!showFields) return;
    for (const a of decl.annos || []) L.push(`${pad}${annoShort(a)}`);
    const tags = [];
    if (decl.mutable) tags.push('var');
    else tags.push('val');
    if (decl.lateinit) tags.push('lateinit');
    for (const m of decl.mods || []) if (['override', 'abstract', 'const', 'private', 'internal', 'protected'].includes(m)) tags.push(m);
    L.push(`${pad}${tags.join(' ')} ${decl.receiver ? decl.receiver + '.' : ''}${decl.name}${decl.type ? ': ' + decl.type : ''} ${range}`);
    return;
  }
  if (decl.kind === 'ctor') {
    const injects = (decl.params || []).map(pp => pp.name + (pp.type ? ': ' + pp.type : '')).join(', ');
    L.push(`${pad}ctor(${injects}) ${range}`);
    return;
  }
  if (decl.kind === 'init') {
    L.push(`${pad}init ${range}`);
    return;
  }
  // классы
  if (!['class', 'interface', 'object', 'enum', 'companion'].includes(decl.kind)) return;
  const mods = (decl.mods || []).filter(m => ['data', 'sealed', 'abstract', 'open', 'inner', 'value', 'private', 'internal', 'protected'].includes(m));
  for (const a of decl.annos || []) L.push(`${pad}${annoShort(a)}`);
  const sup = (decl.supertypes || []).map(s => s.raw).join(', ');
  L.push(`${pad}${[...mods, decl.kind === 'companion' ? 'companion object' : decl.kind + ' ' + decl.name].join(' ')}${sup ? ' : ' + sup : ''} ${range}`);
  if (decl.kind === 'enum' && decl.entries && decl.entries.length) {
    L.push(`${pad}  записи: ${decl.entries.map(e => e.name).join(', ')}`);
  }
  const ctor = (decl.ctorParams || []);
  if (ctor.length) {
    const injects = ctor.map(pp => {
      let s = pp.name + (pp.type ? ': ' + pp.type : '');
      if (pp.kind === 'val' || pp.kind === 'var') s = pp.kind + ' ' + s;
      return s;
    }).join(', ');
    L.push(`${pad}  ctor(${injects})`);
    const proj = ctor.filter(pp => findClasses(data, pp.baseType).length);
    if (proj.length) L.push(`${pad}  inject: ${proj.map(pp => pp.name + ': ' + pp.baseType).join(', ')}`);
  }
  for (const mem of decl.members || []) {
    if (mem.kind === 'ctor' || mem.kind === 'init') continue;
    outlineDecl(data, L, mem, indent + 2, showFields, visited);
  }
}

function outlineInherited(data, L, decl, indent, depth) {
  if (depth > 3) return;
  for (const st of decl.supertypes || []) {
    const targets = findClasses(data, st.simple);
    for (const tgt of targets) {
      const tdecl = findDecl(data, tgt);
      if (!tdecl) continue;
      const pad = ' '.repeat(indent);
      const funs = (tdecl.members || []).filter(m => m.kind === 'fun');
      if (funs.length) {
        L.push(`${pad}↑ из ${tdecl.name}:`);
        for (const f of funs) {
          const tags = [];
          if (f.suspend) tags.push('suspend');
          if (f.composable) tags.push('composable');
          L.push(`${pad}  fun ${funSigLine(f)} [${f.lineStart}-${f.lineEnd}]${tags.length ? '  {' + tags.join(', ') + '}' : ''}`);
        }
      }
      outlineInherited(data, L, tdecl, indent, depth + 1);
    }
  }
}

function opOutline(data, p, out) {
  let targetRel = p.file ? resolveFileArg(data, p.file) : null;
  let classTarget = null;
  if (!targetRel && p.name) {
    const cls = findClasses(data, p.name);
    if (cls.length) { classTarget = cls[0]; targetRel = cls[0].file; }
  }
  if (!targetRel) die('outline: файл или класс не найден (file= или name=)');
  const showFields = pbool(p, 'fields', true);
  const inherit = pbool(p, 'inherit', false);
  const L = [];

  const layout = data.xml.layouts.find(x => x.rel === targetRel);
  const manifest = data.xml.manifests.find(x => x.rel === targetRel);
  const nav = data.xml.navs.find(x => x.rel === targetRel);
  if (layout) {
    L.push(`${layout.rel} (layout, корень ${layout.root})`);
    if (layout.ids.length) L.push('  id: ' + layout.ids.join(', '));
    if (layout.strings.length) L.push('  строки: ' + layout.strings.join(', '));
    L.push(`  binding-класс: ${layout.bindingClass}`);
    const uses = data.files.filter(f => (f.cls === 'kt' || f.cls === 'java') && JSON.stringify(f.decls).includes(layout.bindingClass));
    for (const u of uses) L.push(`  используется в: ${u.rel}`);
    out.push(L.join('\n'));
    return;
  }
  if (manifest) {
    out.push(manifest.rel);
    opManifest(data, { module: manifest.module }, out);
    return;
  }
  if (nav) {
    L.push(`${nav.rel} (navigation, start=${nav.start || '—'})`);
    for (const d of nav.destinations) L.push(`  ${d.kind} ${d.id || ''} -> ${d.name || ''} ${d.label ? '«' + d.label + '»' : ''}`);
    out.push(L.join('\n'));
    return;
  }

  const f = data.files.find(x => x.rel === targetRel);
  if (!f) die('outline: файл не найден: ' + targetRel);
  L.push(`== ${f.rel} (${f.module ? f.module + ', ' : ''}${f.lines} строк, ${f.enc})`);
  L.push(`package ${f.package}`);
  const ownImports = f.imports.filter(i => data.classes.some(c => c.fq === i.name || i.name.startsWith(f.package + '.')));
  L.push(`imports: ${f.imports.length}${ownImports.length ? ', из проекта: ' + ownImports.map(i => i.name).join(', ') : ''}`);
  for (const d of f.decls) outlineDecl(data, L, d, 0, showFields, new Set());
  if (inherit && classTarget) {
    const decl = findDecl(data, classTarget);
    if (decl) outlineInherited(data, L, decl, 0, 0);
  }
  out.push(L.join('\n'));
}

// ---------- symbol ----------

function opSymbol(data, p, out) {
  const name = p.name || p.query;
  if (!name) die('symbol: нужен name=');
  const res = [];

  if (name.includes('#')) {
    const [clsName, member] = [name.slice(0, name.indexOf('#')), name.slice(name.indexOf('#') + 1)];
    for (const c of findClasses(data, clsName)) {
      const decl = findDecl(data, c);
      if (!decl) continue;
      for (const m of decl.members || []) {
        if (m.name === member) {
          const kind = m.kind === 'fun' ? 'fun' : (m.kind === 'prop' ? 'prop' : m.kind);
          res.push({ name: `${c.name}#${m.name}`, kind, file: c.file, line: m.lineStart, lineEnd: m.lineEnd });
        }
      }
    }
  } else {
    // fq или простой класс
    for (const c of data.classes) {
      if (c.fq === name || c.path === name || c.name === name) {
        res.push({ name: c.fq, kind: c.kind, file: c.file, line: c.lineStart, lineEnd: c.lineEnd, role: c.role });
      }
    }
    // верхнеуровневые функции и свойства
    for (const fn of data.functions) {
      if (fn.name === name) {
        const kind = fn.prop ? 'prop' : (fn.composable ? 'composable fun' : 'fun') + (fn.receiver ? ' (ext ' + fn.receiver + ')' : '');
        res.push({ name: fn.receiver ? fn.receiver + '.' + fn.name : fn.name, kind, file: fn.file, line: fn.lineStart, lineEnd: fn.lineEnd });
      }
    }
    // typealias
    for (const f of data.files) {
      for (const d of f.decls) {
        if (d.kind === 'typealias' && d.name === name) res.push({ name: d.name, kind: 'typealias', file: f.rel, line: d.lineStart, lineEnd: d.lineEnd });
      }
    }
    // записи enum
    for (const f of data.files) {
      for (const d of f.decls) {
        if (d.kind === 'enum' && (d.entries || []).some(e => e.name === name)) {
          res.push({ name, kind: 'enum entry', file: f.rel, line: d.lineStart, lineEnd: d.lineEnd });
        }
      }
    }
    // таблица Room
    for (const t of data.tables) {
      if (t.table === name) res.push({ name: t.table, kind: 'table -> ' + t.cls, file: t.file, line: t.line });
    }
    // layout
    for (const l of data.xml.layouts) {
      if (l.name === name) res.push({ name, kind: 'layout (binding ' + l.bindingClass + ')', file: l.rel, line: 1 });
      if (l.bindingClass === name) res.push({ name, kind: 'binding -> ' + l.name, file: l.rel, line: 1 });
    }
    // id представления
    for (const l of data.xml.layouts) {
      if (l.ids.includes(name)) res.push({ name, kind: 'id (layout ' + l.name + ')', file: l.rel, line: 1 });
    }
    // строковый ресурс
    for (const vs of data.xml.values) {
      if (vs.strings.includes(name)) res.push({ name, kind: 'string', file: vs.rel, line: 1 });
    }
    // маршрут
    for (const r of data.routes) {
      if (r.route === name) res.push({ name, kind: 'route (' + r.kind + ')', file: r.file, line: 1 });
    }
    // Class.member (свойство/поле)
    if (!res.length && name.includes('.')) {
      const lastDot = name.lastIndexOf('.');
      const clsName = name.slice(0, lastDot);
      const member = name.slice(lastDot + 1);
      for (const c of findClasses(data, clsName)) {
        const decl = findDecl(data, c);
        if (!decl) continue;
        for (const m of decl.members || []) {
          if (m.name === member && (m.kind === 'prop' || m.kind === 'fun')) {
            res.push({ name: `${c.name}.${m.name}`, kind: m.kind, file: c.file, line: m.lineStart, lineEnd: m.lineEnd });
          }
        }
      }
    }
  }

  if (!res.length) { out.push('Не найдено: ' + name); return; }
  const L = [];
  const seen = new Set();
  for (const r of res) {
    const key = r.name + '|' + r.kind + '|' + r.file;
    if (seen.has(key)) continue;
    seen.add(key);
    const role = r.role ? `  (${r.role})` : '';
    L.push(`${r.name}  ${r.kind}${role}  ${r.file}:${r.line}${r.lineEnd && r.lineEnd !== r.line ? '-' + r.lineEnd : ''}`);
  }
  out.push(L.join('\n'));
}

// ---------- граф связей ----------

function resolveGraphEndpoint(data, val) {
  if (!val) die('нужен file= или name=');
  const cls = findClasses(data, val);
  if (cls.length) return cls.map(c => c.file);
  const layout = data.xml.layouts.find(l => l.name === val || l.bindingClass === val);
  if (layout) return [layout.rel];
  const fn = data.functions.find(f => f.name === val && !f.prop);
  if (fn) return [fn.file];
  const rel = resolveFileArg(data, val);
  if (rel) return [rel];
  die('не найден: ' + val);
}

function groupByType(edges) {
  const byType = {};
  for (const e of edges) (byType[e.type] = byType[e.type] || []).push(e);
  return byType;
}

function opDeps(data, p, out) {
  const targets = [...new Set(resolveGraphEndpoint(data, p.file || p.name))];
  const L = [];
  for (const t of targets) {
    L.push(t + ' — зависимости:');
    const es = data.edges.filter(e => e.from === t);
    if (!es.length) { L.push('  (нет)'); continue; }
    for (const [type, list] of Object.entries(groupByType(es))) {
      L.push(`  ${type} (${list.length}):`);
      for (const e of list.slice(0, 40)) L.push(`    ${e.to}${e.line ? ':' + e.line : ''}`);
      if (list.length > 40) L.push(`    … ещё ${list.length - 40}`);
    }
  }
  out.push(L.join('\n'));
}

function opRdeps(data, p, out) {
  const targets = [...new Set(resolveGraphEndpoint(data, p.file || p.name))];
  const L = [];
  for (const t of targets) {
    L.push(t + ' — кто зависит:');
    const es = data.edges.filter(e => e.to === t);
    if (!es.length) { L.push('  (никто)'); continue; }
    for (const [type, list] of Object.entries(groupByType(es))) {
      L.push(`  ${type} (${list.length}):`);
      for (const e of list.slice(0, 40)) L.push(`    ${e.from}${e.line ? ':' + e.line : ''}`);
      if (list.length > 40) L.push(`    … ещё ${list.length - 40}`);
    }
  }
  out.push(L.join('\n'));
}

function opPath(data, p, out) {
  const a = p.a || p.file || p.from;
  const b = p.b || p.name || p.to;
  if (!a || !b) die('path: нужны a= и b=');
  if (a === b) { out.push('a и b совпадают.'); return; }
  const starts = [...new Set(resolveGraphEndpoint(data, a))];
  const goals = new Set(resolveGraphEndpoint(data, b));
  const undirected = pbool(p, 'undirected', false);
  const q = starts.map(s => ({ node: s, path: [s], edges: [] }));
  const seen = new Set(starts);
  let found = null;
  let qi = 0;
  while (qi < q.length && !found) {
    const cur = q[qi++];
    for (const e of data.edges) {
      let nxt = null;
      if (e.from === cur.node) nxt = e.to;
      else if (undirected && e.to === cur.node) nxt = e.from;
      else continue;
      if (seen.has(nxt)) continue;
      seen.add(nxt);
      const nq = { node: nxt, path: [...cur.path, nxt], edges: [...cur.edges, e] };
      if (goals.has(nxt)) { found = nq; break; }
      q.push(nq);
    }
  }
  if (!found) { out.push(`Путь не найден: ${a} -> ${b}`); return; }
  const L = [`Путь (${found.edges.length} связей):`];
  for (const e of found.edges) L.push(`  ${e.from} --${e.type}--> ${e.to}`);
  out.push(L.join('\n'));
}

function opNode(data, p, out) {
  const targets = [...new Set(resolveGraphEndpoint(data, p.file || p.name))];
  const L = [];
  for (const t of targets) {
    const outs = data.edges.filter(e => e.from === t);
    const ins = data.edges.filter(e => e.to === t);
    L.push(`== ${t}`);
    const role = data.classes.filter(c => c.file === t).map(c => `${c.name} (${c.role || c.kind})`).join(', ');
    if (role) L.push('классы: ' + role);
    L.push(`исходящие: ${outs.length}` + (outs.length ? ' (' + Object.entries(groupByType(outs)).map(([k, v]) => k + ' ' + v.length).join(', ') + ')' : ''));
    L.push(`входящие: ${ins.length}` + (ins.length ? ' (' + Object.entries(groupByType(ins)).map(([k, v]) => k + ' ' + v.length).join(', ') + ')' : ''));
    const topIn = [...ins].sort((x, y2) => (y2.line || 0) - (x.line || 0)).slice(0, 10);
    if (topIn.length) {
      L.push('кто ссылается:');
      for (const e of topIn) L.push(`  ${e.type} <- ${e.from}${e.line ? ':' + e.line : ''}`);
    }
  }
  out.push(L.join('\n'));
}

function opStats(data, p, out) {
  const L = [];
  const ktCount = data.files.filter(f => f.cls === 'kt').length;
  const javaCount = data.files.filter(f => f.cls === 'java').length;
  L.push(`Файлы: kt ${ktCount}, java ${javaCount}; классов ${data.classes.length}; верхнеуровневых функций ${data.functions.filter(f => !f.prop).length}`);
  const byType = groupByType(data.edges);
  L.push('Рёбра: ' + Object.entries(byType).map(([k, v]) => `${k} ${v.length}`).join(', ') + ` (всего ${data.edges.length})`);
  const deg = {};
  for (const e of data.edges) {
    deg[e.from] = deg[e.from] || { out: 0, in: 0 };
    deg[e.to] = deg[e.to] || { out: 0, in: 0 };
    deg[e.from].out++;
    deg[e.to].in++;
  }
  const topOut = Object.entries(deg).sort((a, b) => b[1].out - a[1].out).slice(0, 10);
  const topIn = Object.entries(deg).sort((a, b) => b[1].in - a[1].in).slice(0, 10);
  L.push('Топ по исходящим:');
  for (const [f, d] of topOut) L.push(`  ${d.out}  ${f}`);
  L.push('Топ по входящим:');
  for (const [f, d] of topIn) L.push(`  ${d.in}  ${f}`);
  out.push(L.join('\n'));
}

// ---------- impls ----------

function opImpls(data, p, out) {
  const name = p.name || p.file;
  if (!name) die('impls: нужен name=');
  const cls = findClasses(data, name);
  if (!cls.length) { out.push('Класс не найден: ' + name); return; }
  const depth = pint(p, 'depth', 3);
  const L = [];
  const seen = new Set();
  const walk = (c, d) => {
    const children = data.classes.filter(x =>
      x.fq !== c.fq && (x.supertypes || []).some(s => s === c.name || s === c.fq));
    for (const ch of children) {
      if (seen.has(ch.fq)) continue;
      seen.add(ch.fq);
      L.push(`${'  '.repeat(d)}${ch.name}${ch.file !== c.file ? '  (' + (ch.role || ch.kind) + (ch.abstract ? ', abstract' : '') + ')  ' + ch.file + ':' + ch.lineStart : '  (' + (ch.role || ch.kind) + ', ' + ch.file + ':' + ch.lineStart + ')'}`);
      if (d < depth) walk(ch, d + 1);
    }
  };
  for (const c of cls) {
    L.push(`${c.name} (${c.role || c.kind}${c.abstract ? ', abstract' : ''})  ${c.file}:${c.lineStart}`);
    walk(c, 1);
  }
  if (L.length === cls.length) L.push('Наследников в проекте нет.');
  out.push(L.join('\n'));
}

// ---------- manifest ----------

const normModule = (s) => String(s || '').replace(/^:/, '');

function opManifest(data, p, out) {
  const q = p.query ? String(p.query).toLowerCase() : null;
  const kindFilter = p.kind || p.tag || null;
  const moduleFilter = p.module ? normModule(p.module) : null;
  const L = [];
  let printed = false;
  for (const man of data.xml.manifests) {
    if (moduleFilter && normModule(man.module) !== moduleFilter) continue;
    const mod = data.modules.find(m => m.name === man.module);
    const ns = (mod && mod.namespace) || '';
    L.push(`Манифест: ${man.rel} (модуль ${man.module || '—'}, namespace ${ns || 'не задан'})`);
    printed = true;
    if (man.permissions.length) L.push('разрешения: ' + man.permissions.map(x => x.replace('android.permission.', '')).join(', '));
    if (man.features.length) L.push('uses-feature: ' + man.features.map(x => x.replace('android.hardware.', '')).join(', '));
    const app = man.application;
    if (app) {
      const a = app.attrs;
      const bits = [];
      if (a['android:name']) {
        let n = a['android:name'];
        if (n.startsWith('.')) n = ns + n;
        bits.push('name=' + n);
        const cls = data.classes.find(c => c.fq === n);
        if (cls) bits.push('класс ' + cls.file + ':' + cls.lineStart);
      }
      for (const key of ['android:label', 'android:theme', 'android:allowBackup', 'android:icon']) {
        if (a[key]) bits.push(key.replace('android:', '') + '=' + a[key]);
      }
      if (bits.length) L.push('application: ' + bits.join(', '));
    }
    for (const comp of man.components) {
      if (kindFilter && comp.tag !== kindFilter) continue;
      let cn = comp.attrs['android:name'] || '(без имени)';
      if (cn.startsWith('.')) cn = ns + cn;
      else if (!cn.includes('.')) cn = ns + '.' + cn;
      const low = cn.toLowerCase();
      const inFilterText = comp.filters.some(f =>
        f.actions.some(x => x.toLowerCase().includes(q || '\x00')) ||
        f.categories.some(x => x.toLowerCase().includes(q || '\x00')));
      if (q && !low.includes(q) && !comp.tag.includes(q) && !(comp.attrs['android:permission'] || '').toLowerCase().includes(q) && !inFilterText) continue;
      const exported = comp.attrs['android:exported'];
      const eff = exported !== undefined ? exported : (comp.filters.length ? '(true: есть intent-filter)' : 'false');
      const extras = [];
      if (comp.attrs['android:permission']) extras.push('permission=' + comp.attrs['android:permission']);
      if (comp.attrs['android:authorities']) extras.push('authorities=' + comp.attrs['android:authorities']);
      const cls = data.classes.find(c => c.fq === cn);
      L.push(`${comp.tag} ${cn}${extras.length ? ' [' + extras.join(', ') + ']' : ''} exported=${eff}` + (cls ? `  ${cls.file}:${cls.lineStart}` : ''));
      for (const f of comp.filters) {
        const parts = [];
        if (f.actions.length) parts.push('action ' + f.actions.map(x => x.replace('android.intent.action.', '')).join('+'));
        if (f.categories.length) parts.push('category ' + f.categories.map(x => x.replace('android.intent.category.', '')).join('+'));
        for (const d of f.datas) {
          const ds = [d['android:scheme'], d['android:host'], d['android:pathPrefix'] || d['android:pathPattern'] || d['android:path']].filter(Boolean).join('://');
          if (ds) parts.push('data ' + ds.replace(':///', '/'));
        }
        L.push('  intent-filter: ' + parts.join(' | '));
      }
    }
  }
  if (!printed) { out.push('Манифест не найден' + (moduleFilter ? ' для модуля ' + moduleFilter : '') + '.'); return; }
  const warns = data.warnings.filter(w => w.startsWith('manifest:'));
  if (warns.length && !q && !kindFilter) {
    L.push('');
    L.push('Предупреждения:');
    for (const w of warns) L.push('⚠ ' + w);
  }
  out.push(L.join('\n'));
}

// ---------- общие помощники room/di/api ----------

function declMembersFlat(decl) {
  // все члены класса, включая вложенные object/companion
  const out = [];
  const walk = (ms) => {
    for (const m of ms || []) {
      if (m && ['class', 'interface', 'object', 'companion', 'enum'].includes(m.kind)) walk(m.members);
      else if (m && m.kind) out.push(m);
    }
  };
  walk(decl && decl.members);
  return out;
}

function reEsc(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function sqlOfAnno(raw) {
  // @Query("SELECT ..." + "...") -> склеенный SQL из строковых литералов
  return [...String(raw).matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(m => m[1]).join(' ').replace(/\s+/g, ' ').trim();
}

function tablesInSql(sql, tables) {
  const hits = [];
  for (const t of tables) {
    if (new RegExp('(?:FROM|JOIN|INTO|UPDATE|TABLE)\\s+[`\\[]?' + reEsc(t.table) + '\\b', 'i').test(sql)) hits.push(t.table);
  }
  return hits;
}

// ---------- room ----------

function opRoom(data, p, out) {
  const L = [];
  const tables = data.tables || [];
  const daoEntries = [];
  for (const c of data.classes) {
    if (c.role !== 'dao') continue;
    daoEntries.push({ c, members: declMembersFlat(findDecl(data, c)) });
  }
  const tableOfEntity = new Map();
  for (const t of tables) tableOfEntity.set(t.cls, t.table);

  // какие таблицы трогает метод DAO: SQL у @Query, тип параметра у @Insert/@Update/@Delete/@Upsert
  const methodTables = (m) => {
    const annos = m.annos || [];
    const q = annos.find(a => a.name === '@Query');
    if (q) return tablesInSql(sqlOfAnno(q.raw), tables);
    const verb = annos.find(a => /^@(Insert|Update|Delete|Upsert)$/.test(a.name));
    if (!verb) return [];
    const hits = [];
    for (const pp of m.params || []) {
      const inner = /<(.+)>/.exec(pp.type || '');
      const entity = inner ? inner[1].replace(/[?\s]/g, '') : (pp.baseType || '');
      const tb = tableOfEntity.get(entity);
      if (tb) hits.push(tb);
    }
    return [...new Set(hits)];
  };

  if (p.table) {
    const table = String(p.table);
    const t = tables.find(x => x.table === table);
    if (!t) die('room: таблица не найдена: ' + table + ' (есть: ' + (tables.map(x => x.table).join(', ') || 'нет') + ')');
    const ent = data.classes.find(c => c.role === 'entity' && c.name === t.cls);
    L.push(`Таблица ${table} — сущность ${t.cls} (${t.file}:${t.line})`);
    if (ent) {
      const cols = (ent.ctorParams || []).map(pp => {
        const pk = (pp.annos || []).includes('@PrimaryKey') ? ' [PK]' : '';
        return `${pp.name}: ${pp.type || '?'}${pk}`;
      });
      if (cols.length) { L.push('Колонки:'); for (const c of cols) L.push('  ' + c); }
      for (const raw of ent.annoRaw || []) {
        if (/ForeignKey|indices\s*=|Index\(/.test(raw)) L.push('  ' + trimTo(raw.replace(/\s+/g, ' '), 160));
      }
    }
    L.push('Обращения к таблице:');
    let any = false;
    for (const d of daoEntries) {
      for (const m of d.members) {
        if (m.kind !== 'fun' || !(m.annos || []).length) continue;
        if (!methodTables(m).includes(table)) continue;
        any = true;
        const verb = (m.annos || []).map(a => a.name).join(' ');
        L.push(`  ${d.c.name}#${m.name} ${verb} (${d.c.file}:${m.lineStart})`);
        const q = (m.annos || []).find(a => a.name === '@Query');
        if (q) L.push(`    SQL: ${trimTo(sqlOfAnno(q.raw), 160)}`);
      }
    }
    if (!any) L.push('  (нет — таблица не используется в DAO)');
    out.push(L.join('\n'));
    return;
  }

  if (p.cls) {
    const found = findClasses(data, String(p.cls)).filter(c => c.role === 'dao');
    if (!found.length) die('room: DAO не найден: ' + p.cls);
    for (const c of found) {
      const d = daoEntries.find(x => x.c === c);
      L.push(`${c.fq} (${c.file}:${c.lineStart})`);
      let any = false;
      for (const m of d.members) {
        const annos = (m.annos || []).map(a => a.name).join(' ');
        if (m.kind !== 'fun' || !annos) continue;
        any = true;
        const hits = methodTables(m);
        L.push(`  ${funSigLine(m)} ${annos}${hits.length ? '  [таблицы: ' + hits.join(', ') + ']' : ''} (${m.lineStart})`);
        const q = (m.annos || []).find(a => a.name === '@Query');
        if (q) L.push(`    SQL: ${trimTo(sqlOfAnno(q.raw), 160)}`);
      }
      if (!any) L.push('  (методов с Room-аннотациями нет)');
    }
    out.push(L.join('\n'));
    return;
  }

  // обзор
  const dbs = data.classes.filter(c => c.role === 'database' || (c.annos || []).includes('@Database'));
  if (!tables.length && !daoEntries.length && !dbs.length) {
    out.push('Room не обнаружен: нет @Entity/@Dao/@Database.');
    return;
  }
  L.push(`Room: сущностей ${tables.length}, DAO ${daoEntries.length}, баз ${dbs.length}`);
  for (const db of dbs) {
    const rawAll = (db.annoRaw || []).join(' ');
    const ents = /\[([^\]]*)\]/.exec(/entities\s*=\s*\[[^\]]*\]/.exec(rawAll) || []);
    const entList = ents ? ents[1].split(',').map(x => x.replace(/::class.*/, '').trim()).filter(Boolean) : [];
    const ver = (/version\s*=\s*(\d+)/.exec(rawAll) || [])[1];
    L.push(`  База ${db.name} (v${ver || '?'}) — сущности: ${entList.join(', ') || '?'} (${db.file}:${db.lineStart})`);
    for (const m of declMembersFlat(findDecl(data, db))) {
      if (m.kind === 'fun' && m.ret) L.push(`    DAO: ${m.name}(): ${m.ret.replace(/\s+/g, '')}`);
    }
  }
  for (const t of tables) L.push(`  Таблица ${t.table} — ${t.cls} (${t.file}:${t.line})`);
  for (const d of daoEntries) {
    const n = d.members.filter(m => m.kind === 'fun' && (m.annos || []).length).length;
    L.push(`  DAO ${d.c.name} (${d.c.file}:${d.c.lineStart}) — методов: ${n}`);
  }
  out.push(L.join('\n'));
}

// ---------- di ----------

function opDi(data, p, out) {
  const L = [];
  const modules = [];
  for (const c of data.classes) {
    if (!(c.annos || []).includes('@Module')) continue;
    const provides = [];
    for (const m of declMembersFlat(findDecl(data, c))) {
      if (m.kind !== 'fun') continue;
      const a = (m.annos || []).find(x => x.name === '@Provides' || x.name === '@Binds');
      if (a) provides.push({ m, kind: a.name });
    }
    modules.push({ c, provides });
  }
  const injectables = data.classes.filter(c => (c.ctorAnnos || []).includes('@Inject'));
  const baseMatch = (t, type) => {
    const b = String(t || '').split('<')[0].split('?')[0].trim();
    return b === type || b.endsWith('.' + type);
  };

  if (p.type) {
    const type = String(p.type);
    L.push(`DI: ${type}`);
    let any = false;
    for (const mod of modules) {
      for (const pr of mod.provides) {
        if (!baseMatch(pr.m.ret, type)) continue;
        any = true;
        const scope = (pr.m.annos || []).map(a => a.name).filter(n => /^@(Singleton|.*Scoped)$/.test(n)).join(' ');
        L.push(`  связан: ${mod.c.name}#${pr.m.name}(): ${pr.m.ret} ${pr.kind}${scope ? ' ' + scope : ''} (${mod.c.file}:${pr.m.lineStart})`);
        for (const pp of pr.m.params || []) L.push(`    принимает: ${pp.name}: ${pp.type}`);
      }
    }
    for (const c of injectables) {
      if (baseMatch(c.fq, type)) { any = true; L.push(`  конструктор @Inject: ${c.fq} (${c.file}:${c.lineStart})`); }
    }
    // кто получает тип через конструктор/поле/провайдер
    const consumers = new Set();
    for (const c of data.classes) {
      for (const pp of c.ctorParams || []) {
        if (baseMatch(pp.baseType, type)) consumers.add(`  ${c.fq} (${c.file}:${c.lineStart}) [constructor]`);
      }
      const decl = findDecl(data, c);
      for (const m of (decl && decl.members) || []) {
        if (m.kind === 'prop' && (m.annos || []).some(a => a.name === '@Inject') && baseMatch(m.baseType, type)) {
          consumers.add(`  ${c.fq} поле ${m.name} (${c.file}:${m.lineStart}) [field]`);
        }
      }
    }
    for (const mod of modules) {
      for (const pr of mod.provides) {
        for (const pp of pr.m.params || []) {
          if (baseMatch(pp.baseType, type)) consumers.add(`  ${mod.c.name}#${pr.m.name} параметр ${pp.name} (${mod.c.file}:${pr.m.lineStart}) [provider]`);
        }
      }
    }
    if (consumers.size) {
      L.push('Инжектируется в:');
      for (const x of [...consumers].sort()) L.push(x);
    }
    if (!any && !consumers.size) L.push('  не найдено: ни binding, ни @Inject-конструктора, ни потребителей');
    out.push(L.join('\n'));
    return;
  }

  // обзор
  if (!modules.length && !injectables.length) {
    out.push('DI не обнаружен: нет @Module и @Inject-конструкторов.');
    return;
  }
  L.push(`DI: модулей ${modules.length}, @Inject-конструкторов ${injectables.length}`);
  for (const mod of modules) {
    const install = (/@InstallIn\s*\(([^)]*)\)/.exec((mod.c.annoRaw || []).join(' ').replace(/\s+/g, ' ')) || [])[1];
    L.push(`${mod.c.fq}${install ? ' @InstallIn(' + install.trim() + ')' : ''} (${mod.c.file}:${mod.c.lineStart})`);
    for (const pr of mod.provides) {
      const scope = (pr.m.annos || []).map(a => a.name).filter(n => /^@(Singleton|.*Scoped)$/.test(n)).join(' ');
      L.push(`  ${pr.kind} ${pr.m.name}(): ${pr.m.ret || '?'}${scope ? ' ' + scope : ''} (${pr.m.lineStart})`);
    }
  }
  for (const c of injectables) {
    const params = (c.ctorParams || []).map(pp => pp.name + ': ' + pp.type).join(', ');
    L.push(`@Inject ${c.fq}(${params}) (${c.file}:${c.lineStart})`);
  }
  const SCOPES = ['@HiltViewModel', '@AndroidEntryPoint', '@HiltAndroidApp', '@HiltWorker'];
  for (const c of data.classes) {
    const a = (c.annos || []).find(x => SCOPES.includes(x));
    if (a) L.push(`${a} ${c.fq} (${c.file}:${c.lineStart})`);
  }
  out.push(L.join('\n'));
}

// ---------- nav ----------

function opNav(data, p, out) {
  const L = [];
  const routes = data.routes || [];
  const calls = data.navCalls || [];
  const navs = data.xml.navs || [];

  if (p.route) {
    const routeArg = String(p.route);
    const hits = routes.filter(r => r.route === routeArg);
    L.push(`Маршрут ${routeArg}:`);
    if (!hits.length) L.push('  не найден среди объявленных маршрутов');
    for (const r of hits) L.push(`  объявлен: ${r.kind} (${r.file})`);
    const callers = calls.filter(c => c.target === routeArg);
    if (callers.length) {
      L.push('  переходы на маршрут:');
      for (const c of callers) L.push(`    ${c.file}:${c.line} navigate(${c.resId ? 'R.id.' : '"'}${c.target}${c.resId ? '' : '"'})`);
    } else {
      L.push('  вызовов navigate() не найдено');
    }
    for (const n of navs) {
      for (const d of n.destinations || []) {
        for (const a of d.actions || []) {
          if (a.dest === routeArg) L.push(`    ${n.rel}: action ${a.id || '?'} -> ${routeArg}`);
        }
      }
    }
    out.push(L.join('\n'));
    return;
  }

  // обзор
  if (!routes.length && !navs.length) {
    out.push('Навигация не обнаружена: нет NavHost/composable()/nav-xml.');
    return;
  }
  for (const n of navs) {
    L.push(`${n.rel} (start=${n.start || '—'})`);
    for (const d of n.destinations) {
      L.push(`  ${d.kind} ${d.id || '?'} -> ${d.name || '?'}${d.label ? ' «' + d.label + '»' : ''}`);
      for (const a of d.actions) L.push(`    action ${a.id || '?'} -> ${a.dest}`);
    }
    for (const dl of n.deepLinks || []) {
      const uri = dl['app:uri'] || dl['android:uri'];
      if (uri) L.push(`  deepLink: ${uri}${dl['android:autoVerify'] === 'true' ? ' (autoVerify)' : ''}`);
    }
  }
  const starts = routes.filter(r => r.kind === 'start' || r.kind === 'nav-start');
  const dests = routes.filter(r => r.kind === 'compose' || r.kind === 'nav-dest');
  if (dests.length) {
    L.push('Маршруты:');
    const seen = new Set();
    for (const r of dests) {
      const key = r.route + '|' + r.file;
      if (seen.has(key)) continue;
      seen.add(key);
      const n = calls.filter(c => c.target === r.route).length;
      L.push(`  ${r.route} — ${r.file}${n ? ', переходов: ' + n : ''}`);
    }
  }
  for (const s of starts) L.push(`Старт: ${s.route} (${s.file})`);
  if (calls.length) {
    L.push('Вызовы navigate():');
    for (const c of calls) L.push(`  ${c.file}:${c.line} -> ${c.target}`);
  }
  out.push(L.join('\n'));
}

// ---------- res ----------

function opRes(data, p, out) {
  const L = [];
  const valuesFiles = data.xml.values || [];
  const byKey = new Map();
  for (const vf of valuesFiles) {
    for (const [key, info] of Object.entries(vf.strMap || {})) {
      if (!byKey.has(key)) byKey.set(key, {});
      byKey.get(key)[vf.locale || 'default'] = info;
    }
  }

  if (p.name) {
    const key = String(p.name);
    const info = byKey.get(key);
    if (!info) die('res: строка не найдена: ' + key + ' (запрос без name= покажет все ключи)');
    L.push(`Строка ${key}:`);
    const locales = Object.keys(info).sort((a, b) => (a === 'default' ? -1 : b === 'default' ? 1 : a.localeCompare(b)));
    for (const loc of locales) {
      const v = info[loc];
      L.push(`  ${loc === 'default' ? 'по умолчанию' : loc}: ${trimTo(v.value, 120)}${v.translatable === false ? ' (translatable=false)' : ''}`);
    }
    const uses = [];
    for (const f of data.filesMeta) {
      const ext = path.posix.extname(f.rel);
      if (!['.kt', '.java', '.xml'].includes(ext)) continue;
      let rd;
      try { rd = readSmart(path.join(data.root, f.rel)); } catch (e) { continue; }
      const re = new RegExp('(?:R\\.string\\.|@string\\/)' + reEsc(key) + '\\b');
      const lines = rd.text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) { uses.push(`${f.rel}:${i + 1}`); break; }
      }
    }
    L.push(uses.length ? 'Используется: ' + uses.join(', ') : 'Использований не найдено (возможно, мусор)');
    out.push(L.join('\n'));
    return;
  }

  if (pbool(p, 'missing', false)) {
    const locales = [...new Set(valuesFiles.map(v => v.locale || 'default').filter(x => x !== 'default' && isLocaleQualifier(x)))];
    if (!locales.length) { out.push('Локалей со строками нет — проверять missing нечего.'); return; }
    L.push('Отсутствующие переводы (ключ есть в default, нет в локали):');
    let any = false;
    for (const [key, info] of byKey) {
      const def = info['default'];
      if (!def || def.translatable === false) continue;
      const miss = locales.filter(loc => !info[loc]);
      if (miss.length) { any = true; L.push(`  ${key} — нет в: ${miss.join(', ')}`); }
    }
    if (!any) L.push('  (всё переведено)');
    const defKeys = new Set([...byKey.entries()].filter(([, v]) => v['default']).map(([k]) => k));
    const extra = [];
    for (const [key, info] of byKey) {
      if (defKeys.has(key)) continue;
      extra.push(`  ${key} (есть только в: ${Object.keys(info).join(', ')})`);
    }
    if (extra.length) { L.push('Ключи без значения по умолчанию:'); for (const e of extra) L.push(e); }
    out.push(L.join('\n'));
    return;
  }

  // обзор
  L.push(`Строковые ресурсы: файлов ${valuesFiles.length}, ключей ${byKey.size}`);
  for (const vf of valuesFiles) {
    L.push(`  ${vf.rel} — ${Object.keys(vf.strMap || {}).length} строк, ${vf.module ? vf.module + ', ' : ''}квалификатор: ${vf.locale || 'default'}`);
  }
  out.push(L.join('\n'));
}

// ---------- api ----------

function opApi(data, p, out) {
  const L = [];
  const apis = data.classes.filter(c => c.role === 'api');
  const urlFilter = p.url ? String(p.url) : null;
  const clsFilter = p.cls ? findClasses(data, String(p.cls)) : null;
  const HTTP_RE = /^@(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|HTTP)$/;

  // baseUrl ищем по исходникам (Retrofit.Builder().baseUrl("..."))
  let baseUrl = null;
  if (apis.length && pbool(p, 'base', true)) {
    for (const f of data.filesMeta) {
      const ext = path.posix.extname(f.rel);
      if (ext !== '.kt' && ext !== '.java') continue;
      let rd;
      try { rd = readSmart(path.join(data.root, f.rel)); } catch (e) { continue; }
      const m = /baseUrl\s*\(\s*"([^"]+)"/.exec(rd.text);
      if (m) { baseUrl = m[1]; break; }
    }
  }

  let count = 0;
  for (const c of apis) {
    if (clsFilter && !clsFilter.includes(c)) continue;
    const methods = [];
    for (const m of declMembersFlat(findDecl(data, c))) {
      if (m.kind !== 'fun') continue;
      const a = (m.annos || []).find(x => HTTP_RE.test(x.name));
      if (!a) continue;
      let verb = a.name.slice(1), url = '';
      if (a.name === '@HTTP') {
        verb = (/method\s*=\s*"(\w+)"/.exec(a.raw || '') || [])[1] || 'HTTP';
        url = (/path\s*=\s*"([^"]*)"/.exec(a.raw || '') || [])[1] || '';
      } else {
        url = (/"((?:[^"\\]|\\.)*)"/.exec(a.raw || '') || [])[1] || '';
      }
      if (urlFilter && !url.includes(urlFilter)) continue;
      const params = (m.params || []).map(pp => {
        const marker = (pp.annos || []).filter(n => /^@(Path|Query|Body|Header|Field|Part|Url|HeaderMap|QueryMap|PartMap)$/.test(n)).join('');
        return `${marker ? marker + ' ' : ''}${pp.name}: ${pp.type}`;
      }).join(', ');
      methods.push(`${verb.padEnd(7)} ${url || '?'} ${m.name}(${params})${m.ret ? ': ' + m.ret : ''} (${m.lineStart})`);
    }
    if (!methods.length) continue;
    count += methods.length;
    L.push(`${c.fq} (${c.file}:${c.lineStart})`);
    if (baseUrl) L.push(`  baseUrl: ${baseUrl}`);
    for (const x of methods) L.push('  ' + x);
  }
  if (!L.length) {
    out.push(urlFilter ? `API-методы с url, содержащей "${urlFilter}", не найдены.` : 'Retrofit-интерфейсы не обнаружены (@GET/@POST/...).');
    return;
  }
  L.push(`Всего endpoint'ов: ${count}`);
  out.push(L.join('\n'));
}

// ---------- sig: сигнатуры из jar/aar ----------

function zipEntries(buf) {
  // EOCD
  let eocd = -1;
  const start = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= start; i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const cdCount = buf.readUInt16LE(eocd + 10);
  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < cdCount; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    entries.push({ name, method, compSize, uncompSize, lho });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function zipRead(buf, entry) {
  const p = entry.lho;
  if (buf.readUInt32LE(p) !== 0x04034b50) return null;
  const nameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  const dataStart = p + 30 + nameLen + extraLen;
  const raw = buf.slice(dataStart, dataStart + entry.compSize);
  if (entry.method === 0) return raw;
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  return null;
}

function zipFind(buf, name) {
  const entries = zipEntries(buf);
  if (!entries) return null;
  const e = entries.find(x => x.name === name);
  return e ? zipRead(buf, e) : null;
}

function zipHas(buf, name) {
  const entries = zipEntries(buf);
  if (!entries) return false;
  return entries.some(x => x.name === name);
}

// Разбор .class (только public/protected члены, generic из Signature).
function parseClassFile(buf) {
  if (buf.length < 10 || buf.readUInt32BE(0) !== 0xCAFEBABE) return null;
  let p = 8;
  const cpCount = buf.readUInt16BE(p); p += 2;
  const cp = new Array(cpCount);
  for (let i = 1; i < cpCount; i++) {
    const tag = buf[p]; p++;
    switch (tag) {
      case 1: { const len = buf.readUInt16BE(p); p += 2; cp[i] = { tag, str: buf.slice(p, p + len).toString('utf8') }; p += len; break; }
      case 3: case 4: cp[i] = { tag }; p += 4; break;
      case 5: case 6: cp[i] = { tag }; p += 8; i++; break;
      case 7: cp[i] = { tag, idx: buf.readUInt16BE(p) }; p += 2; break;
      case 8: case 16: case 19: case 20: cp[i] = { tag, idx: buf.readUInt16BE(p) }; p += 2; break;
      case 9: case 10: case 11: case 12: case 17: case 18: cp[i] = { tag, a: buf.readUInt16BE(p), b: buf.readUInt16BE(p + 2) }; p += 4; break;
      case 15: cp[i] = { tag, a: buf[p], idx: buf.readUInt16BE(p + 1) }; p += 3; break;
      default: return null;
    }
  }
  const utf = (i) => (cp[i] && cp[i].tag === 1) ? cp[i].str : null;
  const clsName = (i) => {
    const e = cp[i];
    if (!e || e.tag !== 7) return null;
    const s = utf(e.idx);
    return s ? s.replace(/\//g, '.') : null;
  };
  const acc = buf.readUInt16BE(p); p += 2;
  const thisClass = clsName(buf.readUInt16BE(p)); p += 2;
  const superClassIdx = buf.readUInt16BE(p); p += 2;
  const superClass = superClassIdx ? clsName(superClassIdx) : null;
  const ifCount = buf.readUInt16BE(p); p += 2;
  const interfaces = [];
  for (let i = 0; i < ifCount; i++) { interfaces.push(clsName(buf.readUInt16BE(p))); p += 2; }
  const out = { thisClass, superClass, interfaces, acc, fields: [], methods: [] };
  const readMembers = () => {
    const count = buf.readUInt16BE(p); p += 2;
    const members = [];
    for (let i = 0; i < count; i++) {
      const mAcc = buf.readUInt16BE(p); p += 2;
      const mName = utf(buf.readUInt16BE(p)); p += 2;
      const mDesc = utf(buf.readUInt16BE(p)); p += 2;
      let signature = null, deprecated = false;
      const aCount = buf.readUInt16BE(p); p += 2;
      for (let j = 0; j < aCount; j++) {
        const aName = utf(buf.readUInt16BE(p)); p += 2;
        const aLen = buf.readUInt32BE(p); p += 4;
        const aBody = buf.slice(p, p + aLen); p += aLen;
        if (aName === 'Signature') signature = utf(aBody.readUInt16BE(0));
        if (aName === 'Deprecated') deprecated = true;
      }
      members.push({ acc: mAcc, name: mName, desc: mDesc, signature, deprecated });
    }
    return members;
  };
  out.fields = readMembers();
  out.methods = readMembers();
  out.utf = utf;
  return out;
}

function parseFieldDesc(d) {
  // "Ljava/lang/String;" -> "java.lang.String"
  let dims = 0;
  while (d.startsWith('[')) { dims++; d = d.slice(1); }
  let base;
  if (d.startsWith('L')) base = d.slice(1, -1).replace(/\//g, '.');
  else base = { B: 'byte', C: 'char', D: 'double', F: 'float', I: 'int', J: 'long', S: 'short', Z: 'boolean', V: 'void' }[d[0]] || d;
  return base + '[]'.repeat(dims);
}

function parseMethodDesc(desc) {
  const params = [];
  let i = 1;
  while (i < desc.length && desc[i] !== ')') {
    let dims = 0;
    while (desc[i] === '[') { dims++; i++; }
    let base;
    if (desc[i] === 'L') {
      const e = desc.indexOf(';', i);
      base = desc.slice(i + 1, e).replace(/\//g, '.');
      i = e + 1;
    } else {
      base = { B: 'byte', C: 'char', D: 'double', F: 'float', I: 'int', J: 'long', S: 'short', Z: 'boolean', V: 'void' }[desc[i]] || desc[i];
      i++;
    }
    params.push(base + '[]'.repeat(dims));
  }
  const retStart = desc.indexOf(')') + 1;
  const ret = parseFieldDesc(desc.slice(retStart));
  return { params, ret };
}

function parseGenericSig(sig) {
  // Упрощённый разбор Signature-атрибута: <K:Ljava/lang/Object;>Lkotlin/Pair<TK;TV;>;
  let s = sig;
  const gt = s.indexOf('<');
  if (gt === 0) {
    // пропуск объявления type-параметров класса
    let d = 0, i = 0;
    while (i < s.length) {
      if (s[i] === '<') d++;
      else if (s[i] === '>') { d--; if (d === 0) { i++; break; } }
      i++;
    }
    s = s.slice(i);
  }
  return s;
}

function parseSigType(s, i0) {
  // Разбор одного типа из generic-сигнатуры. Возвращает { text, i }.
  let i = i0;
  let variance = '';
  if (s[i] === '+' || s[i] === '-') { variance = s[i] === '+' ? '? extends ' : '? super '; i++; }
  else if (s[i] === '*') return { text: '?', i: i + 1 };
  let dims = 0;
  while (s[i] === '[') { dims++; i++; }
  let text;
  if (s[i] === 'T') {
    const e = s.indexOf(';', i);
    text = s.slice(i + 1, e);
    i = e + 1;
  } else if (s[i] === 'L') {
    i++;
    let name = '';
    const args = [];
    while (i < s.length) {
      const c = s[i];
      if (c === '<') {
        i++;
        while (i < s.length && s[i] !== '>') {
          const r = parseSigType(s, i);
          args.push(r.text);
          i = r.i;
        }
        i++; // '>'
        continue;
      }
      if (c === ';') { i++; break; }
      name += (c === '/' || c === '.' || c === '$') ? '.' : c;
      i++;
    }
    text = args.length ? name + '<' + args.join(', ') + '>' : name;
  } else {
    const prim = { B: 'byte', C: 'char', D: 'double', F: 'float', I: 'int', J: 'long', S: 'short', Z: 'boolean', V: 'void' }[s[i]];
    text = prim || s[i];
    i++;
  }
  return { text: variance + text + '[]'.repeat(dims), i };
}

function genericSigToType(sig) {
  // Lkotlin/Pair<TK;TV;>; -> kotlin.Pair<K, V>
  try {
    const r = parseSigType(sig, 0);
    return r.text;
  } catch (e) { return sig; }
}

function accFlags(a) {
  const f = [];
  if (a & 0x0001) f.push('public');
  if (a & 0x0004) f.push('protected');
  if (a & 0x0002) f.push('private');
  if (a & 0x0010) f.push('final');
  if (a & 0x0008) f.push('static');
  if (a & 0x0400) f.push('abstract');
  if (a & 0x0020) f.push('synchronized') ;
  return f;
}

function findJarsFor(data, p) {
  const dirs = [];
  if (p.jars) for (const d of String(p.jars).split(',')) if (d.trim()) dirs.push({ path: path.resolve(d.trim()), hint: false });
  if (process.env.KT_JARS) for (const d of process.env.KT_JARS.split(path.delimiter)) if (d.trim()) dirs.push({ path: d.trim(), hint: false });
  // libs-каталоги модулей
  for (const m of data.modules) {
    const libs = m.dir ? path.join(data.root, m.dir, 'libs') : path.join(data.root, 'libs');
    if (fs.existsSync(libs)) dirs.push({ path: libs, hint: false });
  }
  // gradle cache — большой, фильтруем по сегменту пакета
  const gradleCache = path.join(os.homedir(), '.gradle', 'caches', 'modules-2', 'files-2.1');
  if (fs.existsSync(gradleCache)) dirs.push({ path: gradleCache, hint: true });
  return dirs;
}

function searchJarFiles(dirs, hint, jarFilter) {
  const out = [];
  // фильтр по последнему сегменту пакета: retrofit2.Retrofit -> пути с retrofit2
  let segHint = null;
  if (hint && hint.includes('.')) {
    const segs = hint.split('.');
    segHint = segs[segs.length - 2] || segs[0];
  }
  const walk = (dir, depth, useHint) => {
    if (out.length > 2000 || depth > 9) return;
    let names;
    try { names = fs.readdirSync(dir); } catch (e) { return; }
    for (const n of names) {
      const fp = path.join(dir, n);
      let st;
      try { st = fs.statSync(fp); } catch (e) { continue; }
      if (st.isDirectory()) walk(fp, depth + 1, useHint);
      else if (/\.(jar|aar)$/.test(n)) {
        const norm = fp.replace(/\\/g, '/');
        if (jarFilter && !norm.toLowerCase().includes(String(jarFilter).toLowerCase())) continue;
        if (useHint && !jarFilter && segHint && !norm.toLowerCase().includes(segHint.toLowerCase())) continue;
        out.push({ fp, size: st.size });
      }
    }
  };
  for (const d of dirs) walk(d.path, 0, !!d.hint);
  return out;
}

function versionOfJarPath(fp) {
  const m = /-(\d+(?:\.\d+)*(?:-[.\w]+)?)\.(?:jar|aar)$/.exec(fp);
  if (m) return m[1];
  const segs = fp.split(path.sep);
  for (let i = segs.length - 2; i >= 0; i--) {
    if (/^\d/.test(segs[i])) return segs[i];
  }
  return '0';
}

function cmpVer(a, b) {
  const pa = String(a).split(/[.-]/).map(x => /^\d+$/.test(x) ? parseInt(x, 10) : x);
  const pb = String(b).split(/[.-]/).map(x => /^\d+$/.test(x) ? parseInt(x, 10) : x);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i], y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (typeof x === 'number' && typeof y === 'number') { if (x !== y) return x - y; }
    else { const c = String(x).localeCompare(String(y)); if (c) return c; }
  }
  return 0;
}

function shortToFull(data, name) {
  if (name.includes('.')) return name;
  for (const f of data.files) {
    for (const imp of f.imports || []) {
      if (imp.name.endsWith('.' + name)) return imp.name;
    }
  }
  return null;
}

function opSig(data, p, out) {
  let name = p.name || p.query;
  if (!name) die('sig: нужен name=');
  let member = null;
  if (name.includes('#')) { member = name.slice(name.indexOf('#') + 1); name = name.slice(0, name.indexOf('#')); }
  const full = shortToFull(data, name) || name;
  const jarFilter = p.jar ? String(p.jar) : null;
  const dirs = findJarsFor(data, p);
  const candidates = searchJarFiles(dirs, full, jarFilter);
  const classEntry = full.replace(/\./g, '/') + '.class';

  const found = [];
  for (const c of candidates) {
    let buf;
    try { buf = fs.readFileSync(c.fp); } catch (e) { continue; }
    let classBytes = null, jarName = c.fp;
    if (c.fp.endsWith('.aar')) {
      const inner = zipFind(buf, 'classes.jar');
      if (!inner) continue;
      classBytes = zipFind(inner, classEntry);
    } else {
      if (!zipHas(buf, classEntry)) continue;
      classBytes = zipFind(buf, classEntry);
    }
    if (classBytes) found.push({ path: jarName, buf: classBytes, ver: versionOfJarPath(c.fp) });
    if (found.length >= 30) break;
  }
  if (!found.length) {
    out.push(`Класс ${full} не найден в jar/aar.` +
      (candidates.length ? ` Просмотрено файлов: ${candidates.length}.` : ' Каталоги не заданы (см. references/android.md: KT_JARS, jars=, libs/).'));
    return;
  }
  found.sort((a, b) => cmpVer(b.ver, a.ver));
  const best = found[0];
  const cf = parseClassFile(best.buf);
  if (!cf) { out.push('Не удалось разобрать .class (версия файла не поддерживается).'); return; }

  const L = [];
  const accs = accFlags(cf.acc);
  const kind = (cf.acc & 0x0200) ? 'interface' : ((cf.acc & 0x4000) ? 'enum' : 'class');
  L.push(`${accs.includes('public') ? 'public ' : ''}${cf.acc & 0x0010 ? 'final ' : ''}${kind} ${cf.thisClass}` + (member ? `  (член: ${member})` : ''));
  if (cf.superClass && kind === 'class') L.push(`  extends ${cf.superClass}`);
  if (cf.interfaces.length) L.push(`  implements ${cf.interfaces.join(', ')}`);
  L.push(`  из: ${path.basename(best.path)} (${best.ver}${found.length > 1 ? `, других версий: ${found.length - 1}` : ''})`);

  // поля
  const fieldLines = [];
  for (const m of cf.fields) {
    const fl = accFlags(m.acc);
    if (!fl.includes('public') && !fl.includes('protected')) continue;
    if (m.name.includes('$')) continue;
    const type = m.signature ? genericSigToType(m.signature) : parseFieldDesc(m.desc);
    const extra = fl.filter(x => !['public', 'protected', 'private'].includes(x)).join(' ');
    fieldLines.push(`  ${extra ? extra + ' ' : ''}${type} ${m.name}${m.deprecated ? ' [deprecated]' : ''}`);
  }
  // методы и конструкторы
  const methodLines = [];
  for (const m of cf.methods) {
    const fl = accFlags(m.acc);
    if (!fl.includes('public') && !fl.includes('protected')) continue;
    if (m.name.includes('$') || m.name === '<clinit>') continue;
    if (member && m.name !== member && m.name !== '<init>') continue;
    const d = parseMethodDesc(m.desc);
    let params = d.params.slice();
    let ret = d.ret;
    if (m.signature) {
      const par = /^\((.*)\)(.*)$/.exec(m.signature);
      if (par) {
        const ps = [];
        let i = 0;
        while (i < par[1].length) { const r = parseSigType(par[1], i); ps.push(r.text); i = r.i; }
        if (ps.length) params = ps;
        if (par[2]) ret = genericSigToType(par[2]);
      }
    }
    const argList = params.map((x, i2) => `arg${i2}: ${x}`).join(', ');
    const extra = fl.filter(x => !['public', 'protected', 'private', 'synchronized', 'abstract'].includes(x)).join(' ');
    if (m.name === '<init>') {
      methodLines.push(`  ${cf.thisClass.split('.').pop()}(${argList})${m.deprecated ? ' [deprecated]' : ''}`);
    } else {
      methodLines.push(`  ${extra ? extra + ' ' : ''}${ret} ${m.name}(${argList})${m.deprecated ? ' [deprecated]' : ''}`);
    }
  }
  if (fieldLines.length) { L.push('поля:'); L.push(...fieldLines.slice(0, 30)); }
  if (methodLines.length) { L.push('методы/конструкторы:'); L.push(...methodLines.slice(0, 60)); if (methodLines.length > 60) L.push(`  … ещё ${methodLines.length - 60}`); }
  if (member && !methodLines.length) L.push(`  член ${member} не найден или недоступен (public/protected).`);
  out.push(L.join('\n'));
}

// ---------- read / patch / create ----------

function checkInside(data, file) {
  const abs = path.resolve(data.root, file);
  if (!insideDir(data.root, abs)) die('путь вне рабочей директории: ' + file);
  return abs;
}

// Путь для read/patch: точный либо короткое имя через индекс
function resolveFilePath(data, file) {
  let abs = checkInside(data, file);
  if (fs.existsSync(abs)) return abs;
  const rel = resolveFileArg(data, file);
  if (rel) return checkInside(data, rel);
  return abs;
}

function opRead(data, p, out) {
  if (!p.file) die('read: нужен file=');
  const abs = resolveFilePath(data, p.file);
  if (!fs.existsSync(abs)) die('файл не найден: ' + p.file);
  const rd = readSmart(abs);
  const offset = pint(p, 'offset', 1);
  const limit = pint(p, 'limit', 400);
  const all = rd.text.split('\n');
  const from = Math.max(1, offset);
  const to = Math.min(all.length, from + limit - 1);
  const L = [];
  for (let i = from; i <= to; i++) L.push(String(i).padStart(4) + '  ' + all[i - 1].replace(/\r$/, ''));
  L.push(`[${p.file} ${rd.enc}${rd.bom ? ' BOM' : ''}, ${all.length} строк, показаны ${from}-${to}]`);
  out.push(L.join('\n'));
}

function opPatch(data, p, out) {
  if (!p.file || p.old === undefined || p.new === undefined) die('patch: нужны file, old, new');
  const abs = resolveFilePath(data, p.file);
  if (!fs.existsSync(abs)) die('файл не найден: ' + p.file);
  const rd = readSmart(abs);
  let text = rd.text;
  let count = 0;
  const all = pbool(p, 'all', false);
  const doReplace = (t, o, n) => {
    const first = t.indexOf(o);
    if (first < 0) return { t, n: 0 };
    if (all) {
      const parts = t.split(o);
      return { t: parts.join(n), n: parts.length - 1 };
    }
    if (t.indexOf(o, first + 1) >= 0) return { t, n: -1 };
    return { t: t.slice(0, first) + n + t.slice(first + o.length), n: 1 };
  };
  let r = doReplace(text, p.old, p.new);
  if (r.n === 0 && rd.eol === 'crlf') {
    const old2 = p.old.replace(/\n/g, '\r\n');
    const new2 = p.new.replace(/\n/g, '\r\n');
    if (old2 !== p.old) r = doReplace(text, old2, new2);
  }
  if (r.n === -1) die('patch: несколько вхождений (задай all=true или уточни фрагмент)');
  if (r.n === 0) die('patch: фрагмент не найден');
  text = r.t;
  const bufOut = encodeText(text, rd);
  fs.writeFileSync(abs, bufOut);
  out.push(`Заменено вхождений: ${r.n}; файл ${p.file} (${rd.enc}${rd.bom ? ' BOM' : ''}, ${rd.eol}) сохранён`);
}

function encodeText(text, rd) {
  let buf;
  if (rd.enc === 'utf-8') {
    buf = Buffer.from(text, 'utf8');
    if (rd.bom) buf = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), buf]);
  } else if (rd.enc === 'cp1251') buf = encodeCp1251(text);
  else if (rd.enc === 'utf-16le') {
    buf = Buffer.from(text, 'utf16le');
    if (rd.bom) buf = Buffer.concat([Buffer.from([0xFF, 0xFE]), buf]);
  } else {
    buf = Buffer.from(text, 'utf8');
  }
  return buf;
}

function opCreate(data, p, out) {
  if (!p.file || p.text === undefined) die('create: нужны file, text');
  const abs = checkInside(data, p.file);
  if (fs.existsSync(abs)) die('файл уже существует: ' + p.file);
  let text = String(p.text);
  if (!text.endsWith('\n')) text += '\n';
  // преобладающая кодировка/переводы строк в kt/java файлах
  const srcs = data.filesMeta.filter(f => f.cls === 'kt' || f.cls === 'java');
  const cp1251Count = srcs.filter(f => f.enc === 'cp1251').length;
  const nonAscii = /[^\x00-\x7F]/.test(text);
  let enc = 'utf-8';
  if (nonAscii && cp1251Count > srcs.length / 2) enc = 'cp1251';
  if (p.enc) enc = String(p.enc);
  const crlfFiles = data.files.filter(f => f.eol === 'crlf').length;
  const eol = crlfFiles > data.files.length / 2 ? 'crlf' : 'lf';
  let finalText = text;
  if (eol === 'crlf' && !finalText.includes('\r\n')) finalText = finalText.replace(/\n/g, '\r\n');
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, encodeText(finalText, { enc, bom: false, eol }));
  out.push(`Создан ${p.file} (${enc}, ${eol}, ${Buffer.byteLength(finalText, enc === 'utf-8' ? 'utf8' : 'binary')} байт)`);
}

// ---------- самопроверка ----------
// selftest — проверки чистых функций на встроенных примерах; индекс проекта не нужен: kt.js selftest

function opSelftest() {
  const bad = [];
  let total = 0;
  const chk = (name, cond, extra) => {
    total++;
    process.stdout.write((cond ? 'ok    ' : 'FAIL  ') + name + (cond ? '' : '  [' + String(extra === undefined ? '' : extra).replace(/\s+/g, ' ').slice(0, 300) + ']') + '\n');
    if (!cond) bad.push(name);
  };

  // кодировки
  const cyr = 'Привет, мир! Ёё йЙ №3';
  chk('cp1251: encode→decode', decodeCp1251(encodeCp1251(cyr)) === cyr, decodeCp1251(encodeCp1251(cyr)));
  chk('utf8: валидный UTF-8 распознаётся', isValidUtf8(Buffer.from(cyr, 'utf8')));
  chk('utf8: cp1251-байты не UTF-8', !isValidUtf8(encodeCp1251(cyr)));

  // аргументы и gradle
  const p = parseArgs(['op=outline', 'file=Foo.kt', 'flat']);
  chk('args: ключ=значение и флаг', p.op === 'outline' && p.file === 'Foo.kt' && p.flat === true);
  chk('args: pbool/pint', pbool({x: '1'}, 'x', false) === true && pbool({}, 'x', true) === true && pint({n: '42'}, 'n', 0) === 42 && pint({}, 'n', 7) === 7);
  chk('gradle: имя модуля → каталог', gradleModuleDir(':feature:login') === 'feature/login');
  const sg = parseSettingsGradle('rootProject.name = "demo"\ninclude(":app", ":core")\ninclude(":feature:login")');
  chk('settings.gradle: модули и имя', sg.rootName === 'demo' && sg.modules.join('|') === ':app|:core|:feature:login', JSON.stringify(sg));
  const toml = parseToml('[versions]\nkotlin = "2.0.0"\n\n[libraries]\nrx = { group = "io.reactivex.rxjava3", name = "rxjava", version.ref = "kotlin" }\n\n[plugins]\nandroid-app = { id = "com.android.application", version.ref = "kotlin" }');
  chk('toml: versions/libraries/plugins', toml.versions.kotlin === '2.0.0' && toml.libraries.rx.group === 'io.reactivex.rxjava3' && toml.libraries.rx.versionRef === 'kotlin' && toml.plugins['android-app'].id === 'com.android.application', JSON.stringify(toml));
  const gradle = parseModuleGradle('android {\n    namespace = "com.demo"\n    compileSdk = 34\n    buildFeatures { compose = true }\n}\ndependencies {\n    implementation(project(":core"))\n}\n');
  chk('module.gradle: namespace/sdk/compose/project', gradle.namespace === 'com.demo' && String(gradle.compileSdk) === '34' && gradle.compose === true && gradle.projectDeps.join('|') === ':core', JSON.stringify(gradle));

  // xml
  const man = parseManifestXml('<?xml version="1.0"?>\n<manifest package="com.demo">\n  <uses-permission android:name="android.permission.INTERNET"/>\n  <application>\n    <activity android:name=".MainActivity" android:exported="true">\n      <intent-filter>\n        <action android:name="android.intent.action.MAIN"/>\n      </intent-filter>\n    </activity>\n  </application>\n</manifest>');
  chk('manifest: разрешения', man.permissions.length === 1 && man.permissions[0] === 'android.permission.INTERNET', JSON.stringify(man));
  chk('manifest: компонент и intent-filter', man.components.length === 1 && man.components[0].attrs['android:name'] === '.MainActivity' && man.components[0].filters[0].actions[0] === 'android.intent.action.MAIN' && man.components[0].line === 5, JSON.stringify(man));
  const lay = parseLayoutXml('<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android">\n  <Button android:id="@+id/btn_submit" android:text="@string/title"/>\n  <TextView android:text="@string/title"/>\n</LinearLayout>');
  chk('layout: корень, id, строки', lay.root === 'LinearLayout' && lay.ids.join('|') === 'btn_submit' && lay.strings.join('|') === 'title', JSON.stringify(lay));
  const vals = parseValuesXml('<resources>\n  <string name="title">Привет</string>\n  <string name="hint" translatable="false">подсказка</string>\n</resources>');
  chk('values: строки и translatable', vals.strMap.title.value === 'Привет' && vals.strMap.title.translatable === true && vals.strMap.hint.translatable === false, JSON.stringify(vals));
  chk('unescapeRes: сущности и переносы', unescapeRes('&lt;b&gt;a&lt;/b&gt;\n  вторая') === '<b>a</b> вторая', unescapeRes('&lt;b&gt;a&lt;/b&gt;\n  вторая'));
  chk('locale: values-ru → ru', localeOfValuesRel('res/values-ru/strings.xml') === 'ru' && localeOfValuesRel('res/values/strings.xml') === 'default');
  chk('locale: квалификаторы', isLocaleQualifier('en-rGB') && isLocaleQualifier('ru') && !isLocaleQualifier('night') && !isLocaleQualifier('w600dp'));
  const nav = parseNavXml('<navigation app:startDestination="@+id/home">\n  <fragment android:id="@+id/home" android:name="com.demo.HomeFragment">\n    <action android:id="@+id/go" app:destination="@+id/details"/>\n  </fragment>\n  <fragment android:id="@+id/details" android:name="com.demo.DetailsFragment"/>\n  <deepLink android:id="@+id/link" app:uri="demo://item/{id}"/>\n</navigation>');
  chk('nav: старт, переходы, deepLink', String(nav.start).replace(/^@\+?id\//, '') === 'home' && nav.destinations.length === 2 && nav.destinations[0].actions[0].dest === 'details' && nav.deepLinks.length === 1, JSON.stringify(nav));
  chk('viewbinding: имя класса', layoutBindingClass('activity_main') === 'ActivityMainBinding' && layoutBindingClass('fragment_user_details') === 'FragmentUserDetailsBinding');

  // Kotlin-парсер
  const kt = 'package com.demo\n\nimport kotlinx.coroutines.launch\n\nclass UserService(private val repo: Repo) : BaseService() {\n    fun load(id: String): String { // комментарий\n        return "привет" // строка не попадает в санитайзер\n    }\n    suspend fun save(user: User) = repo.save(user)\n}\n';
  const parsed = parseKotlin(kt);
  const cls = parsed.decls.find((d) => d.name === 'UserService');
  chk('kotlin: package и класс', parsed.package === 'com.demo' && !!cls && cls.kind === 'class', JSON.stringify(parsed.decls).slice(0, 300));
  chk('kotlin: методы внутри класса', !!cls && ['load', 'save'].every((n) => (cls.members || []).some((d) => d.name === n)), JSON.stringify(parsed.decls).slice(0, 300));
  chk('sanitize: позиции сохранены, строки/комментарии убраны', parsed.sanitized.length === kt.length && !parsed.sanitized.includes('привет') && !parsed.sanitized.includes('комментарий') && parsed.sanitized.includes('load'));
  chk('splitTop: разделение верхнего уровня', splitTop('a, b(c, d), e', ',').length === 3 && splitTop('Map<K, V>, other', ',').length === 2);

  if (bad.length) {
    process.stdout.write('\nпровалено: ' + bad.join(', ') + '\n');
    process.exit(1);
  }
  process.stdout.write('\nвсе проверки пройдены (' + total + ')\n');
}

// ---------- диспетчер ----------

const OPS = {
  info: opInfo, search: opSearch, symbol: opSymbol, outline: opOutline,
  deps: opDeps, rdeps: opRdeps, path: opPath, node: opNode, stats: opStats,
  impls: opImpls, manifest: opManifest, sig: opSig,
  room: opRoom, di: opDi, nav: opNav, res: opRes, api: opApi,
  read: opRead, patch: opPatch, create: opCreate,
  selftest: () => opSelftest()
};

function main() {
  const p = parseArgs(process.argv.slice(2));
  const op = p.op;
  if (!op) {
    const names = Object.keys(OPS).sort().join(', ');
    process.stdout.write('Операции: ' + names + '\nОбщий параметр: root (корень проекта, по умолчанию текущая папка).\n');
    return;
  }
  if (!OPS[op]) die('неизвестная операция: ' + op + ' (доступны: ' + Object.keys(OPS).sort().join(', ') + ')');
  if (op === 'selftest') { opSelftest(); return; } // индекс проекта не нужен
  const root = p.root ? path.resolve(String(p.root)) : process.cwd();
  if (!fs.existsSync(root)) die('корень не найден: ' + root);
  const data = loadIndex(root);
  const out = [];
  OPS[op](data, p, out);
  for (const chunk of out) process.stdout.write(chunk + '\n');
}

main();

