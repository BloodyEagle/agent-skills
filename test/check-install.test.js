'use strict';
// check и install: статусы, --json, .installed.json (кейсы 9–11 плана).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {tmpRoot, makeSkill, writeManifest, readManifest, writeManifestObj, run, assertCode} = require('./helpers');

// Фикстура на четыре статуса: актуально, устарело, изменён локально, не установлен.
function fixtureWithInstallations() {
    const root = tmpRoot();
    for (const name of ['skill-current', 'skill-outdated', 'skill-modified', 'skill-absent']) {
        makeSkill(root, name, '1.0.0');
    }
    writeManifest(root);
    const inst = tmpRoot();
    for (const name of ['skill-current', 'skill-outdated', 'skill-modified']) {
        assertCode(run(root, ['install', name, '--to', inst]), 0, 'install ' + name);
    }
    // устарело: в манифесте версия выше установленной
    const manifest = readManifest(root);
    manifest.skills.find((s) => s.name === 'skill-outdated').version = '2.0.0';
    writeManifestObj(root, manifest);
    // изменён локально: правка файла в установленной копии
    fs.appendFileSync(path.join(inst, 'skill-modified', 'scripts', 'tool.js'), '// локальная правка\n');
    return {root, inst};
}

test('check: четыре статуса на подготовленных каталогах', () => {
    const {root, inst} = fixtureWithInstallations();
    const rows = JSON.parse(run(root, ['check', '--dir', inst, '--json']).stdout);
    const byName = Object.fromEntries(rows.map((r) => [r.name, r.status]));
    assert.strictEqual(byName['skill-current'], 'актуально');
    assert.strictEqual(byName['skill-outdated'], 'устарело (1.0.0 → 2.0.0)');
    assert.strictEqual(byName['skill-modified'], 'изменён локально');
    assert.strictEqual(byName['skill-absent'], 'не установлен');
});

test('check: текстовая таблица содержит те же статусы', () => {
    const {root, inst} = fixtureWithInstallations();
    const r = run(root, ['check', '--dir', inst]);
    assertCode(r, 0, 'check');
    for (const s of ['актуально', 'устарело (1.0.0 → 2.0.0)', 'изменён локально', 'не установлен']) {
        assert.ok(r.stdout.includes(s), `нет статуса «${s}» в таблице:\n${r.stdout}`);
    }
});

test('check --json: валидный JSON с полями name/status', () => {
    const {root, inst} = fixtureWithInstallations();
    const r = run(root, ['check', '--dir', inst, '--json']);
    assertCode(r, 0, 'check --json');
    const rows = JSON.parse(r.stdout); // бросит, если не JSON
    assert.ok(Array.isArray(rows) && rows.length === 4);
    for (const row of rows) {
        assert.ok(typeof row.name === 'string' && typeof row.status === 'string');
    }
});

test('install: пишет .installed.json с версией и хешем; повторный check — актуально', () => {
    const root = tmpRoot();
    makeSkill(root, 'skill-a', '1.2.0');
    writeManifest(root);
    const inst = tmpRoot();
    const r = run(root, ['install', 'skill-a', '--to', inst]);
    assertCode(r, 0, 'install');
    const meta = JSON.parse(fs.readFileSync(path.join(inst, 'skill-a', '.installed.json'), 'utf8'));
    assert.strictEqual(meta.name, 'skill-a');
    assert.strictEqual(meta.version, '1.2.0');
    assert.match(meta.hash, /^[0-9a-f]{64}$/);
    assert.ok(meta.date && meta.commit !== undefined);
    const rows = JSON.parse(run(root, ['check', '--dir', inst, '--json']).stdout);
    assert.deepStrictEqual(rows, [{name: 'skill-a', installed: '1.2.0', manifest: '1.2.0', status: 'актуально'}]);
});
