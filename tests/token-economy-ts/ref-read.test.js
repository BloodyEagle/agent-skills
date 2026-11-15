// ref-read.test.js — runtime-проверка ref= для graph op=read (этап W4, план 20+21 v3 §16 W3/W4):
// те же сценарии, что в corpus (ref-corpus.json), на реальных временных файлах. Старый
// синтаксис file+ranges не менялся: ответы прежнего пути сверяются с прежним договором.
// Грамматика (без исполнения) — ref-corpus.test.js; реальный мост двух версий — внешний
// live bridge (вне этого набора). Чтение не строит граф: helpers.cli сам проверяет,
// что в проекте не появились ни graph-deps.json, ни кэш.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');
const {project, cli, json, scripts} = require('./helpers');

// Локальный запуск без inventory: сценарий junction/symlink содержит ссылку, которую
// helpers.inventory запрещает в фикстурах; защита пути проверяется на реальном переходе.
function cliRaw(root, argsObj) {
    return spawnSync(process.execPath, [path.join(scripts, 'graph-tool.js'),
        ...Object.entries(argsObj).map(([key, value]) => key + '=' + value)], {
        cwd: root, encoding: 'utf8', timeout: 8000, windowsHide: true,
        env: {...process.env, NODE_OPTIONS: '', HOME: root, USERPROFILE: root}, maxBuffer: 4 * 1024 * 1024
    });
}

const F = 'alpha\nbeta\ngamma\ndelta\n'; // 4 строки
const MANY = (n) => Array.from({length: n}, (_, i) => 'line' + (i + 1)).join('\n') + '\n';

test('ref: bare малого файла — полный текст одним блоком, эквивалент file+ranges', () => project(root => {
    const bare = json(root, 'graph-tool', {op: 'read', ref: 'f.txt'});
    assert.deepEqual(bare, {file: 'f.txt', loc: 4, blocks: [{startLine: 1, endLine: 4, lines: ['alpha', 'beta', 'gamma', 'delta']}]});
    const legacy = json(root, 'graph-tool', {op: 'read', file: 'f.txt', ranges: '1-4'});
    assert.deepEqual(bare, legacy);
}, {'f.txt': F}, {empty: true}));

test('ref: одиночная строка и включительный диапазон; граница конца файла (loc ок, loc+1 отказ)', () => project(root => {
    const one = json(root, 'graph-tool', {op: 'read', ref: 'f.txt:2'});
    assert.deepEqual(one.blocks, [{startLine: 2, endLine: 2, lines: ['beta']}]);
    const range = json(root, 'graph-tool', {op: 'read', ref: 'f.txt:2-3'});
    assert.deepEqual(range.blocks, [{startLine: 2, endLine: 3, lines: ['beta', 'gamma']}]);
    const refEqLegacy = json(root, 'graph-tool', {op: 'read', file: 'f.txt', ranges: '2-3'});
    assert.deepEqual(range, refEqLegacy);
    const eof = json(root, 'graph-tool', {op: 'read', ref: 'f.txt:3-4'});
    assert.deepEqual(eof.blocks, [{startLine: 3, endLine: 4, lines: ['gamma', 'delta']}]);
    const beyond = cli(root, 'graph-tool', {op: 'read', ref: 'f.txt:3-5'});
    assert.equal(beyond.status, 1);
    assert.match(JSON.parse(beyond.stdout).error, /за пределами файла/);
}, {'f.txt': F}, {empty: true}));

test('ref: hash-локаторы #LN / #LN-LM дают тот же результат, что :N / :N-M', () => project(root => {
    assert.deepEqual(json(root, 'graph-tool', {op: 'read', ref: 'f.txt#L2'}), json(root, 'graph-tool', {op: 'read', ref: 'f.txt:2'}));
    assert.deepEqual(json(root, 'graph-tool', {op: 'read', ref: 'f.txt#L2-L3'}), json(root, 'graph-tool', {op: 'read', ref: 'f.txt:2-3'}));
}, {'f.txt': F}, {empty: true}));

test('ref: кириллица и пробелы в имени файла и каталоге', () => project(root => {
    const r = json(root, 'graph-tool', {op: 'read', ref: 'документы/отчёт итог.txt:2'});
    assert.equal(r.file, 'документы/отчёт итог.txt');
    assert.deepEqual(r.blocks[0].lines, ['вторая строка']);
}, {'документы/отчёт итог.txt': 'первая строка\nвторая строка\n'}, {empty: true}));

test('ref: Windows drive — абсолютный путь внутри cwd с локатором и bare', () => project(root => {
    const drive = path.resolve(root, 'f.txt'); // C:\… путь
    const r = json(root, 'graph-tool', {op: 'read', ref: drive + ':3'});
    assert.deepEqual(r.blocks, [{startLine: 3, endLine: 3, lines: ['gamma']}]);
    assert.equal(r.file, 'f.txt');
    const bare = json(root, 'graph-tool', {op: 'read', ref: drive});
    assert.deepEqual(bare.blocks, [{startLine: 1, endLine: 4, lines: ['alpha', 'beta', 'gamma', 'delta']}]);
}, {'f.txt': F}, {empty: true}));

