'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { project } = require('./helpers');

function ok(r) {
  assert.equal(r.error, undefined);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return r.stdout;
}

function refused(r) {
  assert.equal(r.error, undefined);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /Ошибка:.*(?:вне рабочей директории|путь|ссылк)/i);
  assert.doesNotMatch(r.stdout + r.stderr, /ENOENT|RangeError|TypeError/);
}

test('paths: ..foo.java is a legal filename for create, read and patch', (t) => {
  const p = project(t);
  ok(p.run('op=create', 'file=..foo.java', 'text=class Before {}'));
  assert.match(ok(p.run('op=read', 'file=..foo.java')), /class Before/);
  ok(p.run('op=patch', 'file=..foo.java', 'old=Before', 'new=После'));
  assert.equal(fs.readFileSync(path.join(p.root, '..foo.java'), 'utf8'), 'class После {}');
});

test('paths: lexical traversal and absolute external paths are refused', (t) => {
  const p = project(t), outside = path.join(p.dir, 'Outside.java');
  fs.writeFileSync(outside, 'class Outside {}', 'utf8');
  for (const file of ['../Outside.java', outside]) {
    refused(p.run('op=read', 'file=' + file));
    refused(p.run('op=patch', 'file=' + file, 'old=Outside', 'new=Corrupt'));
  }
  refused(p.run('op=create', 'file=../new/Created.java', 'text=class Created {}'));
  assert.equal(fs.readFileSync(outside, 'utf8'), 'class Outside {}');
  assert.equal(fs.existsSync(path.join(p.dir, 'new')), false);
});

test('paths: external junction/symlink and missing descendants cannot be read or written', (t) => {
  const p = project(t), outside = path.join(p.dir, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'Outside.java'), 'class Outside {}', 'utf8');
  fs.symlinkSync(outside, path.join(p.root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  refused(p.run('op=read', 'file=escape/Outside.java'));
  refused(p.run('op=patch', 'file=escape/Outside.java', 'old=Outside', 'new=Corrupt'));
  refused(p.run('op=create', 'file=escape/missing/deeper/New.java', 'text=class New {}'));
  assert.equal(fs.readFileSync(path.join(outside, 'Outside.java'), 'utf8'), 'class Outside {}');
  assert.equal(fs.existsSync(path.join(outside, 'missing')), false);
});

test('paths: in-root junction and new descendant directories remain usable', (t) => {
  const p = project(t);
  p.write('source/Inside.java', 'class Inside {}');
  fs.symlinkSync(path.join(p.root, 'source'), path.join(p.root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.match(ok(p.run('op=read', 'file=alias/Inside.java')), /class Inside/);
  ok(p.run('op=patch', 'file=alias/Inside.java', 'old=Inside', 'new=Updated'));
  ok(p.run('op=create', 'file=alias/new/deeper/Created.java', 'text=class Created {}'));
  assert.equal(fs.readFileSync(path.join(p.root, 'source/Inside.java'), 'utf8'), 'class Updated {}');
  assert.equal(fs.readFileSync(path.join(p.root, 'source/new/deeper/Created.java'), 'utf8'), 'class Created {}');
});

test('paths: dangling external junction cannot become an output directory', (t) => {
  const p = project(t), target = path.join(p.dir, 'not-created');
  fs.symlinkSync(target, path.join(p.root, 'dangling'), process.platform === 'win32' ? 'junction' : 'dir');
  refused(p.run('op=create', 'file=dangling/new/File.java', 'text=class File {}'));
  assert.equal(fs.existsSync(target), false);
});

test('paths: project cache junction never writes outside root', (t) => {
  const p = project(t), outside = path.join(p.dir, 'outside-cache');
  fs.mkdirSync(outside);
  p.write('Foo.java', 'class Foo {}');
  fs.symlinkSync(outside, path.join(p.root, '.jv-cache'), process.platform === 'win32' ? 'junction' : 'dir');
  refused(p.run('op=build'));
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('paths: a pre-existing atomic temporary hardlink must not overwrite an external file', (t) => {
  const p = project(t), outside = path.join(p.dir, 'outside.txt');
  p.write('Inside.java', 'class Before {}');
  fs.writeFileSync(outside, 'outside-original', 'utf8');
  fs.linkSync(outside, path.join(p.root, 'Inside.java.bxtmp'));
  ok(p.run('op=patch', 'file=Inside.java', 'old=Before', 'new=After'));
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside-original');
  assert.equal(fs.readFileSync(path.join(p.root, 'Inside.java'), 'utf8'), 'class After {}');
});

test('paths: external file symlink is excluded from index and search', (t) => {
  const p = project(t), outside = path.join(p.dir, 'Outside.java');
  fs.writeFileSync(outside, 'class ExternalOnly { String value = "fixture-private-value"; }', 'utf8');
  try { fs.symlinkSync(outside, path.join(p.root, 'External.java'), 'file'); }
  catch (e) { if (e.code === 'EPERM' || e.code === 'EACCES') { t.skip('file symlinks require permission on this system'); return; } throw e; }
  assert.doesNotMatch(ok(p.run('op=symbol', 'name=ExternalOnly')), /External\.java/);
  assert.doesNotMatch(ok(p.run('op=search', 'query=fixture-private-value')), /fixture-private-value|External\.java/);
});
