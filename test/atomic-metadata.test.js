'use strict';
// Метаданные источника должны переживать ошибку финального rename без частичного bump.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {tmpRoot, makeSkill, writeManifest, run, assertCode} = require('./helpers');

const cli = path.join(__dirname, '..', 'skills.js');

function fixture(t) {
    const root = tmpRoot();
    const src = makeSkill(root, 'demo');
    writeManifest(root);
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    return {root, src};
}

test('bump: неудачный rename манифеста откатывает VERSION и SKILL.md', (t) => {
    const {root, src} = fixture(t);
    const files = [path.join(src, 'VERSION'), path.join(src, 'SKILL.md'), path.join(root, 'skills', 'manifest.json')];
    const before = files.map((file) => fs.readFileSync(file));
    const hook = path.join(root, 'rename-failure.cjs');
    fs.writeFileSync(hook, `const fs = require('node:fs');
const path = require('node:path');
const rename = fs.renameSync;
fs.renameSync = (from, to) => {
    if (path.basename(to) === 'manifest.json') throw new Error('simulated rename failure');
    return rename(from, to);
};
`);
    const r = spawnSync(process.execPath, ['--require', hook, cli, '--root', root, 'bump', 'demo', 'patch'],
        {encoding: 'utf8', timeout: 10000});
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /simulated rename failure/);
    files.forEach((file, index) => assert.deepEqual(fs.readFileSync(file), before[index]));
    assert.deepEqual(fs.readdirSync(src).sort(), ['SKILL.md', 'VERSION', 'scripts']);
    assert.deepEqual(fs.readdirSync(path.join(root, 'skills')).sort(), ['demo', 'manifest.json']);
    assertCode(run(root, ['verify']), 0, 'verify после rollback');
});

test('bump: version меняется только во frontmatter, BOM и CRLF сохраняются', (t) => {
    const {root, src} = fixture(t);
    const text = '\uFEFF---\r\nname: demo\r\ndescription: тест\r\nversion: 1.0.0\r\n---\r\n\r\nversion: sample\r\n';
    fs.writeFileSync(path.join(src, 'SKILL.md'), text, 'utf8');
    writeManifest(root);
    assertCode(run(root, ['bump', 'demo', 'patch']), 0, 'bump');
    assert.equal(fs.readFileSync(path.join(src, 'SKILL.md'), 'utf8'), text.replace('version: 1.0.0', 'version: 1.0.1'));
    assertCode(run(root, ['verify']), 0, 'verify');
});

test('bump: отсутствующая version добавляется во frontmatter', (t) => {
    const {root, src} = fixture(t);
    const text = '---\nname: demo\ndescription: тест\n---\n\nversion: example\n';
    fs.writeFileSync(path.join(src, 'SKILL.md'), text);
    writeManifest(root);
    assertCode(run(root, ['bump', 'demo', 'minor']), 0, 'bump');
    assert.equal(fs.readFileSync(path.join(src, 'SKILL.md'), 'utf8'), text.replace('description:', 'version: 1.1.0\ndescription:'));
    assertCode(run(root, ['verify']), 0, 'verify');
});

test('check: загрузка манифеста передаёт конечный таймаут fetch', (t) => {
    const {root} = fixture(t);
    const hook = path.join(root, 'fetch-check.cjs');
    fs.writeFileSync(hook, `const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const timeout = AbortSignal.timeout;
let requested;
AbortSignal.timeout = (ms) => { requested = ms; return timeout(ms); };
global.fetch = async (url, options) => {
    assert.equal(requested, 10000);
    assert.ok(options.signal instanceof AbortSignal);
    return {ok: true, text: async () => fs.readFileSync(path.join(__dirname, 'skills', 'manifest.json'), 'utf8')};
};
`);
    const r = spawnSync(process.execPath,
        ['--require', hook, cli, '--root', root, 'check', '--manifest', 'https://example.invalid/manifest.json', '--dir', root, '--json'],
        {encoding: 'utf8', timeout: 10000});
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout)[0].status, 'не установлен');
});
