const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {project, json} = require('./helpers');

for (const ext of ['js', 'jsx', 'mjs', 'cjs']) {
    test('edit-symbol правит .' + ext + ' без npm пакетов', () => project(root => {
        const file = 'edit.' + ext;
        const dry = json(root, 'edit-symbol', {file, symbol: 'change', body: 'return 2;'});
        assert.equal(dry.ok, true);
        assert.match(fs.readFileSync(path.join(root, file), 'utf8'), /return 1/);
        const written = json(root, 'edit-symbol', {file, symbol: 'change', body: 'return 2;', dry: false});
        assert.equal(written.ok, true);
        assert.match(fs.readFileSync(path.join(root, file), 'utf8'), /return 2/);
    }, {['edit.' + ext]: 'function change() {\n    return 1;\n}\n'}));
}

test('edit-symbol fallback поддерживает стрелку с одним параметром', () => project(root => {
    const result = json(root, 'edit-symbol', {file: 'arrow.js', symbol: 'change', body: 'return x + 1;', dry: false});
    assert.equal(result.ok, true);
    assert.match(fs.readFileSync(path.join(root, 'arrow.js'), 'utf8'), /return x \+ 1/);
}, {'arrow.js': 'const change = x => {\n    return x;\n};'}));

test('edit-symbol JSX не считает текст разметки скобками JS', () => project(root => {
    const result = json(root, 'edit-symbol', {file: 'view.jsx', symbol: 'View', body: 'return <div>{value}</div>;', dry: false});
    assert.equal(result.ok, true);
}, {'view.jsx': 'function View() {\n    return <div>don\'t count } as a brace</div>;\n}'}));

test('SKILL.md содержит JS и ограничение Angular', () => {
    const skill = fs.readFileSync(path.resolve(__dirname, '..', '..', 'skills', 'token-economy-ts', 'SKILL.md'), 'utf8');
    assert.match(skill, /\.js/);
    assert.match(skill, /Angular-команды.*неприменимы/);
    assert.match(skill, /module\.exports/);
});

test('инструкции MegaMemory различают квалификацию и актуальную навигацию', () => {
    const root = path.resolve(__dirname, '..', '..');
    const rules = fs.readFileSync(path.join(root, 'rules/RULES.md'), 'utf8');
    for (const pattern of [/короткого релевантного запроса/, /недоступной памяти/, /stale\/refuted\/unknown\/incomplete/, /must_read/, /skip.*не отменяет/, /brief без утверждения/, /актуальную публичную MCP-схему/, /evidence и версиями/]) assert.match(rules, pattern);
    for (const skill of ['ts', 'py', 'har']) {
        const doc = fs.readFileSync(path.join(root, 'skills/token-economy-' + skill, 'SKILL.md'), 'utf8');
        assert.match(doc, /rules\/RULES\.md/);
        assert.match(doc, /Cwd/);
    }
});

test('TS/PY/HAR docs сохраняют раздельные CLI и реальные negative/truncation форматы', () => {
    const root = path.resolve(__dirname, '..', '..', 'skills');
    const ts = fs.readFileSync(path.join(root, 'token-economy-ts/SKILL.md'), 'utf8');
    const py = fs.readFileSync(path.join(root, 'token-economy-py/SKILL.md'), 'utf8');
    const har = fs.readFileSync(path.join(root, 'token-economy-har/SKILL.md'), 'utf8');
    assert.match(ts, /count > matches\.length/);
    assert.match(ts, /completeness/);
    assert.match(ts, /два endpoint/);
    assert.match(py, /python -I/);
    assert.match(py, /показано K/);
    assert.match(py, /exit1.*argparse.*exit2/);
    assert.match(har, /total:0.*exit1/);
    assert.match(har, /error exit2/);
});

test('README явно описывает JavaScript', () => {
    const readme = fs.readFileSync(path.resolve(__dirname, '..', '..', 'README.md'), 'utf8');
    assert.match(readme, /JavaScript/);
    assert.match(readme, /React, Node\.js, Express/);
});
