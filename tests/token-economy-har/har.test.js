'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { getSizes, createStats, addEntry, finishStats } = require('../../skills/token-economy-har/lib/stats');
const { parseArgs } = require('../../skills/token-economy-har/har');

const CLI = path.join(__dirname, '..', '..', 'skills', 'token-economy-har', 'har.js');
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
    assert.equal(result.bytes.transferred_known, 580);
    assert.equal(result.bytes.compression, 620);
    assert.equal(result.bytes.unknownUncompressed, 1);
    assert.equal(result.bytes.transferred_unknown_count, 1);
    assert.equal(result.bytes.transferred_is_lower_bound, true);
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

test('info: передача и разница размеров считаются только по известным bodySize', () => {
    for (const flags of [[], ['--stream']]) {
        const result = json(['info', '-f', fixture('partial-transfer'), ...flags]);
        assert.equal(result.requests, 4);
        assert.deepEqual(result.bytes, {
            transferred_known: 61, transferred_unknown_count: 2, transferred_is_lower_bound: true,
            uncompressed: 1000, compression: 339, unknownUncompressed: 0, unknownCompression: 2,
            estimatedUncompressed: 0
        });
        assert.equal(Object.hasOwn(result.bytes, 'transfer'), false);
        assert.equal(Object.hasOwn(result.bytes, 'transferred'), false);
        assert.equal(result.time.total, 100);
        assert.equal(result.time.p50, 20);
        assert.equal(result.time.p95, 40);
        const text = cli(['info', '-f', fixture('partial-transfer'), ...flags]).stdout;
        assert.match(text, /не менее 61 B передано \(неизвестно для 2 записей\)/);
        assert.match(text, /не менее 339 B разницы размеров \(неизвестно для 2 пар\)/);
        assert.doesNotMatch(text, /339 B экономии/);
    }
    const aggregate = createStats();
    addEntry(aggregate, { response: { bodySize: 20, content: { size: 100 } } });
    const complete = finishStats(aggregate).bytes;
    assert.equal(complete.transferred_known, 20);
    assert.equal(complete.transferred_unknown_count, 0);
    assert.equal(complete.transferred_is_lower_bound, false);
});

