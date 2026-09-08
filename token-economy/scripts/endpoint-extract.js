const fs = require('fs');
const path = require('path');

let args = {};
try { args = JSON.parse(fs.readFileSync(0, 'utf-8').trim() || '{}'); } catch (e) { args = {}; }

const cwd = process.cwd();

/**
 * Собирает список файлов для анализа: указанный файл либо все *.service.ts в src.
 * @returns {string[]} Абсолютные пути к файлам.
 */
function collectFiles() {
  if (args.file) {
    const p = path.resolve(cwd, args.file);
    return fs.existsSync(p) ? [p] : [];
  }
  const out = [];
  (function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir)) {
      const p = path.join(dir, e);
      if (fs.statSync(p).isDirectory()) {
        if (!['node_modules', '.git', 'dist'].includes(e)) walk(p);
      } else if (e.endsWith('.service.ts')) {
        out.push(p);
      }
    }
  })(path.resolve(cwd, args.root || 'src'));
  return out;
}

/**
 * Извлекает HTTP-вызовы и имена методов из файла.
 * @param {string} file - путь к файлу.
 * @returns {Array} Список эндпоинтов.
 */
function extract(file) {
  const lines = fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n').split('\n');
  const rel = path.relative(cwd, file).replace(/\\/g, '/');
  const out = [];
  let currentMethod = '';

  lines.forEach((line, i) => {
    const methodMatch = line.match(/^\s*(?:public|private|protected|static|async|override|\s)*([A-Za-z_$][\w$]*)\s*\(/);
    if (methodMatch && !['if', 'for', 'while', 'switch', 'catch', 'constructor'].includes(methodMatch[1])) {
      currentMethod = methodMatch[1];
    }
    const httpMatch = line.match(/(?:this\.)?(?:http|httpClient|httpService|rest|api)\.(get|post|put|delete|patch|request)\s*(?:<[^>]*>)?\s*\(([^)]*)/);
    if (!httpMatch) return;
    const arg = httpMatch[2].trim();
    const lit = arg.match(/[`'"]([^`'"]+)[`'"]/);
    const url = lit ? lit[1] : arg.slice(0, 60);
    if (!url || (!lit && !/[/]|^https?:/i.test(url))) return;
    out.push({
      file: rel,
      line: i + 1,
      method: currentMethod || '(вне метода)',
      http: httpMatch[1].toUpperCase(),
      url
    });
  });
  return out;
}

const files = collectFiles();
const endpoints = files.flatMap(extract);

console.log(JSON.stringify({
  scannedFiles: files.length,
  count: endpoints.length,
  endpoints: endpoints.slice(0, args.limit || 100)
}));
