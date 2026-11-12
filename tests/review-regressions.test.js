'use strict';
// Подтверждённые замечания независимого ревью исправлений CLI.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {tmpRoot, makeSkill, writeManifest, readManifest, run, assertCode} = require('./helpers');

function fixture(t) {
    const root = tmpRoot();
    const src = makeSkill(root, 'demo');
    writeManifest(root);
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    return {root, src};
}

function linkDir(t, target, link) {
    try {
        fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
        return true;
    } catch (e) {
        if (!['EPERM', 'EACCES', 'ENOSYS'].includes(e.code)) throw e;
        t.skip('Создание ссылок недоступно: ' + e.code);
        return false;
    }
}

test('review: источник со ссылкой внутри не проходит hash/verify', (t) => {
    const {root, src} = fixture(t);
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'index.js'), 'module.exports = "external";\n');
    if (!linkDir(t, outside, path.join(src, 'scripts', 'plugin'))) return;
    for (const args of [['hash', 'demo'], ['verify'], ['manifest']]) {
        const r = run(root, args);
        assert.equal(r.code, 1, args.join(' ') + '\n' + r.stdout);
        assert.match(r.stderr, /ссылк/i);
    }
});

test('review: новая внутренняя junction меняет статус установленного скилла', (t) => {
    const {root} = fixture(t);
    const inst = path.join(root, 'installed');
    assertCode(run(root, ['install', 'demo', '--to', inst]), 0, 'install');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'index.js'), 'module.exports = "external";\n');
    if (!linkDir(t, outside, path.join(inst, 'demo', 'scripts', 'plugin'))) return;
    const r = run(root, ['check', '--dir', inst, '--json']);
    assertCode(r, 0, 'check');
    assert.equal(JSON.parse(r.stdout)[0].status, 'неизвестно (небезопасный каталог установки)');
});

test('review: manifest восстанавливает повреждённые прежние метаданные', (t) => {
    const {root} = fixture(t);
    const file = path.join(root, 'skills', 'manifest.json');
    const initial = readManifest(root);
    for (const text of ['{broken', JSON.stringify({...initial, skills: [{...initial.skills[0], sha256: 'broken'}]})]) {
        fs.writeFileSync(file, text);
        assertCode(run(root, ['manifest']), 0, 'manifest repair');
        assertCode(run(root, ['verify']), 0, 'verify repaired');
    }
});

test('review: manifest пропускает каталоги без SKILL.md до проверки имени', (t) => {
    const {root} = fixture(t);
    fs.mkdirSync(path.join(root, 'skills', '__pycache__'));
    fs.writeFileSync(path.join(root, 'skills', '__pycache__', 'tool.pyc'), 'bytecode');
    fs.mkdirSync(path.join(root, 'skills', 'Draft Notes'));
    assertCode(run(root, ['manifest']), 0, 'manifest');
    assert.deepEqual(readManifest(root).skills.map((s) => s.name), ['demo']);
    assertCode(run(root, ['verify']), 0, 'verify');
});
