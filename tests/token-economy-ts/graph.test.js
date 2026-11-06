const test = require('node:test');
const assert = require('node:assert/strict');
const {project, json} = require('./helpers');

const paths = list => list.map(item => item.file.replace(/\\/g, '/'));
const deps = (root, file) => json(root, 'graph-tool', {op: 'deps', file, root: '.', why: true});

test('require связывает JS-файлы и показывает строку связи', () => project(root => {
    const result = deps(root, 'app.js');
    assert.ok(paths(result.imports).includes('lib/util.js'));
    assert.match(result.imports.find(item => item.file.replace(/\\/g, '/') === 'lib/util.js').via, /^L[1-9]\d*$/);
}));

test('динамический import резолвится к mjs', () => project(root => {
    assert.ok(paths(deps(root, 'app.js').imports).includes('lazy.mjs'));
}));

test('папка резолвится в index.js', () => project(root => {
    assert.ok(paths(deps(root, 'app.js').imports).includes('lib/index.js'));
}));

test('смешанный TS/JS-проект даёт единый граф', () => project(root => {
    assert.ok(paths(deps(root, 'app.js').imports).includes('typed.ts'));
    const result = json(root, 'graph-tool', {op: 'stats', root: '.'});
    assert.ok(result.files >= 8);
}));

test('локальный неразрешённый путь считается отдельно от external', () => project(root => {
    const result = deps(root, 'app.js');
    assert.equal(result.unresolved, 1);
    assert.ok(result.external.includes('express'));
    assert.equal(json(root, 'graph-tool', {op: 'stats', root: '.'}).unresolved, 1);
}));

test('CommonJS реэкспорт и rdeps видят legacy.cjs', () => project(root => {
    assert.ok(paths(deps(root, 'legacy.cjs').imports).includes('lib/util.js'));
    const result = json(root, 'graph-tool', {op: 'rdeps', file: 'lib/util.js', root: '.'});
    assert.ok(paths(result.importedBy).includes('legacy.cjs'));
}));

test('side-effect import и export from учитываются', () => project(root => {
    assert.ok(paths(deps(root, 'app.js').imports).includes('setup.js'));
    assert.ok(paths(deps(root, 'lib/index.js').imports).includes('lib/util.js'));
}));

test('symbol в JS находит стрелку и класс', () => project(root => {
    const load = json(root, 'graph-tool', {op: 'symbol', name: 'load', root: '.'});
    assert.ok(load.definedIn.some(item => item.file === 'app.js' && item.kind === 'function'));
    const counter = json(root, 'graph-tool', {op: 'symbol', name: 'Counter', root: '.'});
    assert.ok(counter.definedIn.some(item => item.kind === 'class'));
}));

test('graph исключает JS тесты, specs=true включает', () => project(root => {
    const without = json(root, 'graph-tool', {op: 'symbol', name: 'testOnly', root: '.'});
    assert.equal(without.definedIn.length, 0);
    const withTests = json(root, 'graph-tool', {op: 'symbol', name: 'testOnly', root: '.', specs: true});
    assert.equal(withTests.definedIn.length, 1);
}, {'special.test.js': 'function testOnly() {}'}));

test('комментарии и строки не создают ложные связи', () => project(root => {
    const result = deps(root, 'masked.js');
    assert.equal(result.unresolved, 0);
    assert.equal(result.imports.length, 0);
}, {'masked.js': '// require("./ghost")\nconst text = "require(\'./phantom\')";\n/* import "./absent"; */'}));

test('JS-first резолв не ломает TS-first для TS импортёров', () => project(root => {
    assert.deepEqual(paths(deps(root, 'js-entry.js').imports), ['shared.js']);
    assert.deepEqual(paths(deps(root, 'ts-entry.ts').imports), ['shared.ts']);
}, {'js-entry.js': 'import "./shared";', 'ts-entry.ts': 'import "./shared";', 'shared.js': 'export const value = 1;', 'shared.ts': 'export const value: number = 2;'}));
