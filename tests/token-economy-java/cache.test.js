'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { project, classFile, jarFile } = require('./helpers');

function prepare(t) {
  const p = project(t);
  p.write('src/main/java/demo/UseBox.java', 'package demo;\nimport fixture.Box;\nclass UseBox { Box box; }\n');
  p.write('lib/box.jar', jarFile([{ name: 'fixture/Box.class', data: classFile() }]));
  const built = p.run('op=build');
  assert.equal(built.status, 0, built.stdout + built.stderr);
  return p;
}

for (const cache of ['missing', 'invalid-json', 'null', 'missing-files', 'broken-entry']) {
  test('sig short-name: ' + cache + ' parse cache does not leak raw filesystem/JSON errors', (t) => {
    const p = prepare(t), file = path.join(p.root, '.jv-cache/cache.json');
    if (cache === 'missing') fs.unlinkSync(file);
    else fs.writeFileSync(file, {
      'invalid-json': '{broken', null: 'null', 'missing-files': '{}',
      'broken-entry': JSON.stringify({ v: 1, files: { 'src/main/java/demo/UseBox.java': { d: null } } })
    }[cache], 'utf8');
    const r = p.run('op=sig', 'name=Box');
    assert.equal(r.error, undefined);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^fixture\.Box\s+box\.jar/m);
    assert.match(r.stdout, /abstract class Box/);
    assert.doesNotMatch(r.stdout + r.stderr, /ENOENT|TypeError|SyntaxError|Cannot convert|Unexpected token/);
  });
}

test('sig short-name: missing import gives an actionable message without cache internals', (t) => {
  const p = project(t);
  const r = p.run('op=sig', 'name=Unknown');
  assert.equal(r.error, undefined);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /укажите полное имя/);
  assert.doesNotMatch(r.stdout + r.stderr, /ENOENT|cache\.json|TypeError/);
});
