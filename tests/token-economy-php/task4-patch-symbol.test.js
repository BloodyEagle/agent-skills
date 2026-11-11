'use strict';
// Задача 4: op patch_symbol — правка тела метода/функции без чтения старого тела в контекст.
// Только stdlib; временный проект (fs.mkdtempSync, удаление в finally), bx.js спавном; php/composer/artisan не запускаются.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const fsx = require('../../skills/token-economy-php/scripts/lib/fsx');

const bx = path.resolve(__dirname, '../../skills/token-economy-php/scripts/bx.js');

const SRC = [
  '<?php',
  'namespace App;',
  '',
  '/** Сервис отчётов. */',
  'class ReportService',
  '{',
  "    public const VERSION = '1.0';",
  '',
  '    /** Приветствие. */',
  '    public function greet(string $name): string',
  '    {',
  "        $label = 'Привет, ' . $name;",
  '        return $label;',
  '    }',
  '',
  '    public function total(array $rows): int',
  '    {',
  '        $sum = 0;',
  '        foreach ($rows as $row) {',
  '            $sum += (int)$row;',
  '        }',
  '        return $sum;',
  '    }',
  '}',
].join('\n');

// хирургическая сборка ожидаемого файла: тело greet (между `{` и `}`) заменено на newBody
function withBody(src, newBody) {
  const open = src.indexOf('{', src.indexOf('public function greet'));
  const close = src.indexOf('}', src.indexOf('return $label;'));
  return src.slice(0, open + 1) + newBody + src.slice(close);
}

function project(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bx-t4-'));
  try {
    for (const [rel, data] of Object.entries(files)) {
      const file = path.join(root, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, data);
    }
    return root;
  } catch (e) {
    fs.rmSync(root, { recursive: true, force: true });
    throw e;
  }
}

function run(root, argv) {
  const res = spawnSync(process.execPath, [bx, 'root=' + root, ...argv], {
    cwd: root, encoding: 'utf8', timeout: 20000, maxBuffer: 2 * 1024 * 1024,
  });
  assert.ifError(res.error);
  return res;
}

// payload через @-файл — способ из SKILL.md для многострочных значений
function runPayload(root, payload) {
  const dir = path.join(root, '.bx-cache');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'payload.json'), JSON.stringify(payload));
  return run(root, ['@.bx-cache/payload.json']);
}

function ok(res) {
  assert.equal(res.status, 0, res.stdout + res.stderr);
  return res.stdout;
}
function denied(res) {
  assert.equal(res.status, 1, res.stdout + res.stderr);
  return res.stdout;
}

