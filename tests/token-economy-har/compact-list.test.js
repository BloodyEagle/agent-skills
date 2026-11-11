'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { encodeLists } = require('../../skills/token-economy-har/lib/compact-list');
const { decodeCompact } = require('./compact-oracle');
const wire = payload => JSON.parse(JSON.stringify({ format: 'har-compact-v1', ...payload }));

function summary(index) {
    return {
        index, method: 'GET', status: 0, url: `/Я😀/${index}`, domain: '', mimeType: 'text/plain',
        time: index / 3, startedDateTime: null, start: null, transfer: null, uncompressed: 0,
        compression: null, uncompressedEstimated: false
    };
}

function aggregate(name, index) {
    return {
        [name]: `${name}-${index}`, count: 1, transfer: 0, uncompressed: 0,
        unknownTransfer: 0, unknownUncompressed: 0, time: index / 3, unknownTime: 0
    };
}

function commandRows(command) {
    if (command === 'domains') return Array.from({ length: 30 }, (_, index) => aggregate('domain', index));
    if (command === 'content') return Array.from({ length: 30 }, (_, index) => aggregate('type', index));
    if (command === 'dup') return Array.from({ length: 30 }, (_, index) => ({
        key: `/key/${index}`, count: 31, indices: [1, 2], urls: ['/u'], omittedIndices: 29
    }));
    if (command === 'diff') return Array.from({ length: 30 }, (_, index) => ({
        change: 'added', method: 'GET', url: `/Я😀/${index}`, before: null,
        after: { count: 2, time: 0.125, size: null, unknownTime: 0, unknownSize: 2 }
    }));
    return Array.from({ length: 30 }, (_, index) => ({
        ...summary(index),
        ...(command === 'slow' ? { timings: { blocked: null, dns: 0, connect: 0, ssl: 0, send: 0, wait: 0.5, receive: null } } : {}),
        ...(command === 'errors' ? { reasons: ['_error', 'таймаут'] } : {}),
        ...(command === 'waterfall' ? { offset: null } : {})
    }));
}

for (const command of ['search', 'slow', 'errors', 'waterfall', 'domains', 'content', 'dup', 'diff']) {
    test(`${command}: tables retain every field, row order and primitive defaults`, () => {
        const baseline = { command, total: 40, shown: 30, omitted: 10, truncated: true, items: commandRows(command) };
        const saved = structuredClone(baseline);
        for (const defaults of [false, true]) {
            const encoded = encodeLists(baseline, { defaults });
            assert.ok(encoded.data.items.columns);
            assert.equal(encoded.data.shown, 30);
            assert.deepEqual(decodeCompact(wire(encoded)), baseline);
        }
        assert.deepEqual(baseline, saved);
    });
}

test('presence: heterogeneous fields, missing versus null and empty lists stay objects', () => {
    for (const items of [[], [{ x: null }, {}], [{ x: 0 }, { x: false }], [{ x: '' }, { x: null }]]) {
        const baseline = { command: 'search', total: items.length, shown: items.length, omitted: 0, truncated: false, items };
        const encoded = encodeLists(baseline, { defaults: true });
        assert.deepEqual(decodeCompact(wire(encoded)), baseline);
        assert.deepEqual(encoded.data.items, items);
    }
});

test('unexpected fields stay in legacy object form rather than entering an implicit schema', () => {
    const items = [{ ...summary(0), extension: 'one' }, { ...summary(1), extension: 'two' }];
    const baseline = { command: 'search', total: 2, shown: 2, omitted: 0, truncated: false, items };
    const encoded = encodeLists(baseline, { defaults: true });
    assert.deepEqual(encoded.data.items, items);
    assert.deepEqual(decodeCompact(wire(encoded)), baseline);
});

test('info groups preserve unknown counters and metadata without factoring envelope', () => {
    const domains = Array.from({ length: 10 }, (_, index) => ({ ...aggregate('domain', index), time: 0 }));
    const contentTypes = Array.from({ length: 10 }, (_, index) => ({ ...aggregate('type', index), time: 0 }));
    const baseline = { command: 'info', requests: 12, domains, contentTypes, omittedDomains: 2, omittedContentTypes: 3, omittedValues: 7, truncated: true };
    const encoded = encodeLists(baseline, { defaults: true });
    assert.deepEqual(encoded.data.domains.defaults, {
        count: 1, transfer: 0, uncompressed: 0, unknownTransfer: 0,
        unknownUncompressed: 0, time: 0, unknownTime: 0
    });
    assert.deepEqual(decodeCompact(wire(encoded)), baseline);
});
