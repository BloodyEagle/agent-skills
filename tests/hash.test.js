'use strict';
// lib/hash.js: детерминированность и исключения (кейсы 1–3 плана).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {hashDir, listFiles} = require('../lib/hash');
const {tmpRoot} = require('./helpers');

function writeFile(p, text) {
    fs.mkdirSync(path.dirname(p), {recursive: true});
    fs.writeFileSync(p, text);
}

test('hash: не зависит от порядка обхода и mtime', () => {
    const a = tmpRoot();
    const b = tmpRoot();
    // A: создали skill.ts, потом sub/other.ts; mtime — старая дата.
    writeFile(path.join(a, 'skill.ts'), 'export const a = 1;\n');
    writeFile(path.join(a, 'sub', 'other.ts'), 'export const b = 2;\n');
    const old = new Date('2020-01-01T00:00:00Z');
    for (const rel of ['skill.ts', 'sub/other.ts']) fs.utimesSync(path.join(a, rel), old, old);
    // B: обратный порядок создания, свежие mtime.
    writeFile(path.join(b, 'sub', 'other.ts'), 'export const b = 2;\n');
    writeFile(path.join(b, 'skill.ts'), 'export const a = 1;\n');
    const ha = hashDir(a);
    const hb = hashDir(b);
    assert.strictEqual(ha.hash, hb.hash);
    assert.strictEqual(ha.files, 2);
});

test('hash: изменение одного байта меняет хеш', () => {
    const dir = tmpRoot();
    writeFile(path.join(dir, 'tool.js'), 'const x = 1;\n');
    const before = hashDir(dir).hash;
    fs.writeFileSync(path.join(dir, 'tool.js'), 'const x = 2;\n');
    const after = hashDir(dir).hash;
    assert.notStrictEqual(before, after);
});

test('hash: исключения (node_modules, test/fixtures, dist, .installed.json) не влияют', () => {
    const a = tmpRoot();
    const b = tmpRoot();
    for (const dir of [a, b]) {
        writeFile(path.join(dir, 'SKILL.md'), '# skill\n');
        writeFile(path.join(dir, 'scripts', 'tool.js'), '// tool\n');
    }
    // В A — мусор в исключаемых каталогах и метка установки; в B их нет вовсе.
    writeFile(path.join(a, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');
    writeFile(path.join(a, 'test', 'fixtures', 'big.bin'), '\0'.repeat(1024));
    writeFile(path.join(a, 'dist', 'bundle.js'), 'var a;\n');
    writeFile(path.join(a, '.installed.json'), '{"name":"x"}\n');
    const ha = hashDir(a);
    const hb = hashDir(b);
    assert.strictEqual(ha.hash, hb.hash);
    assert.strictEqual(ha.files, hb.files);
    // Сам список не содержит исключённых путей.
    assert.deepStrictEqual(listFiles(a), ['SKILL.md', 'scripts/tool.js']);
});

test('hash: Python bytecode и системные файлы не меняют состав скилла', () => {
    const dir = tmpRoot();
    writeFile(path.join(dir, 'scripts', 'tool.py'), 'print("ok")\n');
    const before = hashDir(dir);
    for (const rel of ['scripts/__pycache__/tool.cpython-313.pyc', 'scripts/old.pyc',
        '.DS_Store', 'nested/Thumbs.db', 'nested/desktop.ini']) {
        writeFile(path.join(dir, rel), 'local cache');
    }
    assert.deepStrictEqual(hashDir(dir), before);
    assert.deepStrictEqual(listFiles(dir), ['scripts/tool.py']);
});
