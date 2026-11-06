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

test('README явно описывает JavaScript', () => {
    const readme = fs.readFileSync(path.resolve(__dirname, '..', '..', 'README.md'), 'utf8');
    assert.match(readme, /JavaScript/);
    assert.match(readme, /React, Node\.js, Express/);
});