test('patch_symbol: dry по умолчанию — отчёт есть, файл не изменён', (t) => {
  const root = project(t, { 'src/ReportService.php': SRC });
  try {
    const before = fs.readFileSync(path.join(root, 'src/ReportService.php'));
    const out = ok(runPayload(root, { op: 'patch_symbol', file: 'src/ReportService.php', symbol: 'ReportService::greet', body: "return 'кратко';" }));
    assert.match(out, /^dry: src\/ReportService\.php {2}ReportService::greet {2}тело L11-L14 → 1 строка {2}\(кодировка utf8\)\n?$/);
    assert.deepEqual(fs.readFileSync(path.join(root, 'src/ReportService.php')), before);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('patch_symbol: однострочное тело — замена между { и }, сигнатура не тронута', (t) => {
  const root = project(t, {
    'src/ReportService.php': SRC,
    'src/One.php': '<?php\nclass One\n{\n    public function a() { return 1; }\n    public function b() { return 2; }\n}\n',
  });
  try {
    const out = ok(runPayload(root, { op: 'patch_symbol', file: 'src/One.php', symbol: 'One::a', body: 'return 10;', dry: false }));
    assert.match(out, /^OK: src\/One\.php {2}One::a {2}тело L4-L4 → 1 строка {2}кодировка ascii {2}EOL lf\n?$/);
    const res = fsx.readText(path.join(root, 'src/One.php'));
    assert.equal(res.text, '<?php\nclass One\n{\n    public function a() { return 10; }\n    public function b() { return 2; }\n}\n');
    assert.ok(res.text.includes('public function a()'));
    // пустое новое тело → {}
    ok(runPayload(root, { op: 'patch_symbol', file: 'src/One.php', symbol: 'One::b', body: '', dry: false }));
    const res2 = fsx.readText(path.join(root, 'src/One.php'));
    assert.equal(res2.text, '<?php\nclass One\n{\n    public function a() { return 10; }\n    public function b() {}\n}\n');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('patch_symbol: многострочное тело — диф целиком, остальной файл байт в байт', (t) => {
  const root = project(t, { 'src/ReportService.php': SRC });
  try {
    const out = ok(runPayload(root, {
      op: 'patch_symbol', file: 'src/ReportService.php', symbol: 'ReportService::greet', dry: false,
      body: "if ($name === '') {\n    return 'гость';\n}\nreturn 'Привет, ' . $name;",
    }));
    assert.match(out, /^OK: .* → 4 строки {2}кодировка utf8 {2}EOL lf\n?$/);
    const res = fsx.readText(path.join(root, 'src/ReportService.php'));
    assert.equal(res.text, withBody(SRC, '\n' + [
      "        if ($name === '') {",
      "            return 'гость';",
      '        }',
      "        return 'Привет, ' . $name;",
    ].join('\n') + '\n    '));
    assert.ok(!res.text.includes('$label'));
    assert.ok(res.text.includes('public function total') && res.text.includes('const VERSION'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('patch_symbol: heredoc в старом теле не сбивает замену', (t) => {
  const src = [
    '<?php',
    'class Docs',
    '{',
    '    public function render($t)',
    '    {',
    '        $s = <<<TXT',
    'заголовок {брак} $t',
    'TXT;',
    '        return trim($s);',
    '    }',
    '}',
  ].join('\n');
  const root = project(t, { 'src/Docs.php': src });
  try {
    const open = src.indexOf('{', src.indexOf('public function render'));
    const close = src.indexOf('}', src.indexOf('return trim($s);'));
    const out = ok(runPayload(root, { op: 'patch_symbol', file: 'src/Docs.php', symbol: 'Docs::render', body: 'return $t;', dry: false }));
    assert.match(out, /^OK: .*тело L5-L10 → 1 строка/);
    const res = fsx.readText(path.join(root, 'src/Docs.php'));
    assert.equal(res.text, src.slice(0, open + 1) + '\n' + '        return $t;' + '\n' + '    ' + src.slice(close));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('patch_symbol: cp1251 — кириллица в теле и вне тела не битая, кодировка сохранилась', (t) => {
  const root = project(t, { 'src/Legacy.php': fsx.encodeText(SRC, 'cp1251', false) });
  try {
    ok(runPayload(root, { op: 'patch_symbol', file: 'src/Legacy.php', symbol: 'ReportService::greet', body: "return 'Привет, ' . $name . '!';", dry: false }));
    const res = fsx.readText(path.join(root, 'src/Legacy.php'));
    assert.equal(res.enc, 'cp1251');
    assert.equal(res.text, withBody(SRC, '\n' + "        return 'Привет, ' . $name . '!';" + '\n    '));
    assert.ok(res.text.includes('/** Сервис отчётов. */') && res.text.includes('/** Приветствие. */'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('patch_symbol: cp1251 + символ вне кодировки — отказ, файл не тронут', (t) => {
  const root = project(t, { 'src/Legacy.php': fsx.encodeText(SRC, 'cp1251', false) });
  try {
    const before = fs.readFileSync(path.join(root, 'src/Legacy.php'));
    const out = denied(runPayload(root, { op: 'patch_symbol', file: 'src/Legacy.php', symbol: 'ReportService::greet', body: 'return "✕";', dry: false }));
    assert.match(out, /нельзя записать в cp1251|запись отменена/);
    assert.deepEqual(fs.readFileSync(path.join(root, 'src/Legacy.php')), before);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('patch_symbol: UTF-16LE+BOM — BOM и порядок байтов сохранены', (t) => {
  const root = project(t, { 'src/Wide.php': fsx.encodeText(SRC, 'utf16le', true) });
  try {
    ok(runPayload(root, { op: 'patch_symbol', file: 'src/Wide.php', symbol: 'ReportService::greet', body: 'return $name;', dry: false }));
    const raw = fs.readFileSync(path.join(root, 'src/Wide.php'));
    assert.deepEqual([...raw.subarray(0, 2)], [0xFF, 0xFE]);
    const res = fsx.readText(path.join(root, 'src/Wide.php'));
    assert.equal(res.enc, 'utf16le');
    assert.equal(res.bom, true);
    assert.equal(res.text, withBody(SRC, '\n' + '        return $name;' + '\n    '));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('patch_symbol: CRLF-файл — EOL сохранён, новое тело переведено в CRLF', (t) => {
  const crlf = SRC.replace(/\n/g, '\r\n');
  const root = project(t, { 'src/Crlf.php': crlf });
  try {
    ok(runPayload(root, {
      op: 'patch_symbol', file: 'src/Crlf.php', symbol: 'ReportService::greet', dry: false,
      body: "return 'Привет, ' . $name;\nreturn strtolower($name);",
    }));
    const res = fsx.readText(path.join(root, 'src/Crlf.php'));
    assert.equal(res.eol, 'crlf');
    assert.equal(res.text, withBody(crlf, '\r\n' + "        return 'Привет, ' . $name;\r\n        return strtolower($name);" + '\r\n    '));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('patch_symbol: неоднозначный класс по файлам — отказ со списком кандидатов', (t) => {
  const a = '<?php\nclass Dup { public function m() { return 1; } }\n';
  const root = project(t, { 'src/a.php': a, 'src/b.php': '<?php\nclass Dup { public function m() { return 2; } }\n' });
  try {
    const out = denied(runPayload(root, { op: 'patch_symbol', file: 'src/a.php', symbol: 'Dup::m', body: 'return 3;', dry: false }));
    assert.match(out, /найден в нескольких файлах/);
    assert.match(out, /src\/a\.php/);
    assert.match(out, /src\/b\.php/);
    assert.equal(fs.readFileSync(path.join(root, 'src/a.php'), 'utf8'), a);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('patch_symbol: символ не найден — отказ с подсказкой op=symbol', (t) => {
  const root = project(t, { 'src/ReportService.php': SRC });
  try {
    const before = fs.readFileSync(path.join(root, 'src/ReportService.php'));
    const out = denied(runPayload(root, { op: 'patch_symbol', file: 'src/ReportService.php', symbol: 'NoSuch::greet', body: 'return 1;', dry: false }));
    assert.match(out, /не найден/);
    assert.match(out, /op=symbol/);
    const out2 = denied(runPayload(root, { op: 'patch_symbol', file: 'src/ReportService.php', symbol: 'ReportService::missing', body: 'return 1;', dry: false }));
    assert.match(out2, /не найдено|abstract|интерфейсн/);
    assert.deepEqual(fs.readFileSync(path.join(root, 'src/ReportService.php')), before);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('patch_symbol: abstract-метод — отказ', (t) => {
  const src = '<?php\nabstract class AbstractRepo\n{\n    abstract public function load(int $id): array;\n\n    public function ok(): int\n    {\n        return 1;\n    }\n}\n';
  const root = project(t, { 'src/Repo.php': src });
  try {
    const out = denied(runPayload(root, { op: 'patch_symbol', file: 'src/Repo.php', symbol: 'AbstractRepo::load', body: 'return [];', dry: false }));
    assert.match(out, /не найдено|abstract/i);
    assert.equal(fs.readFileSync(path.join(root, 'src/Repo.php'), 'utf8'), src);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('patch_symbol: несбалансированное новое тело — отказ, файл не тронут', (t) => {
  const root = project(t, { 'src/ReportService.php': SRC });
  try {
    const before = fs.readFileSync(path.join(root, 'src/ReportService.php'));
    const out = denied(runPayload(root, { op: 'patch_symbol', file: 'src/ReportService.php', symbol: 'ReportService::greet', body: 'if (true) { return 1;', dry: false }));
    assert.match(out, /несбалансировано/);
    assert.deepEqual(fs.readFileSync(path.join(root, 'src/ReportService.php')), before);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('patch_symbol: body_file внутри проекта — тело из файла; вне проекта — отказ', (t) => {
  const root = project(t, {
    'src/ReportService.php': SRC,
    'newbody.txt': "return 'из файла';\n",
  });
  try {
    const out = ok(runPayload(root, { op: 'patch_symbol', file: 'src/ReportService.php', symbol: 'ReportService::greet', body_file: 'newbody.txt', dry: false }));
    assert.match(out, /^OK:/);
    const res = fsx.readText(path.join(root, 'src/ReportService.php'));
    assert.equal(res.text, withBody(SRC, '\n' + "        return 'из файла';" + '\n    '));
    const outside = path.join(root, '..', 't4-outside-body.txt');
    fs.writeFileSync(outside, 'return 1;\n');
    try {
      const before = fs.readFileSync(path.join(root, 'src/ReportService.php'));
      const out2 = denied(runPayload(root, { op: 'patch_symbol', file: 'src/ReportService.php', symbol: 'ReportService::greet', body_file: '../t4-outside-body.txt', dry: false }));
      assert.match(out2, /вне рабочей директории/);
      assert.deepEqual(fs.readFileSync(path.join(root, 'src/ReportService.php')), before);
    } finally { fs.rmSync(outside, { force: true }); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('patch_symbol: body и body_file вместе — отказ; ни того ни другого — отказ', (t) => {
  const root = project(t, { 'src/ReportService.php': SRC, 'newbody.txt': 'return 1;\n' });
  try {
    const out = denied(runPayload(root, { op: 'patch_symbol', file: 'src/ReportService.php', symbol: 'ReportService::greet', body: 'return 1;', body_file: 'newbody.txt', dry: false }));
    assert.match(out, /ровно одно: body или body_file/);
    const out2 = denied(runPayload(root, { op: 'patch_symbol', file: 'src/ReportService.php', symbol: 'ReportService::greet', dry: false }));
    assert.match(out2, /ровно одно: body или body_file/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('patch_symbol: indent=raw vs indent=auto — различимое поведение', (t) => {
  const root = project(t, { 'src/ReportService.php': SRC, 'src/Auto.php': SRC.replace(/ReportService/g, 'AutoSvc'), 'src/Raw.php': SRC.replace(/ReportService/g, 'RawSvc') });
  try {
    ok(runPayload(root, { op: 'patch_symbol', file: 'src/Auto.php', symbol: 'AutoSvc::greet', body: 'return 7;', dry: false }));
    const auto = fsx.readText(path.join(root, 'src/Auto.php')).text;
    assert.ok(auto.includes('\n        return 7;\n'), 'auto: базовый отступ старого тела');
    ok(runPayload(root, { op: 'patch_symbol', file: 'src/Raw.php', symbol: 'RawSvc::greet', body: 'return 7;', dry: false, indent: 'raw' }));
    const raw = fsx.readText(path.join(root, 'src/Raw.php')).text;
    assert.ok(raw.includes('\nreturn 7;\n'), 'raw: тело вставлено как передано');
    assert.equal(raw, withBody(SRC.replace(/ReportService/g, 'RawSvc'), '\n' + 'return 7;' + '\n    '));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('patch_symbol: раскрытие \\n, \\t, \\r в body из argv; глобальная функция', (t) => {
  const root = project(t, { 'src/ReportService.php': SRC, 'src/helpers.php': '<?php\nfunction helper_total(array $rows): int\n{\n    return 1;\n}\n' });
  try {
    ok(run(root, ['op=patch_symbol', 'file=src/ReportService.php', 'symbol=ReportService::greet', 'body=$x = 1;\\n\\treturn $x;', 'dry=false']));
    const res = fsx.readText(path.join(root, 'src/ReportService.php'));
    assert.equal(res.text, withBody(SRC, '\n' + '        $x = 1;\n        \treturn $x;' + '\n    '));
    const out = ok(runPayload(root, { op: 'patch_symbol', file: 'src/helpers.php', symbol: 'helper_total', body: 'return count($rows);', dry: false }));
    assert.match(out, /^OK: src\/helpers\.php {2}helper_total {2}тело L3-L5 → 1 строка/);
    const res2 = fsx.readText(path.join(root, 'src/helpers.php'));
    assert.equal(res2.text, '<?php\nfunction helper_total(array $rows): int\n{\n    return count($rows);\n}\n');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('patch_symbol: указанный file не совпадает с файлом символа — отказ; generic-режим работает', (t) => {
  const root = project(t, { 'src/ReportService.php': SRC });
  try {
    const out = denied(runPayload(root, { op: 'patch_symbol', file: 'src/Other.php', symbol: 'ReportService::greet', body: 'return 1;', dry: false }));
    assert.match(out, /найден в src\/ReportService\.php, а указан file=src\/Other\.php/);
    const out2 = ok(runPayload(root, { op: 'patch_symbol', file: './src/ReportService.php', symbol: 'App\\ReportService::greet', body: 'return 1;', dry: false }));
    assert.match(out2, /^OK: src\/ReportService\.php/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('patch_symbol: работает в Laravel-режиме (не режимная операция)', (t) => {
  const root = project(t, {
    'artisan': '',
    'composer.json': '{"require":{"laravel/framework":"^12.0"}}',
    'app/Services/Price.php': '<?php\nnamespace App\\Services;\n\nclass Price\n{\n    public function calc(int $n): int\n    {\n        return $n * 2;\n    }\n}\n',
  });
  try {
    const out = ok(runPayload(root, { op: 'patch_symbol', file: 'app/Services/Price.php', symbol: 'Price::calc', body: 'return $n * 3;', dry: false }));
    assert.match(out, /^OK: app\/Services\/Price\.php {2}Price::calc/);
    const res = fsx.readText(path.join(root, 'app/Services/Price.php'));
    assert.ok(res.text.includes('return $n * 3;'));
    assert.ok(res.text.includes('public function calc(int $n): int'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
