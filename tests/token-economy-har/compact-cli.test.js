'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { decodeCompact } = require('./compact-oracle');

const CLI = path.join(__dirname, '..', '..', 'skills', 'token-economy-har', 'har.js');
const fixture = name => path.join(__dirname, 'fixtures', `${name}.har`);

function cli(args, expected = 0, input) {
    const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', input, maxBuffer: 1024 * 1024, timeout: 15000 });
    assert.ifError(result.error);
    assert.equal(result.status, expected, result.stderr);
    return result;
}

function document(args, expected = 0, input) {
    return JSON.parse(cli(args, expected, input).stdout);
}

function baseline(args, expected = 0, input) {
    return document([...args, '--json'], expected, input);
}

function compact(args, expected = 0, input) {
    return document([...args, '--json', '--compact'], expected, input);
}

for (const [name, args, expected] of [
    ['info', ['info', '-f', fixture('mixed'), '--limit', '5'], 0],
    ['slow', ['slow', '-f', fixture('mixed'), '--top', '6'], 0],
    ['errors', ['errors', '-f', fixture('mixed')], 0],
    ['domains', ['domains', '-f', fixture('mixed'), '--sort', 'size'], 0],
    ['content', ['content', '-f', fixture('mixed'), '--by-mime'], 0],
    ['dup exact', ['dup', '-f', fixture('duplicates'), '--strategy', 'exact'], 0],
    ['dup norm', ['dup', '-f', fixture('duplicates'), '--strategy', 'norm'], 0],
    ['dup hash', ['dup', '-f', fixture('base64'), '--strategy', 'hash'], 0],
    ['search', ['search', 'GET', '-f', fixture('mixed'), '--limit', '6'], 0],
    ['entry', ['entry', '0', '-f', fixture('mixed')], 0],
    ['entry body', ['entry', '0', '-f', fixture('mixed'), '--body', '2k'], 0],
    ['waterfall', ['waterfall', '-f', fixture('mixed'), '--top', '6'], 0],
    ['diff', ['diff', fixture('mixed'), fixture('partial-transfer')], 0]
]) {
    test(`${name}: compact decodes to exact bounded legacy JSON`, () => {
        const legacy = baseline(args, expected);
        const encoded = compact(args, expected);
        assert.deepEqual(decodeCompact(encoded), legacy);
        const output = cli([...args, '--json', '--compact'], expected).stdout;
        assert.ok(Buffer.byteLength(output) <= 8192);
        assert.ok(output.trimEnd().split('\n').length <= 200);
    });
}

test('single-row response uses measured legacy fallback', () => {
    const legacy = baseline(['search', 'HEAD', '-f', fixture('mixed')]);
    const encoded = compact(['search', 'HEAD', '-f', fixture('mixed')]);
    assert.equal(Object.hasOwn(encoded, 'format'), false);
    assert.deepEqual(encoded, legacy);
});

test('entry preserves legacy header/query/body truncation with repeated pairs and base64', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'har-compact-entry-'));
    try {
        const repeated = Array.from({ length: 205 }, (_, index) => ({ name: index % 2 ? 'Set-Cookie' : 'set-cookie', value: `${index}:Я😀` }));
        const input = { log: { entries: [{
            startedDateTime: '2026-11-12T00:00:00Z', time: 0,
            request: {
                method: 'POST', url: 'https://example.test/%2F?q=%20&q=+', headers: repeated,
                queryString: [{ name: 'q', value: '%20' }, { name: 'q', value: '+' }, { name: '', value: '' }],
                postData: { mimeType: 'text/plain', text: '  Я😀  \n' }
            },
            response: {
                status: 200, headers: repeated, bodySize: 5,
                content: { size: 5, mimeType: 'application/octet-stream', encoding: 'base64', text: 'AAECAwQ=' }
            },
            timings: { blocked: 0, dns: -1, connect: 0, ssl: 0, send: 0, wait: 0, receive: 0 }
        }] } };
        const file = path.join(directory, 'entry.har');
        fs.writeFileSync(file, JSON.stringify(input));
        const args = ['entry', '0', '-f', file, '--body', '4'];
        const legacy = baseline(args);
        const encoded = compact(args);
        assert.deepEqual(decodeCompact(encoded), legacy);
        assert.equal(legacy.truncated, true);
        assert.equal(legacy.body.encoding, 'base64');
        assert.equal(legacy.body.truncated, true);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('compact falls back to legacy for help, no-match and entry not found', () => {
    for (const [args, expected] of [
        [['help'], 0], [['search', 'NEVER_MATCH', '-f', fixture('mixed')], 1],
        [['entry', '999', '-f', fixture('mixed')], 1], [['diff', fixture('mixed'), fixture('mixed')], 1]
    ]) {
        const legacy = baseline(args, expected);
        const encoded = compact(args, expected);
        assert.equal(Object.hasOwn(encoded, 'format'), false);
        assert.deepEqual(encoded, legacy);
    }
});

test('argument and malformed-HAR diagnostics remain legacy on stderr', () => {
    for (const [args, jsonDiagnostic] of [
        [['info', '--compact'], false],
        [['help', '--compact'], false],
        [['--compact=true', '--json', 'info'], true],
        [['info', '--json', '--compact', '--pretty'], true],
        [['search', '[', '--json', '--compact'], true]
    ]) {
        const result = cli(args, 2);
        assert.equal(result.stdout, '');
        if (jsonDiagnostic) {
            const error = JSON.parse(result.stderr);
            assert.equal(error.exitCode, 2);
            assert.equal(Object.hasOwn(error, 'format'), false);
        } else assert.match(result.stderr, /--compact:.*--json/);
    }
    const result = cli(['info', '--json', '--compact'], 2, '{"log":{"entries":[]} garbage');
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).exitCode, 2);
});

test('stdin/stream and argv forms retain parity', () => {
    const input = fs.readFileSync(fixture('mixed'), 'utf8');
    const variants = [
        ['--json', '--compact', '--stream', 'slow', '--top=6', '--file=-'],
        ['slow', '--file', '-', '--top', '6', '--stream', '--compact', '--json'],
        ['--compact', '--json', 'slow', '--', '--top']
    ];
    const expected = baseline(['slow', '--top', '6', '-f', fixture('mixed')]);
    for (const args of variants.slice(0, 2)) assert.deepEqual(decodeCompact(document(args, 0, input)), expected);
    const positional = cli(variants[2], 2);
    assert.equal(JSON.parse(positional.stderr).exitCode, 2);
});

test('file paths with spaces/commas and search patterns containing equals/backslashes keep argv semantics', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'har compact,argv-'));
    try {
        const file = path.join(directory, 'capture, with spaces.har');
        fs.copyFileSync(fixture('mixed'), file);
        for (const args of [
            ['search', String.raw`https:\/\/app\.example\.test\/.*access_token=`, `--file=${file}`, '--limit=30'],
            ['--file', file, '--compact', '--json', 'search', String.raw`access_token=test_query_secret`]
        ]) {
            const encoded = document(args.includes('--json') ? args : [...args, '--json', '--compact']);
            assert.equal(decodeCompact(encoded).items[0].index, 3);
        }
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('redact accepts valid compact combination but stays legacy', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'har-compact-redact-'));
    try {
        const output = path.join(directory, 'clean.har');
        const result = document(['redact', '-f', fixture('mixed'), '-o', output, '--json', '--compact']);
        assert.equal(result.command, 'redact');
        assert.equal(Object.hasOwn(result, 'format'), false);
        assert.ok(fs.existsSync(output));
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
