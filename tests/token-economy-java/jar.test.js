'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const { project, classFile, jarFile, CLASSFILE } = require('./helpers');
const CF = require(CLASSFILE);

test('jar: stored/deflated classes and EOCD signatures inside comments are read', (t) => {
  const p = project(t), bytes = classFile();
  const comment = Buffer.alloc(32, 65);
  comment.writeUInt32LE(0x06054b50, 2);
  for (const method of [0, 8]) {
    const file = p.write('lib/box-' + method + '.jar', jarFile([{ name: 'fixture/Box.class', data: bytes, method }], comment));
    assert.equal(CF.zipEntries(file).length, 1);
    const r = p.run('op=sig', 'name=fixture.Box', 'jar=box-' + method);
    assert.equal(r.error, undefined);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /abstract class Box/);
  }
});

test('jar: malformed EOCD and central directory are rejected within child limits', (t) => {
  const p = project(t);
  const valid = jarFile([{ name: 'fixture/Box.class', data: classFile() }]);
  const end = valid.length - 22, cd = valid.readUInt32LE(end + 16);
  const variants = [];
  const change = (name, fn) => { const bytes = Buffer.from(valid); fn(bytes); variants.push([name, bytes]); };
  change('oversized-directory', (b) => b.writeUInt32LE(0xfffffffe, end + 12));
  change('directory-after-eocd', (b) => b.writeUInt32LE(b.length + 1, end + 16));
  change('truncated-comment', (b) => b.writeUInt16LE(12, end + 20));
  change('missing-entries', (b) => { b.writeUInt16LE(2, end + 8); b.writeUInt16LE(2, end + 10); });
  change('oversized-entry-name', (b) => b.writeUInt16LE(0xffff, cd + 28));
  change('local-offset-outside', (b) => b.writeUInt32LE(0xfffffffe, cd + 42));
  change('spanned-archive', (b) => b.writeUInt16LE(1, end + 4));
  change('zip64', (b) => b.writeUInt32LE(0xffffffff, end + 12));
  variants.push(['truncated', valid.subarray(0, valid.length - 1)], ['empty-buffer', Buffer.alloc(0)]);
  const files = variants.map(([name, bytes]) => p.write(name + '.jar', bytes));
  const code = `
    const assert = require('node:assert/strict'), CF = require(process.argv[1]);
    for (const file of process.argv.slice(2)) {
      process.stdout.write(file + '\\n');
      assert.throws(() => CF.zipEntries(file), /(?:jar|ZIP)/i);
    }
  `;
  const r = cp.spawnSync(process.execPath, ['--max-old-space-size=64', '-e', code, CLASSFILE, ...files], {
    cwd: p.dir, env: p.env, encoding: 'utf8', timeout: 2500, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024
  });
  assert.equal(r.error, undefined, r.stdout);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('sig: damaged class in newest jar falls back to an older valid version', (t) => {
  const p = project(t);
  p.write('lib/box-9.jar', jarFile([{ name: 'fixture/Box.class', data: classFile({ signature: '<Txxx' }) }]));
  p.write('lib/box-1.jar', jarFile([{ name: 'fixture/Box.class', data: classFile() }]));
  const r = p.run('op=sig', 'name=fixture.Box');
  assert.equal(r.error, undefined);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /box-1\.jar/);
  assert.match(r.stdout, /abstract class Box/);
  assert.match(r.stdout + r.stderr, /(?:пропущен|поврежд|предупрежден)/i);
});

test('sig: invalid local header falls back instead of accepting bytes from a corrupt jar', (t) => {
  const p = project(t), bad = jarFile([{ name: 'fixture/Box.class', data: classFile(), method: 0 }]);
  bad.writeUInt32LE(0, 0);
  p.write('lib/box-9.jar', bad);
  p.write('lib/box-1.jar', jarFile([{ name: 'fixture/Box.class', data: classFile() }]));
  const r = p.run('op=sig', 'name=fixture.Box');
  assert.equal(r.error, undefined);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /box-1\.jar/);
  assert.doesNotMatch(r.stdout.split('\n').find((line) => line.startsWith('fixture.Box')) || '', /^fixture\.Box\s+box-9\.jar/);
});

test('sig: CRC corruption falls back even when class bytes still parse', (t) => {
  const p = project(t), bad = jarFile([{ name: 'fixture/Box.class', data: classFile(), method: 0 }]);
  const start = 30 + Buffer.byteLength('fixture/Box.class');
  bad.writeUInt16BE(62, start + 6); // Валидная версия class, но CRC архива уже неверна.
  p.write('lib/box-9.jar', bad);
  p.write('lib/box-1.jar', jarFile([{ name: 'fixture/Box.class', data: classFile() }]));
  const r = p.run('op=sig', 'name=fixture.Box');
  assert.equal(r.error, undefined);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^fixture\.Box\s+box-1\.jar/m);
  assert.match(r.stderr, /CRC/i);
});

test('sig: sole broken generic jar reports an error, not a missing class', (t) => {
  const p = project(t);
  p.write('lib/box.jar', jarFile([{ name: 'fixture/Box.class', data: classFile({ signature: '<Txxx' }) }]));
  const r = p.run('op=sig', 'name=fixture.Box');
  assert.equal(r.error, undefined);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /Ошибка:.*Signature/);
  assert.doesNotMatch(r.stdout, /не найден в jar/);
});

test('sig: corrupt jar directory is skipped while valid jar remains usable', (t) => {
  const p = project(t);
  p.write('lib/broken.jar', Buffer.from('PK truncated', 'utf8'));
  p.write('lib/box.jar', jarFile([{ name: 'fixture/Box.class', data: classFile() }]));
  const first = p.run('op=sig', 'name=fixture.Box');
  const cached = p.run('op=sig', 'name=fixture.Box');
  for (const r of [first, cached]) {
    assert.equal(r.error, undefined);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /abstract class Box/);
    assert.match(r.stderr, /пропущен broken\.jar.*jar\/ZIP/);
    assert.doesNotMatch(r.stdout + r.stderr, /RangeError|ENOENT|FATAL ERROR/);
  }
});

test('sig: bounded deflate, sizes and unsupported methods allow fallback', (t) => {
  const p = project(t);
  p.write('lib/box-1.jar', jarFile([{ name: 'fixture/Box.class', data: classFile() }]));
  const valid = jarFile([{ name: 'fixture/Box.class', data: classFile() }]);
  const cd = valid.readUInt32LE(valid.length - 6);
  const variants = [
    (b) => { b.writeUInt16LE(12, 8); b.writeUInt16LE(12, cd + 10); },
    (b) => { b.writeUInt16LE(0x0801, 6); b.writeUInt16LE(0x0801, cd + 8); },
    (b) => { b.writeUInt32LE(0x1000001, 22); b.writeUInt32LE(0x1000001, cd + 24); },
    (b) => { b.fill(0xff, 30 + Buffer.byteLength('fixture/Box.class'), cd); },
    (b) => { b.writeUInt16LE(0xffff, 28); }
  ];
  for (let i = 0; i < variants.length; i++) {
    const bytes = Buffer.from(valid); variants[i](bytes);
    p.write('lib/box-9.jar', bytes);
    const r = p.run('op=sig', 'name=fixture.Box');
    assert.equal(r.error, undefined, 'case ' + i);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^fixture\.Box\s+box-1\.jar/m);
  }
});
