'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const zlib = require('node:zlib');

const CLI = path.resolve(__dirname, '../../skills/token-economy-java/scripts/jv.js');
const CLASSFILE = path.resolve(__dirname, '../../skills/token-economy-java/scripts/lib/classfile.js');

function project(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-regression-'));
  const root = path.join(dir, 'project');
  const home = path.join(dir, 'home');
  fs.mkdirSync(root);
  fs.mkdirSync(home);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, GRADLE_USER_HOME: path.join(home, '.gradle'), JV_JARS: path.join(root, 'lib'), NODE_OPTIONS: '' };
  const write = (name, data) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data, typeof data === 'string' ? 'utf8' : undefined);
    return file;
  };
  const run = (...args) => cp.spawnSync(process.execPath, ['--max-old-space-size=64', CLI, 'root=' + root, ...args], {
    cwd: dir, env, encoding: 'utf8', timeout: 2500, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024
  });
  return { dir, root, home, env, write, run };
}

function u2(n) { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; }
function u4(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; }

function classFile(opts = {}) {
  const pool = [], strings = new Map(), classes = new Map();
  const utf = (value) => {
    if (strings.has(value)) return strings.get(value);
    const bytes = Buffer.from(value, 'utf8');
    pool.push(Buffer.concat([Buffer.from([1]), u2(bytes.length), bytes]));
    strings.set(value, pool.length);
    return pool.length;
  };
  const cls = (name) => {
    if (classes.has(name)) return classes.get(name);
    const idx = utf(name);
    pool.push(Buffer.concat([Buffer.from([7]), u2(idx)]));
    classes.set(name, pool.length);
    return pool.length;
  };
  const attrs = (spec) => {
    const list = [];
    const add = (name, data) => list.push(Buffer.concat([u2(utf(name)), u4(data.length), data]));
    if (spec.signature !== undefined) add('Signature', u2(utf(spec.signature)));
    if (spec.deprecated) add('Deprecated', Buffer.alloc(0));
    if (spec.exceptions) add('Exceptions', Buffer.concat([u2(spec.exceptions.length), ...spec.exceptions.map((n) => u2(cls(n)))]));
    if (spec.parameters) add('MethodParameters', Buffer.concat([Buffer.from([spec.parameters.length]), ...spec.parameters.map((n) => Buffer.concat([u2(n ? utf(n) : 0), u2(0)]))]));
    return Buffer.concat([u2(list.length), ...list]);
  };
  const member = (m, access) => Buffer.concat([u2(m.access === undefined ? access : m.access), u2(utf(m.name)), u2(utf(m.descriptor)), attrs(m)]);
  const header = Buffer.concat([u2(opts.access === undefined ? 0x0421 : opts.access), u2(cls(opts.name || 'fixture/Box')), u2(cls('java/lang/Object')), u2(0)]);
  const fields = (opts.fields || []).map((m) => member(m, 1));
  const methods = (opts.methods || []).map((m) => member(m, 0x0401));
  const attributes = attrs(opts);
  return Buffer.concat([u4(0xCAFEBABE), u2(0), u2(61), u2(pool.length + 1), ...pool, header, u2(fields.length), ...fields, u2(methods.length), ...methods, attributes]);
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const b of bytes) {
    crc ^= b;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function jarFile(entries, comment = Buffer.alloc(0)) {
  const locals = [], central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8'), data = Buffer.from(e.data);
    const method = e.method === undefined ? 8 : e.method;
    const packed = method === 8 ? zlib.deflateRawSync(data) : data;
    const crc = crc32(data), h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(method, 8);
    h.writeUInt32LE(crc, 14); h.writeUInt32LE(packed.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(name.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x0800, 8); cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(packed.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(offset, 42);
    const local = Buffer.concat([h, name, packed]);
    locals.push(local); central.push(cd, name); offset += local.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...locals, directory, end, comment]);
}

module.exports = { CLI, CLASSFILE, project, classFile, jarFile };
