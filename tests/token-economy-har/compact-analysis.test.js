'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { compactResult } = require('../../skills/token-economy-har/lib/compact');
const { decodeCompact } = require('./compact-oracle');

function endpoint(count, time, size, unknownTime = 0, unknownSize = 0) {
    return { count, time, size, unknownTime, unknownSize };
}

function analyze(data) {
    const items = data.items;
    return {
        slowest: items.reduce((best, row) => best === null || row.time > best.time ? row : best, null),
        knownTransfer: items.reduce((sum, row) => sum + (row.transfer ?? 0), 0),
        unknownTransfer: items.filter(row => row.transfer === null).length,
        zeros: items.filter(row => row.transfer === 0).map(row => row.index),
        unknowns: items.filter(row => row.transfer === null).map(row => row.index),
        omitted: data.omitted,
        truncated: data.truncated
    };
}

test('compact retains conclusions about phases, lower bounds, zero/unknown and completeness', () => {
    const baseline = {
        command: 'slow', total: 4, shown: 3, omitted: 1, limit: 3, truncated: true,
        items: [
            { index: 4, method: 'GET', status: 200, url: '/slow', domain: '', mimeType: '', time: 100, transfer: 0, timings: { blocked: 0, dns: null, connect: 10, ssl: 5, send: 0, wait: 80, receive: 5 } },
            { index: 5, method: 'GET', status: 200, url: '/unknown', domain: '', mimeType: '', time: 90, transfer: null, timings: { blocked: null, dns: null, connect: null, ssl: null, send: 0, wait: 90, receive: 0 } },
            { index: 6, method: 'GET', status: 204, url: '/empty', domain: '', mimeType: '', time: 0, transfer: 12, timings: { blocked: 0, dns: 0, connect: 0, ssl: 0, send: 0, wait: 0, receive: 0 } }
        ]
    };
    const output = JSON.parse(compactResult(baseline));
    const decoded = decodeCompact(output);
    assert.deepEqual(analyze(decoded), analyze(baseline));
    assert.equal(decoded.items[0].timings.connect, 10);
    assert.equal(decoded.items[0].timings.ssl, 5);
    assert.equal(decoded.items[1].timings.connect, null);
});

test('compact retains duplicate evidence and independent diff metrics', () => {
    const duplicates = {
        command: 'dup', strategy: 'norm', total: 2, shown: 2, omitted: 0, limit: 2, truncated: true,
        items: [
            { key: 'https://example.test/app.*.js', count: 35, indices: [0, 2, 4], urls: ['https://example.test/app.abc.js'], omittedIndices: 32 },
            { key: 'https://example.test/api', count: 2, indices: [1, 3], urls: ['https://example.test/api'], omittedIndices: 0 }
        ]
    };
    assert.deepEqual(decodeCompact(JSON.parse(compactResult(duplicates))), duplicates);

    const diff = {
        command: 'diff', total: 3, shown: 3, omitted: 0, limit: 3, truncated: false,
        items: [
            { change: 'count', method: 'GET', url: '/a', before: endpoint(1, 10, 20), after: endpoint(3, 10, 20) },
            { change: 'slower', method: 'GET', url: '/a', before: endpoint(1, 10, 20), after: endpoint(3, 30, 20) },
            { change: 'heavier', method: 'GET', url: '/a', before: endpoint(1, 10, 20), after: endpoint(3, 30, 80) }
        ]
    };
    assert.deepEqual(decodeCompact(JSON.parse(compactResult(diff))), diff);
});
