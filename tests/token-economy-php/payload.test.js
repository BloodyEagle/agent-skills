'use strict';
// F05: файловый JSON не задаёт себе границу; argv приоритетнее JSON.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const bx = path.resolve(__dirname, '../../skills/token-economy-php/scripts/bx.js');

function project(t, files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bx-payload-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  return root;
}

function run(cwd, argv, input = '') {
  const result = spawnSync(process.execPath, [bx, ...argv], {
    cwd, input, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024,
  });
  assert.ifError(result.error);
  return result;
}

function success(result) {
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
}

function rejected(result, pattern) {
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, pattern);
  return result.stdout;
}

function link(t, target, alias, directory = false) {
  try { fs.symlinkSync(target, alias, directory ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file'); }
  catch (e) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(e.code)) {
      t.skip('ссылки недоступны: ' + e.code);
      return false;
    }
    throw e;
  }
  return true;
}

const payload = JSON.stringify({ op: 'read', file: 'source.php', limit: 1 });
const files = { 'source.php': '<?php // внутренний\n', 'payload.json': '\uFEFF' + payload };

for (const rootFirst of [true, false]) {
  test('F05: root ' + (rootFirst ? 'до' : 'после') + ' @payload известен до чтения; относительный путь от root', (t) => {
    const root = project(t, files);
    const cwd = project(t, { 'payload.json': 'invalid JSON' });
    const argv = rootFirst ? ['root=' + root, '@payload.json'] : ['@payload.json', 'root=' + root];
    assert.match(success(run(cwd, argv)), /внутренний/);
    assert.equal(fs.existsSync(path.join(root, '.bx-cache')), false);
  });
}

test('F05: без argv root файловый payload ограничен cwd, его root игнорируется', (t) => {
  const outside = project(t, { 'source.php': '<?php // внешний\n' });
  const root = project(t, { ...files, 'payload.json': JSON.stringify({ op: 'read', root: outside, file: 'source.php', limit: 1 }) });
  assert.match(success(run(root, ['@payload.json'])), /внутренний/);
  fs.writeFileSync(path.join(root, 'payload.json'), JSON.stringify({ op: 'patch', root: outside,
    file: path.join(outside, 'source.php'), old: 'внешний', new: 'испорчен' }));
  const before = fs.readFileSync(path.join(outside, 'source.php'));
  rejected(run(root, ['@payload.json']), /путь вне рабочей директории/);
  assert.deepEqual(fs.readFileSync(path.join(outside, 'source.php')), before);
});

test('F05: явный argv root приоритетнее root из JSON, последнее argv root побеждает', (t) => {
  const first = project(t, { 'payload.json': 'invalid JSON' });
  const root = project(t, { ...files, 'payload.json': JSON.stringify({ op: 'read', root: first, file: 'source.php', limit: 1 }) });
  assert.match(success(run(first, ['root=' + first, '@payload.json', 'root=' + root])), /внутренний/);
});

for (const argvFirst of [true, false]) {
  test('F05: argv ' + (argvFirst ? 'до' : 'после') + ' JSON приоритетнее op/file/limit из payload', (t) => {
    const root = project(t, { ...files, 'payload.json': JSON.stringify({ op: 'create', file: 'wrong.php', text: 'wrong', limit: 20 }) });
    const explicit = ['op=read', 'file=source.php', 'limit=1'];
    const argv = argvFirst ? [...explicit, '@payload.json'] : ['@payload.json', ...explicit];
    assert.match(success(run(root, argv)), /внутренний/);
    assert.equal(fs.existsSync(path.join(root, 'wrong.php')), false);
  });
}

test('F05: несколько @JSON сливаются слева направо без смены root; positional op сохранён', (t) => {
  const outside = project(t);
  const root = project(t, { ...files,
    'first.json': JSON.stringify({ op: 'create', file: 'wrong.php', root: outside, limit: 8 }),
    'second.json': JSON.stringify({ file: 'source.php', limit: 1 }),
  });
  assert.match(success(run(root, ['read', '@first.json', '@second.json'])), /внутренний/);
  assert.equal(fs.existsSync(path.join(root, 'wrong.php')), false);
});

