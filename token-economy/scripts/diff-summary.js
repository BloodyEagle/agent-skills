const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

let args = {};
try { args = JSON.parse(fs.readFileSync(0, 'utf-8').trim() || '{}'); } catch (e) { args = {}; }

const LIMIT = args.limit || 400;

try {
  const numstat = execSync('git diff HEAD --numstat', { encoding: 'utf8' }).trim();

  const files = numstat
    .split('\n')
    .filter(Boolean)
    .map(l => {
      const [added, removed, file] = l.split('\t');
      return { file, added: parseInt(added, 10) || 0, removed: parseInt(removed, 10) || 0, untracked: false };
    });

  // Untracked-файлы не попадают в `git diff HEAD` — берём их из porcelain отдельно
  const untrackedLines = [];
  execSync('git status --porcelain', { encoding: 'utf8' })
    .split('\n')
    .filter(l => l.startsWith('?? '))
    .map(l => l.slice(3))
    .forEach(file => {
      const abs = path.join(process.cwd(), file);
      const added = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8').split('\n').length : 0;
      files.push({ file, added, removed: 0, untracked: true });
      untrackedLines.push(`[untracked] ${file} (+${added})`);
    });

  // Сжатый дифф: 0 строк контекста, только +/- и заголовки
  const raw = execSync('git diff HEAD -U0 -- . ":(exclude)package-lock.json" ":(exclude)yarn.lock"', { encoding: 'utf8' });
  const diffLines = raw.split('\n').filter(l =>
    /^diff --git|^@@|^[+-]{3} /.test(l) || (/^[+-]/.test(l) && !/^[+-]{3} /.test(l))
  );

  const combined = diffLines.concat(untrackedLines).slice(0, LIMIT);

  console.log(JSON.stringify({
    files,
    totalFiles: files.length,
    untrackedCount: untrackedLines.length,
    diff: combined.join('\n') || '(нет изменений)',
    truncated: combined.length >= LIMIT
  }));
} catch (err) {
  console.log(JSON.stringify({ error: "Не удалось получить diff: " + ((err.stderr || err.message || '').trim()) }));
}
