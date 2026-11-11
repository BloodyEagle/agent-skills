'use strict';
// Задача 5: op=console — суммарный кап 50 записей (команды + расписание), limit= меняет кап,
// limit=0 выводит всё, при усечении маркер «… ещё N (limit=0 — полностью)».
// Только stdlib; проект генерируется во временном каталоге и удаляется в finally.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const bx = path.resolve(__dirname, '../../skills/token-economy-php/scripts/bx.js');

// Состав фикстуры: 59 классов команд с $signature + 1 Artisan::command = 60 команд,
// 5 записей расписания (3 через CommandN::class, 2 строкой) — 65 записей суммарно.
function makeProject(root) {
  fs.mkdirSync(path.join(root, 'app/Console/Commands'), { recursive: true });
  fs.mkdirSync(path.join(root, 'routes'), { recursive: true });
  fs.writeFileSync(path.join(root, 'artisan'),
    "#!/usr/bin/env php\n<?php\ndefine('LARAVEL_START', microtime(true));\nrequire __DIR__.'/vendor/autoload.php';\n$app = require_once __DIR__.'/bootstrap/app.php';\n");
  fs.writeFileSync(path.join(root, 'composer.json'), '{"require":{"laravel/framework":"^12.0"}}');
  for (let i = 1; i <= 59; i++) {
    fs.writeFileSync(path.join(root, 'app/Console/Commands/Command' + i + '.php'),
      '<?php\n' +
      'namespace App\\Console\\Commands;\n' +
      'use Illuminate\\Console\\Command;\n\n' +
      'class Command' + i + ' extends Command\n' +
      '{\n' +
      "    protected $signature = 'app:job" + i + " {id}';\n" +
      "    protected $description = 'Описание команды номер " + i + ": выполняет фоновое задание';\n\n" +
      '    public function handle()\n' +
      '    {\n' +
      '    }\n' +
      '}\n');
  }
  fs.writeFileSync(path.join(root, 'routes/console.php'),
    '<?php\n\n' +
    'use App\\Console\\Commands\\Command1;\n' +
    'use App\\Console\\Commands\\Command2;\n' +
    'use App\\Console\\Commands\\Command3;\n' +
    'use Illuminate\\Support\\Facades\\Artisan;\n' +
    'use Illuminate\\Support\\Facades\\Schedule;\n\n' +
    "Schedule::command(Command1::class)->dailyAt('02:00');\n" +
    'Schedule::command(Command2::class)->hourly();\n' +
    'Schedule::command(Command3::class)->daily();\n' +
    "Schedule::command('app:job4')->weekdays();\n" +
    "Schedule::command('app:job5')->everyMinute();\n\n" +
    "Artisan::command('app:inline {id}', function () {\n" +
    '    // разовая inline-команда\n' +
    '});\n');
}

function withProject(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bx-t5-'));
  try {
    makeProject(root);
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function cli(root, params) {
  return spawnSync(process.execPath, [bx, 'root=' + root,
    ...Object.entries(params).map(([k, v]) => k + '=' + v)], {
    cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024,
  });
}

function success(result) {
  assert.ifError(result.error);
  assert.equal(result.status, 0, (result.stdout + result.stderr).slice(0, 1200));
  assert.equal(result.stderr, '', 'stderr пуст');
  return result.stdout.replace(/\r\n/g, '\n');
}

// строка записи начинается с двух пробелов; заголовки и маркер — нет
const rows = (out) => out.split('\n').filter((l) => /^ {2}\S/.test(l));
// записи расписания: частота после сигнатуры — dailyAt('02:00') с аргументом,
// без аргументов имя цепочки без скобок (hourly, daily, weekdays, everyMinute)
const schedRows = (out) => rows(out).filter((l) => /^ {2}\S.*  (dailyAt\('[^']*'\)|hourly|daily(?!At)|weekdays|everyMinute)  \(\S+:\d+\)$/.test(l));

test('дефолт: ровно 50 записей, оба заголовка, маркер «ещё 15», расписания в окне нет', () => withProject((root) => {
  const out = success(cli(root, { op: 'console' }));
  const lines = out.replace(/\r\n/g, '\n').split('\n');
  assert.equal(lines[0], 'команды (60):');
  assert.equal(rows(out).length, 50);
  assert.equal(schedRows(out).length, 0);
  assert.ok(lines.includes('расписание (5):'), 'заголовок расписания на месте');
  assert.equal(out.trimEnd().split('\n').pop(), '… ещё 15 (limit=0 — полностью)');
}));

test('limit=0: все 65 записей, маркера нет', () => withProject((root) => {
  const out = success(cli(root, { op: 'console', limit: 0 }));
  assert.equal(rows(out).length, 65);
  assert.equal(schedRows(out).length, 5);
  assert.doesNotMatch(out, /ещё \d+/);
  assert.match(out, /^команды \(60\):$/m);
  assert.match(out, /^расписание \(5\):$/m);
}));

test('limit=10: 10 записей, маркер «ещё 55»', () => withProject((root) => {
  const out = success(cli(root, { op: 'console', limit: 10 }));
  assert.equal(rows(out).length, 10);
  assert.equal(out.trimEnd().split('\n').pop(), '… ещё 55 (limit=0 — полностью)');
}));

test('limit=63: 60 команд + 3 записи расписания, маркер «ещё 2»', () => withProject((root) => {
  const out = success(cli(root, { op: 'console', limit: 63 }));
  assert.equal(rows(out).length, 63);
  assert.equal(schedRows(out).length, 3);
  assert.equal(out.trimEnd().split('\n').pop(), '… ещё 2 (limit=0 — полностью)');
}));

test('limit=65: ровно все записи, маркера нет', () => withProject((root) => {
  const out = success(cli(root, { op: 'console', limit: 65 }));
  assert.equal(rows(out).length, 65);
  assert.doesNotMatch(out, /ещё \d+/);
}));

test('порядок: сначала записи команд, затем записи расписания', () => withProject((root) => {
  const out = success(cli(root, { op: 'console', limit: 0 }));
  const all = rows(out);
  const cmd = all.filter((l) => !schedRows(out).includes(l));
  assert.equal(cmd.length, 60);
  assert.equal(schedRows(out).length, 5);
  const lastCmd = all.indexOf(cmd[cmd.length - 1]);
  const firstSched = all.indexOf(schedRows(out)[0]);
  assert.ok(lastCmd < firstSched, 'команды идут раньше расписания');
}));

test('заголовок расписания печатается, даже когда ни одна запись расписания не влезла', () => withProject((root) => {
  const out = success(cli(root, { op: 'console', limit: 60 }));
  assert.equal(rows(out).length, 60);
  assert.equal(schedRows(out).length, 0);
  assert.match(out, /^расписание \(5\):$/m);
  assert.equal(out.trimEnd().split('\n').pop(), '… ещё 5 (limit=0 — полностью)');
}));

test('расписание с X::class резолвится в сигнатуру команды', () => withProject((root) => {
  const out = success(cli(root, { op: 'console', limit: 0 }));
  assert.match(out, /^ {2}app:job1 \{id\}  dailyAt\('02:00'\)  \(routes\/console\.php:\d+\)$/m);
  assert.doesNotMatch(out, /Command\d+::class/);
}));
