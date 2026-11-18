const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {project, cli, json} = require('./helpers');
const {REACT_ERROR} = require('../../skills/token-economy-ts/scripts/lib/files');

const REACT_PKG = JSON.stringify({dependencies: {react: '^17.0.2', 'react-dom': '^17.0.2'}});

const reactFiles = {
    'package.json': REACT_PKG,
    'src/UserCard.tsx': 'export function UserCard() {\n    return <section>card</section>;\n}\n',
    'src/App.tsx': "import {UserCard} from './UserCard';\n\nexport default function App() {\n    return (\n        <div>\n            <UserCard id={1} />\n            <UserCard id={2} />\n        </div>\n    );\n}\n"
};

test('op=component отказывает без react с кодом 1 и не строит граф', () => project(root => {
    const result = cli(root, 'graph-tool', {op: 'component', name: 'UserCard'});
    assert.equal(result.status, 1);
    assert.equal(result.stdout.trim(), REACT_ERROR);
    assert.equal(fs.existsSync(path.join(root, 'graph-deps.json')), false);
}));

test('react 15 не включает op=component', () => project(root => {
    const result = cli(root, 'graph-tool', {op: 'component', name: 'UserCard'});
    assert.equal(result.status, 1);
    assert.equal(result.stdout.trim(), REACT_ERROR);
}, {'package.json': JSON.stringify({dependencies: {react: '15.6.2'}}), 'src/App.tsx': 'export const x = 1;\n'}, {empty: true}));

test('op=component: definedIn и usedIn по открывающим JSX-тегам', () => project(root => {
    const r = json(root, 'graph-tool', {op: 'component', name: 'UserCard'});
    assert.equal(r.found, true);
    assert.equal(r.definedIn.length, 1);
    const d = r.definedIn[0];
    assert.equal(d.file, 'src/UserCard.tsx');
    assert.equal(d.kind, 'function');
    assert.equal(d.line, 1);
    assert.equal(d.startLine, 1);
    assert.equal(d.endLine, 3);
    assert.equal(r.usedTotal, 2);
    assert.deepEqual(r.usedIn, [{file: 'src/App.tsx', line: 6}, {file: 'src/App.tsx', line: 7}]);
    assert.equal(r.scope.scanRoot, 'src');
    assert.equal(r.completeness.complete, true);
}, reactFiles, {empty: true}));

test('audit: <UserCard в строке и комментарии не индексируются (маска кода)', () => project(root => {
    const r = json(root, 'graph-tool', {op: 'component', name: 'Ghost'});
    assert.equal(r.found, true);
    assert.deepEqual(r.definedIn, []);
    assert.equal(r.usedTotal, 1);
    assert.deepEqual(r.usedIn, [{file: 'src/real.tsx', line: 4}]);
}, {
    'package.json': REACT_PKG,
    'src/masked.tsx': "export const tip = '<Ghost />';\n// <Ghost /> в комментарии\n/* <Ghost */\n",
    'src/real.tsx': "import {Ghost} from './masked';\n\nexport function Real() {\n    return <Ghost />;\n}\n"
}, {empty: true}));

test('component: .ts assertions/generics не являются JSX, TSX/JSX/JS tags сохраняются', () => project(root => {
    const ghost = json(root, 'graph-tool', {op: 'component', name: 'Ghost'});
    assert.deepEqual(ghost.usedIn, [
        {file: 'src/legacy.cjs', line: 1},
        {file: 'src/legacy.js', line: 1},
        {file: 'src/legacy.mjs', line: 1},
        {file: 'src/real.jsx', line: 1},
        {file: 'src/real.tsx', line: 1},
        {file: 'src/template.tsx', line: 2}
    ]);
    assert.equal(ghost.usedTotal, 6);
    for (const name of ['AssertOnly', 'GenericOnly']) {
        const result = json(root, 'graph-tool', {op: 'component', name});
        assert.equal(result.found, false);
        assert.equal(result.usedTotal, 0);
        assert.deepEqual(result.usedIn, []);
    }
}, {
    'package.json': REACT_PKG,
    'src/assert.ts': 'const x = <Ghost>value;\nconst y = <AssertOnly>value;\nconst f = <GenericOnly extends object>(value: GenericOnly) => value;\n',
    'src/legacy.js': 'export const view = <Ghost />;\n',
    'src/legacy.mjs': 'export const view = <Ghost />;\n',
    'src/legacy.cjs': 'const view = <Ghost />;\n',
    'src/real.jsx': 'export const view = <Ghost />;\n',
    'src/real.tsx': 'export const view = <Ghost />;\n',
    'src/template.tsx': 'const text = `<Ghost />`;\nconst expr = `${<Ghost />}`;\n// <Ghost />\n/* <Ghost /> */\nconst id = <T,>(x: T) => x;\n'
}, {empty: true}));

