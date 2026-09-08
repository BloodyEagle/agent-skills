const fs = require('fs');
const path = require('path');

let args = {};
try {
  const inputData = fs.readFileSync(0, 'utf-8').trim();
  if (inputData) args = JSON.parse(inputData);
} catch (e) {
  args = { file: process.env.COMPRESS_FILE };
}

const filePath = path.resolve(process.cwd(), args.file || '');

if (!fs.existsSync(filePath) || !args.file) {
  console.log(JSON.stringify({ error: "Файл не найден. Укажите корректный аргумент file" }));
  process.exit(1);
}

/**
 * Удаляет комментарии из кода, не трогая строки, шаблонные литералы и url(...).
 * Сохраняет все переносы строк, чтобы номера строк в сжатом виде совпадали с исходником.
 * @param {string} code - исходный код.
 * @param {{lineComments?: boolean, protectUrl?: boolean}} opts - lineComments: удалять ли `//`
 *   (в CSS их нет); protectUrl: защищать ли содержимое `url(...)` от `//` (для CSS/SCSS).
 * @returns {string} Код без комментариев.
 * @example stripComments("const u = 'http://x'; // комм", { lineComments: true })
 *   // => "const u = 'http://x'; "
 */
function stripComments(code, opts) {
  let out = '';
  let i = 0;
  const n = code.length;
  const stack = []; // { kind: 'template' } | { kind: 'interp', depth }

  const readString = (quote) => {
    out += quote;
    i++;
    while (i < n) {
      if (code[i] === '\\') { out += code[i] + (code[i + 1] || ''); i += 2; continue; }
      if (code[i] === quote) { out += code[i]; i++; return; }
      out += code[i];
      i++;
    }
  };

  const skipLineComment = () => { while (i < n && code[i] !== '\n') i++; };

  const skipBlockComment = () => {
    i += 2;
    while (i < n && !(code[i] === '*' && code[i + 1] === '/')) {
      if (code[i] === '\n') out += '\n';
      i++;
    }
    i += 2;
  };

  while (i < n) {
    const c = code[i];
    const nx = i + 1 < n ? code[i + 1] : '';
    const top = stack[stack.length - 1];

    if (top && top.kind === 'template') {
      if (c === '\\') { out += c + nx; i += 2; continue; }
      if (c === '`') { out += c; i++; stack.pop(); continue; }
      if (c === '$' && nx === '{') { out += c + nx; i += 2; stack.push({ kind: 'interp', depth: 0 }); continue; }
      out += c; i++; continue;
    }

    if (top && top.kind === 'interp') {
      if (c === "'" || c === '"') { readString(c); continue; }
      if (c === '`') { out += c; i++; stack.push({ kind: 'template' }); continue; }
      if (c === '/' && nx === '/') { skipLineComment(); continue; }
      if (c === '/' && nx === '*') { skipBlockComment(); continue; }
      if (c === '{') { top.depth++; out += c; i++; continue; }
      if (c === '}') {
        top.depth--;
        out += c; i++;
        if (top.depth < 0) stack.pop();
        continue;
      }
      out += c; i++; continue;
    }

    // Обычный код
    if (c === "'" || c === '"') { readString(c); continue; }
    if (c === '`') { out += c; i++; stack.push({ kind: 'template' }); continue; }
    if (opts.lineComments && c === '/' && nx === '/') { skipLineComment(); continue; }
    if (c === '/' && nx === '*') { skipBlockComment(); continue; }
    if (opts.protectUrl && code.slice(i, i + 4).toLowerCase() === 'url(') {
      let depth = 0;
      do {
        if (code[i] === '(') depth++;
        else if (code[i] === ')') depth--;
        out += code[i];
        i++;
      } while (i < n && depth > 0);
      continue;
    }
    out += c; i++;
  }
  return out;
}

let content = fs.readFileSync(filePath, 'utf8');

if (filePath.endsWith('.html')) {
  // HTML: убираем комментарии, сохраняя переносы строк
  content = content.replace(/<!--[\s\S]*?-->/g, m => m.replace(/[^\n]/g, ''));
} else {
  const isCss = filePath.endsWith('.css');
  const cssLike = isCss || filePath.endsWith('.scss');
  content = stripComments(content, { lineComments: !isCss, protectUrl: cssLike });
}

// Обрезаем хвостовые пробелы (\r в т.ч.), но СОХРАНЯЕМ пустые строки — номера строк не сдвигаются
content = content.replace(/\r\n?/g, '\n').split('\n').map(line => line.trimEnd()).join('\n');

console.log(JSON.stringify({ compressedContent: content }));
