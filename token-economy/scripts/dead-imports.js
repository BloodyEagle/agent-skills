const fs = require('fs');
const path = require('path');

let args = {};
try { args = JSON.parse(fs.readFileSync(0, 'utf-8').trim() || '{}'); } catch (e) { args = {}; }

const cwd = process.cwd();

/**
 * Разбирает однострочный import и возвращает импортируемые имена.
 * @param {string} line - строка импорта.
 * @returns {{names: string[], multiLine: boolean}|null} Имена или null если не импорт.
 */
function parseImport(line) {
  const t = line.trim();
  if (!t.startsWith('import')) return null;
  const hasBrace = t.includes('{');
  if (hasBrace && !t.includes('}')) return { names: [], multiLine: true };

  const fromIdx = t.indexOf(' from ');
  const head = fromIdx === -1 ? t : t.slice(0, fromIdx);
  const names = [];

  // import * as Y from 'm'
  const star = head.match(/import\s+\*\s+as\s+([\w$]+)/);
  if (star) names.push(star[1]);

  // import { A, B as C } from 'm'
  const brace = head.match(/\{([^}]*)\}/);
  if (brace) {
    brace[1].split(',').forEach(s => {
      const n = s.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop().trim();
      if (n) names.push(n);
    });
  }

  // import X from 'm' / import X, { A } from 'm'
  const rest = head.replace(/\*\s+as\s+[\w$]+/, '').replace(/\{[^}]*\}/, '');
  const def = rest.match(/import\s+(?:type\s+)?([A-Za-z_$][\w$]*)/);
  if (def) names.push(def[1]);

  return { names, multiLine: false };
}

/**
 * Проверяет использование импортированного имени в остальной части файла.
 * @param {string} name - имя.
 * @param {string} body - содержимое файла без строки импорта.
 * @returns {boolean} true если имя не используется.
 */
function isUnused(name, body) {
  const re = new RegExp('\\b' + name.replace(/[$]/g, '\\$&') + '\\b');
  return !re.test(body);
}

/**
 * Находит неиспользуемые импорты в файле.
 * @param {string} file - путь к файлу.
 * @returns {Array} Список неиспользуемых импортов.
 */
function scan(file) {
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  const rel = path.relative(cwd, file).replace(/\\/g, '/');
  const out = [];

  lines.forEach((line, i) => {
    const parsed = parseImport(line);
    if (!parsed) return;
    if (parsed.multiLine) {
      out.push({ file: rel, line: i + 1, name: '(многострочный импорт)', multiLine: true });
      return;
    }
    const body = lines.filter((_, idx) => idx !== i).join('\n');
    parsed.names.forEach(name => {
      if (isUnused(name, body)) out.push({ file: rel, line: i + 1, name });
    });
  });
  return out;
}

const files = (args.files || (args.file ? [args.file] : [])).map(f => path.resolve(cwd, f));

if (!files.length) {
  console.log(JSON.stringify({ error: "Укажите payload.file или payload.files" }));
  process.exit(1);
}

const unused = files.filter(f => fs.existsSync(f)).flatMap(scan);

console.log(JSON.stringify({
  count: unused.length,
  unused
}));