test('ref: bare большого файла (>=300 строк) — range_required с точным путём и следующим шагом', () => project(root => {
    const r = cli(root, 'graph-tool', {op: 'read', ref: 'big.txt'});
    assert.equal(r.status, 1);
    const out = JSON.parse(r.stdout);
    assert.equal(out.code, 'range_required');
    assert.match(out.error, /ref=big\.txt/);
    assert.match(out.error, /300/);
    assert.match(out.error, /outline/);
    // диапазон того же файла работает — отказ касается только полного чтения
    const ranged = json(root, 'graph-tool', {op: 'read', ref: 'big.txt:299-301'});
    assert.equal(ranged.blocks[0].startLine, 299);
}, {'big.txt': MANY(400)}, {empty: true}));

test('ref: bare в байтовом лимите — файл >1 МиБ и <300 строк тоже range_required', () => project(root => {
    const r = cli(root, 'graph-tool', {op: 'read', ref: 'fat.txt'});
    assert.equal(r.status, 1);
    const out = JSON.parse(r.stdout);
    assert.equal(out.code, 'range_required');
    assert.match(out.error, /байтовый лимит/);
    const ranged = json(root, 'graph-tool', {op: 'read', ref: 'fat.txt:1-2'});
    assert.equal(ranged.blocks.length, 1);
}, {'fat.txt': Array.from({length: 250}, () => 'x'.repeat(5000)).join('\n')}, {empty: true}));

test('ref: длинная строка >64 КиБ по ref= — явный отказ; прежний file+ranges возвращает её без изменений', () => project(root => {
    const refused = cli(root, 'graph-tool', {op: 'read', ref: 'long.txt:1-2'});
    assert.equal(refused.status, 1);
    const out = JSON.parse(refused.stdout);
    assert.equal(out.code, 'line_too_long');
    // старый путь сохраняет прежнее поведение (лимит строк, не байт)
    const legacy = json(root, 'graph-tool', {op: 'read', file: 'long.txt', ranges: '1-2'});
    assert.equal(legacy.blocks[0].lines[0].length, 70000);
}, {'long.txt': 'x'.repeat(70000) + '\nsecond\n'}, {empty: true}));

test('ref: конфликт аргументов — ref одновременно с file или ranges; без скрытого приоритета', () => project(root => {
    for (const args of [
        {op: 'read', ref: 'f.txt:1', file: 'f.txt'},
        {op: 'read', ref: 'f.txt:1', ranges: '1-2'},
        {op: 'read', ref: 'f.txt:1', file: 'f.txt', ranges: '1-2'},
        {op: 'read', ref: 'f.txt:1', ranges: [1, 2]}
    ]) {
        const r = cli(root, 'graph-tool', args);
        assert.equal(r.status, 1, JSON.stringify(args));
        const out = JSON.parse(r.stdout);
        assert.equal(out.code, 'conflicting_args');
        assert.match(out.error, /конфликт аргументов/);
    }
}, {'f.txt': F}, {empty: true}));

test('ref: git-виды — явный unsupported_ref_kind, не «файл не найден», без подмены working tree', () => project(root => {
    for (const raw of ['git:tag:2026', 'git:commit:abc123', 'git:branch:main', 'HEAD:src/f.txt', 'abc1234:src/f.txt']) {
        const r = cli(root, 'graph-tool', {op: 'read', ref: raw});
        assert.equal(r.status, 1, raw);
        const out = JSON.parse(r.stdout);
        assert.equal(out.code, 'unsupported_ref_kind', raw);
        assert.equal(out.refKind, raw.startsWith('git:') ? 'git_ref' : 'git_blob', raw);
        assert.ok(Array.isArray(out.supported) && out.supported.includes('path:N-M'), raw);
        assert.match(out.error, /Поддерживаемые виды/);
    }
}, {'f.txt': F}, {empty: true}));

test('ref: выход за корень и несуществующий путь — те же защитные ошибки, что у file+ranges', () => project(root => {
    const refOut = cli(root, 'graph-tool', {op: 'read', ref: '../outside.txt:1'});
    assert.equal(refOut.status, 1);
    const legacyOut = cli(root, 'graph-tool', {op: 'read', file: '../outside.txt', ranges: '1'});
    assert.equal(legacyOut.status, 1);
    assert.equal(JSON.parse(refOut.stdout).error, JSON.parse(legacyOut.stdout).error);
    const missing = cli(root, 'graph-tool', {op: 'read', ref: 'нет-такого.txt:1'});
    assert.equal(missing.status, 1);
    assert.match(JSON.parse(missing.stdout).error, /Файл не найден/);
    // обратный/нулевой диапазон — ошибка без усечки
    const reversed = cli(root, 'graph-tool', {op: 'read', ref: 'f.txt:3-2'});
    assert.equal(reversed.status, 1);
    assert.match(JSON.parse(reversed.stdout).error, /конец ≥ начала/);
    const zero = cli(root, 'graph-tool', {op: 'read', ref: 'f.txt:0'});
    assert.equal(zero.status, 1);
}, {'f.txt': F}, {empty: true}));

