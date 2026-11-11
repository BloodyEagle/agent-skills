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
