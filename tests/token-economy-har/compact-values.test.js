'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { encodeValues } = require('../../skills/token-economy-har/lib/compact-values');
const { decodeCompact } = require('./compact-oracle');
const wire = payload => JSON.parse(JSON.stringify({ format: 'har-compact-v1', ...payload }));

const urls = [
    'https://User:Pass@Example.test:8443/длинный/путь/a%2Fb?q=%20&q=+#Frag',
    'https://User:Pass@Example.test:8443/длинный/путь/a/b?q=+&q=%20#frag',
    'HTTPS://example.test:8443/длинный/путь/😀?cache=1', '/relative%2F?x=1&x=',
    'невалидный URL 😀', '', 'https://other.test/x', 'http://Example.test/x'
];

for (const dictionary of [false, true]) for (const prefixes of [false, true]) {
    test(`exact values round-trip dictionary=${dictionary} prefixes=${prefixes}`, () => {
        const baseline = { command: 'errors', items: Array.from({ length: 40 }, (_, index) => ({
            method: 'LONG-REPEATED-METHOD', domain: 'повторяющийся-длинный-домен.test', mimeType: 'application/very-long-repeated-mime-type',
            url: urls[index % urls.length], reasons: ['повторяющаяся очень длинная причина ошибки', '']
        })), shown: 40, total: 40, omitted: 0, truncated: false };
        const saved = structuredClone(baseline);
        const encoded = encodeValues({ data: baseline }, { dictionary, prefixes });
        assert.deepEqual(decodeCompact(wire(encoded)), baseline);
        assert.deepEqual(baseline, saved);
        if (dictionary) {
            assert.ok(encoded.strings.length);
            const source = new Set(baseline.items.flatMap(row => [row.method, row.domain, row.mimeType, row.url, ...row.reasons]));
            assert.ok(encoded.strings.every(value => source.has(value)));
        }
        if (!dictionary && prefixes) assert.ok(encoded.urlPrefixes.length);
    });
}

test('short unique values do not create an unprofitable dictionary', () => {
    const payload = { data: { command: 'search', items: [{ method: 'A', url: '/a', domain: '' }, { method: 'B', url: '/b', domain: 'd' }] } };
    assert.deepEqual(encodeValues(payload), payload);
});

test('entry header names, not query names/values/body text, are eligible; schemas compose', () => {
    const name = 'X-A-Very-Long-Repeated-Header-Name';
    const payload = { data: { command: 'entry', entry: {
        request: { method: 'GET', url: urls[0], headers: Array.from({ length: 20 }, () => [name, name]), queryString: [[name, name]] },
        response: { headers: [{ name, value: name }], redirectURL: '', content: { mimeType: 'text/plain' } }
    }, body: { text: name, encoding: 'utf8', bytes: 35, shownBytes: 35, truncated: false } }, headerColumns: ['name', 'value'] };
    const encoded = encodeValues(payload);
    assert.ok(encoded.strings.includes(name));
    assert.deepEqual(encoded.data.entry.request.queryString, [[name, name]]);
    assert.equal(encoded.data.entry.request.headers[0][1], name);
    assert.deepEqual(encoded.data.body, payload.data.body);
    const expected = structuredClone(payload.data);
    expected.entry.request.headers = expected.entry.request.headers.map(([headerName, value]) => ({ name: headerName, value }));
    expected.entry.request.queryString = expected.entry.request.queryString.map(([headerName, value]) => ({ name: headerName, value }));
    assert.deepEqual(decodeCompact(wire(encoded)), expected);
});

test('dictionary only contains values present at eligible baseline slots and every ref resolves', () => {
    const payload = { data: { command: 'errors', items: Array.from({ length: 50 }, (_, index) => ({
        method: 'REPEATED-LONG-METHOD', domain: 'repeated.long.domain.test', mimeType: 'application/repeated-long-type',
        url: `https://repeated.long.domain.test/assets/${index}`,
        reasons: ['A repeated and sufficiently long error reason']
    })) } };
    const encoded = encodeValues(payload, { dictionary: true, prefixes: false });
    assert.ok(encoded.strings.length);
    const eligible = new Set(payload.data.items.flatMap(row => [row.method, row.domain, row.mimeType, row.url, ...row.reasons]));
    assert.ok(encoded.strings.every(value => eligible.has(value)));
    const refs = [];
    (function visit(value) {
        if (Array.isArray(value)) for (const item of value) visit(item);
        else if (value && typeof value === 'object') {
            if (Object.hasOwn(value, '$ref')) refs.push(value.$ref);
            else for (const item of Object.values(value)) visit(item);
        }
    })(encoded.data);
    assert.ok(refs.length);
    assert.ok(refs.every(index => Number.isInteger(index) && index >= 0 && index < encoded.strings.length));
    assert.ok(encoded.strings.every((unused, index) => refs.includes(index)));
});

test('prefix tag-like body and header values remain literal data', () => {
    const marker = { $prefix: [999, 'planted'] };
    const name = 'X-A-Very-Long-Repeated-Header-Name';
    const payload = {
        data: {
            command: 'entry',
            entry: {
                request: { method: 'GET', url: urls[0], headers: Array.from({ length: 20 }, () => [name, JSON.stringify(marker)]), queryString: [] },
                response: { headers: [], redirectURL: urls[1], content: { mimeType: 'text/plain' } }
            },
            body: { text: JSON.stringify(marker), metadata: marker }
        },
        headerColumns: ['name', 'value']
    };
    const encoded = encodeValues(payload);
    assert.deepEqual(encoded.data.body, payload.data.body);
    assert.deepEqual(encoded.data.entry.request.headers[0][1], JSON.stringify(marker));
});

test('table rows/defaults and dup URL arrays retain indices, values and hash keys', () => {
    for (const strategy of ['exact', 'norm', 'hash']) {
        const payload = { data: { command: 'dup', strategy, items: {
            columns: ['key', 'urls', 'indices', 'omittedIndices'], defaults: { count: 2 },
            rows: Array.from({ length: 20 }, (_, index) => [urls[0], [urls[0], urls[1]], [index, index + 1], 0])
        } } };
        const encoded = encodeValues(payload);
        if (strategy === 'hash') {
            assert.equal(encoded.data.items.rows[0][0], urls[0]);
            assert.deepEqual(encoded.data.items.rows[0][1], [urls[0], urls[1]]);
        }
        const expected = { command: 'dup', strategy, items: payload.data.items.rows.map(row => ({ count: 2, key: row[0], urls: row[1], indices: row[2], omittedIndices: row[3] })) };
        assert.deepEqual(decodeCompact(wire(encoded)), expected);
    }
});
