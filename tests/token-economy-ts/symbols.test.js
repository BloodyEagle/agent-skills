const test = require('node:test');
const assert = require('node:assert/strict');
const {project, json} = require('./helpers');

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
