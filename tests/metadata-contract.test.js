'use strict';
// Локальное подмножество YAML: проверяем decoded значения, не совместимость внешних loader.

const test = require('node:test');
const assert = require('node:assert/strict');
const {parseDescription, parseFrontmatterVersion, parseVersion, descriptionIssue} = require('../lib/metadata');

function document(value, eol = '\n', bom = '') {
    return bom + ['---', 'name: demo', 'description: ' + value, 'version: 1.0.0', '---', '# Demo', ''].join(eol);
}

for (const [label, scalar, decoded] of [
    ['plain + comment', 'описание:без-пробела # комментарий', 'описание:без-пробела'],
    ['plain hash', 'описание#текст', 'описание#текст'],
    ['plain apostrophes', "it's a skill", "it's a skill"],
    ['single quoted', "'It''s # текст: [ok] \\n' # комментарий", "It's # текст: [ok] \\n"],
    ['double quoted', '"Текст \\"цитата\\" \\\\ путь \\/"', 'Текст "цитата" \\ путь /'],
    ['quoted null', '"null"', 'null'],
    ['quoted number', "'123'", '123'],
    ['literal strip', '|-\n  alpha\n  beta\n\n', 'alpha\nbeta'],
    ['literal clip', '|\n  alpha\n  beta\n\n', 'alpha\nbeta\n'],
    ['literal keep', '|+\n  alpha\n  beta\n\n', 'alpha\nbeta\n\n\n'],
    ['folded strip', '>-\n  alpha\n  beta', 'alpha beta'],
    ['folded paragraphs', '>-\n  alpha\n\n  beta\n\n\n  gamma', 'alpha\nbeta\n\ngamma'],
    ['folded leading blanks', '>-\n\n  alpha', '\nalpha'],
    ['folded clip', '> # комментарий\n  alpha\n  beta\n\n', 'alpha beta\n'],
    ['folded keep', '>+\n  alpha\n  beta\n\n', 'alpha beta\n\n\n'],
    ['block quoted-looking text', '|-\n  description: literal\n  # not a comment', 'description: literal\n# not a comment'],
    ['block trailing spaces', '|-\n  text  ', 'text  '],
    ['block non-ASCII space is content', '|-\n  text\n  \u00a0', 'text\n\u00a0'],
]) {
    test('description YAML: ' + label, () => assert.equal(parseDescription(document(scalar)), decoded));
}

test('description YAML: double quoted escapes декодируются по YAML, не JSON', () => {
    const scalar = '"\\0\\a\\b\\t\\n\\v\\f\\r\\e\\ \\"\\/\\\\\\N\\_\\L\\P\\x41\\u0416\\U0001F600"';
    const decoded = ['\0', '\x07', '\b', '\t', '\n', '\v', '\f', '\r', '\x1b', ' ', '"', '/', '\\',
        '\u0085', '\u00a0', '\u2028', '\u2029', 'A', 'Ж', '😀'].join('');
    assert.equal(parseDescription(document(scalar)), decoded);
});

test('description YAML: BOM/CRLF сохраняют decoded semantics', () => {
    assert.equal(parseDescription(document('>-\r\n  Кириллица\r\n\r\n  😀', '\r\n', '\uFEFF')), 'Кириллица\n😀');
    assert.equal(parseDescription(document('"\\u0416\\U0001F600"', '\r\n', '\uFEFF')), 'Ж😀');
});

test('description YAML: Unicode code points, combining marks без нормализации', () => {
    for (const char of ['я', '😀']) {
        for (const length of [900, 901, 1024, 1025]) {
            const value = parseDescription(document('"' + char.repeat(length) + '"'));
            assert.equal([...value].length, length);
            if (length > 1024) assert.match(descriptionIssue(value), /1025 Unicode code points > 1024/);
            else assert.equal(descriptionIssue(value), null);
        }
    }
    assert.equal([...parseDescription(document('"e\\u0301"'))].length, 2);
    assert.equal([...parseDescription(document('"' + '\\U0001F600'.repeat(1024) + '"'))].length, 1024);
});

test('description YAML: missing, empty и whitespace-only различаются с непустым текстом', () => {
    assert.equal(parseDescription('---\nname: demo\n---\n'), null);
    assert.equal(parseDescription('# Demo\ndescription: ignored\n'), null);
    assert.match(descriptionIssue(null), /нет description/);
    for (const value of ['', '# comment', "''", '""', "'   '", '|', '|-\n\n', '|+\n\n', '>\n  ']) {
        const decoded = parseDescription(document(value));
        assert.match(descriptionIssue(decoded), /пустое/, JSON.stringify(value));
    }
});

for (const value of [
    '[one, two]', '{key: value}', '&anchor text', '*anchor', '!!str text',
    'text: mapping', '- item', '? key', '@reserved', '`reserved',
    'null', 'NULL', '~', 'true', 'False', '0', '01', '-1', '+12', '0x10', '0o10', '1.5', '.5', '1.', '1e3', '1.5E-2', '.inf', '-.Inf', '.NaN',
    'plain\n  continuation', '"quoted\n  continuation"', '"unterminated', "'unterminated", '"ok"junk', "'ok' #ignored\n  continuation",
    '"\\q"', '"\\x4"', '"\\uGGGG"', '"\\U00110000"', '"\\uD800"', '"\\uD83D\\uDE00"',
    '|2\n  text', '>2-\n  text', '|-2\n  text', '|-+\n  text', '|\n  first\n    more-indented', '|\n    first\n  less-indented', '|\n\ttext', '|\n    \n  text', '|\n  text\n    ',
    'text\rbroken', 'text\u0085broken', '"raw\0control"', '"\ud800"',
]) {
    test('description YAML unsupported: ' + JSON.stringify(value), () => {
        assert.throws(() => parseDescription(document(value)), /description: неподдерживаемый YAML/);
    });
}

test('description YAML: duplicate/quoted/explicit keys не выбираются молча', () => {
    for (const text of [
        document('first\ndescription: second'),
        '---\n"description": text\n---\n',
        "---\n'description': text\n---\n",
        '---\n? description\n: text\n---\n',
        '---\ndescription:text\n---\n',
    ]) assert.throws(() => parseDescription(text), /description: неподдерживаемый YAML/);
});

test('VERSION: canonical X.Y.Z, только string, safe integers', () => {
    assert.deepEqual(parseVersion('0.0.0'), {major: 0, minor: 0, patch: 0});
    assert.deepEqual(parseVersion('9007199254740991.12.3'), {major: Number.MAX_SAFE_INTEGER, minor: 12, patch: 3});
    for (const value of [null, 1, {}, '01.2.3', '1.02.3', '1.2.03', '1.2.3-alpha', '1.2.3+build',
        '1.2', '-1.2.3', '+1.2.3', ' 1.2.3', '1.2.3\n', '1.2.3 ', '1e3.2.3', '9007199254740992.0.0',
        '0.9007199254740992.0', '0.0.9007199254740992', '9'.repeat(400) + '.0.0']) {
        assert.equal(parseVersion(value), null, String(value));
    }
});

test('version frontmatter: plain canonical token и comment, без quoted/block/duplicate', () => {
    assert.equal(parseFrontmatterVersion('---\nversion: 1.2.3 # comment\n---\n'), '1.2.3');
    assert.equal(parseFrontmatterVersion('---\nname: demo\n---\n'), null);
    for (const scalar of ['01.2.3', '"1.2.3"', "'1.2.3'", '|\n  1.2.3', '1.2.3\nversion: 1.2.3']) {
        assert.throws(() => parseFrontmatterVersion('---\nversion: ' + scalar + '\n---\n'), /version:/);
    }
});
