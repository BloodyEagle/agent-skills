'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const { project, classFile, CLASSFILE } = require('./helpers');
const CF = require(CLASSFILE);

test('sig: truncated generic class Signature fails clearly without hanging', (t) => {
  const p = project(t);
  p.write('target/classes/fixture/Box.class', classFile({ signature: '<Txxx' }));
  const r = p.run('op=sig', 'name=fixture.Box');
  assert.equal(r.error, undefined, 'sig exceeded the bounded child timeout: ' + r.error?.code);
  assert.equal(r.signal, null);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /Ошибка:.*(?:сигнатур|Signature)/i);
  assert.doesNotMatch(r.stdout + r.stderr, /RangeError|TypeError|ENOENT|FATAL ERROR/);
});

function rejectSignatures(t, cases) {
  const p = project(t);
  const file = p.write('cases.json', JSON.stringify(cases.map(([label, spec]) => ({ label, bytes: classFile(spec).toString('base64') }))));
  const code = `
    const fs = require('node:fs');
    const assert = require('node:assert/strict');
    const CF = require(process.argv[1]);
    for (const c of JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))) {
      process.stdout.write(c.label + '\\n');
      assert.throws(() => CF.describe(CF.parseClass(Buffer.from(c.bytes, 'base64')), {}), /сигнатура Signature/i, c.label);
    }
  `;
  const r = cp.spawnSync(process.execPath, ['--max-old-space-size=64', '-e', code, CLASSFILE, file], {
    cwd: p.dir, env: p.env, encoding: 'utf8', timeout: 2500, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024
  });
  assert.equal(r.error, undefined, 'bounded parser failed after ' + r.stdout);
  assert.equal(r.status, 0, r.stdout + r.stderr);
}

test('class Signature: unterminated type variables, generics and invalid bounds are rejected', (t) => {
  const malformed = ['<T:TT>Ljava/lang/Object;', '<T:Ljava/util/List<TT;', '<', '', '<>Ljava/lang/Object;', '<T::>Ljava/lang/Object;', '<T:I>Ljava/lang/Object;', 'I', 'Ljava/lang/Object', 'L;', 'Ljava//lang/Object;', 'Ljava/lang/Object;I', 'Ljava/util/List<>;', 'Ljava/util/List<I>;', 'Ljava/util/List<+>;', 'Ljava/util/List<T;>;'];
  rejectSignatures(t, malformed.map((signature, i) => ['class-' + i, { signature }]));
});

test('field and method Signatures reject truncation, invalid tokens and trailing data', (t) => {
  const fields = ['TT', 'Ljava/util/List<TT;', '[', 'V', 'TT;garbage', 'Ljava/util/List<>;', 'Ljava/util/List<I>;', 'Ljava/lang/String;;', ''];
  const methods = ['(', '(TT', '(Ljava/lang/String;', '(I', '()','(V)V', '()Vgarbage', '()V^', '()V^[I', '<T:Ljava/lang/Object;>()TT', 'TT;', ''];
  rejectSignatures(t, [
    ...fields.map((signature, i) => ['field-' + i, { fields: [{ name: 'value', descriptor: 'Ljava/lang/Object;', signature }] }]),
    ...methods.map((signature, i) => ['method-' + i, { methods: [{ name: 'get', descriptor: '()V', signature }] }])
  ]);
});

