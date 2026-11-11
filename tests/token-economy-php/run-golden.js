'use strict';
// Четыре генерируемые фикстуры; эталоны stdout трекнуты отдельно от локальных golden/.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');

const bx = path.resolve(__dirname, '../../skills/token-economy-php/scripts/bx.js');
const cases = {
  bitrix: [
    { op: 'info' }, { op: 'symbol', name: 'DemoListComponent' },
    { op: 'symbol', name: 'CIBlockElement::GetList' }, { op: 'outline', file: 'Demo\\Helper' },
    { op: 'component', id: 'demo:list' }, { op: 'events', query: 'OnAfterItemAdd' },
    { op: 'search', query: 'includeModule' }, { op: 'rdeps', file: 'Demo\\Helper' },
    { op: 'route', url: '/catalog/item-1/' }, { op: 'table', name: 'b_demo_item' }, { op: 'lang', query: 'Новости' },
  ],
  laravel: [
    { op: 'info' }, { op: 'routes' }, { op: 'model', name: 'Post' },
    { op: 'container', type: 'App\\Contracts\\PaymentGateway' }, { op: 'blade', name: 'posts.index' },
    { op: 'console' }, { op: 'route', url: '/posts', method: 'GET' },
    { op: 'lang', query: 'Записи' }, { op: 'symbol', name: 'App\\Models\\Post' },
    { op: 'deps', file: 'app/Http/Controllers/PostController.php' },
    { op: 'read', file: 'routes/web.php', ranges: '1-3,5-7' },
    { op: 'patch_symbol', file: 'app/Models/Post.php', symbol: 'App\\Models\\Post::comments', body: "return $this->hasMany(Comment::class);", dry: true },
  ],
  modx: [
    { op: 'info' }, { op: 'symbol', name: 'modX' },
    { op: 'outline', file: 'core/model/modx/modx.class.php', core: true },
    { op: 'search', query: 'runSnippet' }, { op: 'element', name: 'hello' },
    { op: 'tpl', name: 'templates/base.tpl' }, { op: 'rdeps', file: 'acme:hello' },
    { op: 'component', id: 'bitrix:menu', exit: 1 }, { op: 'routes', exit: 1 },
    { op: 'route', url: '/about/', exit: 1 },
  ],
  plain: [
    { op: 'info' }, { op: 'symbol', name: 'App\\Services\\Billing' },
    { op: 'outline', file: 'App\\Support\\Helper' }, { op: 'deps', file: 'src/Services/Billing.php' },
    { op: 'search', query: 'slugify' }, { op: 'routes', exit: 1 },
    { op: 'node', file: 'src/Services/Billing.php', offset: '0', limit: '1' },
    { op: 'node', file: 'index.php' },
    { op: 'outline', file: 'App\\Support\\Helper', limit: '1' },
  ],
};

function runNode(args, cwd) {
  const result = spawnSync(process.execPath, ['--max-old-space-size=128', ...args], {
    cwd, encoding: 'utf8', timeout: 15000, maxBuffer: 2 * 1024 * 1024,
  });
  assert.ifError(result.error);
  return result;
}

function runFixture(name) {
  assert.ok(cases[name], 'неизвестная фикстура: ' + name);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bx-golden-'));
  const root = path.join(base, name);
  try {
    const generated = runNode([path.join(__dirname, 'gen-' + name + '-fixture.js'), root], base);
    assert.equal(generated.status, 0, generated.stdout + generated.stderr);
    let result = '';
    for (const entry of cases[name]) {
      const { exit = 0, ...args } = entry;
      const argv = Object.entries(args).map(([key, value]) => key + '=' + value);
      const res = runNode([bx, 'root=' + root, ...argv], root);
      assert.equal(res.status, exit, name + ': ' + argv.join(' ') + '\n' + res.stdout + res.stderr);
      assert.equal(res.stderr, '', name + ': stderr');
      result += (result ? '\n' : '') + '$ ' + argv.join(' ') + '\n' + res.stdout.replace(/\r\n/g, '\n') + 'exit=' + exit + '\n';
    }
    return result;
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
}

function compare(name, text) {
  const expected = fs.readFileSync(path.join(__dirname, 'expected', name + '.txt'), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(text, expected, 'golden отличается: ' + name);
}

if (require.main === module) {
  const tag = process.argv[2] || 'check';
  if (!/^[a-zA-Z0-9_-]+$/.test(tag)) throw new Error('имя прогона: только буквы, цифры, _ и -');
  let output = null;
  if (tag !== 'check') {
    const parent = path.join(__dirname, 'golden');
    fs.mkdirSync(parent, { recursive: true });
    output = fs.mkdtempSync(path.join(parent, tag + '-'));
  }
  for (const name of Object.keys(cases)) {
    const text = runFixture(name);
    if (output) fs.writeFileSync(path.join(output, name + '.txt'), text, { flag: 'wx', encoding: 'utf8' });
    else compare(name, text);
    console.log(name + ': ' + cases[name].length + ' проверок');
  }
  console.log(output ? 'golden сохранён: ' + output : 'golden: все эталоны совпали');
}

module.exports = { cases, runFixture, compare };
