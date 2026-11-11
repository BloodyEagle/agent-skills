'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { compactCandidates } = require('../../skills/token-economy-har/lib/compact');
const { decodeCompact } = require('./compact-oracle');

const timings = { blocked: 0, dns: null, connect: 0, ssl: 0, send: 0, wait: 10, receive: 0 };
const baseline = {
    command: 'slow', total: 2, shown: 2, omitted: 0, limit: 2, truncated: false,
    items: [
        { index: 0, method: 'GET', url: 'https://example.test/a', timings },
        { index: 1, method: 'GET', url: 'https://example.test/b', timings }
    ]
};

test('untransformed payload never receives a tagged wrapper', () => {
    const baseline = { command: 'entry', message: 'x'.repeat(500), extra: 'y'.repeat(500) };
    const legacy = JSON.stringify(baseline);
    assert.equal(require('../../skills/token-economy-har/lib/compact').compactResult(baseline, legacy), legacy);
});

test('candidate set compares table and timing transformations independently and together', () => {
    const candidates = compactCandidates(baseline);
    const tableOnly = candidates.find(candidate => candidate.data.items?.columns && !candidate.timingColumns);
    const timingsOnly = candidates.find(candidate => Array.isArray(candidate.data.items) && candidate.timingColumns);
    const together = candidates.find(candidate => candidate.data.items?.columns && candidate.timingColumns);
    assert.ok(tableOnly);
    assert.ok(timingsOnly);
    assert.ok(together);
    for (const candidate of [tableOnly, timingsOnly, together]) {
        assert.deepEqual(decodeCompact({ format: 'har-compact-v1', ...candidate }), baseline);
    }
});
