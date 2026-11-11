'use strict';
// Задача 1 (op node): totals объявлений, страница 50, offset/limit.
// Только stdlib; временный Laravel-проект в mkdtemp, bx.js — дочерним процессом node.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const bx = path.resolve(__dirname, '../../skills/token-economy-php/scripts/bx.js');

// src/helpers.php — 150 функций по образцу приложения А плана.
// Разметка файла: преамбулы 3 строки, функция — 5 строк, между функциями пустая строка,
// поэтому сигнатура функции i на строке 5 + (i-1)*6, конец тела на 3 строки ниже.
const helperSource = (count) => {
  const fns = [];
  for (let i = 1; i <= count; i++) {
    fns.push([
      `/** Вспомогательная функция №${i}. */`,
      `function helper_function_${i}(array $config = [], $context = null, bool $strict = true): array`,
      '{',
      `    return array_merge($config, ['index' => ${i}, 'strict' => $strict]);`,
      '}',
    ].join('\n'));
  }
  return '<?php\nnamespace App;\n\n' + fns.join('\n\n') + '\n';
};
const helperLine = (i) => `  function App\\helper_function_${i}  ${5 + (i - 1) * 6}-${8 + (i - 1) * 6}`;
const allHelperLines = (count) => Array.from({ length: count }, (_, k) => helperLine(k + 1));

const bootSource = [
  '<?php',
  'namespace App;',
  '',
  '/** Загрузчик проекта. */',
  'class Boot',
  '{',
  '    public function run(): void',
  '    {',
  '    }',
  '}',
  '',
  'function boot_load(string $name): array',
  '{',
  "    return ['name' => $name];",
  '}',
  '',
  'function boot_save(array $data): bool',
  '{',
  '    return $data !== [];',
  '}',
].join('\n') + '\n';

const consumerSource = [
  '<?php',
  'namespace App;',
  '',
  'function consume(array $config = []): array',
  '{',
  '    return helper_function_1($config);',
  '}',
].join('\n') + '\n';

function project(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bx-task1-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'artisan'), "<?php\ndefine('LARAVEL_START', microtime(true));\n");
  fs.writeFileSync(path.join(root, 'composer.json'), '{"require":{"laravel/framework":"^12.0"}}');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'resources/views'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/helpers.php'), helperSource(150));
  fs.writeFileSync(path.join(root, 'src/Boot.php'), bootSource);
  fs.writeFileSync(path.join(root, 'src/consumer.php'), consumerSource);
  fs.writeFileSync(path.join(root, 'resources/views/blank.blade.php'), '<div>Пустой шаблон</div>\n');
  return root;
}

function nodeOp(root, extra = {}) {
  const argv = Object.entries({ op: 'node', ...extra }).map(([k, v]) => k + '=' + v);
  const r = spawnSync(process.execPath, [bx, 'root=' + root, ...argv], {
    cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024,
  });
  assert.ifError(r.error);
  const stdout = r.stdout.replace(/\r\n/g, '\n');
  return { ...r, stdout, lines: stdout.split('\n') };
}

// Окно объявлений: totals-строка сразу после заголовка файла, список — до блока рёбер.
function declWindow(r) {
  const i = r.lines.findIndex((l) => l.startsWith('объявлений: '));
  assert.equal(i, 1, 'totals-строка — сразу после заголовка файла, got: ' + r.lines.slice(0, 3).join(' | '));
  const j = r.lines.findIndex((l) => l === 'использует:');
  assert.ok(j > i, 'блок рёбер «использует» на месте');
  return { totals: r.lines[i], decls: r.lines.slice(i + 1, j) };
}

test('node: файл на 150 функций — ровно 50 строк и totals', (t) => {
  const root = project(t);
  const r = nodeOp(root, { file: 'src/helpers.php' });
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
  const { totals, decls } = declWindow(r);
  assert.equal(totals, 'объявлений: 150 (показано 50 со смещения 0)');
  assert.equal(decls.length, 50);
  assert.deepEqual(decls, allHelperLines(150).slice(0, 50));
  const ui = r.lines.indexOf('использует:');
  assert.equal(r.lines[ui + 1], '  -', 'helpers.php ничего не использует');
});

