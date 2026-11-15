// ref-corpus.test.js — corpus-проверка грамматики refs (этап W4, план 20+21 v3 §16 W3/W4):
// versioned набор raw refs (tests/token-economy-ts/ref-corpus.json) и ожидаемого разбора
// lib/refs.js. Фикстуры не исполняются как скрипты — это данные; разбор сверяется с полем
// parse. Грамматика едина с MegaMemory src/refs.ts (classifyRef/parseRef): git-формы
// распознаются первыми, Windows drive/UNC и двоеточия/решётки внутри имени сохраняются.
// Распознанный вид ≠ поддержанный способ чтения: поведение чтения — в ref-read.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {parseRefLocator, splitFileLocator, SUPPORTED_READ_KINDS} = require('../../skills/token-economy-ts/scripts/lib/refs');

const corpus = JSON.parse(fs.readFileSync(path.join(__dirname, 'ref-corpus.json'), 'utf8'));

test('corpus: каждая запись разбирается ровно в ожидаемый вид и координаты', () => {
    assert.ok(corpus.cases.length >= 30, 'корпус не урезан: ' + corpus.cases.length + ' записей');
    const seen = new Set();
    for (const c of corpus.cases) {
        assert.ok(c.id && !seen.has(c.id), 'id записи уникален: ' + c.id);
        seen.add(c.id);
        assert.ok(typeof c.raw === 'string' && c.raw.length > 0, 'raw не пуст: ' + c.id);
        const got = parseRefLocator(c.raw);
        assert.equal(got.kind, c.parse.kind, 'kind: ' + c.id);
        assert.equal(got.path, c.parse.path, 'path: ' + c.id);
        if (c.parse.start !== undefined) {
            assert.equal(got.start, c.parse.start, 'start: ' + c.id);
            assert.equal(got.end, c.parse.end, 'end: ' + c.id);
        } else {
            assert.equal(got.start, undefined, 'без локатора start отсутствует: ' + c.id);
        }
        if (c.parse.scheme !== undefined) assert.equal(got.scheme, c.parse.scheme, 'scheme: ' + c.id);
        if (c.parse.rev !== undefined) assert.equal(got.rev, c.parse.rev, 'rev: ' + c.id);
        if (c.parse.name !== undefined) assert.equal(got.name, c.parse.name, 'name: ' + c.id);
    }
});

test('corpus: заявленная таблица поддерживаемых read-видов совпадает с lib/refs', () => {
    assert.deepEqual(SUPPORTED_READ_KINDS, corpus.supported_read_kinds);
});

test('corpus: git-формы распознаются до файловой нормализации и не режутся на локатор', () => {
    // «git:tag:2026» не превращается в путь «git:tag» с локатором «2026» (контракт parseRef)
    assert.equal(parseRefLocator('git:tag:2026').kind, 'git_ref');
    assert.equal(parseRefLocator('HEAD:src/a.ts:12').kind, 'git_blob');
    // blob-форма с двоеточием-локатором в пути: всё после первого «:» — путь, не локатор
    const blob = parseRefLocator('HEAD:src/a.ts:12');
    assert.equal(blob.path, 'src/a.ts:12');
});

test('corpus: диск C: и UNC не путаются с локатором (индексы 0/1 не режутся)', () => {
    assert.deepEqual(splitFileLocator('C:\\prj\\a.ts'), {path: 'C:\\prj\\a.ts', locator: null});
    assert.deepEqual(splitFileLocator('C:\\prj\\a.ts:7'), {path: 'C:\\prj\\a.ts', locator: '7'});
    assert.deepEqual(splitFileLocator('\\\\srv\\share\\a.ts:7'), {path: '\\\\srv\\share\\a.ts', locator: '7'});
    // «C:5» — путь с двоеточием диска на индексе 1, не локатор
    assert.deepEqual(splitFileLocator('C:5'), {path: 'C:5', locator: null});
});

test('corpus: все refusal-коды нового договора перечислены в фикстурах', () => {
    for (const code of ['range_required', 'unsupported_ref_kind', 'conflicting_args', 'line_too_long'])
        assert.ok(corpus.refusal_codes.includes(code), 'refusal-код объявлен: ' + code);
});
