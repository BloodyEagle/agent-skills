'use strict';
// bump: patch/minor/major и согласованность с манифестом (кейсы 6–8 плана).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {tmpRoot, makeSkill, writeManifest, readManifest, run, assertCode} = require('./helpers');

function fixture(version) {
    const root = tmpRoot();
    makeSkill(root, 'skill-a', version);
    writeManifest(root);
    return root;
}

test('bump: quoted decoded description ровно 1024 code points допускается с BOM/CRLF', (t) => {
    const root = fixture('1.0.0');
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    const file = path.join(root, 'skills', 'skill-a', 'SKILL.md');
    const text = '\uFEFF---\r\nname: skill-a\r\ndescription: "' + '\\U0001F600'.repeat(1024)
        + '"\r\nversion: 1.0.0\r\n---\r\n# Demo\r\n';
    fs.writeFileSync(file, text);
    writeManifest(root);
    assertCode(run(root, ['bump', 'skill-a', 'patch']), 0, 'bump decoded boundary');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), text.replace('version: 1.0.0', 'version: 1.0.1'));
    assertCode(run(root, ['verify']), 0, 'verify decoded boundary');
});

test('bump: переполнение patch/minor/major отвергается без изменения metadata', (t) => {
    const max = Number.MAX_SAFE_INTEGER;
    for (const [level, version] of [['patch', `1.2.${max}`], ['minor', `1.${max}.2`], ['major', `${max}.1.2`]]) {
        const root = fixture(version);
        t.after(() => fs.rmSync(root, {recursive: true, force: true}));
        const src = path.join(root, 'skills', 'skill-a');
        const files = [path.join(src, 'VERSION'), path.join(src, 'SKILL.md'), path.join(root, 'skills', 'manifest.json')];
        const before = files.map((file) => fs.readFileSync(file));
        const r = run(root, ['bump', 'skill-a', level]);
        assertCode(r, 1, 'bump overflow');
        assert.match(r.stderr, /переполнение safe-integer/);
        files.forEach((file, index) => assert.deepStrictEqual(fs.readFileSync(file), before[index]));
        assert.deepStrictEqual(fs.readdirSync(src).sort(), ['SKILL.md', 'VERSION', 'scripts']);
    }
});

test('bump: safe-integer граница разрешена, reset нижних компонентов не переполняется', (t) => {
    const max = Number.MAX_SAFE_INTEGER;
    for (const [level, version, expected] of [
        ['patch', `1.2.${max - 1}`, `1.2.${max}`],
        ['minor', `1.${max - 1}.${max}`, `1.${max}.0`],
        ['major', `${max - 1}.${max}.${max}`, `${max}.0.0`],
    ]) {
        const root = fixture(version);
        t.after(() => fs.rmSync(root, {recursive: true, force: true}));
        const r = run(root, ['bump', 'skill-a', level]);
        assertCode(r, 0, 'bump safe boundary');
        assert.strictEqual(readManifest(root).skills[0].version, expected);
        assert.strictEqual(fs.readFileSync(path.join(root, 'skills', 'skill-a', 'VERSION'), 'utf8'), expected + '\n');
        assertCode(run(root, ['verify']), 0, 'verify boundary');
    }
});

test('bump patch: 1.2.3 → 1.2.4 и манифест обновлён', () => {
    const root = fixture('1.2.3');
    const r = run(root, ['bump', 'skill-a', 'patch']);
    assertCode(r, 0, 'bump patch');
    assert.ok(r.stdout.includes('1.2.3 → 1.2.4'), r.stdout);
    assert.strictEqual(fs.readFileSync(path.join(root, 'skills', 'skill-a', 'VERSION'), 'utf8').trim(), '1.2.4');
    assert.match(fs.readFileSync(path.join(root, 'skills', 'skill-a', 'SKILL.md'), 'utf8'), /^version: 1\.2\.4$/m);
    const entry = readManifest(root).skills.find((s) => s.name === 'skill-a');
    assert.strictEqual(entry.version, '1.2.4');
    assert.notStrictEqual(entry.sha256, null);
    // После bump всё согласовано.
    assertCode(run(root, ['verify']), 0, 'verify после bump');
});

test('bump minor: 1.2.4 → 1.3.0 (patch сброшен)', () => {
    const root = fixture('1.2.4');
    const r = run(root, ['bump', 'skill-a', 'minor']);
    assertCode(r, 0, 'bump minor');
    assert.ok(r.stdout.includes('1.2.4 → 1.3.0'), r.stdout);
    assert.strictEqual(fs.readFileSync(path.join(root, 'skills', 'skill-a', 'VERSION'), 'utf8').trim(), '1.3.0');
});

test('bump major: 1.3.0 → 2.0.0 (minor и patch сброшены)', () => {
    const root = fixture('1.3.0');
    const r = run(root, ['bump', 'skill-a', 'major']);
    assertCode(r, 0, 'bump major');
    assert.ok(r.stdout.includes('1.3.0 → 2.0.0'), r.stdout);
    assert.strictEqual(fs.readFileSync(path.join(root, 'skills', 'skill-a', 'VERSION'), 'utf8').trim(), '2.0.0');
    const entry = readManifest(root).skills.find((s) => s.name === 'skill-a');
    assert.strictEqual(entry.version, '2.0.0');
});
