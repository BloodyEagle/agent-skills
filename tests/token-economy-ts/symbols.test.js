const test = require('node:test');
const assert = require('node:assert/strict');
const {project, cli, json, scripts} = require('./helpers');
const fs = require('fs');
const path = require('path');
const {spawnSync} = require('child_process');

const outline = (root, file, args = {}) => json(root, 'symbol-index', {file, ...args});

test('именованные export default function и class попадают в оглавление', () => project(root => {
    const result = outline(root, 'defaults.js');
    assert.match(result.outline, /\[function\] Example/);
    assert.match(result.outline, /\[class\] Model/);
}, {'defaults.js': 'export default function Example() {}\nexport default class Model {}'}));

test('const стрелки с async и одним параметром распознаются', () => project(root => {
    const result = outline(root, 'arrows.js');
    for (const name of ['first', 'second', 'third']) assert.match(result.outline, new RegExp('\\[function\\] ' + name));
}, {'arrows.js': 'const first = () => {};\nconst second = async (x) => {};\nconst third = x => x;'}));

test('обычная функция без экспорта распознаётся', () => project(root => {
    assert.match(outline(root, 'lib/util.js').outline, /\[function\] sum/);
}));

test('module.exports объект и свойства дают список экспортов', () => project(root => {
    const result = outline(root, 'lib/util.js');
    assert.match(result.outline, /\[export\] sum/);
    assert.match(result.outline, /\[export\] version/);
}));

test('многострочный module.exports учитывает все имена', () => project(root => {
    const result = outline(root, 'exports.cjs');
    for (const name of ['a', 'b']) assert.match(result.outline, new RegExp('\\[export\\] ' + name));
}, {'exports.cjs': 'module.exports = {\n  a,\n  b\n};'}));

test('JSX-теги не засоряют оглавление', () => project(root => {
    const result = outline(root, 'components/Button.jsx');
    assert.match(result.outline, /Button/);
    assert.doesNotMatch(result.outline, /\]\s+(button|span|label)\b/);
}));

