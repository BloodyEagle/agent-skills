const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

let args = {};
try { args = JSON.parse(fs.readFileSync(0, 'utf-8').trim() || '{}'); } catch (e) { args = {}; }

const cwd = process.cwd();

/**
 * Находит локальный или глобальный бинарник eslint.
 * @returns {string|null} Путь к бинарнику либо null.
 */
function findEslint() {
  const local = process.platform === 'win32'
    ? ['node_modules\\.bin\\eslint.cmd', 'node_modules\\.bin\\eslint']
    : ['node_modules/.bin/eslint'];
  for (const p of local) if (fs.existsSync(path.join(cwd, p))) return path.join(cwd, p);
  return null;
}

/**
 * Возвращает список изменённых .ts файлов относительно HEAD.
 * @returns {string[]} Пути файлов.
 */
function changedTsFiles() {
  try {
    const tracked = execSync('git diff HEAD --name-only -- "*.ts"', { encoding: 'utf8' }).trim()
      .split('\n').filter(Boolean);
    const untracked = execSync('git status --porcelain', { encoding: 'utf8' })
      .split('\n')
      .filter(l => l.startsWith('?? ') && l.endsWith('.ts'))
      .map(l => l.slice(3));
    return [...new Set([...tracked, ...untracked])];
  } catch (e) {
    return [];
  }
}

const eslint = findEslint();
if (!eslint) {
  console.log(JSON.stringify({ error: "ESLint не установлен в проекте. Используйте действие 'validate' (tsc --noEmit)." }));
  process.exit(1);
}

const files = args.files || changedTsFiles();
if (!files.length) {
  console.log(JSON.stringify({ message: "Нет изменённых .ts файлов для проверки.", issues: [] }));
  process.exit(0);
}

try {
  const cmd = `"${eslint}" ${files.map(f => `"${f}"`).join(' ')} --format unix --quiet`;
  const out = execSync(cmd, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }).trim();
  const issues = out.split('\n').filter(Boolean).slice(0, 50);
  console.log(JSON.stringify({ count: issues.length, issues }));
} catch (err) {
  // eslint возвращает ненулевой код при наличии ошибок — выводим их
  const out = ((err.stdout || '') + (err.stderr || '')).trim();
  const issues = out.split('\n').filter(l => /\.ts:\d+:\d+:\s*error/i.test(l)).slice(0, 50);
  console.log(JSON.stringify({ count: issues.length, issues }));
}
