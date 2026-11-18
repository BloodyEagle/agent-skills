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

test('verify: decoded Unicode description 900/901/1024/1025, BOM и CRLF', (t) => {
    const root = fixture();
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    const skillFile = path.join(root, 'skills', 'skill-a', 'SKILL.md');
    for (const char of ['я', '😀']) {
        for (const length of [900, 901, 1024, 1025]) {
            for (const style of ['plain', 'single', 'double', 'literal', 'folded', 'escape']) {
                const text = char.repeat(length);
                const scalar = style === 'plain' ? text : style === 'single' ? "'" + text + "'"
                    : style === 'double' ? '"' + text + '"' : style === 'escape' ? '"' + (char === 'я' ? '\\u044F' : '\\U0001F600').repeat(length) + '"'
                        : (style === 'literal' ? '|-' : '>-') + '\r\n  ' + text;
                fs.writeFileSync(skillFile, '\uFEFF---\r\nname: skill-a\r\ndescription: ' + scalar + '\r\nversion: 1.0.0\r\n---\r\n');
                writeManifest(root);
                const r = run(root, ['verify']);
                assert.strictEqual(r.code, length > 1024 ? 1 : 0, style + ' ' + length + '\n' + r.stderr);
                if (length === 900) assert.doesNotMatch(r.stdout, /Предупреждения:/);
                else if (length <= 1024) assert.match(r.stdout, new RegExp(`description ${length} Unicode code points`));
                else assert.match(r.stderr, /description 1025 Unicode code points > 1024/);
                assert.doesNotMatch(r.stdout + r.stderr, /не загрузят скилл/);
            }
        }
    }
});

test('verify: folding/chomping и escapes учитываются после декодирования', (t) => {
    const root = fixture();
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    const skillFile = path.join(root, 'skills', 'skill-a', 'SKILL.md');
    for (const [scalar, expected, length] of [
        ['|\n  ' + 'я'.repeat(1023), 0, 1024],
        ['|\n  ' + 'я'.repeat(1024), 1, 1025],
        ['|+\n  ' + 'я'.repeat(1023) + '\n', 1, 1025],
        ['>-\n  ' + 'я'.repeat(511) + '\n  ' + 'я'.repeat(512), 0, 1024],
        ['>-\n  ' + 'я'.repeat(511) + '\n\n\n  ' + 'я'.repeat(512), 1, 1025],
        ['"' + 'я'.repeat(1022) + "''" + '"', 0, 1024],
        ["'" + 'я'.repeat(1023) + "''" + "'", 0, 1024],
    ]) {
        fs.writeFileSync(skillFile, '---\nname: skill-a\ndescription: ' + scalar + '\nversion: 1.0.0\n---\n');
        writeManifest(root);
        const r = run(root, ['verify']);
        assert.strictEqual(r.code, expected, r.stderr);
        assert.match(r.stdout + r.stderr, new RegExp(`description ${length} Unicode code points`));
    }
});

test('verify: missing/empty/unsupported description и canonical version диагностируются', (t) => {
    const root = fixture();
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    const skillFile = path.join(root, 'skills', 'skill-a', 'SKILL.md');
    for (const [field, diagnostic] of [
        ['', /нет description/], ['description: ', /description пустое/], ["description: ''", /description пустое/],
        ['description: "   "', /description пустое/], ['description: |\n', /description пустое/],
        ['description: null', /description: неподдерживаемый YAML/], ['description: "\\q"', /description: неподдерживаемый YAML/],
        ['description: >2\n  text', /description: неподдерживаемый YAML/],
        ['description: text\ndescription: other', /description: неподдерживаемый YAML/],
    ]) {
        fs.writeFileSync(skillFile, '---\nname: skill-a\n' + field + '\nversion: 1.0.0\n---\n');
        writeManifest(root);
        const r = run(root, ['verify']);
        assert.strictEqual(r.code, 1, r.stdout);
        assert.match(r.stderr, diagnostic);
    }
    fs.writeFileSync(skillFile, '---\nname: skill-a\ndescription: text\nversion: 01.0.0\n---\n');
    writeManifest(root);
    const r = run(root, ['verify']);
    assert.strictEqual(r.code, 1, r.stdout);
    assert.match(r.stderr, /version: нужна каноническая числовая тройка/);
});

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
