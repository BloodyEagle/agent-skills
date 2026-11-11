'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { decodeCompact } = require('./compact-oracle');

const CLI = path.join(__dirname, '..', '..', 'skills', 'token-economy-har', 'har.js');

function run(file, compact) {
    const args = [CLI, 'search', 'GET', '-f', file, '--limit', '195', '--json'];
    if (compact) args.push('--compact');
    const result = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 15000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
}

function entry(index, unique) {
    const url = unique
        ? `https://host-${index}.example.test/unique/${index}?v=${index}`
        : `https://static.example.test/assets/application/chunks/file-${index}.js?v=${index}`;
    return {
        startedDateTime: `2026-11-12T00:00:${String(index % 60).padStart(2, '0')}.${String(index).padStart(3, '0')}Z`,
        time: index % 4 === 0 ? 0 : index + 0.125,
        request: { method: index % 2 ? 'GET' : 'GET', url, headers: [], queryString: [] },
        response: {
            status: index % 7 ? 200 : 0, bodySize: index % 5 ? index : -1,
            content: { size: index % 3 ? index * 2 : -1, mimeType: index % 2 ? 'application/javascript' : 'text/css' }
        },
        timings: { blocked: 0, dns: -1, connect: -1, ssl: -1, send: 0, wait: index, receive: 0 }
    };
}

for (const unique of [false, true]) {
    test(`near-budget output remains exact and bounded, unique=${unique}`, () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'har-compact-budget-'));
        try {
            const file = path.join(directory, 'fixture.har');
            fs.writeFileSync(file, JSON.stringify({ log: { entries: Array.from({ length: 195 }, (_, index) => entry(index, unique)) } }));
            const legacyText = run(file, false);
            const compactText = run(file, true);
            const legacy = JSON.parse(legacyText);
            const encoded = JSON.parse(compactText);
            assert.deepEqual(decodeCompact(encoded), legacy);
            assert.ok(Buffer.byteLength(compactText) <= 8192);
            assert.ok(compactText.trimEnd().split('\n').length <= 200);
            if (encoded.format === 'har-compact-v1') {
                assert.ok(Buffer.byteLength(compactText) < Buffer.byteLength(legacyText));
                if (encoded.strings) assert.ok(findTags(encoded.data, '$ref').every(index => index < encoded.strings.length));
                if (encoded.urlPrefixes) assert.ok(findTags(encoded.data, '$prefix').every(index => index < encoded.urlPrefixes.length));
            } else assert.deepEqual(encoded, legacy);
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
}

function findTags(value, tag, found = []) {
    if (Array.isArray(value)) {
        for (const item of value) findTags(item, tag, found);
    } else if (value && typeof value === 'object') {
        if (tag === '$ref' && Object.hasOwn(value, tag)) found.push(value[tag]);
        else if (tag === '$prefix' && Object.hasOwn(value, tag)) found.push(value[tag][0]);
        else for (const item of Object.values(value)) findTags(item, tag, found);
    }
    return found;
}
