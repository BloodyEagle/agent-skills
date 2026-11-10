'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { cases, runFixture, compare } = require('./run-golden');

for (const name of Object.keys(cases)) {
  test('golden: ' + name + ' — stdout и коды завершения', { timeout: 60000 }, () => {
    compare(name, runFixture(name));
  });
}

test('генераторы отказываются стирать непустые пользовательские каталоги', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bx-fixture-guard-'));
  try {
    fs.writeFileSync(path.join(root, 'keep.txt'), 'keep');
    for (const name of Object.keys(cases)) {
      const result = spawnSync(process.execPath, [path.join(__dirname, 'gen-' + name + '-fixture.js'), root], {
        cwd: os.tmpdir(), encoding: 'utf8', timeout: 5000,
      });
      assert.ifError(result.error);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /каталог фикстуры не пуст/);
      assert.equal(fs.readFileSync(path.join(root, 'keep.txt'), 'utf8'), 'keep');
      assert.deepEqual(fs.readdirSync(root), ['keep.txt']);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