test('F05: JSON из stdin сохраняет root; явные argv приоритетнее stdin', (t) => {
  const root = project(t, files);
  const cwd = project(t);
  assert.match(success(run(cwd, [], JSON.stringify({ op: 'read', root, file: 'source.php', limit: 1 }))), /внутренний/);
  assert.match(success(run(cwd, ['root=' + root, 'file=source.php'], JSON.stringify({ op: 'read', root: cwd, file: 'wrong.php', limit: 1 }))), /внутренний/);
});

for (const kind of ['absolute', 'traversal', 'self-root']) {
  test('F05: внешний @payload ' + kind + ' отклонён до JSON.parse', (t) => {
    const root = project(t, files);
    const outside = project(t, { 'payload.json': 'invalid JSON' });
    const target = path.join(outside, 'payload.json');
    const ref = kind === 'traversal' ? path.relative(root, target) : target;
    if (kind === 'self-root') fs.writeFileSync(target, JSON.stringify({ root: outside, op: 'create', file: 'bad.php', text: 'bad' }));
    const before = fs.readFileSync(target);
    rejected(run(root, ['@' + ref]), /не удалось прочитать.*путь вне рабочей директории/);
    assert.deepEqual(fs.readFileSync(target), before);
    assert.equal(fs.existsSync(path.join(outside, 'bad.php')), false);
    assert.equal(fs.existsSync(path.join(root, '.bx-cache')), false);
  });
}

for (const kind of ['directory', 'missing']) {
  test('F05: @payload ' + kind + ' явно отклонён', (t) => {
    const root = project(t, files);
    if (kind === 'directory') fs.mkdirSync(path.join(root, 'not-json'));
    rejected(run(root, ['@not-json']), kind === 'directory' ? /payload должен быть обычным файлом/ : /ENOENT/);
    assert.equal(fs.existsSync(path.join(root, '.bx-cache')), false);
  });
}

for (const internal of [true, false]) {
  test('F05: файловая ссылка на ' + (internal ? 'внутренний' : 'внешний') + ' @payload', (t) => {
    const root = project(t, files);
    const other = internal ? root : project(t, { 'payload.json': 'invalid JSON' });
    const target = path.join(other, 'payload.json');
    const before = fs.readFileSync(target);
    if (!link(t, target, path.join(root, 'alias.json'))) return;
    const result = run(root, ['@alias.json']);
    if (internal) assert.match(success(result), /внутренний/);
    else rejected(result, /путь вне рабочей директории/);
    assert.deepEqual(fs.readFileSync(target), before);
  });
}

for (const internal of [true, false]) {
  test('F05: junction на ' + (internal ? 'внутренний' : 'внешний') + ' каталог @payload', (t) => {
    const root = project(t, { ...files, 'data/payload.json': payload });
    const target = internal ? path.join(root, 'data') : project(t, { 'payload.json': 'invalid JSON' });
    const before = fs.readFileSync(path.join(target, 'payload.json'));
    if (!link(t, target, path.join(root, 'alias'), true)) return;
    const result = run(root, ['@alias/payload.json']);
    if (internal) assert.match(success(result), /внутренний/);
    else rejected(result, /путь вне рабочей директории/);
    assert.deepEqual(fs.readFileSync(path.join(target, 'payload.json')), before);
  });
}

for (const directory of [false, true]) {
  test('F05: dangling ' + (directory ? 'junction' : 'file-symlink') + ' не считается новым payload', (t) => {
    const root = project(t, files);
    if (!link(t, path.join(root, 'gone'), path.join(root, 'alias'), directory)) return;
    rejected(run(root, ['@' + (directory ? 'alias/payload.json' : 'alias')]), /не удалось разрешить путь/);
    assert.equal(fs.existsSync(path.join(root, '.bx-cache')), false);
  });
}

test('F05: root-junction и абсолютный внутренний payload работают', (t) => {
  const root = project(t, files);
  const holder = project(t);
  const alias = path.join(holder, 'root');
  if (!link(t, root, alias, true)) return;
  assert.match(success(run(holder, ['@payload.json', 'root=' + alias])), /внутренний/);
  assert.match(success(run(holder, ['root=' + alias, '@' + path.join(root, 'payload.json')])), /внутренний/);
});
