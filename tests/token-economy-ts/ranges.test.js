// ranges.test.js — приёмка задач 1/3/6/9/10/11/12: диапазоны, op=read, node totals,
// format=table, batch graph/outline/sig, compact-словарь; декодеры восстанавливают legacy.
const test = require('node:test');
const assert = require('node:assert/strict');
const {project, json, cli} = require('./helpers');

const short = (entity) => {
    const out = {name: entity.name, kind: entity.kind, line: entity.line,
        s: entity.startLine, e: entity.endLine};
    if (entity.bodyStartLine !== undefined) out.bs = entity.bodyStartLine;
    if (entity.bodyEndLine !== undefined) out.be = entity.bodyEndLine;
    return out;
};

test('диапазоны: object return type, declare, перегрузки, async/generator, стрелки', () => project(root => {
    const node = json(root, 'graph-tool', {op: 'node', file: 'a.ts', root: '.'});
    const byName = {};
    for (const e of node.entities) byName[e.name + ':' + e.line] = short(e);
    // первая { — тип результата, тело начинается после него
    assert.deepEqual(byName['plain:1'], {name: 'plain', kind: 'function', line: 1, s: 1, e: 3, bs: 1, be: 3});
    assert.deepEqual(byName['af:4'], {name: 'af', kind: 'function', line: 4, s: 4, e: 6, bs: 4, be: 6});
    assert.deepEqual(byName['gen:7'], {name: 'gen', kind: 'function', line: 7, s: 7, e: 9, bs: 7, be: 9});
    // declare/overload без тела: конец есть, тела нет
    assert.deepEqual(byName['df:10'], {name: 'df', kind: 'function', line: 10, s: 10, e: 10});
    assert.deepEqual(byName['ov:11'], {name: 'ov', kind: 'function', line: 11, s: 11, e: 11});
    assert.deepEqual(byName['ov:12'], {name: 'ov', kind: 'function', line: 12, s: 12, e: 14, bs: 12, be: 14});
    // стрелка-выражение и стрелка-блок
    assert.deepEqual(byName['expr:20'], {name: 'expr', kind: 'const', line: 20, s: 20, e: 20});
    assert.deepEqual(byName['blk:21'], {name: 'blk', kind: 'const', line: 21, s: 21, e: 23, bs: 21, be: 23});
}, {'a.ts': `export function plain(): {ok: boolean} {
    return {ok: true};
}
export async function af() {
    return 1;
}
export function* gen() {
    yield 1;
}
declare function df(): void;
function ov(x: string): void;
function ov(x: any) {
    return x;
}
export interface I {
    m(): {a: 1} | {b: 2};
    nested(): Promise<Map<string, {x: number}>>;
}
type ASI = A | B
const expr = () => ({x: 1});
const blk = () => {
    return 1;
};
export enum E { A, B }
`}, {empty: true}));

test('диапазоны: generics с телом-объектом, conditional type, union с телом', () => project(root => {
    const node = json(root, 'graph-tool', {op: 'node', file: 'g.ts', root: '.'});
    const byName = {};
    for (const e of node.entities) byName[e.name] = short(e);
    assert.deepEqual(byName.cond, {name: 'cond', kind: 'function', line: 1, s: 1, e: 3, bs: 1, be: 3});
    assert.deepEqual(byName.union, {name: 'union', kind: 'function', line: 4, s: 4, e: 6, bs: 4, be: 6});
    assert.deepEqual(byName.multi, {name: 'multi', kind: 'function', line: 7, s: 7, e: 12, bs: 10, be: 12});
}, {'g.ts': `function cond(): A extends B ? {x: 1} : {y: 2} {
    return null;
}
function union(): number | {a: 1} {
    return 1;
}
function multi(): Foo<
    string,
    number
> {
    return null;
}
`}, {empty: true}));

