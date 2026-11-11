'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { encodeEntry } = require('../../skills/token-economy-har/lib/compact-entry');

// Independent wire decoder: only the documented schemas, no production helpers.
function decodeEntryPayload(payload) {
    const data = structuredClone(payload.data);
    function timings(value) {
        if (!payload.timingColumns || !Array.isArray(value)) return value;
        assert.equal(value.length, payload.timingColumns.length);
        return Object.fromEntries(payload.timingColumns.map((column, index) => [column, value[index]]));
    }
    function pairs(value) {
        if (!payload.headerColumns || !Array.isArray(value) || value.length === 0
            || !value.every(row => Array.isArray(row) && row.length === 2)) return value;
        return value.map(row => Object.fromEntries(payload.headerColumns.map((column, index) => [column, row[index]])));
    }
    if (data.command === 'entry' && data.entry) {
        if (Object.hasOwn(data.entry, 'timings')) data.entry.timings = timings(data.entry.timings);
        for (const [side, fields] of [['request', ['headers', 'queryString']], ['response', ['headers']]]) {
            if (!data.entry[side]) continue;
            for (const field of fields) {
                if (Object.hasOwn(data.entry[side], field)) data.entry[side][field] = pairs(data.entry[side][field]);
            }
        }
    }
    if (data.command === 'slow') {
        if (data.items && !Array.isArray(data.items) && data.items.columns && data.items.rows) {
            const table = data.items;
            data.items = table.rows.map(row => ({
                ...table.defaults,
                ...Object.fromEntries(table.columns.map((column, index) => [column, row[index]]))
            }));
        }
        if (Array.isArray(data.items)) {
            for (const row of data.items) {
                if (row && Object.hasOwn(row, 'timings')) row.timings = timings(row.timings);
            }
        }
    }
    return data;
}

test('entry pairs: request/response/query retain case, duplicates, empty values and untouched bodies', () => {
    const payload = freeze({
        data: {
            command: 'entry', index: 0, truncated: true,
            entry: {
                timings: { blocked: null, dns: null, connect: 0, ssl: null, send: 0, wait: 12.5, receive: 0 },
                request: {
                    url: '/?q=%2F&q=+', method: 'POST',
                    headers: [{ name: 'X-Name', value: '' }, { name: 'x-name', value: 'Я\n世界' }, { name: '', value: '' }],
                    queryString: [{ name: 'q', value: '/' }, { name: 'q', value: '+' }, { name: '', value: '' }]
                },
                response: {
                    headers: [{ name: 'Set-Cookie', value: 'first' }, { name: 'Set-Cookie', value: 'second' }, { name: 'set-cookie', value: '' }],
                    content: { size: null, mimeType: 'application/octet-stream' }
                }
            },
            body: { encoding: 'base64', text: 'AP+AAg==', bytes: 12, shownBytes: 4, truncated: true },
            requestBody: { encoding: 'utf8', text: '  { "текст": "Я世界" }\n', bytes: 26, shownBytes: 26, truncated: false },
            message: ''
        },
        marker: { retained: true }
    });
    const encoded = encodeEntry(payload);
    assert.deepEqual(encoded.headerColumns, ['name', 'value']);
    assert.deepEqual(encoded.data.entry.request.headers, [['X-Name', ''], ['x-name', 'Я\n世界'], ['', '']]);
    assert.deepEqual(encoded.data.entry.request.queryString, [['q', '/'], ['q', '+'], ['', '']]);
    assert.deepEqual(encoded.data.entry.response.headers, [['Set-Cookie', 'first'], ['Set-Cookie', 'second'], ['set-cookie', '']]);
    assert.deepEqual(decodeEntryPayload(wire(encoded)), payload.data);
    assert.deepEqual(encoded.data.body, payload.data.body);
    assert.deepEqual(encoded.data.requestBody, payload.data.requestBody);
    assert.deepEqual(encoded.marker, payload.marker);
});

function freeze(value) {
    if (value && typeof value === 'object') {
        for (const child of Object.values(value)) freeze(child);
        Object.freeze(value);
    }
    return value;
}

function wire(payload) {
    return JSON.parse(JSON.stringify(payload));
}

