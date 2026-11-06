'use strict';
// verify: расхождения VERSION/version:/манифеста и понятная ошибка без VERSION (кейсы 4, 5, 12 плана).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {tmpRoot, makeSkill, writeManifest, run} = require('./helpers');

function fixture() {
    const root = tmpRoot();
    makeSkill(root, 'skill-a', '1.0.0');
    writeManifest(root);
    return root;
}

test('verify: зелёный на согласованной фикстуре', () => {
    const root = fixture();
    const r = run(root, ['verify']);
    assert.strictEqual(r.code, 0, r.stderr || r.stdout);
    assert.ok(r.stdout.includes('skill-a') || r.stdout.includes('скиллов'), r.stdout);
});

test('verify: падает при расхождении VERSION и version: в SKILL.md', () => {
    const root = fixture();
    fs.writeFileSync(path.join(root, 'skills', 'skill-a', 'VERSION'), '1.2.0\n');
    const r = run(root, ['verify']);
    assert.strictEqual(r.code, 1);
    assert.ok(r.stderr.includes('расходятся'), r.stderr);
    assert.ok(r.stderr.includes('1.2.0'), r.stderr);
});

test('verify: падает при устаревшем хеше в манифесте', () => {
    const root = fixture();
    // Файл правят после манифеста — хеш в манифесте больше не соответствует.
    fs.appendFileSync(path.join(root, 'skills', 'skill-a', 'scripts', 'tool.js'), '// правка\n');
    const r = run(root, ['verify']);
    assert.strictEqual(r.code, 1);
    assert.ok(r.stderr.includes('хеш устарел'), r.stderr);
});

test('verify: нет VERSION — понятная ошибка, а не падение', () => {
    const root = fixture();
    fs.rmSync(path.join(root, 'skills', 'skill-a', 'VERSION'));
    const r = run(root, ['verify']);
    assert.strictEqual(r.code, 1);
    assert.ok(r.stderr.includes('нет файла VERSION'), r.stderr);
});