test('valid generic class, nested types, method bounds, wildcards and arrays retain signatures', () => {
  const bytes = classFile({
    signature: '<T:Ljava/lang/Object;U::Ljava/lang/Comparable<TU;>;>Ljava/lang/Object;Ljava/io/Serializable;',
    fields: [
      { name: 'values', descriptor: 'Ljava/util/Map;', signature: 'Ljava/util/Map<Ljava/lang/String;Ljava/util/List<+TT;>;>;' },
      { name: 'nested', descriptor: 'Lfixture/Outer$Inner;', signature: 'Lfixture/Outer<TT;>.Inner<TU;>;' },
      { name: 'unknown', descriptor: 'Ljava/util/List;', signature: 'Ljava/util/List<*>;' }
    ],
    methods: [{ name: 'copy', descriptor: '(Ljava/lang/Object;[Ljava/lang/String;)Ljava/lang/Object;', signature: '<E:Ljava/lang/Exception;>(TT;[Ljava/lang/String;)TT;^TE;', parameters: ['value', 'names'], exceptions: ['java/lang/Exception'], access: 0x0481, deprecated: true }]
  });
  assert.deepEqual(CF.describe(CF.parseClass(bytes), {}), [
    'abstract class Box<T, U extends Comparable<U>> implements Serializable',
    '  Map<String, List<? extends T>> values',
    '  Outer<T>.Inner<U> nested',
    '  List<?> unknown',
    '  @Deprecated abstract <E extends Exception> T copy(T value, String... names) throws E'
  ]);
  assert.deepEqual(CF.describe(CF.parseClass(classFile({ signature: '<T:>Ljava/lang/Object;' })), {}), ['abstract class Box<T>']);
});

test('classfile: every truncated byte prefix reports a bounded class-file error', (t) => {
  const p = project(t);
  const file = p.write('Box.class', classFile({ signature: '<T:Ljava/lang/Object;>Ljava/lang/Object;', fields: [{ name: 'value', descriptor: 'Ljava/lang/Object;', signature: 'TT;' }], methods: [{ name: 'get', descriptor: '()Ljava/lang/Object;', signature: '()TT;', exceptions: ['java/io/IOException'], parameters: [], deprecated: true }] }));
  const code = `
    const fs = require('node:fs'), assert = require('node:assert/strict');
    const CF = require(process.argv[1]), bytes = fs.readFileSync(process.argv[2]);
    CF.describe(CF.parseClass(bytes), {});
    for (let i = 0; i < bytes.length; i++) {
      assert.throws(() => CF.parseClass(bytes.subarray(0, i)), /class-файл/i, 'truncated at byte ' + i);
    }
  `;
  const r = cp.spawnSync(process.execPath, ['--max-old-space-size=64', '-e', code, CLASSFILE, file], { cwd: p.dir, env: p.env, encoding: 'utf8', timeout: 2500, killSignal: 'SIGKILL' });
  assert.equal(r.error, undefined);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('classfile: invalid attribute sizes and constant-pool references fail explicitly', () => {
  const valid = classFile({ signature: 'Ljava/lang/Object;' });
  const wrongLength = Buffer.from(valid);
  wrongLength.writeUInt32BE(0xffffffff, valid.length - 6);
  const shortLength = Buffer.from(valid);
  shortLength.writeUInt32BE(1, valid.length - 6);
  const badReference = Buffer.from(valid);
  badReference.writeUInt16BE(0xffff, valid.length - 2);
  const badPoolCount = Buffer.from(valid);
  badPoolCount.writeUInt16BE(0, 8);
  for (const bytes of [wrongLength, shortLength, badReference, badPoolCount, Buffer.concat([valid, Buffer.from([0])])]) {
    assert.throws(() => CF.parseClass(bytes), /class-файл/i);
  }
});

test('Signature parser: all truncated prefixes, deep nesting and deterministic mutations terminate', (t) => {
  const sig = '<T:Ljava/lang/Object;>Ljava/util/AbstractList<TT;>;';
  const cases = Array.from({ length: sig.length }, (_, i) => ['prefix-' + i, { signature: sig.slice(0, i) }]);
  cases.push(['deep-generics', { signature: 'Lfixture/X<'.repeat(180) + 'TT;' + '>;'.repeat(180) }]);
  cases.push(['deep-array', { fields: [{ name: 'value', descriptor: 'Ljava/lang/Object;', signature: '['.repeat(256) + 'I' }] }]);
  // Вставка запрещённого токена в каждой позиции гарантированно портит грамматику.
  for (let i = 0; i <= sig.length; i++) cases.push(['mutation-' + i, { signature: sig.slice(0, i) + ')' + sig.slice(i) }]);
  rejectSignatures(t, cases);
});
