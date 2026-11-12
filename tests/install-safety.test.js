'use strict';
// Регрессии аудита: установка не выходит за назначение и не оставляет старые файлы.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {tmpRoot, makeSkill, writeManifest, run, assertCode} = require('./helpers');

const cli = path.join(__dirname, '..', 'skills.js');

function fixture(t) {
    const root = tmpRoot();
    const inst = path.join(root, 'installed');
    const src = makeSkill(root, 'demo');
    writeManifest(root);
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    return {root, inst, src};
}

function linkDir(t, target, link) {
    try {
        fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (e) {
        if (!['EPERM', 'EACCES', 'ENOSYS'].includes(e.code)) throw e;
        t.skip('Создание ссылок недоступно: ' + e.code);
        return false;
    }
    return true;
}

test('install: повторная установка удаляет исчезнувшие файлы источника', (t) => {
    const {root, inst, src} = fixture(t);
    const obsolete = path.join(src, 'scripts', 'obsolete.js');
    fs.writeFileSync(obsolete, '// obsolete\n');
    assertCode(run(root, ['install', 'demo', '--to', inst]), 0, 'install');
    fs.rmSync(obsolete);
    writeManifest(root);
    assertCode(run(root, ['install', 'demo', '--to', inst]), 0, 'reinstall');
    assert.equal(fs.existsSync(path.join(inst, 'demo', 'scripts', 'obsolete.js')), false);
    const rows = JSON.parse(run(root, ['check', '--dir', inst, '--json']).stdout);
    assert.equal(rows[0].status, 'актуально');
});

test('hash/bump/install: имя не может содержать обход каталога', (t) => {
    const {root, inst, src} = fixture(t);
    const before = fs.readFileSync(path.join(src, 'VERSION'), 'utf8');
    for (const name of ['../skills/demo', '..\\skills\\demo', '.', '..', 'demo/child']) {
        for (const args of [['hash', name], ['bump', name, 'patch'], ['install', name, '--to', inst]]) {
            const r = run(root, args);
            assert.equal(r.code, 1, args.join(' ') + '\n' + r.stdout);
            assert.match(r.stderr, /недопустимое имя скилла/i);
        }
    }
    assert.equal(fs.readFileSync(path.join(src, 'VERSION'), 'utf8'), before);
    assert.equal(fs.existsSync(inst), false);
});

test('install: junction назначения не позволяет перезаписать соседний каталог', (t) => {
    const {root, inst} = fixture(t);
    const outside = path.join(root, 'outside');
    fs.mkdirSync(path.join(outside, 'scripts'), {recursive: true});
    fs.mkdirSync(inst);
    const sentinel = path.join(outside, 'scripts', 'tool.js');
    fs.writeFileSync(sentinel, '// сохранить\n');
    if (!linkDir(t, outside, path.join(inst, 'demo'))) return;
    const r = run(root, ['install', 'demo', '--to', inst]);
    assert.equal(r.code, 1, r.stdout);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), '// сохранить\n');
    assert.equal(fs.existsSync(path.join(outside, '.installed.json')), false);
});

test('hash/bump/install: исходный скилл не может быть внешней junction', (t) => {
    const {root, inst, src} = fixture(t);
    const moved = path.join(root, 'outside-demo');
    fs.renameSync(src, moved);
    if (!linkDir(t, moved, src)) return;
    for (const args of [['hash', 'demo'], ['bump', 'demo', 'patch'], ['install', 'demo', '--to', inst]]) {
        const r = run(root, args);
        assert.equal(r.code, 1, args.join(' ') + '\n' + r.stdout);
    }
    assert.equal(fs.readFileSync(path.join(moved, 'VERSION'), 'utf8'), '1.0.0\n');
    assert.equal(fs.existsSync(inst), false);
});

test('install: отказ при пересечении источника и назначения сохраняет источник', (t) => {
    const {root, src} = fixture(t);
    const before = fs.readFileSync(path.join(src, 'scripts', 'tool.js'));
    for (const to of [path.join(root, 'skills'), path.join(src, 'nested')]) {
        const r = run(root, ['install', 'demo', '--to', to]);
        assert.equal(r.code, 1, r.stdout);
        assert.deepEqual(fs.readFileSync(path.join(src, 'scripts', 'tool.js')), before);
    }
    assert.equal(fs.existsSync(path.join(src, 'nested')), false);
});

test('install: ошибка копирования не меняет установленную копию', (t) => {
    const {root, inst} = fixture(t);
    assertCode(run(root, ['install', 'demo', '--to', inst]), 0, 'install');
    const dest = path.join(inst, 'demo');
    const before = fs.readFileSync(path.join(dest, '.installed.json'));
    const hook = path.join(root, 'copy-failure.cjs');
    fs.writeFileSync(hook, `const fs = require('node:fs');
const path = require('node:path');
fs.cpSync = (src, dest) => {
    fs.mkdirSync(dest, {recursive: true});
    fs.writeFileSync(path.join(dest, 'partial.js'), 'partial');
    throw new Error('simulated copy failure');
};
`);
    const r = spawnSync(process.execPath, ['--require', hook, cli, '--root', root, 'install', 'demo', '--to', inst],
        {encoding: 'utf8', timeout: 10000});
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /simulated copy failure/);
    assert.deepEqual(fs.readFileSync(path.join(dest, '.installed.json')), before);
    assert.equal(fs.existsSync(path.join(dest, 'partial.js')), false);
    assert.deepEqual(fs.readdirSync(inst), ['demo']);
});

test('install: без git-репозитория stderr остаётся пустым', (t) => {
    const {root, inst} = fixture(t);
    const r = spawnSync(process.execPath, [cli, '--root', root, 'install', 'demo', '--to', inst],
        {encoding: 'utf8', timeout: 10000});
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
});

test('install: системные кэши и старые метки не копируются', (t) => {
    const {root, inst, src} = fixture(t);
    fs.mkdirSync(path.join(src, 'scripts', '__pycache__'));
    fs.writeFileSync(path.join(src, 'scripts', '__pycache__', 'tool.pyc'), 'bytecode');
    fs.writeFileSync(path.join(src, '.DS_Store'), 'desktop');
    fs.writeFileSync(path.join(src, '.installed.json'), '{"foreign":true}');
    assertCode(run(root, ['install', 'demo', '--to', inst]), 0, 'install');
    assert.equal(fs.existsSync(path.join(inst, 'demo', 'scripts', '__pycache__')), false);
    assert.equal(fs.existsSync(path.join(inst, 'demo', '.DS_Store')), false);
    const meta = JSON.parse(fs.readFileSync(path.join(inst, 'demo', '.installed.json'), 'utf8'));
    assert.equal(meta.foreign, undefined);
});
