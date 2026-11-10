'use strict';
// Регрессии аудита: согласованность метаданных и ошибки до любой записи.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {tmpRoot, makeSkill, writeManifest, readManifest, writeManifestObj, run, assertCode} = require('./helpers');

function fixture(t) {
    const root = tmpRoot();
    const src = makeSkill(root, 'demo');
    const manifest = writeManifest(root);
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    return {root, src, manifest};
}

test('bump: битый манифест не меняет VERSION и SKILL.md', (t) => {
    const {root, src} = fixture(t);
    const version = fs.readFileSync(path.join(src, 'VERSION'));
    const skill = fs.readFileSync(path.join(src, 'SKILL.md'));
    fs.writeFileSync(path.join(root, 'skills', 'manifest.json'), '{broken');
    const r = run(root, ['bump', 'demo', 'patch']);
    assert.equal(r.code, 1);
    assert.deepEqual(fs.readFileSync(path.join(src, 'VERSION')), version);
    assert.deepEqual(fs.readFileSync(path.join(src, 'SKILL.md')), skill);
});

test('bump: отсутствие frontmatter не меняет VERSION', (t) => {
    const {root, src} = fixture(t);
    const text = '# Demo\n\nversion: 7.0.0\n';
    fs.writeFileSync(path.join(src, 'SKILL.md'), text);
    const before = fs.readFileSync(path.join(root, 'skills', 'manifest.json'));
    const r = run(root, ['bump', 'demo', 'patch']);
    assert.equal(r.code, 1);
    assert.equal(fs.readFileSync(path.join(src, 'VERSION'), 'utf8'), '1.0.0\n');
    assert.equal(fs.readFileSync(path.join(src, 'SKILL.md'), 'utf8'), text);
    assert.deepEqual(fs.readFileSync(path.join(root, 'skills', 'manifest.json')), before);
});

test('bump: добавление Python обновляет requires вместе с хешем', (t) => {
    const {root, src} = fixture(t);
    fs.writeFileSync(path.join(src, 'scripts', 'tool.py'), 'print("ok")\n');
    assertCode(run(root, ['bump', 'demo', 'patch']), 0, 'bump');
    assert.deepEqual(readManifest(root).skills[0].requires, ['node>=18', 'python>=3']);
    assertCode(run(root, ['verify']), 0, 'verify');
});

test('verify: неверные requires не проходят проверку', (t) => {
    const {root, manifest} = fixture(t);
    manifest.skills[0].requires = ['python>=3'];
    writeManifestObj(root, manifest);
    const r = run(root, ['verify']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /requires/);
});

test('manifest: updated неизменённого скилла сохраняется, schemaVersion записывается', (t) => {
    const {root} = fixture(t);
    assertCode(run(root, ['manifest']), 0, 'manifest');
    const manifest = readManifest(root);
    assert.equal(manifest.skills[0].updated, '2026-11-06');
    assert.equal(manifest.schemaVersion, 1);
    assertCode(run(root, ['verify']), 0, 'verify');
});

test('check: более новая установка отличается от локальной правки', (t) => {
    const {root, manifest} = fixture(t);
    const inst = path.join(root, 'installed');
    assertCode(run(root, ['install', 'demo', '--to', inst]), 0, 'install');
    manifest.skills[0].version = '0.9.0';
    writeManifestObj(root, manifest);
    const r = run(root, ['check', '--dir', inst, '--json']);
    assertCode(r, 0, 'check');
    assert.equal(JSON.parse(r.stdout)[0].status, 'новее манифеста (1.0.0 > 0.9.0)');
});

test('check: null и неполные .installed.json дают понятный статус', (t) => {
    const {root} = fixture(t);
    const inst = path.join(root, 'installed');
    assertCode(run(root, ['install', 'demo', '--to', inst]), 0, 'install');
    for (const meta of [null, {}, {name: 'demo', version: 'not-semver'}]) {
        fs.writeFileSync(path.join(inst, 'demo', '.installed.json'), JSON.stringify(meta));
        const r = run(root, ['check', '--dir', inst, '--json']);
        assertCode(r, 0, 'check');
        assert.equal(JSON.parse(r.stdout)[0].status, 'неизвестно (битый .installed.json)');
    }
});

test('CLI: флаг значения не поглощает следующий флаг и не принимает пустое значение', (t) => {
    const {root} = fixture(t);
    for (const args of [['check', '--dir', '--json'], ['hash', 'demo', '--to', '--json'], ['hash', 'demo', '--manifest=']]) {
        const r = run(root, args);
        assert.equal(r.code, 1, args.join(' ') + '\n' + r.stdout);
        assert.match(r.stderr, /значение.*--(?:dir|to|manifest)|--(?:dir|to|manifest).*значение/);
    }
});

test('манифест: traversal, дубликаты и неизвестная схема отклоняются', (t) => {
    const {root, manifest} = fixture(t);
    for (const invalid of [
        {...manifest, skills: [{...manifest.skills[0], name: '../outside'}]},
        {...manifest, skills: [manifest.skills[0], manifest.skills[0]]},
        {...manifest, schemaVersion: 999},
    ]) {
        writeManifestObj(root, invalid);
        const r = run(root, ['verify']);
        assert.equal(r.code, 1);
        assert.match(r.stderr, /имя|дубликат|schemaVersion/);
    }
});
