const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const {project, json} = require('./helpers');
const {SOURCE_EXT, IGNORED_DIRS, walk} = require('../../skills/token-economy-ts/scripts/lib/files');

const found = result => result.matches.map(m => m.file.replace(/\\/g, '/'));

test('search находит JavaScript без ext и src', () => project(root => {
    assert.ok(found(json(root, 'code-searcher', {query: 'router'})).includes('app.js'));
}));

test('search исключает зависимости и каталоги сборки', () => {
    const files = Object.fromEntries(IGNORED_DIRS.map(dir => [dir + '/hidden.js', 'const hiddenNeedle = 1;']));
    project(root => assert.equal(json(root, 'code-searcher', {query: 'hiddenNeedle'}).count, 0), files);
});

test('явный ext=.js заменяет дефолт', () => project(root => {
    const result = json(root, 'code-searcher', {query: 'export', ext: '.js'});
    assert.ok(result.count > 0);
    assert.ok(found(result).every(file => file.endsWith('.js')));
}));

test('TSX и JSX одинаково участвуют в поиске', () => project(root => {
    const files = found(json(root, 'code-searcher', {query: 'sameMarker'}));
    assert.deepEqual(files.sort(), ['one.tsx', 'two.jsx']);
}, {'one.tsx': 'export const sameMarker = <span />;', 'two.jsx': 'export const sameMarker = <span />;'}));

test('walk покрывает шесть расширений', () => project(root => {
    const files = walk(root).map(file => path.extname(file));
    for (const ext of SOURCE_EXT) assert.ok(files.includes(ext), ext);
}, {'extra.tsx': 'export const node = <div />;'}));

test('walk поддерживает фильтр ext и отсутствующий каталог', () => project(root => {
    assert.ok(walk(root, {ext: ['.cjs']}).every(file => file.endsWith('.cjs')));
    assert.deepEqual(walk(path.join(root, 'absent')), []);
}));

test('search сохраняет явный поиск HTML', () => project(root => {
    assert.equal(json(root, 'code-searcher', {query: 'htmlMarker', ext: '.html'}).count, 1);
}, {'page.html': '<div>htmlMarker</div>'}));