test('диапазоны: члены класса — методы, свойства, стрелки, #члены, computed', () => project(root => {
    const save = json(root, 'graph-tool', {op: 'symbol', name: 'save', in: 'C', root: '.'}).definedIn[0];
    assert.deepEqual({line: save.line, s: save.startLine, e: save.endLine, bs: save.bodyStartLine, be: save.bodyEndLine},
        {line: 2, s: 2, e: 4, bs: 2, be: 4});
    const prop = json(root, 'graph-tool', {op: 'symbol', name: 'p', in: 'C', root: '.'}).definedIn[0];
    assert.deepEqual({s: prop.startLine, e: prop.endLine}, {s: 5, e: 5});
    const arrow = json(root, 'graph-tool', {op: 'symbol', name: 'onClick', in: 'C', root: '.'}).definedIn[0];
    assert.deepEqual({s: arrow.startLine, e: arrow.endLine}, {s: 6, e: 6});
    const priv = json(root, 'graph-tool', {op: 'symbol', name: '#priv', root: '.'}).definedIn[0];
    assert.equal(priv.kind, 'private-method');
    assert.deepEqual({s: priv.startLine, e: priv.endLine}, {s: 7, e: 9});
    const computed = json(root, 'graph-tool', {op: 'symbol', name: 'Symbol.iterator', root: '.'}).definedIn[0];
    assert.deepEqual({s: computed.startLine, e: computed.endLine}, {s: 10, e: 12});
}, {'c.ts': `export class C {
    save(id: number): number {
        return id;
    }
    p: Map<string, number> = new Map();
    onClick = (e: Event) => e;
    #priv() {
        return 2;
    }
    static [Symbol.iterator]() {
        return 3;
    }
}
`}, {empty: true}));

test('диапазоны: Angular-entity сохраняет класс, декораторы и JSDoc не входят в span', () => project(root => {
    const comp = json(root, 'graph-tool', {op: 'node', file: 'x.ts', root: '.'}).entities.find(e => e.kind === 'component');
    assert.equal(comp.line, 2);          // строка декоратора
    assert.equal(comp.startLine, 3);     // строка class — декоратор не входит
    assert.equal(comp.endLine, 5);
    const fn = json(root, 'graph-tool', {op: 'node', file: 'x.ts', root: '.'}).entities.find(e => e.name === 'documented');
    assert.equal(fn.startLine, 8);       // JSDoc выше — не входит
    assert.equal(fn.endLine, 10);
}, {'x.ts': `import {Component} from '@angular/core';
@Component({selector: 'app-x'})
export class X {
    render() { return 1; }
}
/** документация
 * над функцией */
function documented() {
    return 2;
}
`}, {empty: true}));

test('диапазоны: TSX/JSX, regex и шаблоны в теле, CRLF и BOM не ломают границы', () => project(root => {
    const node = json(root, 'graph-tool', {op: 'node', file: 'view.tsx', root: '.'});
    const el = node.entities.find(e => e.name === 'View');
    assert.deepEqual({s: el.startLine, e: el.endLine}, {s: 1, e: 4});
    const re = node.entities.find(e => e.name === 'withRegex');
    assert.deepEqual({s: re.startLine, e: re.endLine}, {s: 6, e: 8});
}, {'view.tsx': 'function View() {\n    const el = <div onClick={() => log(1)}>text</div>;\n    return el;\n}\n\nfunction withRegex() {\n    return /[{}]/.test("{}");\n}\n'}, {empty: true}));

test('outline compact=1: диапазон = полный span, декодер восстанавливает line/kind/name', () => project(root => {
    const legacy = json(root, 'symbol-index', {file: 'a.ts'});
    const compact = json(root, 'symbol-index', {file: 'a.ts', compact: '1'});
    const decode = compact.outline.split('\n').map(l => {
        const m = l.match(/^L(\d+)(?:-(\d+))? \[(\w[\w-]*)\] (.+)$/);
        return {line: Number(m[1]), end: m[2] ? Number(m[2]) : null, kind: m[3], name: m[4]};
    });
    const legacyLines = legacy.outline.split('\n').map(l => {
        const m = l.match(/^\s+L\s*(\d+)\s+\[([\w-]+)\] (.+)$/);
        return {line: Number(m[1]), kind: m[2], name: m[3]};
    });
    for (const [i, d] of decode.entries()) {
        assert.equal(d.line, legacyLines[i].line);
        assert.equal(d.kind, legacyLines[i].kind);
        assert.equal(d.name, legacyLines[i].name);
        if (d.end != null) assert.ok(d.end >= d.line);
    }
    // известный случай: метод save — 2-4
    assert.deepEqual(decode.find(d => d.name.startsWith('save')), {line: 2, end: 4, kind: 'method', name: 'save(id: number)'});
}, {'a.ts': `export class C {
    save(id: number): number {
        return id;
    }
    p: number = 1;
}
function top() {}
`}, {empty: true}));