test('node: offset=50 — вторая страница; склейка 0/50/100 без пропусков и повторов', (t) => {
  const root = project(t);
  const page = (offset) => declWindow(nodeOp(root, { file: 'src/helpers.php', offset: String(offset) }));
  const second = page(50);
  assert.equal(second.totals, 'объявлений: 150 (показано 50 со смещения 50)');
  assert.deepEqual(second.decls, allHelperLines(150).slice(50, 100));
  const all = [...page(0).decls, ...second.decls, ...page(100).decls];
  assert.equal(all.length, 150);
  assert.equal(new Set(all).size, 150);
  assert.deepEqual(all, allHelperLines(150));
});

test('node: limit=0 — все 150 строк', (t) => {
  const root = project(t);
  const r = nodeOp(root, { file: 'src/helpers.php', limit: '0' });
  assert.equal(r.status, 0);
  const { totals, decls } = declWindow(r);
  assert.equal(totals, 'объявлений: 150 (показано 150 со смещения 0)');
  assert.deepEqual(decls, allHelperLines(150));
});

test('node: limit=7 — ровно 7 строк, totals показывает окно', (t) => {
  const root = project(t);
  const r = nodeOp(root, { file: 'src/helpers.php', limit: '7' });
  assert.equal(r.status, 0);
  const { totals, decls } = declWindow(r);
  assert.equal(totals, 'объявлений: 150 (показано 7 со смещения 0)');
  assert.deepEqual(decls, allHelperLines(150).slice(0, 7));
});

test('node: offset=1000 за концом списка — пустое окно, totals, exit 0', (t) => {
  const root = project(t);
  const r = nodeOp(root, { file: 'src/helpers.php', offset: '1000' });
  assert.equal(r.status, 0);
  const { totals, decls } = declWindow(r);
  assert.equal(totals, 'объявлений: 150 (показано 0 со смещения 1000)');
  assert.deepEqual(decls, []);
});

test('node: view без PHP-объявлений — totals 0, exit 0', (t) => {
  const root = project(t);
  const r = nodeOp(root, { file: 'resources/views/blank.blade.php' });
  assert.equal(r.status, 0);
  const { totals, decls } = declWindow(r);
  assert.equal(totals, 'объявлений: 0 (показано 0 со смещения 0)');
  // между totals и рёбрами — служебные блоки node (view: …), строк объявлений быть не должно
  assert.equal(decls.filter((l) => /^  (class|interface|trait|enum|function) /.test(l)).length, 0);
});

test('node: порядок и текст строк объявлений — decls до funcs, старый формат', (t) => {
  const root = project(t);
  const r = nodeOp(root, { file: 'src/Boot.php' });
  assert.equal(r.status, 0);
  const { totals, decls } = declWindow(r);
  assert.equal(totals, 'объявлений: 3 (показано 3 со смещения 0)');
  assert.deepEqual(decls, [
    '  class App\\Boot  5-10',
    '  function App\\boot_load  12-15',
    '  function App\\boot_save  17-20',
  ]);
});

test('node: рёбра «использует» и «используют его» на месте', (t) => {
  const root = project(t);
  const uses = nodeOp(root, { file: 'src/consumer.php' });
  assert.equal(uses.status, 0);
  assert.ok(uses.lines.some((l) => l === '1 src/helpers.php [page] (function)'), 'использует → helpers.php:\n' + uses.stdout);
  const usedBy = nodeOp(root, { file: 'src/helpers.php' });
  assert.equal(usedBy.status, 0);
  assert.ok(usedBy.lines.some((l) => l === '1 src/consumer.php [page] (function)'), 'используют его → consumer.php:\n' + usedBy.stdout);
});