test('ref: symlink/junction наружу — отказ тем же защитным путём', root => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-economy-ref-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'token-economy-ref-out-'));
    try {
        fs.writeFileSync(path.join(dir, 'f.txt'), F, 'utf8');
        fs.writeFileSync(path.join(outside, 'secret.txt'), 'top\n', 'utf8');
        fs.symlinkSync(outside, path.join(dir, 'j-out'), 'junction');
        const r = cliRaw(dir, {op: 'read', ref: 'j-out/secret.txt:1'});
        assert.equal(r.status, 1);
        assert.match(JSON.parse(r.stdout).error, /вне рабочей директории/);
        // и bare-форма не обходит границу
        const bare = cliRaw(dir, {op: 'read', ref: 'j-out/secret.txt'});
        assert.equal(bare.status, 1);
        assert.match(JSON.parse(bare.stdout).error, /вне рабочей директории/);
    } finally {
        fs.rmSync(dir, {recursive: true, force: true});
        fs.rmSync(outside, {recursive: true, force: true});
    }
});

test('ref: пустой файл — bare даёт пустые блоки; диапазон за пределами — отказ', () => project(root => {
    const bare = json(root, 'graph-tool', {op: 'read', ref: 'empty.txt'});
    assert.deepEqual(bare, {file: 'empty.txt', loc: 0, blocks: []});
    const r = cli(root, 'graph-tool', {op: 'read', ref: 'empty.txt:1'});
    assert.equal(r.status, 1);
    assert.match(JSON.parse(r.stdout).error, /за пределами файла/);
}, {'empty.txt': ''}, {empty: true}));

test('ref: BOM и CRLF — тот же контракт line-блоков; выдача нормализована и не является исходными байтами', () => project(root => {
    const r = json(root, 'graph-tool', {op: 'read', ref: 'c.txt:1-2'});
    assert.deepEqual(r.blocks[0].lines, ['\uFEFF-removed', 'second']);
    assert.ok(r.blocks[0].lines.every(l => !l.includes('\r')));
}, {'c.txt': '\uFEFF\uFEFF-removed\r\nsecond\r\nthird\r\n'}, {empty: true}));

test('ref: batch — ref у read-запроса; идентичность/порядок по index, per-item error, failed, exit 0 ≠ полный успех', () => project(root => {
    const r = json(root, 'graph-tool', {requests: JSON.stringify([
        {op: 'read', ref: 'f.txt:2'},
        {op: 'read', ref: 'git:branch:main'},
        {op: 'read', file: 'f.txt', ranges: '1-2'},
        {op: 'read', ref: 'f.txt'},
        {op: 'read', ref: 'f.txt:1', file: 'f.txt'}
    ])});
    assert.equal(r.batch, true);
    assert.equal(r.total, 5);
    assert.equal(r.failed, 2);
    assert.deepEqual(r.results[0].blocks, [{startLine: 2, endLine: 2, lines: ['beta']}]);
    assert.equal(r.results[1].code, 'unsupported_ref_kind');
    assert.deepEqual(r.results[2].blocks, [{startLine: 1, endLine: 2, lines: ['alpha', 'beta']}]);
    assert.equal(r.results[3].blocks[0].endLine, 4);
    assert.equal(r.results[4].code, 'conflicting_args');
    for (const [i, res] of r.results.entries()) assert.equal(res.index, i);
    // все запросы с ошибками — exit 1
    const all = cli(root, 'graph-tool', {requests: JSON.stringify([
        {op: 'read', ref: 'git:tag:x'}, {op: 'read', ref: 'HEAD:f.txt'}])});
    assert.equal(all.status, 1);
}, {'f.txt': F}, {empty: true}));

test('ref: пустой ref= не является ссылкой — прежнее поведение file/ranges сохранено', () => project(root => {
    const r = cli(root, 'graph-tool', {op: 'read', ref: ''});
    assert.equal(r.status, 1);
    assert.match(JSON.parse(r.stdout).error, /Укажите payload\.file/);
    const legacy = cli(root, 'graph-tool', {op: 'read', file: 'f.txt', ranges: '1-4', ref: ''});
    assert.equal(legacy.status, 0);
    assert.equal(JSON.parse(legacy.stdout).blocks[0].endLine, 4);
}, {'f.txt': F}, {empty: true}));