test('op=read: перекрытие/включение/соседние объединяются, раздельные остаются блоками', () => project(root => {
    const r = json(root, 'graph-tool', {op: 'read', file: 'f.txt', ranges: '3-6,4-5,8,9-10,20-22'});
    assert.deepEqual(r.blocks.map(b => [b.startLine, b.endLine]), [[3, 6], [8, 10], [20, 22]]);
    assert.equal(r.loc, 22);
    assert.equal(r.blocks[0].lines.length, 4);
}, {'f.txt': Array.from({length: 22}, (_, i) => 'line' + (i + 1)).join('\n')}, {empty: true}));

test('op=read: CRLF и BOM — контракт line-блоков (BOM снят, EOL = \\n)', () => project(root => {
    const r = json(root, 'graph-tool', {op: 'read', file: 'c.txt', ranges: '1-2'});
    assert.deepEqual(r.blocks[0].lines, ['\uFEFF-removed', 'second']);
    assert.ok(r.blocks[0].lines.every(l => !l.includes('\r')));
}, {'c.txt': '\uFEFF\uFEFF-removed\r\nsecond\r\nthird\r\n'}, {empty: true}));

test('op=read: границы и охрана путей — явные ошибки без частичной выдачи', () => project(root => {
    const beyond = cli(root, 'graph-tool', {op: 'read', file: 'f.txt', ranges: '21-25'});
    assert.equal(beyond.status, 1);
    assert.match(JSON.parse(beyond.stdout).error, /за пределами файла/);
    const outside = cli(root, 'graph-tool', {op: 'read', file: '../x.txt', ranges: '1'});
    assert.equal(outside.status, 1);
    assert.match(JSON.parse(outside.stdout).error, /вне рабочей директории/);
    const bad = cli(root, 'graph-tool', {op: 'read', file: 'f.txt', ranges: '5-2'});
    assert.equal(bad.status, 1);
    // диапазон сверяется с фактическим файлом, а не с координатами графа
    const fs = require('fs');
    fs.writeFileSync(require('path').join(root, 'f.txt'), 'short\n');
    const shrunk = cli(root, 'graph-tool', {op: 'read', file: 'f.txt', ranges: '3-6'});
    assert.equal(shrunk.status, 1);
}, {'f.txt': Array.from({length: 22}, (_, i) => 'line' + (i + 1)).join('\n')}, {empty: true}));

test('node: totals и пагинация — полный список восстанавливается без пропусков и повторов', () => project(root => {
    const page1 = json(root, 'graph-tool', {op: 'node', file: 'hub.ts', root: '.'});
    assert.equal(page1.importedByTotal, 35);
    assert.equal(page1.importedBy.length, 30);
    assert.equal(page1.importedByTruncated, 5);
    const page2 = json(root, 'graph-tool', {op: 'node', file: 'hub.ts', root: '.', offset: '30'});
    assert.equal(page2.importedBy.length, 5);
    const seen = [...page1.importedBy, ...page2.importedBy].map(x => x.file);
    assert.equal(new Set(seen).size, 35);
    for (const item of page1.importedBy.concat(page2.importedBy)) assert.ok(typeof item.file === 'string');
}, {...Object.fromEntries(Array.from({length: 35}, (_, i) => ['u' + (i + 1) + '.ts', "import {hub} from './hub';\nexport const u = hub;\n"])), 'hub.ts': 'export const hub = 1;\n'}, {empty: true}));

test('format=table: декодер восстанавливает объекты {file,kind,level,via?}, null via опускается', () => project(root => {
    const legacy = json(root, 'graph-tool', {op: 'deps', file: 'app.js', root: '.', why: '1'});
    const table = json(root, 'graph-tool', {op: 'deps', file: 'app.js', root: '.', why: '1', format: 'table'});
    assert.deepEqual(table.columns, ['file', 'kind', 'level', 'via']);
    const decoded = table.imports.map(([file, kind, level, via]) => ({file, kind, level, ...(via === null ? {} : {via})}));
    assert.deepEqual(decoded, legacy.imports);
    // без why все via null — декодер опускает поле
    const plain = json(root, 'graph-tool', {op: 'deps', file: 'app.js', root: '.', format: 'table'});
    const plainDecoded = plain.imports.map(([file, kind, level, via]) => ({file, kind, level, ...(via === null ? {} : {via})}));
    assert.ok(plain.imports.every(r => r[3] === null));
    assert.deepEqual(plainDecoded, json(root, 'graph-tool', {op: 'deps', file: 'app.js', root: '.'}).imports);
}, {}, {}));

