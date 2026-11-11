'use strict';
// Задача 3: op read — несколько диапазонов за вызов (ranges). Только stdlib;
// временный Laravel-проект на mkdtempSync, bx.js спавном, удаление в finally.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const bx = path.resolve(__dirname, '../../skills/token-economy-php/scripts/bx.js');
const { encodeText } = require(path.resolve(__dirname, '../../skills/token-economy-php/scripts/lib/fsx'));

// Файлы временного проекта: без завершающего перевода строки, чтобы число строк совпадало с числом элементов.
const PLAIN = Array.from({ length: 50 }, (_, i) => 'Строка ' + (i + 1)); // UTF-8, 50 строк
const CP = Array.from({ length: 20 }, (_, i) => 'Кириллица cp1251, строка ' + (i + 1)); // windows-1251
const CRLF = Array.from({ length: 30 }, (_, i) => 'crlf строка ' + (i + 1)); // UTF-8, CRLF
const LONG = Array.from({ length: 3000 }, (_, i) => 'long ' + (i + 1)); // для отказа >2000 строк

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bx-t3-'));
  fs.writeFileSync(path.join(root, 'artisan'), '');
  fs.writeFileSync(path.join(root, 'composer.json'), JSON.stringify({ require: { 'laravel/framework': '^12.0' } }));
  fs.writeFileSync(path.join(root, 'plain.txt'), PLAIN.join('\n'), 'utf8');
  fs.writeFileSync(path.join(root, 'cp1251.txt'), encodeText(CP.join('\n'), 'cp1251', false));
  fs.writeFileSync(path.join(root, 'crlf.txt'), CRLF.join('\r\n'), 'utf8');
  fs.writeFileSync(path.join(root, 'long.txt'), LONG.join('\n'), 'utf8');
  return root;
}

function bxRun(root, argv, extra = {}) {
  const result = spawnSync(process.execPath, [bx, 'root=' + root, ...argv], {
    cwd: root, encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024, ...extra,
  });
  assert.ifError(result.error);
  return result;
}

const norm = (s) => s.replace(/\r\n/g, '\n');

// Ожидаемый stdout: один заголовок файла, блоки строк с абсолютными номерами,
// между блоками с зазором разделитель пропуска.
function expectedOut(name, lines, enc, blocks) {
  const out = [`${name}  (${lines.length} строк, ${enc})`];
  let prev = 0;
  for (const [a, b] of blocks) {
    if (prev) out.push(`--- пропуск L${prev + 1}-${a - 1} ---`);
    for (let i = a; i <= b; i++) out.push(`${i}: ${lines[i - 1]}`);
    prev = b;
  }
  return out.join('\n') + '\n';
}