test('entry: seven exact phases round-trip without SSL subtraction or total-time reconstruction', () => {
    const payload = freeze({
        data: {
            command: 'entry', index: 3, truncated: false,
            entry: {
                time: 999.875,
                timings: { receive: null, wait: 500.125, ssl: 10, connect: 10, send: 0, dns: 1.25, blocked: 0 }
            }
        },
        endpointColumns: ['count', 'time', 'size', 'unknownTime', 'unknownSize'],
        marker: { retained: false }
    });
    const encoded = encodeEntry(payload);
    assert.deepEqual(encoded.timingColumns, ['blocked', 'dns', 'connect', 'ssl', 'send', 'wait', 'receive']);
    assert.deepEqual(encoded.data.entry.timings, [0, 1.25, 10, 10, 0, 500.125, null]);
    assert.deepEqual(decodeEntryPayload(wire(encoded)), payload.data);
    assert.deepEqual(encoded.endpointColumns, payload.endpointColumns);
    assert.deepEqual(encoded.marker, payload.marker);
    assert.notStrictEqual(encoded, payload);
    assert.equal(Object.hasOwn(encoded, 'headerColumns'), false);
});

test('slow object rows: timings round-trip with all unknown phases, measured zeros and original order', () => {
    const payload = freeze({
        data: {
            command: 'slow', total: 5, shown: 5, omitted: 0, truncated: true,
            items: [
                { index: 9, time: null, timings: { blocked: null, dns: null, connect: null, ssl: null, send: null, wait: null, receive: null } },
                { index: 1, time: 0, timings: { blocked: 0, dns: 0, connect: 0, ssl: 0, send: 0, wait: 0, receive: 0 } },
                { index: 1, time: 0, timings: { blocked: 0, dns: null, connect: null, ssl: 0, send: 0, wait: 0, receive: 0 } },
                { index: 4, time: null, timings: null },
                { index: 5, time: null }
            ]
        },
        marker: ''
    });
    const encoded = encodeEntry(payload);
    assert.deepEqual(encoded.timingColumns, ['blocked', 'dns', 'connect', 'ssl', 'send', 'wait', 'receive']);
    assert.deepEqual(encoded.data.items[0].timings, [null, null, null, null, null, null, null]);
    assert.deepEqual(encoded.data.items[1].timings, [0, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(encoded.data.items[2].timings, [0, null, null, 0, 0, 0, 0]);
    assert.deepEqual(decodeEntryPayload(wire(encoded)), payload.data);
    assert.equal(encoded.marker, '');
});

test('slow tables: the timings column composes with columns/rows and primitive defaults', () => {
    const input = freeze({
        data: {
            command: 'slow', total: 3, shown: 3, omitted: 0, truncated: false,
            items: {
                columns: ['index', 'timings', 'url', 'time'],
                rows: [
                    [7, { blocked: 0, dns: 1.5, connect: 2.75, ssl: 3.25, send: 0, wait: 100.125, receive: null }, '/Я%2F?x=1&x=', 999],
                    [8, null, '', null],
                    [9, { wait: 1 }, '/partial', 1]
                ],
                defaults: { uncompressedEstimated: false, compression: null }
            }
        },
        endpointColumns: ['count', 'time', 'size', 'unknownTime', 'unknownSize']
    });
    const encoded = encodeEntry(input);
    assert.deepEqual(encoded.data.items.rows[0][1], [0, 1.5, 2.75, 3.25, 0, 100.125, null]);
    assert.deepEqual(encoded.data.items.columns, input.data.items.columns);
    assert.deepEqual(encoded.data.items.defaults, input.data.items.defaults);
    assert.deepEqual(encoded.endpointColumns, input.endpointColumns);
    assert.deepEqual(decodeEntryPayload(wire(encoded)), {
        command: 'slow', total: 3, shown: 3, omitted: 0, truncated: false,
        items: [
            { index: 7, timings: { blocked: 0, dns: 1.5, connect: 2.75, ssl: 3.25, send: 0, wait: 100.125, receive: null }, url: '/Я%2F?x=1&x=', time: 999, uncompressedEstimated: false, compression: null },
            { index: 8, timings: null, url: '', time: null, uncompressedEstimated: false, compression: null },
            { index: 9, timings: { wait: 1 }, url: '/partial', time: 1, uncompressedEstimated: false, compression: null }
        ]
    });
});