test('приватные методы и поля класса отмечены отдельно', () => project(root => {
    const result = outline(root, 'components/Button.jsx');
    assert.match(result.outline, /\[private-property\] #value/);
    assert.match(result.outline, /\[private-method\] #increment/);
    assert.match(result.outline, /\[method\] increment/);
}));

test('800 строк ограничены 60 строками оглавления', () => project(root => {
    const result = outline(root, 'large.js');
    assert.equal(result.lines, 800);
    assert.equal(result.count, 800);
    assert.equal(result.truncated, true);
    assert.equal(result.outline.split('\n').length, 60);
}, {'large.js': Array.from({length: 800}, (_, i) => 'function item' + i + '() {}').join('\n')}));

test('комментарии и строки не меняют глубину класса', () => project(root => {
    const result = outline(root, 'braces.js');
    assert.match(result.outline, /\[method\] save/);
    assert.doesNotMatch(result.outline, /Phantom/);
}, {'braces.js': '/*\nclass Phantom {\n*/\nclass Real {\n  value = "}";\n  save() {}\n}'}));

test('строковое содержимое не порождает ложные объявления', () => project(root => {
    const result = outline(root, 'strings.js');
    assert.doesNotMatch(result.outline, /Phantom/);
}, {'strings.js': '`\nclass Phantom {}\n`\nfunction real() {}'}));

test('прежние TS объявления сохраняются', () => project(root => {
    const result = outline(root, 'types.ts');
    for (const kind of ['interface', 'enum', 'type', 'class', 'method']) assert.match(result.outline, new RegExp('\\[' + kind + '\\]'));
}, {'types.ts': 'interface Shape {}\nenum Mode { A }\ntype Name = string;\nclass Service {\n  save(value: string): void {}\n}'}));

test('audit: generic arrows распознаются как функции', () => project(root => {
    const result = outline(root, 'generic.ts');
    for (const name of ['identity', 'asyncIdentity', 'constrained']) assert.match(result.outline, new RegExp('\\[function\\] ' + name));
}, {'generic.ts': 'const identity = <T>(x: T): T => x;\nconst asyncIdentity = async <T>(x: T) => x;\nconst constrained = <T extends Map<string, number>>(x: T) => x;\n'}, {empty: true}));

test('audit: arrow-свойства класса распознаются как методы', () => project(root => {
    const result = outline(root, 'arrows.ts');
    for (const name of ['onClick', 'identity', 'typed']) assert.match(result.outline, new RegExp('\\[method\\] ' + name));
    assert.match(result.outline, /\[private-method\] #hidden/);
    assert.match(result.outline, /\[property\] value/);
}, {'arrows.ts': 'class Service {\n  onClick = (event: Event) => {};\n  identity = <T>(x: T) => x;\n  typed = (x: number): number => x;\n  #hidden = () => {};\n  value = 1;\n}\n'}, {empty: true}));

test('audit: outline сохраняет Unicode имена, combining marks и astral letters', () => project(root => {
    const result = outline(root, 'unicode.ts');
    assert.match(result.outline, /\[class\] Сервис/);
    assert.match(result.outline, /\[method\] сохранить/);
    for (const name of ['привет', 'cafe\u0301', '𐐀run']) assert.ok(result.outline.includes('[function] ' + name), result.outline);
}, {'unicode.ts': 'class Сервис {\n  сохранить() {}\n}\nfunction привет() {}\nconst cafe\u0301 = () => {};\nfunction 𐐀run() {}\n'}, {empty: true}));

test('audit: деление перед комментарием не скрывает конец метода в outline', () => project(root => {
    const result = outline(root, 'division.js');
    assert.match(result.outline, /\[method\] calculate/);
    assert.match(result.outline, /\[method\] save/);
    assert.doesNotMatch(result.outline, /Phantom/);
}, {'division.js': 'class Service {\n  calculate() { return a / b; } // ratio\n  save() { return /[{}]/.test("{}"); }\n}\nconst pattern = /class Phantom {}/;\n'}, {empty: true}));

test('audit: маска различает postfix division и regex после условия', () => project(root => {
    const result = outline(root, 'slash.js');
    for (const name of ['postfix', 'conditional', 'after']) assert.ok(result.outline.includes('[method] ' + name), result.outline);
}, {'slash.js': 'class Service {\n  postfix() { return counter++ / divisor; } // ratio\n  conditional() { if (enabled) /[}]/.test(value); }\n  after() {}\n}\n'}, {empty: true}));

const sig = (root, name) => json(root, 'sig-reader', {name});

for (const target of [
    {'.': {types: './types/public.d.ts'}},
    {'.': './types/public.d.ts'},
    {types: './types/public.d.ts'},
    './types/public.d.ts',
    {'.': {import: {types: './types/public.d.ts'}}}
]) {
    test('audit: sig exports root ' + JSON.stringify(target), () => project(root => {
        const result = sig(root, 'onlyexp#Visible');
        assert.equal(result.found, true);
        assert.equal(result.owner, 'Visible');
        assert.match(result.file, /types\/public\.d\.ts$/);
    }, {'node_modules/onlyexp/package.json': JSON.stringify({name: 'onlyexp', exports: target}),
        'node_modules/onlyexp/types/public.d.ts': 'export declare class Visible { value: string; }'}, {empty: true}));
}

test('review: sig dual-package runtime exports не затеняет package types', () => project(root => {
    const options = sig(root, 'dual#Options');
    assert.equal(options.found, true);
    assert.match(options.file, /types\/index\.d\.ts$/);
    assert.deepEqual(options.signatures, ['retries: number;']);
    const start = sig(root, 'dual#start');
    assert.match(start.file, /types\/index\.d\.ts$/);
    assert.deepEqual(start.signatures, ['export declare function start(options: Options): void;']);
}, {'node_modules/dual/package.json': JSON.stringify({types: './types/index.d.ts',
        exports: {'.': {import: './dist/index.js', require: './dist/index.cjs'}}}),
    'node_modules/dual/types/index.d.ts': 'export interface Options { retries: number; }\nexport declare function start(options: Options): void;',
    'node_modules/dual/dist/index.js': 'export function start(options) {}',
    'node_modules/dual/dist/index.cjs': 'exports.start = function (options) {};'}, {empty: true}));

for (const [condition, ext, fallback] of [
    ['import', 'js', 'types'], ['require', 'cjs', 'typings'], ['node', 'mjs', 'index']
]) {
    test('review: sig runtime ' + condition + ' сохраняет fallback ' + fallback, () => project(root => {
        const result = sig(root, 'dual#Options');
        assert.equal(result.found, true);
        assert.match(result.file, /index\.d\.ts$/);
        const file = path.join(root, 'node_modules/dual', fallback === 'index' ? 'index.d.ts' : 'types/index.d.ts');
        fs.unlinkSync(file);
        const missing = cli(root, 'sig-reader', {name: 'dual#Options'});
        assert.equal(missing.status, 1, missing.stdout);
        assert.ok(JSON.parse(missing.stdout).error);
        assert.equal(missing.stderr, '');
    }, {'node_modules/dual/package.json': JSON.stringify({
            ...(fallback === 'index' ? {} : {[fallback]: './types/index.d.ts'}),
            exports: {'.': {[condition]: './dist/index.' + ext}}}),
        ['node_modules/dual/' + (fallback === 'index' ? 'index.d.ts' : 'types/index.d.ts')]: 'export interface Options { retries: number; }',
        ['node_modules/dual/dist/index.' + ext]: 'export function start(options) {}'}, {empty: true}));
}

for (const [condition, runtimeExt, declarationExt] of [
    ['import', '.js', '.d.ts'], ['import', '.mjs', '.d.mts'], ['require', '.cjs', '.d.cts']
]) {
    test('review: sig runtime target использует соседнюю ' + declarationExt, () => project(root => {
        const result = sig(root, 'dual#Options');
        assert.equal(result.found, true);
        assert.ok(result.file.endsWith('/dist/index' + declarationExt), result.file);
    }, {'node_modules/dual/package.json': JSON.stringify({exports: {'.': {[condition]: './dist/index' + runtimeExt}}}),
        ['node_modules/dual/dist/index' + runtimeExt]: 'export function start(options) {}',
        ['node_modules/dual/dist/index' + declarationExt]: 'export interface Options { retries: number; }'}, {empty: true}));
}

test('review: sig nested types после runtime ветки сохраняет приоритет деклараций', () => project(root => {
    const result = sig(root, 'dual#Options');
    assert.equal(result.found, true);
    assert.match(result.file, /types\/explicit\.d\.cts$/);
}, {'node_modules/dual/package.json': JSON.stringify({types: './types/fallback.d.ts', exports: {'.': {
        import: './dist/index.js', require: {types: './types/explicit.d.cts', default: './dist/index.cjs'}}}}),
    'node_modules/dual/dist/index.js': 'export function start(options) {}',
    'node_modules/dual/dist/index.cjs': 'exports.start = function (options) {};',
    'node_modules/dual/types/explicit.d.cts': 'export interface Options { retries: number; }',
    'node_modules/dual/types/fallback.d.ts': 'export interface Fallback {}'}, {empty: true}));

test('audit: sig subpath exports и обычные types сохраняются', () => project(root => {
    assert.equal(sig(root, 'ordinary#Visible').found, true);
    assert.equal(sig(root, 'onlyexp/sub#Visible').found, true);
}, {'node_modules/ordinary/package.json': '{"types":"public.d.ts"}',
    'node_modules/ordinary/public.d.ts': 'export declare class Visible {}',
    'node_modules/onlyexp/package.json': '{"exports":{"./sub":{"types":"./public.d.ts"}}}',
    'node_modules/onlyexp/public.d.ts': 'export declare class Visible {}'}, {empty: true}));

test('audit: sig missing dependency в reexport не прерывает fallback', () => project(root => {
    const result = sig(root, 'barrel#Visible');
    assert.equal(result.found, true);
    assert.match(result.file, /local\.d\.ts$/);
    const missing = sig(root, 'barrel#Missing');
    assert.equal(missing.found, false);
    const direct = cli(root, 'sig-reader', {name: 'missing-pkg#Visible'});
    assert.equal(direct.status, 1);
    assert.ok(JSON.parse(direct.stdout).error);
    assert.equal(direct.stderr, '');
}, {'node_modules/barrel/package.json': '{"types":"index.d.ts"}',
    'node_modules/barrel/index.d.ts': 'export {Visible} from "missing-pkg";\nexport * from "./local";\n',
    'node_modules/barrel/local.d.ts': 'export declare class Visible { value: number; }'}, {empty: true}));

test('audit: sig без member раскрывает export star, именованные оставляет в available', () => project(root => {
    const all = sig(root, 'star-barrel');
    assert.equal(all.found, true);
    assert.deepEqual(all.declarations.map(item => item.name), ['Visible']);
    const named = sig(root, 'named-barrel');
    assert.equal(named.found, false);
    assert.deepEqual(named.available, ['Visible']);
}, {'node_modules/star-barrel/package.json': '{"types":"index.d.ts"}',
    'node_modules/star-barrel/index.d.ts': 'export * from "./types";',
    'node_modules/star-barrel/types.d.ts': 'export declare class Visible {}',
    'node_modules/named-barrel/package.json': '{"types":"index.d.ts"}',
    'node_modules/named-barrel/index.d.ts': 'export {Visible} from "./types";',
    'node_modules/named-barrel/types.d.ts': 'export declare class Visible {}'}, {empty: true}));

for (const form of ['absolute', 'relative']) {
    test('audit: sig отклоняет прямой внешний путь ' + form, () => project(outer => {
        const root = path.join(outer, 'project');
        const external = path.join(outer, 'external.d.ts');
        const spec = form === 'absolute' ? external : '../external.d.ts';
        const result = cli(root, 'sig-reader', {name: spec + '#Outside'});
        assert.equal(result.status, 1, result.stdout);
        assert.match(JSON.parse(result.stdout).error, /вне|предел|outside/i);
        assert.equal(result.stderr, '');
        assert.doesNotMatch(result.stdout, /privatePayload/);
    }, {'project/local.d.ts': 'export declare class Local {}',
        'external.d.ts': 'export declare class Outside { privatePayload: string; }'}, {empty: true}));
}

test('audit: sig сохраняет прямые пути внутри cwd и не выходит по reexport', () => project(outer => {
    const root = path.join(outer, 'project');
    assert.equal(sig(root, './local.d.ts#Local').found, true);
    assert.equal(sig(root, path.join(root, 'local.d.ts') + '#Local').found, true);
    const result = sig(root, './barrel.d.ts#Outside');
    assert.equal(result.found, false);
    assert.doesNotMatch(JSON.stringify(result), /privatePayload/);
}, {'project/local.d.ts': 'export declare class Local {}',
    'project/barrel.d.ts': 'export * from "../external";',
    'external.d.ts': 'export declare class Outside { privatePayload: string; }'}, {empty: true}));

test('audit: sig Unicode declarations и members доступны по имени', () => project(root => {
    assert.equal(sig(root, 'unicode#Сервис').found, true);
    assert.deepEqual(sig(root, 'unicode#сохранить').signatures, ['сохранить(): void;']);
    assert.equal(sig(root, 'unicode#cafe\u0301').found, true);
    assert.equal(sig(root, 'unicode#𐐀run').found, true);
}, {'node_modules/unicode/package.json': '{"types":"index.d.ts"}',
    'node_modules/unicode/index.d.ts': 'export declare class Сервис {\n  сохранить(): void;\n}\nexport declare function cafe\u0301(): void;\nexport declare function 𐐀run(): void;\n'}, {empty: true}));

test('audit: sig package traversal и внешний types target отклоняются', () => project(outer => {
    const root = path.join(outer, 'project');
    for (const name of ['pkg/../../../outside.d.ts#Outside', 'escape#Outside']) {
        const result = cli(root, 'sig-reader', {name});
        assert.equal(result.status, 1, result.stdout);
        assert.ok(JSON.parse(result.stdout).error);
        assert.doesNotMatch(result.stdout, /privatePayload/);
    }
}, {'project/node_modules/pkg/package.json': '{"types":"index.d.ts"}',
    'project/node_modules/pkg/index.d.ts': 'export declare class Visible {}',
    'project/node_modules/escape/package.json': '{"types":"../../../outside.d.ts"}',
    'outside.d.ts': 'export declare class Outside { privatePayload: string; }'}, {empty: true}));

test('audit: sig выбирает dependency относительно импортирующего пакета', () => project(root => {
    const result = sig(root, 'parent#Visible');
    assert.equal(result.found, true);
    assert.deepEqual(result.signatures, ['local: string;']);
}, {'node_modules/parent/package.json': '{"types":"index.d.ts"}',
    'node_modules/parent/index.d.ts': 'export {Visible} from "dependency";',
    'node_modules/parent/node_modules/dependency/package.json': '{"types":"index.d.ts"}',
    'node_modules/parent/node_modules/dependency/index.d.ts': 'export declare class Visible { local: string; }',
    'node_modules/dependency/package.json': '{"types":"index.d.ts"}',
    'node_modules/dependency/index.d.ts': 'export declare class Visible { wrong: number; }'}, {empty: true}));

function linkedSig(root, name) {
    const result = spawnSync(process.execPath, [path.join(scripts, 'sig-reader.js'), 'name=' + name], {
        cwd: root, encoding: 'utf8', timeout: 8000, windowsHide: true,
        env: {...process.env, NODE_OPTIONS: '', HOME: root, USERPROFILE: root}
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
    return result;
}

test('audit: sig realpath не допускает прямой путь через внешний junction', () => project(outer => {
    const root = path.join(outer, 'project');
    const link = path.join(root, 'linked');
    fs.symlinkSync(path.join(outer, 'outside'), link, process.platform === 'win32' ? 'junction' : 'dir');
    try {
        const result = linkedSig(root, './linked/types.d.ts#Outside');
        assert.equal(result.status, 1, result.stdout);
        assert.match(JSON.parse(result.stdout).error, /вне|предел|outside/i);
        assert.doesNotMatch(result.stdout, /privatePayload/);
    } finally {
        fs.unlinkSync(link);
    }
}, {'project/local.d.ts': 'export declare class Local {}',
    'outside/types.d.ts': 'export declare class Outside { privatePayload: string; }'}, {empty: true}));

test('audit: sig разрешает ancestor node_modules и dependency reexports', () => project(outer => {
    const root = path.join(outer, 'project');
    assert.equal(sig(root, 'hoisted#Visible').found, true);
    assert.equal(sig(root, 'hoisted#FromDependency').found, true);
    assert.equal(sig(root, '@scope/typed/sub#Visible').found, true);
}, {'project/local.d.ts': 'export declare class Local {}',
    'node_modules/hoisted/package.json': '{"types":"index.d.ts"}',
    'node_modules/hoisted/index.d.ts': 'export {Visible} from "./types";\nexport {FromDependency} from "dependency";',
    'node_modules/hoisted/types.d.ts': 'export declare class Visible {}',
    'node_modules/dependency/package.json': '{"types":"index.d.ts"}',
    'node_modules/dependency/index.d.ts': 'export declare class FromDependency {}',
    'node_modules/@scope/typed/package.json': '{"exports":{"./sub":{"types":"./public.d.ts"}}}',
    'node_modules/@scope/typed/public.d.ts': 'export declare class Visible {}'}, {empty: true}));

test('audit: sig разрешает установленный пакет через node_modules junction', () => project(outer => {
    const root = path.join(outer, 'project');
    const modules = path.join(root, 'node_modules');
    fs.mkdirSync(modules);
    const link = path.join(modules, 'linked-pkg');
    fs.symlinkSync(path.join(outer, 'store/linked-pkg'), link, process.platform === 'win32' ? 'junction' : 'dir');
    try {
        const result = linkedSig(root, 'linked-pkg#Visible');
        assert.equal(result.status, 0, result.stdout);
        assert.equal(JSON.parse(result.stdout).found, true);
    } finally {
        fs.unlinkSync(link);
    }
}, {'project/local.d.ts': 'export declare class Local {}',
    'store/linked-pkg/package.json': '{"types":"index.d.ts"}',
    'store/linked-pkg/index.d.ts': 'export {Visible} from "./types";',
    'store/linked-pkg/types.d.ts': 'export declare class Visible {}'}, {empty: true}));
