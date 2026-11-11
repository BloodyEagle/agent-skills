const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const {project, json} = require('./helpers');
const {SOURCE_EXT, IGNORED_DIRS, walk, isReact, parseReactMajor, REACT_ERROR} = require('../../skills/token-economy-ts/scripts/lib/files');

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

for (const ext of SOURCE_EXT) {
    test('audit: Windows учитывает расширение ' + ext.toUpperCase(), {skip: process.platform !== 'win32'}, () => project(root => {
        const file = 'upper' + ext.toUpperCase();
        assert.ok(walk(root).some(item => path.basename(item) === file));
        assert.deepEqual(found(json(root, 'code-searcher', {query: 'upperMarker'})), [file]);
        assert.equal(json(root, 'symbol-index', {file}).count, 1);
        assert.equal(json(root, 'graph-tool', {op: 'symbol', name: 'upperMarker', root: '.'}).definedIn.length, 1);
    }, {['upper' + ext.toUpperCase()]: 'export function upperMarker() {}'}, {empty: true}));
}

test('audit: Windows исключает каталоги зависимостей без учёта регистра', {skip: process.platform !== 'win32'}, () => project(root => {
    assert.deepEqual(walk(root), [path.join(root, 'visible.ts')]);
    assert.equal(json(root, 'code-searcher', {query: 'hiddenMarker'}).count, 0);
    assert.deepEqual(json(root, 'graph-tool', {op: 'symbol', name: 'hiddenMarker', root: '.'}).definedIn, []);
}, {...Object.fromEntries(IGNORED_DIRS.map(dir => [dir.toUpperCase() + '/hidden.ts', 'export class hiddenMarker {}'])),
    'visible.ts': 'export const visible = 1;'}, {empty: true}));

test('audit: Windows resolver сопоставляет регистр имени и расширения', {skip: process.platform !== 'win32'}, () => project(root => {
    const result = json(root, 'graph-tool', {op: 'deps', file: 'a.ts', root: '.'});
    assert.deepEqual(result.imports.map(item => item.file), ['Upper.TS']);
    assert.equal(result.unresolved, 0);
}, {'a.ts': 'import "./upper.ts";', 'Upper.TS': 'export class Visible {}'}, {empty: true}));

test('audit: search не обрывает surrogate pair на границе snippet', () => project(root => {
    const result = json(root, 'code-searcher', {query: 'needle'});
    assert.equal(result.count, 1);
    const text = result.matches[0].text;
    assert.ok(![...text].some(char => char.length === 1 && /[\uD800-\uDFFF]/.test(char)), JSON.stringify(text));
    assert.ok([...text].length <= 100);
    assert.ok(text.startsWith('needle '));
}, {'unicode.js': 'needle ' + 'x'.repeat(92) + '😀end'}, {empty: true}));

test('parseReactMajor извлекает major из спецификаторов package.json', () => {
    assert.equal(parseReactMajor('16.8.0'), 16);
    assert.equal(parseReactMajor('^16.0.0'), 16);
    assert.equal(parseReactMajor('~17.2.1'), 17);
    assert.equal(parseReactMajor('>=16'), 16);
    assert.equal(parseReactMajor('18.x'), 18);
    assert.equal(parseReactMajor('19.0.0-rc.1'), 19);
    assert.equal(parseReactMajor('npm:react@18.3.1'), 18);
    assert.equal(parseReactMajor('15.6.2'), 15);
});

test('parseReactMajor: нераспознаваемые версии дают null', () => {
    for (const spec of ['latest', 'next', '*', 'workspace:*']) assert.equal(parseReactMajor(spec), null, spec);
    assert.equal(parseReactMajor(null), null);
    assert.equal(parseReactMajor(42), null);
});

test('isReact: react 16+ в любой секции package.json', () => {
    const pkg = dependencies => JSON.stringify({dependencies});
    project(root => assert.equal(isReact(root), true, 'dependencies'), {['package.json']: pkg({react: '^17.0.0'})}, {empty: true});
    project(root => assert.equal(isReact(root), true, 'devDependencies'),
        {['package.json']: JSON.stringify({devDependencies: {react: '18.3.1'}})}, {empty: true});
    project(root => assert.equal(isReact(root), true, 'peerDependencies'),
        {['package.json']: JSON.stringify({peerDependencies: {react: '16.8.0'}})}, {empty: true});
    project(root => assert.equal(isReact(root), true, 'optionalDependencies'),
        {['package.json']: JSON.stringify({optionalDependencies: {react: '19.0.0'}})}, {empty: true});
});

test('isReact: react < 16 и отсутствие react дают false', () => {
    const pkg = content => ({['package.json']: content});
    project(root => assert.equal(isReact(root), false, 'react 15'),
        pkg(JSON.stringify({dependencies: {react: '15.6.2'}})), {empty: true});
    project(root => assert.equal(isReact(root), false, 'react-dom без react'),
        pkg(JSON.stringify({dependencies: {'react-dom': '^18.0.0'}})), {empty: true});
    project(root => assert.equal(isReact(root), false, 'нет package.json'), {}, {empty: true});
    project(root => assert.equal(isReact(root), false, 'битый package.json'), pkg('{oops'), {empty: true});
});
