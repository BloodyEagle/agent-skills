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

test('bump: ошибки decoded metadata сохраняют все три файла и не оставляют tmp', (t) => {
    const {root, src, manifest} = fixture(t);
    const versionFile = path.join(src, 'VERSION');
    const skillFile = path.join(src, 'SKILL.md');
    const files = [versionFile, skillFile, path.join(root, 'skills', 'manifest.json')];
    const original = fs.readFileSync(skillFile, 'utf8');
    const cases = [
        {skill: original.replace('description: тестовый скилл\n', '')},
        ...['', "''", '"   "', 'null', '"' + '😀'.repeat(1025) + '"', '|2\n  text', '"\\q"'].map((value) =>
            ({skill: original.replace('description: тестовый скилл', 'description: ' + value)})),
        ...['01.0.0', '1.0.0-alpha', '1.0.0+build', '9007199254740992.0.0'].map((version) => ({version})),
        ...['01.0.0', '"1.0.0"', '1.0.1', '1.0.0\nversion: 1.0.0'].map((version) =>
            ({skill: original.replace('version: 1.0.0', 'version: ' + version)})),
        {manifestVersion: '1.00.0'}, {manifestVersion: '1.0.9007199254740992'}, {manifestVersion: 1},
    ];
    for (const invalid of cases) {
        fs.writeFileSync(versionFile, (invalid.version || '1.0.0') + '\n');
        fs.writeFileSync(skillFile, invalid.skill || original);
        writeManifestObj(root, {...manifest, skills: [{...manifest.skills[0], version: invalid.manifestVersion ?? '1.0.0'}]});
        const before = files.map((file) => fs.readFileSync(file));
        const r = run(root, ['bump', 'demo', 'patch']);
        assertCode(r, 1, 'bump metadata refusal');
        assert.match(r.stderr, /description|VERSION|version|расходятся/);
        files.forEach((file, index) => assert.deepEqual(fs.readFileSync(file), before[index]));
        assert.deepEqual(fs.readdirSync(src).sort(), ['SKILL.md', 'VERSION', 'scripts']);
        assert.deepEqual(fs.readdirSync(path.join(root, 'skills')).sort(), ['demo', 'manifest.json']);
    }
});

test('manifest: невалидный metadata второго скилла не публикует частичный манифест', (t) => {
    const {root, manifest} = fixture(t);
    const second = makeSkill(root, 'z-demo');
    fs.writeFileSync(path.join(second, 'SKILL.md'), '---\nname: z-demo\ndescription: &anchor text\nversion: 1.0.0\n---\n');
    const manifestFile = path.join(root, 'skills', 'manifest.json');
    const before = fs.readFileSync(manifestFile);
    const r = run(root, ['manifest']);
    assertCode(r, 1, 'manifest refusal');
    assert.match(r.stderr, /description: неподдерживаемый YAML/);
    assert.deepEqual(fs.readFileSync(manifestFile), before);
    assert.deepEqual(readManifest(root), manifest);
    assert.deepEqual(fs.readdirSync(path.join(root, 'skills')).sort(), ['demo', 'manifest.json', 'z-demo']);
});

test('check: неканонический version в .installed.json имеет статус битой метки', (t) => {
    const {root} = fixture(t);
    const inst = path.join(root, 'installed');
    assertCode(run(root, ['install', 'demo', '--to', inst]), 0, 'install');
    const metaFile = path.join(inst, 'demo', '.installed.json');
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    for (const version of ['01.0.0', '1.0.0-alpha', '1.0.0+build', '9007199254740992.0.0', '1.0.0\n', 1]) {
        fs.writeFileSync(metaFile, JSON.stringify({...meta, version}));
        const r = run(root, ['check', '--dir', inst, '--json']);
        assertCode(r, 0, 'check');
        assert.equal(JSON.parse(r.stdout)[0].status, 'неизвестно (битый .installed.json)');
    }
});

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
