'use strict';
// Задача 2 плана TOKEN-ECONOMY-PHP-SAVINGS-PLAN.md: op outline — дефолтный предел 60 печатаемых
// строк объявлений, при усечении точный count и подсказка limit=0; параметр limit= (0 — вывести все).
// Extras-блоки и inherit-блоки в предел не входят. Временный проект генерируется здесь,
// php/composer/artisan не запускаются — только node (bx.js спавном).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const bx = path.resolve(__dirname, '../../skills/token-economy-php/scripts/bx.js');
const MARK = (shown, full) => `показано ${shown} из ${full} объявлений (limit=0 — вывести все)`;

function mkProject() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bx-t2-outline-'));
  const root = path.join(base, 'proj');
  const W = (rel, text) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  };
  W('composer.json', JSON.stringify({ require: { 'laravel/framework': '^12.0' } }));
  W('artisan', "<?php\ndefine('LARAVEL_START', microtime(true));\n// заглушка artisan; php не запускается\n");
  // Big.php: класс с 80 методами (81 печатаемая строка объявлений); в двух методах — вызовы
  // route()/view(), чтобы у файла были extras (ссылки на маршруты, рендер views).
  const methods = [];
  for (let i = 1; i <= 80; i++) {
    let body = ' return $i; ';
    if (i === 79) body = " return route('big.index'); ";
    if (i === 80) body = " return view('big.report', ['i' => $i]); ";
    methods.push(`    public function method${i}(int $i): int {${body}}`);
  }
  W('src/Big.php', "<?php\nnamespace App\\Src;\n\nclass Big {\n" + methods.join('\n') + "\n}\n");
  // helpers.php: 150 глобальных функций в namespace
  const funcs = [];
  for (let i = 1; i <= 150; i++) funcs.push(`function helper_function_${i}(array $config = [], $context = null): array { return ['index' => ${i}]; }`);
  W('src/helpers.php', "<?php\nnamespace App;\n\n" + funcs.join('\n') + "\n");
  // routes/web.php: PHP-объявлений нет, есть пара маршрутов (extras)
  W('routes/web.php', "<?php\nuse Illuminate\\Support\\Facades\\Route;\n\nRoute::get('/big', [\\App\\Src\\Big::class, 'method1'])->name('big.index');\nRoute::get('/big/report', function () { return view('big.report'); })->name('big.report');\n");
  // Inherit.php: A с 50 публичными методами, B extends A с одним своим
  const aMethods = [];
  for (let i = 1; i <= 50; i++) aMethods.push(`    public function baseMethod${i}(): int { return ${i}; }`);
  W('src/Inherit.php', "<?php\nnamespace App\\Src;\n\nclass A {\n" + aMethods.join('\n') + "\n}\n\nclass B extends A {\n    public function ownMethod(): void {}\n}\n");
  return { base, root };
}

