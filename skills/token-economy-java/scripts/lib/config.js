'use strict';
// config.js — плоский разбор конфигурации Spring Boot: YAML (подмножество: вложенные ключи, списки, несколько
// документов через «---», блочные скаляры) и .properties. Для каждого ключа сохраняются номер строки и профиль.

const SECRET = /(password|passwd|pwd|secret|token|credential|private[-_.]?key|api[-_.]?key|access[-_.]?key|client[-_.]?secret|salt)/i;

const ENV_REF = /^\$\{[\w.-]+\}$/;
const hidden = (key, value) => (SECRET.test(key) && value && !ENV_REF.test(value)) || (/^[\[{]/.test(value) && SECRET.test(value.replace(/"(?:\\.|[^"\\])*"(?=\s*:)/g, unquote)));
const isConfigFile = (file) => /(?:^|[/\\])(application|bootstrap)[^/\\]*\.(ya?ml|properties)$/i.test(file);

/** Значение для вывода: секреты скрыты; только ${ENV} без значения по умолчанию остаётся видимым. */
function show(key, value) {
  if (hidden(key, value)) return '***';
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
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
    return v.slice(1, -1).replace(/\\u([0-9a-fA-F]{4})|\\U([0-9a-fA-F]{8})|\\x([0-9a-fA-F]{2})|\\(.)/g, (raw, u, U, x, ch) => {
      if (u || U || x) { const n = parseInt(u || U || x, 16); return n <= 0x10ffff ? String.fromCodePoint(n) : raw; }
      return ({ n: '\n', r: '\r', t: '\t' })[ch] || ch;
    });
  }
  if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) return v.slice(1, -1).replace(/''/g, "'");
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
  const pushEntry = (key, value, line, endLine = line) => doc.entries.push({ key, value, line, endLine });

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
      } else scalar(itemPath, rest, lineNo, lineIdx, indent);
      return;
    }
    const m = /^("[^"]*"|'[^']*'|[^\s:][^:]*?):(?:\s+(.*))?$/.exec(content);
    if (!m) return;
    const key = unquote(m[1]);
    let value = (m[2] || '').trim();
    const path = parent ? parent + '.' + key : key;
    scalar(path, value, lineNo, lineIdx, indent);
  }

  function scalar(key, value, lineNo, lineIdx, indent) {
    value = value.replace(/^&\S+\s*/, '');
    if (!value) {
      let first = lineIdx + 1;
      while (first < lines.length && !stripComment(lines[first]).trim()) first++;
      const next = first < lines.length ? stripComment(lines[first]).trim() : '';
      const deeper = first < lines.length && lines[first].length - lines[first].trimStart().length > indent;
      if (deeper && next && !/^(?:-\s|-$)/.test(next) && !/^(?:"(?:\\.|[^"\\])*"|'(?:''|[^'])*'|[^"'{}\[\]:][^:]*):(?:\s|$)/.test(next)) {
        let end = first + 1;
        while (end < lines.length && (/^\s*$/.test(lines[end]) || lines[end].length - lines[end].trimStart().length > indent)) end++;
        pushEntry(key, unquote(lines.slice(first, end).map((line) => stripComment(line).trim()).join(' ')), lineNo, end);
        skipTo = end;
      } else stack.push({ kind: 'key', indent, path: key, container: true, cnt: 0 });
      return;
    }
    let end = lineIdx + 1;
    while (end < lines.length && !/^---(?:\s|$)/.test(lines[end]) && (/^\s*$/.test(lines[end]) || lines[end].length - lines[end].trimStart().length > indent)) end++;
    if (/^[|>](?:[+-]?\d*|\d+[+-]?)$/.test(value)) {
      pushEntry(key, '<текстовый блок>', lineNo, end);
    } else {
      const continuation = lines.slice(lineIdx + 1, end).map((line) => stripComment(line).trim()).filter(Boolean);
      pushEntry(key, unquote([value, ...continuation].join(' ')), lineNo, end);
    }
    skipTo = end;
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
  const decode = (s) => s.replace(/\\u([0-9a-fA-F]{4})|\\(.)/g, (_, h, c) => h ? String.fromCharCode(parseInt(h, 16)) : ({ t: '\t', r: '\r', n: '\n', f: '\f' }[c] || c));
  for (let i = 0; i < lines.length; i++) {
    let l = lines[i];
    if (/^\s*[#!]/.test(l) || !l.trim()) continue;
    const start = i + 1;
    while (((l.match(/\\+$/) || [''])[0].length % 2) && i + 1 < lines.length) l = l.slice(0, -1) + lines[++i].trimStart();
    const m = /^\s*((?:\\.|[^=:\s\\])+)\s*(?:[=:]\s*)?(.*)$/.exec(l);
    if (!m) continue;
    entries.push({ key: decode(m[1]), value: decode(m[2]).trim(), line: start, endLine: i + 1 });
  }
  return [{ profile: null, entries }];
}

/** Строки для search: матчинг остаётся по исходнику, значения секретов маскируются до сокращения вывода. */
function redactLines(text, properties) {
  const lines = text.split(/\r?\n/), out = [...lines];
  const docs = properties ? parseProperties(text) : parseYaml(text);
  for (const doc of docs) for (const e of doc.entries) {
    if (!hidden(e.key, e.value)) continue;
    const start = e.line - 1, end = e.endLine || e.line;
    const raw = out[start];
    const match = properties
      ? /^\s*(?:\\.|[^=:\s\\])+(?:\s*[=:]\s*|\s+)/.exec(raw)
      : /^\s*(?:-\s*)?(?:"(?:\\.|[^"\\])*"|'(?:''|[^'])*'|[^:]+):\s*/.exec(raw);
    out[start] = (match ? match[0] : (raw.match(/^\s*(?:-\s*)?/) || [''])[0]) + '***';
    for (let i = start + 1; i < end; i++) out[i] = (lines[i].match(/^\s*/) || [''])[0] + '***';
  }
  return out;
}

module.exports = { parseYaml, parseProperties, show, norm, SECRET, isConfigFile, redactLines };
