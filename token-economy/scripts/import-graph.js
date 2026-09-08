const fs = require('fs');
const path = require('path');

let args = {};
try { args = JSON.parse(fs.readFileSync(0, 'utf-8').trim() || '{}'); } catch (e) { args = {}; }

const cwd = process.cwd();
const target = (args.file || '').replace(/\\/g, '/');
if (!target) {
  console.log(JSON.stringify({ error: "Не указан файл (payload.file)" }));
  process.exit(1);
}

/**
 * Собирает список путей-кандидатов для сопоставления импортов (без расширения, варианты относительно src и корня).
 * @param {string} file - путь к файлу.
 * @returns {string[]} Варианты идентификаторов модуля.
 */
function moduleIdVariants(file) {
  const rel = file.replace(/\\/g, '/');
  const noExt = rel.replace(/\.(ts|js)$/, '');
  const base = path.basename(noExt);
  const fromSrc = noExt.replace(/^src\//, '');
  return [...new Set([noExt, fromSrc, base, './' + fromSrc])];
}

/**
 * Извлекает прямые импорты из файла.
 * @param {string} filePath - абсолютный путь.
 * @returns {string[]} Список импортируемых модулей.
 */
function forwardImports(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const out = [];
  const re = /import\s*(?:[\w$*\s{},]+?)\s*from\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(content))) out.push(m[1]);
  return out;
}

/**
 * Рекурсивно ищет файлы, импортирующие указанный модуль.
 * @param {string} dir - каталог сканирования.
 * @param {string[]} variants - варианты идентификатора модуля.
 * @param {string[]} acc - аккумулятор результатов.
 */
function reverseImports(dir, variants, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (fs.statSync(p).isDirectory()) {
      if (!['node_modules', '.git', 'dist'].includes(entry)) reverseImports(p, variants, acc);
    } else if (/\.(ts|js)$/.test(entry)) {
      const lines = fs.readFileSync(p, 'utf8').replace(/\r\n?/g, '\n').split('\n');
      lines.forEach((line, i) => {
        if (!line.includes('from')) return;
        const m = line.match(/from\s*['"]([^'"]+)['"]/);
        if (!m) return;
        const mod = m[1];
        if (variants.some(v => mod === v || mod.endsWith('/' + v) || mod.endsWith(v))) {
          acc.push({ file: path.relative(cwd, p).replace(/\\/g, '/'), line: i + 1 });
        }
      });
    }
  }
  return acc;
}

const targetAbs = path.resolve(cwd, target);
const imports = fs.existsSync(targetAbs) ? forwardImports(targetAbs) : [];

const variants = moduleIdVariants(target);
const importedBy = reverseImports(path.resolve(cwd, args.root || 'src'), variants);

console.log(JSON.stringify({
  file: target,
  imports,
  importedBy
}));