test('component: legacy v10 jsxUsages из .ts инвалидируется без изменения mtime/size', () => project(root => {
    const source = path.join(root, 'src/assert.ts');
    const stat = fs.statSync(source);
    const legacy = {__v: 10, 'src/assert.ts': {mtime: stat.mtimeMs, size: stat.size, data: {
        entities: [], exports: [], specifiers: [], reexportAll: false, loc: 2,
        jsxUsages: [{name: 'Ghost', line: 1}]
    }}};
    fs.writeFileSync(path.join(root, '.graph-deps-cache.json'), JSON.stringify(legacy));
    const result = json(root, 'graph-tool', {op: 'component', name: 'Ghost'});
    assert.equal(result.found, false);
    assert.equal(result.usedTotal, 0);
    assert.deepEqual(result.usedIn, []);
    assert.equal(fs.statSync(source).mtimeMs, stat.mtimeMs);
    assert.equal(fs.statSync(source).size, stat.size);
}, {'package.json': REACT_PKG, 'src/assert.ts': 'const value = <Ghost>input;\n'}, {empty: true}));

test('использование в собственном файле попадает в usedIn', () => project(root => {
    const r = json(root, 'graph-tool', {op: 'component', name: 'Row'});
    assert.equal(r.definedIn.length, 1);
    assert.equal(r.definedIn[0].file, 'src/list.tsx');
    assert.equal(r.usedTotal, 1);
    assert.deepEqual(r.usedIn, [{file: 'src/list.tsx', line: 6}]);
}, {
    'package.json': REACT_PKG,
    'src/list.tsx': 'export function Row() {\n    return <li>x</li>;\n}\n\nexport function List() {\n    return <ul><Row /></ul>;\n}\n'
}, {empty: true}));

test('op=component без имени — ошибка запроса с кодом 1', () => project(root => {
    const result = cli(root, 'graph-tool', {op: 'component'});
    assert.equal(result.status, 1);
    assert.ok(JSON.parse(result.stdout).error);
}, {'package.json': REACT_PKG, 'src/App.tsx': 'export const x = 1;\n'}, {empty: true}));

test('незнакомое имя — found:false, пустые списки, exit 0', () => project(root => {
    const r = json(root, 'graph-tool', {op: 'component', name: 'Missing'});
    assert.equal(r.found, false);
    assert.deepEqual(r.definedIn, []);
    assert.deepEqual(r.usedIn, []);
    assert.equal(r.usedTotal, 0);
}, reactFiles, {empty: true}));

test('batch: op=component исполняется вместе с другими запросами', () => project(root => {
    const r = json(root, 'graph-tool', {requests: JSON.stringify([
        {op: 'component', name: 'UserCard'},
        {op: 'component'},
        {op: 'symbol', name: 'UserCard'}
    ])});
    assert.equal(r.batch, true);
    assert.equal(r.total, 3);
    assert.equal(r.failed, 1);
    assert.equal(r.results[0].usedTotal, 2);
    assert.ok(r.results[1].error);
    assert.equal(r.results[2].definedIn.length, 1);
}, reactFiles, {empty: true}));

test('compact=1: пути usedIn/definedIn индексируются словарём paths', () => project(root => {
    const r = json(root, 'graph-tool', {compact: '1', requests: JSON.stringify([
        {op: 'component', name: 'UserCard'}
    ])});
    const res = r.results[0];
    assert.ok(Array.isArray(r.paths));
    assert.equal(typeof res.usedIn[0].file, 'number');
    assert.equal(typeof res.definedIn[0].file, 'number');
    assert.equal(r.paths[res.usedIn[0].file], 'src/App.tsx');
    assert.equal(r.paths[res.definedIn[0].file], 'src/UserCard.tsx');
}, reactFiles, {empty: true}));