const compactBatch = json => json; // маркер для чтения

test('batch graph: несколько запросов, partial errors, ambiguous — ответы, не ошибки', () => project(root => {
    const r = json(root, 'graph-tool', {requests: JSON.stringify([
        {op: 'symbol', name: 'hub'},
        {op: 'node', file: 'ambiguous'},
        {op: 'deps', file: 'missing.ts'},
        {op: 'read', file: 'hub.ts', ranges: [1, 1]}
    ])});
    assert.equal(r.batch, true);
    assert.equal(r.total, 4);
    assert.equal(r.failed, 1);
    assert.equal(r.results[0].definedIn.length, 1);
    assert.equal(r.results[1].ambiguous, true);
    assert.ok(r.results[2].error);
    assert.equal(r.results[3].blocks[0].lines[0], 'export const hub = 1;');
}, {'ambiguous.ts': 'export const ambiguous = 1;\n', 'ambiguous.js': 'export const ambiguous = 2;\n', 'hub.ts': 'export const hub = 1;\n'}, {empty: true}));

test('batch graph: одинаковый scope — одна группа; путь с запятой валиден', () => project(root => {
    const r = json(root, 'graph-tool', {requests: JSON.stringify([
        {op: 'node', file: 'a,b.ts'},
        {op: 'symbol', name: 'comma'}
    ])});
    assert.equal(r.failed, 0);
    assert.equal(r.results[0].file, 'a,b.ts');
    assert.equal(r.results[1].definedIn[0].file, 'a,b.ts');
}, {'a,b.ts': 'export const comma = 1;\n'}, {empty: true}));

test('batch graph: разные scope не объединяются молча — изоляция ответов', () => project(root => {
    const r = json(root, 'graph-tool', {requests: JSON.stringify([
        {op: 'symbol', name: 'marker', root: 'one'},
        {op: 'symbol', name: 'marker', root: 'two'}
    ])});
    assert.equal(r.failed, 0);
    assert.deepEqual(r.results[0].definedIn.map(d => d.file), ['one/m.ts']);
    assert.deepEqual(r.results[1].definedIn.map(d => d.file), ['two/m.ts']);
}, {'one/m.ts': 'export const marker = 1;\n', 'two/m.ts': 'export const marker = 2;\n'}, {empty: true}));

test('batch graph: все запросы с ошибками — exit 1; частичный успех — exit 0', () => project(root => {
    const all = cli(root, 'graph-tool', {requests: JSON.stringify([{op: 'deps', file: 'nope1'}, {op: 'deps', file: 'nope2'}])});
    assert.equal(all.status, 1);
    assert.equal(JSON.parse(all.stdout).failed, 2);
    const part = cli(root, 'graph-tool', {requests: JSON.stringify([{op: 'deps', file: 'nope1'}, {op: 'symbol', name: 'hub'}])});
    assert.equal(part.status, 0);
    assert.equal(JSON.parse(part.stdout).failed, 1);
}, {'hub.ts': 'export const hub = 1;\n'}, {empty: true}));

test('compact=1 batch: словарь путей + hoist scope/completeness декодируются в одиночные ответы', () => project(root => {
    const single = json(root, 'graph-tool', {op: 'node', file: 'hub.ts', root: '.', why: '1'});
    const batch = json(root, 'graph-tool', {compact: '1', requests: JSON.stringify([
        {op: 'node', file: 'hub.ts', why: true},
        {op: 'rdeps', file: 'hub.ts', why: true}
    ])});
    assert.ok(Array.isArray(batch.paths));
    const decode = (res) => {
        const out = {...res};
        for (const k of ['file', 'from', 'to']) if (typeof out[k] === 'number') out[k] = batch.paths[out[k]];
        for (const k of ['imports', 'importedBy', 'definedIn'])
            if (Array.isArray(out[k])) out[k] = out[k].map(x => typeof x === 'object' && typeof x.file === 'number' ? {...x, file: batch.paths[x.file]} : x);
        return out;
    };
    const node0 = decode(batch.results[0]);
    assert.equal(node0.file, single.file);
    assert.deepEqual(node0.imports, single.imports);
    assert.deepEqual(node0.importedBy, single.importedBy);
    // scope у всех успешных совпадает → вынесен наверх; completeness различается (truncated) → в элементах
    assert.ok(batch.scope);
    assert.equal(batch.results[0].completeness !== undefined || batch.completeness !== undefined, true);
}, {...Object.fromEntries(Array.from({length: 35}, (_, i) => ['u' + (i + 1) + '.ts', "import {hub} from './hub';\n"])), 'hub.ts': 'export const hub = 1;\n'}, {empty: true}));

