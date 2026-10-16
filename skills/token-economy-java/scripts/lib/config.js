'use strict';
// config.js — плоский разбор конфигурации Spring Boot: YAML (подмножество: вложенные ключи, списки, несколько
// документов через «---», блочные скаляры) и .properties. Для каждого ключа сохраняются номер строки и профиль.

const SECRET = /(password|passwd|pwd|secret|token|credential|private[-_.]?key|api[-_.]?key|access[-_.]?key|client[-_.]?secret|salt)/i;

/**
 * Значение для вывода: секреты скрываются, если это не ссылка на переменную окружения ${...}.
 */
function show(key, value) {
  if (SECRET.test(key) && value && !/^\$\{[^}]*\}$/.test(value)) return '***';
  return value.length > 120 ? value.slice(0, 119) + '…' : value;
}

/** Нормализованный ключ для сравнения: kebab, camel и snake совпадают (relaxed binding). */
const norm = (k) => String(k).toLowerCase().replace(/[-_]/g, '');

function stripComment(line) {
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === q && line[i - 1] !== '\\') q = null; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

const unquote = (v) => {
  v = v.trim();
  if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) return v.slice(1, -1);
  return v;
};

/**
 * @returns {Array<{profile: string|null, entries: Array<{key: string, value: string, line: number}>}>} документы YAML.
 */
function parseYaml(text) {
  const docs = [];
  let doc = { profile: null, entries: [] };
  let stack = [];
  const lines = text.split(/\r?\n/);
  const flush = () => {
    const p = doc.entries.find((e) => e.key === 'spring.config.activate.on-profile' || e.key === 'spring.profiles');
    if (p) doc.profile = p.value;
    if (doc.entries.length) docs.push(doc);
    doc = { profile: null, entries: [] };
    stack = [];
  };
  const pushEntry = (key, value, line) => doc.entries.push({ key, value, line });

  function handle(content, indent, lineNo, lineIdx) {
    const isItem = content === '-' || content.startsWith('- ');
    for (;;) {
      const top = stack[stack.length - 1];
      if (!top) break;
      if (top.kind === 'map') { if (top.indent > indent) { stack.pop(); continue; } break; }
      if (top.indent > indent) { stack.pop(); continue; }
      if (top.indent === indent && !(isItem && top.container)) { stack.pop(); continue; }
      break;
    }
    const parent = stack.length ? stack[stack.length - 1].path : '';
    if (isItem) {
      const holder = stack[stack.length - 1];
      const idx = holder ? (holder.cnt = (holder.cnt || 0) + 1) - 1 : 0;
      const itemPath = parent + '[' + idx + ']';
      const rest = content.slice(1).trim();
      const offset = content.length - content.slice(1).trimStart().length;
      if (!rest) return;
      if (/^("[^"]*"|'[^']*'|[^\s:#{}\[\]][^:]*?):(\s|$)/.test(rest) && !rest.startsWith('{')) {
        stack.push({ kind: 'map', indent: indent + offset, path: itemPath });
        handle(rest, indent + offset, lineNo, lineIdx);
      } else pushEntry(itemPath, unquote(rest), lineNo);
      return;
    }
    const m = /^("[^"]*"|'[^']*'|[^\s:][^:]*?):(?:\s+(.*))?$/.exec(content);
    if (!m) return;
    const key = unquote(m[1]);
    let value = (m[2] || '').trim();
    const path = parent ? parent + '.' + key : key;
    if (/^[|>][+-]?\d*$/.test(value)) { // блочный скаляр: пропускаем строки с большим отступом
      let k = lineIdx + 1;
      while (k < lines.length && (/^\s*$/.test(lines[k]) || (lines[k].length - lines[k].trimStart().length) > indent)) k++;
      skipTo = k;
      pushEntry(path, '<текстовый блок>', lineNo);
      return;
    }
    value = value.replace(/^&\S+\s*/, '');
    if (value === '') stack.push({ kind: 'key', indent, path, container: true, cnt: 0 });
    else pushEntry(path, unquote(value), lineNo);
  }

  let skipTo = -1;
  for (let li = 0; li < lines.length; li++) {
    if (li < skipTo) continue;
    const raw = lines[li];
    if (/^---(\s|$)/.test(raw)) { flush(); continue; }
    if (/^\.\.\.\s*$/.test(raw)) continue;
    const noc = stripComment(raw).replace(/\s+$/, '');
    if (!noc.trim()) continue;
    const indent = noc.length - noc.trimStart().length;
    handle(noc.trim(), indent, li + 1, li);
  }
  flush();
  return docs;
}

/**
 * .properties: key=value, key: value, продолжение строки обратным слэшем, комментарии # и !.
 */
function parseProperties(text) {
  const entries = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let l = lines[i];
    if (/^\s*[#!]/.test(l) || !l.trim()) continue;
    const start = i + 1;
    while (/\\$/.test(l) && i + 1 < lines.length) { l = l.slice(0, -1) + lines[++i].trimStart(); }
    const m = /^\s*([^=:\s]+)\s*[=:\s]\s*(.*)$/.exec(l);
    if (!m) continue;
    const value = m[2].replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).trim();
    entries.push({ key: m[1], value, line: start });
  }
  return [{ profile: null, entries }];
}

module.exports = { parseYaml, parseProperties, show, norm, SECRET };
