'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { getSizes, createStats, addEntry, finishStats } = require('../lib/stats');

const CLI = path.join(__dirname, '..', 'har.js');
const fixture = name => path.join(__dirname, 'fixtures', `${name}.har`);

function cli(args, expected = 0, input) {
    const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', input, maxBuffer: 1024 * 1024, timeout: 15000 });
    assert.ifError(result.error);
    assert.equal(result.status, expected, result.stderr);
    return result;
}

function json(args, expected = 0) {
    return JSON.parse(cli([...args, '--json'], expected).stdout);
}

function withDocument(document, run) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'har-cli-test-'));
    const file = path.join(directory, 'input.har');
    fs.writeFileSync(file, typeof document === 'string' ? document : JSON.stringify(document));
    try {
        return run(file, directory);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

test('info: записи, страницы, честные суммы и процентили', () => {
    const result = json(['info', '-f', fixture('mixed')]);
    assert.equal(result.requests, 6);
    assert.equal(result.pages, 1);
    assert.equal(result.bytes.uncompressed, 1200);
    assert.equal(result.bytes.transfer, 580);
    assert.equal(result.bytes.compression, 620);
    assert.equal(result.bytes.unknownUncompressed, 1);
    assert.equal(result.bytes.unknownTransfer, 1);
    assert.equal(result.bytes.unknownCompression, 1);
    assert.deepEqual(result.statuses, { 0: 1, 200: 3, 404: 1, 500: 1 });
    assert.deepEqual(result.methods, { GET: 4, HEAD: 1, POST: 1 });
    assert.equal(result.time.total, 1490);
    assert.equal(result.time.p50, 50);
    assert.equal(result.time.p95, 800);
    assert.equal(result.time.p99, 800);
    assert.equal(result.time.span, 5010);
    assert.ok(Buffer.byteLength(cli(['info', '-f', fixture('mixed')]).stdout) <= 2048);
});

test('неизвестные размеры и времена не превращаются в известные нули', () => {
    const aggregate = createStats();
    addEntry(aggregate, { time: -1, timings: { wait: 10 }, response: { bodySize: -1, content: {} } });
    const result = finishStats(aggregate);
    assert.equal(result.bytes.unknownUncompressed, 1);
    assert.equal(result.bytes.unknownTransfer, 1);
    assert.equal(result.time.unknown, 1);
    assert.equal(result.time.p50, null);
    assert.deepEqual(getSizes({ response: { bodySize: 20, content: { size: -1 } } }), {
        transfer: 20, uncompressed: 20, compression: null, uncompressedEstimated: true
    });
    assert.equal(getSizes({ response: { bodySize: -1, content: { size: 100, compression: 40 } } }).transfer, 60);
    assert.equal(getSizes({ response: { bodySize: -1, content: { size: 100 } } }).transfer, null);
});

test('slow: сортировка, порог и SSL без двойного подсчёта', () => {
    const result = json(['slow', '-f', fixture('mixed'), '--top', '6']);
    assert.deepEqual(result.items.map(row => row.time), [800, 500, 100, 50, 30, 10]);
    for (const row of result.items) {
        const sum = Object.values(row.timings).reduce((value, phase) => value + (phase || 0), 0);
        assert.ok(Math.abs(sum - row.time) <= row.time * 0.05);
    }
    const first = result.items.find(row => row.index === 0);
    assert.equal(first.timings.connect, 10);
    assert.equal(first.timings.ssl, 10);
    assert.equal(json(['slow', '-f', fixture('mixed'), '--min', '501']).total, 1);
    assert.equal(json(['slow', '-f', fixture('mixed'), '--min', '9999'], 1).total, 0);
});

test('errors: четыре ошибки, без ложных HEAD/204/3xx/1xx', () => {
    const result = json(['errors', '-f', fixture('mixed')]);
    assert.deepEqual(result.items.map(row => row.index), [1, 2, 3, 4]);
    assert.equal(result.total, 4);
    assert.ok(result.items[2].reasons.includes('_error'));
    assert.ok(result.items[2].reasons.includes('таймаут'));
    assert.ok(result.items[3].reasons.includes('пустой ответ'));
    assert.equal(json(['errors', '-f', fixture('redirects')], 1).total, 0);
});

test('domains/content: размер, число, время и группировка MIME', () => {
    assert.equal(json(['domains', '-f', fixture('mixed'), '--sort', 'size']).items[0].domain, 'app.example.test');
    assert.equal(json(['domains', '-f', fixture('mixed'), '--sort', 'count']).items[0].count, 5);
    assert.equal(json(['domains', '-f', fixture('mixed'), '--sort', 'time']).items[0].domain, 'cdn.example.test');
    assert.equal(json(['content', '-f', fixture('mixed')]).items[0].type, 'html');
    const mime = json(['content', '-f', fixture('mixed'), '--by-mime']);
    assert.equal(mime.items[0].type, 'text/html');
    assert.equal(mime.items[0].uncompressed, 1000);
    assert.equal(mime.items[0].transfer, 400);
});

test('dup: exact, нормализация query/хешей и хеш декодированного тела', () => {
    const exact = json(['dup', '-f', fixture('duplicates'), '--strategy', 'exact']);
    assert.equal(exact.total, 1);
    assert.deepEqual(exact.items[0].indices, [0, 1]);
    const normalized = json(['dup', '-f', fixture('duplicates'), '--strategy', 'norm']);
    assert.equal(normalized.items[0].count, 3);
    assert.match(normalized.items[0].key, /app\.\*\.js\?a=1&b=2$/);
    const hash = json(['dup', '-f', fixture('base64'), '--strategy', 'hash']);
    assert.deepEqual(hash.items[0].indices, [1, 2]);
});

test('search: regex, лимит, валидный JSON и отсутствие поиска в телах', () => {
    const result = json(['search', 'GET', '-f', fixture('mixed'), '--limit', '2']);
    assert.equal(result.total, 4);
    assert.equal(result.shown, 2);
    assert.equal(result.omitted, 2);
    assert.equal(result.truncated, true);
    assert.equal(json(['search', 'fixture-body-sentinel', '-f', fixture('mixed')], 1).total, 0);
});

test('entry: тело только явно, ограничение байтов и base64', () => {
    const without = json(['entry', '0', '-f', fixture('mixed')]);
    assert.equal(Object.hasOwn(without, 'body'), false);
    assert.equal(Object.hasOwn(without.entry.response.content, 'text'), false);
    const body = json(['entry', '0', '-f', fixture('mixed'), '--body', '16']).body;
    assert.equal(Buffer.byteLength(body.text), 16);
    assert.equal(body.shownBytes, 16);
    assert.equal(body.truncated, true);
    assert.equal(json(['entry', '2', '-f', fixture('base64'), '--body']).body.text, 'hello');
    const binary = json(['entry', '0', '-f', fixture('base64'), '--body', '2']).body;
    assert.equal(binary.encoding, 'base64');
    assert.deepEqual([...Buffer.from(binary.text, 'base64')], [1, 2]);
    assert.equal(binary.truncated, true);
    assert.equal(json(['entry', '999', '-f', fixture('mixed')], 1).found, false);
});

test('команды не выводят тела по умолчанию', () => {
    for (const command of ['info', 'slow', 'errors', 'domains', 'content', 'dup', 'waterfall']) {
        const result = cli([command, '-f', fixture('mixed'), '--json'], command === 'dup' ? 1 : 0);
        assert.doesNotMatch(result.stdout, /fixture-body-sentinel|test_body_secret|test_response_secret/);
    }
});

test('waterfall: порядок стартов, смещения и общий интервал', () => {
    const result = json(['waterfall', '-f', fixture('mixed'), '--top', '3']);
    assert.deepEqual(result.items.map(row => row.index), [0, 1, 2]);
    assert.deepEqual(result.items.map(row => row.offset), [0, 1000, 2000]);
    assert.equal(result.span, 5010);
    assert.equal(result.omitted, 3);
});

test('diff: новые, исчезнувшие, медленные, тяжёлые и отсутствие изменений', () => {
    const original = JSON.parse(fs.readFileSync(fixture('mixed'), 'utf8'));
    const changed = structuredClone(original);
    changed.log.entries.pop();
    changed.log.entries[0].time += 100;
    changed.log.entries[0].response.content.size += 200;
    const added = structuredClone(changed.log.entries[0]);
    added.request.url = 'https://app.example.test/new';
    changed.log.entries.push(added);
    withDocument(changed, file => {
        const result = json(['diff', fixture('mixed'), file]);
        assert.deepEqual(result.items.map(row => row.change).sort(), ['added', 'heavier', 'removed', 'slower']);
    });
    assert.equal(json(['diff', fixture('mixed'), fixture('mixed')], 1).total, 0);
});

test('redact CLI: секреты удалены, размеры сохранены, исходник не меняется', () => {
    const original = JSON.parse(fs.readFileSync(fixture('mixed'), 'utf8'));
    withDocument(original, (file, directory) => {
        const output = path.join(directory, 'clean.har');
        const before = fs.readFileSync(file, 'utf8');
        const result = json(['redact', '-f', file, '-o', output, '--stream']);
        assert.equal(result.requests, 6);
        const raw = fs.readFileSync(output, 'utf8');
        assert.doesNotMatch(raw, /test_(?:query|cookie|authorization|api_key|body|response|set_cookie)_secret/);
        const clean = JSON.parse(raw);
        for (let index = 0; index < original.log.entries.length; index++) {
            const a = original.log.entries[index];
            const b = clean.log.entries[index];
            assert.equal(b.time, a.time);
            assert.deepEqual(b.timings, a.timings);
            assert.equal(b.response.bodySize, a.response.bodySize);
            assert.equal(b.response.headersSize, a.response.headersSize);
            assert.equal(b.response.content.size, a.response.content.size);
            assert.equal(b.response.content.compression, a.response.content.compression);
        }
        assert.equal(fs.readFileSync(file, 'utf8'), before);
        cli(['redact', '-f', file, '-o', output], 2);
        assert.equal(fs.readFileSync(output, 'utf8'), raw);
        cli(['redact', '-f', file, '-o', file], 2);
    });
});

test('битый HAR: код 2, нет traceback/фрагмента тела/частичного clean.har', () => {
    for (const flags of [[], ['--stream']]) {
        const result = cli(['info', '-f', fixture('invalid'), '--json', ...flags], 2);
        assert.equal(result.stdout, '');
        assert.equal(JSON.parse(result.stderr).exitCode, 2);
        assert.doesNotMatch(result.stderr, /HAR_INVALID_BODY_SECRET|SyntaxError|at main/);
    }
    withDocument(fs.readFileSync(fixture('invalid'), 'utf8'), (file, directory) => {
        const output = path.join(directory, 'clean.har');
        cli(['redact', '-f', file, '-o', output, '--stream'], 2);
        assert.deepEqual(fs.readdirSync(directory), ['input.har']);
    });
});

test('обычный/потоковый CLI и stdin дают одинаковую сводку', () => {
    for (const command of ['info', 'slow', 'errors', 'domains', 'content', 'waterfall']) {
        assert.deepEqual(json([command, '-f', fixture('mixed'), '--stream']), json([command, '-f', fixture('mixed')]));
    }
    const stdin = cli(['info', '--json'], 0, fs.readFileSync(fixture('mixed')));
    assert.deepEqual(JSON.parse(stdin.stdout), json(['info', '-f', fixture('mixed')]));
});

test('вывод ограничен байтами/строками, счётчики обрезки честные', () => {
    const entries = Array.from({ length: 1000 }, (_, index) => ({
        time: 1, request: { method: 'GET', url: `https://app.example.test/${index}?q=${'x'.repeat(600)}` },
        response: { status: 200, bodySize: 1, content: { size: 1 } }
    }));
    withDocument({ log: { entries } }, file => {
        for (const flags of [[], ['--json'], ['--json', '--pretty']]) {
            const output = cli(['search', 'GET', '-f', file, '--limit', '1000', ...flags]).stdout;
            assert.ok(Buffer.byteLength(output) <= 8192);
            assert.ok(output.trimEnd().split('\n').length <= 200);
            if (flags.includes('--json')) {
                const result = JSON.parse(output);
                assert.equal(result.shown, result.items.length);
                assert.equal(result.omitted, result.total - result.shown);
                assert.equal(result.truncated, true);
            } else {
                const shown = (output.match(/^#/gm) || []).length;
                const omitted = Number(/ещё (\d+), --limit/.exec(output)[1]);
                assert.equal(shown + omitted, 1000);
            }
        }
    });
});

test('пустой HAR и неверные аргументы имеют предсказуемые коды', () => {
    withDocument({ log: { entries: [] } }, file => assert.equal(json(['info', '-f', file], 1).requests, 0));
    for (const args of [['search', '['], ['info', '--unknown'], ['entry', '-1'], ['slow', '--min', '-1'], ['info', '--limit', '0']]) {
        cli([...args, '-f', fixture('mixed')], 2);
    }
});