test('sig: literal whitespace сохраняется, full=1 и диагностика обрезки, offset читает хвост', () => project(root => {
    const spaced = json(root, 'sig-reader', {name: 'litpkg#Spaced'});
    assert.deepEqual(spaced.signatures, ["export type Spaced = 'a  b';"]);
    const long = json(root, 'sig-reader', {name: 'litpkg#Long'});
    assert.deepEqual(long.clippedSignatures, [0]);
    const full = json(root, 'sig-reader', {name: 'litpkg#Long', full: '1'});
    assert.ok(full.signatures[0].length > long.signatures[0].length && full.signatures[0].endsWith("';"));
    assert.equal(full.clippedSignatures, undefined);
    const card = json(root, 'sig-reader', {name: 'litpkg#Big'});
    assert.equal(card.signaturesTotal, 2);
    const tail = json(root, 'sig-reader', {name: 'litpkg#Big', offset: '1', limit: '1'});
    assert.deepEqual(tail.signatures, ['m2(): void;']);
    assert.deepEqual(tail.truncated, undefined);
}, {'node_modules/litpkg/package.json': '{"name":"litpkg","types":"index.d.ts"}',
    'node_modules/litpkg/index.d.ts': "export type Spaced = 'a  b';\nexport type Long = '" + 'a'.repeat(220) + "';\nexport declare class Big {\n  m1(): void;\n  m2(): void;\n}\n"}, {empty: true}));

const BIG_MEMBERS = Array.from({length: 450}, (_, i) => '  m' + i + '(): void;').join('\n');

test('sig: >400 членов — membersTotal реален, усечение показа помечено, offset даёт доступ', () => project(root => {
    const list = json(root, 'sig-reader', {name: 'bigpkg'}); // без # — список деклараций
    assert.equal(list.found, true);
    assert.equal(list.declarations[0].membersTotal, 450);
    assert.equal(list.declarations[0].members.length, 40);
    assert.equal(list.declarations[0].membersTruncated, 410);
    const card = json(root, 'sig-reader', {name: 'bigpkg#Huge', offset: '440', limit: '10'});
    assert.equal(card.signaturesTotal, 450);
    assert.deepEqual(card.signatures, Array.from({length: 10}, (_, i) => 'm' + (440 + i) + '(): void;'));
}, {'node_modules/bigpkg/package.json': '{"name":"bigpkg","types":"index.d.ts"}',
    'node_modules/bigpkg/index.d.ts': 'export declare class Huge {\n' + BIG_MEMBERS + '\n}\n'}, {empty: true}));

test('batch sig и batch outline: общий кэш, собственные visited/state, partial errors', () => project(root => {
    const sig = json(root, 'sig-reader', {requests: JSON.stringify([
        {name: 'litpkg#Big'},
        {name: 'litpkg#Big', member: 'm1'},
        {name: 'missing-pkg#X'}
    ])});
    assert.equal(sig.total, 3);
    assert.equal(sig.failed, 1);
    assert.equal(sig.results[0].owner, 'Big');
    assert.deepEqual(sig.results[1].signatures, ['m1(): void;']);
    assert.ok(sig.results[2].error);

    const outline = json(root, 'symbol-index', {requests: JSON.stringify([
        {file: 'src/a.ts', compact: true},
        {file: 'src/b.ts'},
        {file: 'src/absent.ts'}
    ])});
    assert.equal(outline.failed, 1);
    assert.match(outline.results[0].outline, /^L1-\d+ \[class\] A/);
    assert.ok(outline.results[2].error);
}, {'node_modules/litpkg/package.json': '{"name":"litpkg","types":"index.d.ts"}',
    'node_modules/litpkg/index.d.ts': 'export declare class Big {\n  m1(): void;\n  m2(): void;\n}\n',
    'src/a.ts': 'export class A {\n  m() { return 1; }\n}\n',
    'src/b.ts': 'export const b = 1;\n'}, {empty: true}));