function run(root, argv) {
  const res = spawnSync(process.execPath, [bx, 'root=' + root, ...argv], { encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
  assert.ifError(res.error);
  assert.equal(res.status, 0, 'exit=' + res.status + '\n' + res.stdout + res.stderr);
  assert.equal(res.stderr, '');
  return res.stdout.replace(/\r\n/g, '\n');
}

// печатаемые строки объявлений: заголовки decls, члены, funcs, consts — все начинаются с L<число>
const declLines = (out) => out.split('\n').filter((l) => /^L\d+/.test(l));

test('outline Big.php: дефолт — ровно 60 строк объявлений и точный count', () => {
  const { base, root } = mkProject();
  try {
    const out = run(root, ['op=outline', 'file=src/Big.php']);
    const lines = out.split('\n');
    const mi = lines.indexOf(MARK(60, 81));
    assert.ok(mi > 0, 'маркер усечения не найден:\n' + out);
    const decl = lines.slice(0, mi).filter((l) => /^L\d+/.test(l));
    assert.equal(decl.length, 60, 'строк объявлений до маркера должно быть ровно 60');
    assert.match(decl[0], /class Big/);
    assert.match(decl[1], /method1\(/);
    assert.match(decl[59], /method59\(/);
    assert.ok(!lines.slice(mi + 1).some((l) => /^L\d+/.test(l)), 'после маркера строк объявлений быть не должно');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('outline Big.php: limit=0 — все 81 строка, маркера нет', () => {
  const { base, root } = mkProject();
  try {
    const out = run(root, ['op=outline', 'file=src/Big.php', 'limit=0']);
    assert.equal(declLines(out).length, 81, 'limit=0 должен вывести все строки объявлений');
    assert.ok(!out.includes('показано '), 'при limit=0 маркера усечения быть не должно');
    assert.match(out, /method80\(/);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('outline Big.php: limit=15 — ровно 15 строк и маркер с точным count', () => {
  const { base, root } = mkProject();
  try {
    const out = run(root, ['op=outline', 'file=src/Big.php', 'limit=15']);
    const lines = out.split('\n');
    const mi = lines.indexOf(MARK(15, 81));
    assert.ok(mi > 0, 'маркер усечения не найден:\n' + out);
    const decl = lines.slice(0, mi).filter((l) => /^L\d+/.test(l));
    assert.equal(decl.length, 15);
    assert.match(decl[14], /method14\(/);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('outline Big.php: limit=999999 (больше N) — всё без маркера', () => {
  const { base, root } = mkProject();
  try {
    const out = run(root, ['op=outline', 'file=src/Big.php', 'limit=999999']);
    assert.equal(declLines(out).length, 81);
    assert.ok(!out.includes('показано '), 'при lim >= N маркера быть не должно');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('outline routes/web.php: файл без объявлений — вывод как раньше, маркера нет', () => {
  const { base, root } = mkProject();
  try {
    const out = run(root, ['op=outline', 'file=routes/web.php']);
    assert.ok(out.includes('(объявлений классов и функций нет — шаблон или страница)'), 'сообщение о файлах без объявлений на месте:\n' + out);
    assert.ok(!out.includes('показано '), 'для файла без объявлений маркера быть не должно');
    assert.ok(out.includes('маршруты (2):'), 'маршруты (extras) печатаются');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('outline Big.php: при усечении extras печатаются после маркера', () => {
  const { base, root } = mkProject();
  try {
    const out = run(root, ['op=outline', 'file=src/Big.php']);
    const lines = out.split('\n');
    const mi = lines.indexOf(MARK(60, 81));
    assert.ok(mi > 0, 'маркер усечения не найден:\n' + out);
    const after = lines.slice(mi + 1);
    const views = after.findIndex((l) => l.startsWith('рендерит views: big.report'));
    const refs = after.findIndex((l) => l.startsWith('ссылки на маршруты: big.index'));
    assert.ok(views >= 0, 'после маркера нет extras «рендерит views»:\n' + out);
    assert.ok(refs >= 0, 'после маркера нет extras «ссылки на маршруты»:\n' + out);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('outline Inherit.php: inherit-блок печатается как раньше и не входит в кап', () => {
  const { base, root } = mkProject();
  try {
    // A: 51 строка объявлений (заголовок + 50 методов), B: 2 строки — итого 53 <= 60, усечения нет.
    // Блок наследования печатается по прежним правилам (кап 40 на предка + «ещё N»).
    const out = run(root, ['op=outline', 'file=src/Inherit.php', 'inherit=true']);
    const lines = out.split('\n');
    const hi = lines.findIndex((l) => l.startsWith('  -- унаследовано от A ('));
    assert.ok(hi > 0, 'inherit-блок не найден:\n' + out);
    const countedBefore = lines.slice(0, hi).filter((l) => /^L\d+/.test(l));
    assert.equal(countedBefore.length, 53, 'до inherit-блока все 53 строки объявлений');
    const block = lines.slice(hi + 1).filter((l) => /^L\d+/.test(l));
    assert.equal(block.length, 40, 'в inherit-блоке прежний кап 40 на предка');
    assert.ok(lines.slice(hi + 1).some((l) => l === '  … ещё 10'), 'остаток методов предка обозначен «ещё N»');
    assert.ok(!out.includes('показано '), 'inherit-строки не входят в кап — усечения нет');
    // при усечённом списке (52 из 53) блок наследования видимого класса печатается целиком
    const out2 = run(root, ['op=outline', 'file=src/Inherit.php', 'inherit=true', 'limit=52']);
    const lines2 = out2.split('\n');
    const mi = lines2.indexOf(MARK(52, 53));
    assert.ok(mi > 0, 'маркер с count 52 из 53 не найден:\n' + out2);
    const hi2 = lines2.findIndex((l) => l.startsWith('  -- унаследовано от A ('));
    assert.ok(hi2 > 0 && hi2 < mi, 'inherit-блок печатается до маркера, сразу за показанными объявлениями');
    assert.equal(lines2.slice(0, hi2).filter((l) => /^L\d+/.test(l)).length, 52, 'до inherit-блока ровно 52 строки объявлений');
    assert.equal(lines2.slice(hi2 + 1, mi).filter((l) => /^L\d+/.test(l)).length, 40, 'inherit-блок не усечён капом объявлений');
    assert.ok(lines2.slice(hi2 + 1, mi).some((l) => l === '  … ещё 10'));
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('outline helpers.php: 150 функций — ровно 60 строк funcs и маркер с N=150', () => {
  const { base, root } = mkProject();
  try {
    const out = run(root, ['op=outline', 'file=src/helpers.php']);
    const lines = out.split('\n');
    const mi = lines.indexOf(MARK(60, 150));
    assert.ok(mi > 0, 'маркер усечения не найден:\n' + out);
    const decl = lines.slice(0, mi).filter((l) => /^L\d+/.test(l));
    assert.equal(decl.length, 60, 'строк funcs до маркера должно быть ровно 60');
    assert.match(decl[0], /function helper_function_1\(/);
    assert.match(decl[59], /function helper_function_60\(/);
    const out0 = run(root, ['op=outline', 'file=src/helpers.php', 'limit=0']);
    assert.equal(declLines(out0).length, 150);
    assert.ok(!out0.includes('показано '));
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
