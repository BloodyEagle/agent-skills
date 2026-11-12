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