test('неизвестные размеры и времена не превращаются в известные нули', () => {
    const aggregate = createStats();
    addEntry(aggregate, { time: -1, timings: { wait: 10 }, response: { bodySize: -1, content: {} } });
    const result = finishStats(aggregate);
    assert.equal(result.bytes.unknownUncompressed, 1);
    assert.equal(result.bytes.transferred_known, 0);
    assert.equal(result.bytes.transferred_unknown_count, 1);
    assert.equal(result.bytes.transferred_is_lower_bound, true);
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

test('entry: --body без размера до команды и неверный явный размер', () => {
    const expected = json(['entry', '0', '-f', fixture('mixed'), '--body', '2k']).body;
    for (const args of [
        ['--body', 'entry', '0'], ['--body', '2k', 'entry', '0'], ['entry', '0', '--body'],
        ['--json', '--body', 'entry', '0'], ['--body', '--json', 'entry', '0'],
        ['--pretty', '--body', 'entry', '0']
    ]) {
        assert.equal(parseArgs([...args, '-f', fixture('mixed')]).body, 2048);
        assert.deepEqual(json([...args, '-f', fixture('mixed')]).body, expected);
    }
    for (const args of [
        ['--body', '5x', 'entry', '0'], ['entry', '0', '--body', '5x'], ['--body=5x', 'entry', '0']
    ]) {
        const result = cli([...args, '-f', fixture('mixed'), '--json'], 2);
        assert.equal(JSON.parse(result.stderr).exitCode, 2);
        assert.match(JSON.parse(result.stderr).error, /--body:.*(?:байтов|размер)/);
    }
});

test('help: полный текст в JSON и pretty с общим пределом вывода', () => {
    const expected = cli(['help']).stdout.trimEnd();
    for (const flags of [[], ['--pretty']]) {
        const output = cli(['help', '--json', ...flags]).stdout;
        const result = JSON.parse(output);
        assert.equal(result.message, expected);
        assert.ok(result.message.includes('\n'));
        assert.notEqual(result.truncated, true);
        assert.ok(Buffer.byteLength(output) <= 8192);
        assert.ok(output.trimEnd().split('\n').length <= 200);
    }
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

test('search/entry не являются redaction: секреты видны до очистки HAR', () => {
    const entry = {
        request: {
            method: 'GET', url: 'https://example.test/?token=fixture_query_secret',
            headers: [{ name: 'Authorization', value: 'fixture_header_secret' }]
        },
        response: { status: 200, content: { mimeType: 'application/json', text: '{"token":"fixture_body_secret"}' } }
    };
    withDocument({ log: { entries: [entry] } }, (file, directory) => {
        const search = cli(['search', 'GET', '-f', file, '--json']).stdout;
        assert.ok(search.includes('fixture_query_secret'));
        const detail = cli(['entry', '0', '-f', file, '--body', '2k', '--json']).stdout;
        assert.ok(detail.includes('fixture_header_secret'));
        assert.ok(detail.includes('fixture_body_secret'));
        const output = path.join(directory, 'clean.har');
        cli(['redact', '-f', file, '-o', output]);
        const clean = cli(['entry', '0', '-f', output, '--body', '2k', '--json']).stdout;
        assert.ok(!clean.includes('fixture_query_secret') && !clean.includes('fixture_header_secret') && !clean.includes('fixture_body_secret'));
    });
});

test('redact CLI: JOSE/query/long blobs в обычном и потоковом режиме', () => {
    const unsigned = `${Buffer.from('{"alg":"none"}').toString('base64url')}.e30.`;
    const jwe = `${Buffer.from('{"alg":"dir","enc":"A256GCM"}').toString('base64url')}..a.b.c`;
    const blob = 'A'.repeat(64 * 1024);
    const longToken = 'fixture_' + 's'.repeat(64 * 1024) + '_tail';
    const document = {
        log: {
            pages: [{ id: 'p', title: `audit token=${longToken}` }],
            entries: [{
                request: { url: `https://user:${longToken}@example.test/?q=keep` },
                response: { bodySize: 999, content: {
                    size: 1999, mimeType: 'application/json', encoding: 'base64',
                    text: Buffer.from(JSON.stringify({ blob, unsigned, encrypted: jwe, label: `access_token=${longToken}\nnext=kept` })).toString('base64')
                } }
            }]
        }
    };
    withDocument(document, (file, directory) => {
        let first;
        for (const flags of [[], ['--stream']]) {
            const output = path.join(directory, flags.length ? 'stream.har' : 'clean.har');
            cli(['redact', '-f', file, '-o', output, ...flags]);
            const raw = fs.readFileSync(output, 'utf8');
            const clean = JSON.parse(raw);
            assert.ok(!raw.includes('fixture_') && !raw.includes('_tail'));
            const entry = clean.log.entries[0];
            const body = JSON.parse(Buffer.from(entry.response.content.text, 'base64').toString('utf8'));
            assert.equal(body.blob, blob);
            assert.equal(body.unsigned, '[REDACTED]');
            assert.equal(body.encrypted, '[REDACTED]');
            assert.equal(body.label, 'access_token=[REDACTED]\nnext=kept');
            assert.equal(clean.log.pages[0].title, 'audit token=[REDACTED]');
            assert.equal(entry.request.url, 'https://example.test/?q=keep');
            assert.equal(entry.response.bodySize, 999);
            assert.equal(entry.response.content.size, 1999);
            if (first) assert.deepEqual(clean, first);
            else first = clean;
        }
    });
});

test('redact CLI: bounded 100 MiB HAR сохраняет blobs и не оставляет секретов', { timeout: 180000 }, async t => {
    const { openHar } = require('../../skills/token-economy-har/lib/parse');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'har-redaction-100m-'));
    const file = path.join(directory, 'input.har');
    const output = path.join(directory, 'clean.har');
    const blob = 'A'.repeat(256 * 1024);
    const secret = 'fixture_redaction_sentinel';
    const unsigned = Buffer.from('{"alg":"none"}').toString('base64url') + '.e30.';
    const jwe = Buffer.from('{"alg":"dir","enc":"A256GCM"}').toString('base64url') + '..a.b.c';
    const body = JSON.stringify({ blob, token: secret, label: `access_token=${secret}`, unsigned, encrypted: jwe });
    const header = '{"log":{"version":"1.2","pages":[],"entries":[';
    const limit = 100 * 1024 ** 2;
    let bytes = Buffer.byteLength(header) + 3;
    let count = 0;
    try {
        const fd = fs.openSync(file, 'wx', 0o600);
        try {
            fs.writeFileSync(fd, header);
            while (bytes < limit) {
                const entry = {
                    time: 10, request: { method: 'GET', url: `https://example.test/${count}?token=${secret}&q=keep` },
                    response: { status: 200, bodySize: blob.length, content: {
                        size: blob.length, mimeType: 'application/json',
                        text: count % 2 ? Buffer.from(body).toString('base64') : body,
                        ...(count % 2 ? { encoding: 'base64' } : {})
                    } }
                };
                const encoded = `${count ? ',' : ''}${JSON.stringify(entry)}`;
                fs.writeFileSync(fd, encoded);
                bytes += Buffer.byteLength(encoded);
                count++;
            }
            fs.writeFileSync(fd, ']}}');
        } finally {
            fs.closeSync(fd);
        }
        const started = performance.now();
        const child = spawnSync(process.execPath, [CLI, 'redact', '-f', file, '-o', output, '--stream', '--json'], {
            encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024, windowsHide: true
        });
        const durationMs = performance.now() - started;
        assert.ifError(child.error);
        assert.equal(child.status, 0, child.stderr);
        assert.ok(durationMs < 120000, '100 MiB redaction должен уложиться в 120 секунд');
        assert.ok(Buffer.byteLength(child.stdout) <= 8192);
        assert.ok(!child.stdout.includes(secret) && !child.stderr.includes(secret));
        assert.equal(JSON.parse(child.stdout).requests, count);
        const cleaned = await openHar(output, { stream: true });
        let checked = 0;
        for await (const { entry } of cleaned.entries) {
            const content = entry.response.content;
            const decoded = content.encoding === 'base64' ? Buffer.from(content.text, 'base64').toString('utf8') : content.text;
            const value = JSON.parse(decoded);
            assert.ok(!JSON.stringify(entry).includes(secret) && !decoded.includes(secret), 'секрет не должен оставаться и в base64');
            assert.equal(value.blob, blob);
            assert.equal(value.token, '[REDACTED]');
            assert.equal(value.label, 'access_token=[REDACTED]');
            assert.equal(value.unsigned, '[REDACTED]');
            assert.equal(value.encrypted, '[REDACTED]');
            assert.equal(content.size, blob.length);
            assert.equal(entry.response.bodySize, blob.length);
            checked++;
        }
        assert.equal(checked, count);
        assert.equal(fs.statSync(file).size, bytes);
        t.diagnostic(JSON.stringify({ inputBytes: bytes, outputBytes: fs.statSync(output).size, stdoutBytes: Buffer.byteLength(child.stdout), requests: count, durationMs }));
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
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
