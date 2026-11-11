'use strict';

const assert = require('node:assert/strict');

const { compactCandidates, compactResult } = require('../../skills/token-economy-har/lib/compact');
const { decodeCompact } = require('./compact-oracle');

function summary(index, repeated) {
    return {
        index, method: repeated ? 'GET' : `M${index}`, status: index % 5 ? 200 : 0,
        url: repeated ? `https://example.test/assets/very/long/common/path/file-${index}.js?q=${index}` : `/u/${index}`,
        domain: repeated ? 'example.test' : `d${index}.test`, mimeType: repeated ? 'application/javascript' : `t/${index}`,
        time: index / 3, startedDateTime: `2026-11-12T00:00:${String(index % 60).padStart(2, '0')}Z`,
        start: 1794441600000 + index, transfer: index, uncompressed: index * 2,
        compression: index, uncompressedEstimated: false
    };
}

function payload(rows, repeated) {
    const items = Array.from({ length: rows }, (_, index) => summary(index, repeated));
    return { command: 'search', total: rows, shown: rows, omitted: 0, limit: Math.max(rows, 1), truncated: false, items };
}

const cases = [];
for (const rows of [0, 1, 5, 30, 195]) for (const repeated of [false, true]) cases.push({ rows, repeated });
for (const item of cases) {
    const baseline = payload(item.rows, item.repeated);
    const legacy = JSON.stringify(baseline);
    const output = compactResult(baseline, legacy);
    const decoded = decodeCompact(JSON.parse(output));
    assert.deepEqual(decoded, baseline, `round-trip failed: ${JSON.stringify(item)}`);
    const candidates = compactCandidates(baseline);
    const active = output !== legacy;
    process.stdout.write(`${JSON.stringify({
        ...item, legacyBytes: Buffer.byteLength(legacy) + 1, outputBytes: Buffer.byteLength(output) + 1,
        savedBytes: Buffer.byteLength(legacy) - Buffer.byteLength(output), active, candidates: candidates.length,
        tokenizer: null
    })}\n`);
}
