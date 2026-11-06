'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { openHar, STREAM_THRESHOLD } = require('../lib/parse');

async function collect(file, options = {}) {
    const har = await openHar(file, options);
    const entries = [];
    for await (const row of har.entries) entries.push(row);
    return { entries, metadata: har.metadata, streaming: har.streaming };
}

async function withRaw(raw, run) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'har-parse-test-'));
    const file = path.join(directory, 'input.har');
    fs.writeFileSync(file, raw);
    try {
        return await run(file);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

test('путь log.entries, метаданные, скобки/кавычки в строках и маленькие чанки', async () => {
    const document = {
        unrelated: { entries: [{ ignored: true }], text: '"entries": [{ }]' },
        log: {
            version: '1.2', creator: { name: 'fixture', version: '1' }, pages: [{ id: 'page', title: 'Страница' }],
            nested: { entries: [{ ignored: true }] },
            entries: [
                { request: { url: 'https://example.test/a' }, response: { content: { text: 'Русский "текст" \\ { [ ] }' } } },
                { nested: [{ text: '}],\\"' }], bool: true, number: -1, empty: null }
            ],
            after: [{ text: '[ } "' }]
        },
        tail: { valid: true }
    };
    await withRaw(JSON.stringify(document), async file => {
        const ordinary = await collect(file);
        assert.equal(ordinary.streaming, false);
        assert.deepEqual(ordinary.entries.map(row => row.index), [0, 1]);
        assert.deepEqual(ordinary.entries.map(row => row.entry), document.log.entries);
        assert.equal(Object.hasOwn(ordinary.metadata.log, 'entries'), false);
        for (const highWaterMark of [1, 7, 64, 65536]) {
            const streamed = await collect(file, { stream: true, highWaterMark });
            assert.equal(streamed.streaming, true);
            assert.deepEqual(streamed.entries, ordinary.entries);
            assert.deepEqual(streamed.metadata, ordinary.metadata);
        }
    });
});

test('UTF-8 BOM и экранированные имена log/entries поддерживаются в обоих режимах', async () => {
    const raw = '\uFEFF{"l\\u006fg":{"entr\\u0069es":[{"text":"Привет"}]}}';
    await withRaw(raw, async file => {
        const ordinary = await collect(file);
        const streamed = await collect(file, { stream: true, highWaterMark: 1 });
        assert.deepEqual(streamed.entries, ordinary.entries);
        assert.deepEqual(streamed.metadata, ordinary.metadata);
    });
});

test('stdin всегда потоковый и не повреждает UTF-8 на границе чанков', async () => {
    const raw = Buffer.from(JSON.stringify({ log: { entries: [{ text: 'Кириллица' }] } }));
    const split = raw.indexOf(Buffer.from('К')) + 1;
    const input = Readable.from([raw.subarray(0, split), raw.subarray(split)], { objectMode: false });
    const result = await collect('-', { input });
    assert.equal(result.streaming, true);
    assert.equal(result.entries[0].entry.text, 'Кириллица');
    assert.equal(STREAM_THRESHOLD, 200 * 1024 * 1024);
});

test('средняя запись: обычный и потоковый разбор идентичны', async () => {
    const entries = Array.from({ length: 100 }, (_, index) => ({
        time: index, request: { url: `https://example.test/${index}` },
        response: { content: { mimeType: 'text/plain', text: ('["escaped\\value"] Привет ').repeat(1000) } }
    }));
    await withRaw(JSON.stringify({ log: { entries, pages: [] } }), async file => {
        const ordinary = await collect(file);
        const streamed = await collect(file, { stream: true, highWaterMark: 4096 });
        assert.deepEqual(streamed.entries, ordinary.entries);
        assert.deepEqual(streamed.metadata, ordinary.metadata);
    });
});

test('битый JSON/HAR, разделители, конец и неоднозначные поля отклоняются', async () => {
    const valid = '{"log":{"entries":[{}]}}';
    const invalid = [
        '', '{', '[]', '{"log":{}}', '{"log":{"entries":{}}}',
        '{"log":{"entries":[null]}}', '{"log":{"entries":[[]]}}',
        '{"log":{"entries":[{},]}}', '{"log":{"entries":[,{}]}}',
        '{"log":{"entries":[{} {}]}}', '{"log":{"entries":[{"a":1,}]}}',
        '{"log":{"entries":[{"text":"unterminated}]}}',
        '{"log":{"entries":[]},"tail":[1,]}',
        '{"log":{"entries":[]},"tail":"bad\\q"}',
        '{"other":{"entries":[]},"log":{}}',
        '{"log":{"entries":[]},"log":{"entries":[]}}',
        '{"log":{"entries":[],"entries":[]}}',
        `x${valid}`, `${valid} trailing`, valid.slice(0, -1),
        '{"log":{"entries":[{"text":"HAR_INVALID_BODY_SECRET",}]}}'
    ];
    for (const raw of invalid) {
        await withRaw(raw, async file => {
            for (const stream of [false, true]) {
                await assert.rejects(() => collect(file, { stream, highWaterMark: 7 }), error => {
                    assert.equal(error.exitCode, 2);
                    assert.doesNotMatch(error.message, /HAR_INVALID_BODY_SECRET|SyntaxError|Unexpected token/);
                    return true;
                });
            }
        });
    }
});