test('задача 3: перекрывающиеся диапазоны сливаются (10-20,15-25 → 10-25)', () => {
  const root = makeProject();
  try {
    const r = bxRun(root, ['op=read', 'file=plain.txt', 'ranges=10-20,15-25']);
    assert.equal(r.status, 0, r.stdout);
    assert.equal(norm(r.stdout), expectedOut('plain.txt', PLAIN, 'utf8', [[10, 25]]));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('задача 3: вплотную соседние сливаются (10-20,21-30 → 10-30)', () => {
  const root = makeProject();
  try {
    const r = bxRun(root, ['op=read', 'file=plain.txt', 'ranges=10-20,21-30']);
    assert.equal(r.status, 0, r.stdout);
    assert.equal(norm(r.stdout), expectedOut('plain.txt', PLAIN, 'utf8', [[10, 30]]));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('задача 3: зазор сохранён, разделитель пропуска (10-20,30-40)', () => {
  const root = makeProject();
  try {
    const r = bxRun(root, ['op=read', 'file=plain.txt', 'ranges=10-20,30-40']);
    assert.equal(r.status, 0, r.stdout);
    assert.equal(norm(r.stdout), expectedOut('plain.txt', PLAIN, 'utf8', [[10, 20], [30, 40]]));
    assert.ok(norm(r.stdout).includes('--- пропуск L21-29 ---'), 'разделитель: ' + r.stdout);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('задача 3: обратный порядок входа даёт тот же вывод', () => {
  const root = makeProject();
  try {
    const direct = bxRun(root, ['op=read', 'file=plain.txt', 'ranges=10-20,30-40']);
    const reversed = bxRun(root, ['op=read', 'file=plain.txt', 'ranges=30-40,10-20']);
    assert.equal(direct.status, 0);
    assert.equal(reversed.status, 0);
    assert.equal(norm(reversed.stdout), norm(direct.stdout));
    assert.equal(norm(reversed.stdout), expectedOut('plain.txt', PLAIN, 'utf8', [[10, 20], [30, 40]]));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('задача 3: дубликат диапазона — один блок без повторов строк', () => {
  const root = makeProject();
  try {
    const r = bxRun(root, ['op=read', 'file=plain.txt', 'ranges=10-20,10-20']);
    assert.equal(r.status, 0, r.stdout);
    assert.equal(norm(r.stdout), expectedOut('plain.txt', PLAIN, 'utf8', [[10, 20]]));
    assert.equal((norm(r.stdout).match(/^12: Строка 12$/gm) || []).length, 1, 'строка 12 один раз');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('задача 3: одна строка — формы «15» и «15-15»', () => {
  const root = makeProject();
  try {
    for (const ranges of ['ranges=15', 'ranges=15-15']) {
      const r = bxRun(root, ['op=read', 'file=plain.txt', ranges]);
      assert.equal(r.status, 0, r.stdout);
      assert.equal(norm(r.stdout), expectedOut('plain.txt', PLAIN, 'utf8', [[15, 15]]));
      assert.ok(norm(r.stdout).includes('15: Строка 15'), r.stdout);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('задача 3: диапазон за концом частично клампится (45-60 на 50 строк → 45-50)', () => {
  const root = makeProject();
  try {
    const r = bxRun(root, ['op=read', 'file=plain.txt', 'ranges=45-60']);
    assert.equal(r.status, 0, r.stdout);
    assert.equal(norm(r.stdout), expectedOut('plain.txt', PLAIN, 'utf8', [[45, 50]]));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('задача 3: диапазон целиком за концом файла — отказ (60-70)', () => {
  const root = makeProject();
  try {
    const r = bxRun(root, ['op=read', 'file=plain.txt', 'ranges=60-70']);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /за концом файла/);
    assert.ok(!r.stdout.includes('Строка'), 'файл не печатается: ' + r.stdout);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('задача 3: start больше end — отказ (20-10)', () => {
  const root = makeProject();
  try {
    const r = bxRun(root, ['op=read', 'file=plain.txt', 'ranges=20-10']);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /начало больше конца/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('задача 3: суммарно больше 2000 строк — отказ без усечки (1-2500)', () => {
  const root = makeProject();
  try {
    const r = bxRun(root, ['op=read', 'file=long.txt', 'ranges=1-2500']);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /2500/);
    assert.match(r.stdout, /больше 2000/);
    assert.ok(!r.stdout.includes('long '), 'файл не печатается: ' + r.stdout.slice(0, 300));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('задача 3: cp1251 — кириллица в выводе не битая', () => {
  const root = makeProject();
  try {
    const r = bxRun(root, ['op=read', 'file=cp1251.txt', 'ranges=3-5']);
    assert.equal(r.status, 0, r.stdout);
    assert.equal(norm(r.stdout), expectedOut('cp1251.txt', CP, 'cp1251', [[3, 5]]));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('задача 3: CRLF-файл — строки выводятся как обычно', () => {
  const root = makeProject();
  try {
    const r = bxRun(root, ['op=read', 'file=crlf.txt', 'ranges=2-4']);
    assert.equal(r.status, 0, r.stdout);
    assert.equal(norm(r.stdout), expectedOut('crlf.txt', CRLF, 'utf8', [[2, 4]]));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('задача 3: ranges вместе с offset/limit — отказ', () => {
  const root = makeProject();
  try {
    const withLimit = bxRun(root, ['op=read', 'file=plain.txt', 'ranges=1-5', 'limit=10']);
    assert.equal(withLimit.status, 1, withLimit.stdout);
    assert.match(withLimit.stdout, /несовместим/);
    const withOffset = bxRun(root, ['op=read', 'file=plain.txt', 'ranges=1-5', 'offset=2']);
    assert.equal(withOffset.status, 1, withOffset.stdout);
    assert.match(withOffset.stdout, /несовместим/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('задача 3: legacy-вызов с offset/limit не изменился', () => {
  const root = makeProject();
  try {
    const r = bxRun(root, ['op=read', 'file=plain.txt', 'offset=2', 'limit=3']);
    assert.equal(r.status, 0, r.stdout);
    assert.equal(norm(r.stdout), [
      'plain.txt  (50 строк, utf8)',
      '2: Строка 2',
      '3: Строка 3',
      '4: Строка 4',
      '… ещё строк: 46',
      '',
    ].join('\n'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('задача 3: заголовок файла один даже при нескольких блоках', () => {
  const root = makeProject();
  try {
    const r = bxRun(root, ['op=read', 'file=plain.txt', 'ranges=5-10,20-25,40-45']);
    assert.equal(r.status, 0, r.stdout);
    const text = norm(r.stdout);
    assert.equal((text.match(/^plain.txt {2}\(/gm) || []).length, 1, 'один заголовок: ' + text.split('\n')[0]);
    assert.equal((text.match(/^--- пропуск /gm) || []).length, 2, 'два разделителя');
    assert.equal(norm(r.stdout), expectedOut('plain.txt', PLAIN, 'utf8', [[5, 10], [20, 25], [40, 45]]));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('задача 3: JSON-массив диапазонов через @-payload', () => {
  const root = makeProject();
  try {
    const payload = path.join(root, 'payload.json');
    fs.writeFileSync(payload, JSON.stringify({ op: 'read', file: 'plain.txt', ranges: [[10, 20], [30, 40]] }), 'utf8');
    const viaPayload = bxRun(root, ['@' + payload]);
    assert.equal(viaPayload.status, 0, viaPayload.stdout);
    assert.equal(norm(viaPayload.stdout), expectedOut('plain.txt', PLAIN, 'utf8', [[10, 20], [30, 40]]));
    const viaArgv = bxRun(root, ['op=read', 'file=plain.txt', 'ranges=10-20,30-40']);
    assert.equal(norm(viaPayload.stdout), norm(viaArgv.stdout), 'массив и строка дают один вывод');

    const payloadSingle = path.join(root, 'payload-single.json');
    fs.writeFileSync(payloadSingle, JSON.stringify({ op: 'read', file: 'plain.txt', ranges: [[15]] }), 'utf8');
    const viaSingle = bxRun(root, ['@' + payloadSingle]);
    assert.equal(viaSingle.status, 0, viaSingle.stdout);
    assert.equal(norm(viaSingle.stdout), expectedOut('plain.txt', PLAIN, 'utf8', [[15, 15]]));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
