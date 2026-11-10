'use strict';
// Регрессии PHP-аудита: только stdlib, собственные временные проекты, bounded-подпроцессы.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const fsx = require('../../skills/token-economy-php/scripts/lib/fsx');
const php = require('../../skills/token-economy-php/scripts/lib/php');
const index = require('../../skills/token-economy-php/scripts/lib/index');
const { detectMode } = require('../../skills/token-economy-php/scripts/lib/detect');
const { pcreToRegExp } = require('../../skills/token-economy-php/scripts/lib/bitrix');

const bx = path.resolve(__dirname, '../../skills/token-economy-php/scripts/bx.js');
const phpFile = path.join(path.dirname(bx), 'lib/php.js');

function project(t, files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bx-audit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [rel, data] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);
  }
  return root;
}

function cli(root, args) {
  return spawnSync(process.execPath, ['--max-old-space-size=64', bx, 'root=' + root,
    ...Object.entries(args).map(([key, value]) => key + '=' + value)], {
    cwd: root, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024,
  });
}

function success(result) {
  assert.ifError(result.error);
  assert.equal(result.status, 0, (result.stdout + result.stderr).slice(0, 1200));
  return result.stdout;
}

function denied(result) {
  assert.ifError(result.error);
  assert.equal(result.status, 1, (result.stdout + result.stderr).slice(0, 1200));
  assert.match(result.stdout, /путь вне рабочей директории/);
}

function parseBounded(src) {
  const result = spawnSync(process.execPath, ['--max-old-space-size=64', '-e',
    'process.stdout.write(JSON.stringify(require(process.argv[1]).parsePhp(process.argv[2])))', phpFile, src], {
    cwd: __dirname, encoding: 'utf8', timeout: 2000, maxBuffer: 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, 'парсер не завершился: ' + (result.stderr || '').slice(0, 500));
  return JSON.parse(result.stdout);
}

function junction(t, target, link) {
  try { fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (e) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(e.code)) { t.skip('ссылки недоступны: ' + e.code); return false; }
    throw e;
  }
  return true;
}

const bitrixFiles = { 'bitrix/modules/main/include.php': '<?php\n', 'index.php': '<?php\n' };
const modxFiles = {
  'core/model/modx/modx.class.php': '<?php class modX { public function runSnippet() {} } // CORE_ONLY_TOKEN\n',
  'core/src/Revolution/Service.php': '<?php class CoreService {}\n',
  'manager/index.php': '<?php\n', 'connectors/index.php': '<?php\n',
  'core/vendor/lib/Hidden.php': '<?php class HiddenVendor {}\n',
  'core/components/acme/elements/snippets/hello.php': '<?php return "hello";\n',
  'core/components/acme/lexicon/ru/default.inc.php': '<?php $_lang["hello"] = "Привет";\n',
  'templates/base.tpl': '[[hello]]\n',
};
const laravelFiles = {
  'composer.json': '{"require":{"laravel/framework":"^12.0"}}',
  'routes/web.php': [
    '<?php', 'use App\\Http\\Controllers\\DocController;',
    'Route::post("/docs", [DocController::class, "update"]);',
    'Route::get("/docs", [DocController::class, "index"]);',
    'Route::delete("/docs", [DocController::class, "destroy"]);',
    'Route::match(["put", "patch"], "/docs", [DocController::class, "replace"]);',
    'Route::any("/any", [DocController::class, "any"]);',
    'Route::get("/head", [DocController::class, "index"]);',
    'Route::post("/only-post", [DocController::class, "update"]);',
    'Route::get("/missing", [DocController::class, "missing"]);',
    'Route::get("/package", [DocController::class, "package"]);',
  ].join('\n'),
  'app/Http/Controllers/DocController.php': [
    '<?php', 'namespace App\\Http\\Controllers;', 'class DocController {',
    'public function index() { return view("docs.index"); }',
    'public function update() {}', 'public function destroy() {}', 'public function replace() {}',
    'public function any() {}', 'public function missing() { return view("docs.missing"); }',
    'public function package() { return view("mail::message"); }', '}',
  ].join('\n'),
  'resources/views/docs/index.blade.php': '<h1>Документы</h1>\n',
};

test('P0: атрибуты свойства, метода и параметра сохраняют класс и методы', () => {
  const data = parseBounded('<?php class Post { #[ORM\\Column(type: "string", options: ["x" => [1]])] private string $title; #[Route("/posts")] public function show(#[SensitiveParameter] string $key): string { return $key; } public function next() {} }');
  assert.equal(data.decls.length, 1);
  assert.equal(data.decls[0].name, 'Post');
  assert.deepEqual(data.decls[0].members.filter((m) => m.k === 'method').map((m) => m.n), ['show', 'next']);
});

test('P0: атрибут класса не скрывает объявление', () => {
  const data = parseBounded('<?php #[ORM\\Entity] class Post { public function show() {} }');
  assert.equal(data.decls[0].name, 'Post');
  assert.equal(data.decls[0].members[0].n, 'show');
});

test('P0: чужая закрывающая скобка не съедает открывающую скобку класса', () => {
  const tokens = php.lex('<?php { ] () }');
  const matches = php.matchBrackets(tokens);
  assert.equal(matches[0], tokens.length - 1);
  assert.equal(matches[1], -1);
  assert.equal(matches[2], 3);
});

for (const [name, source] of [
  ['незакрытый класс', '<?php class Broken {'],
  ['незакрытый групповой use', '<?php use Vendor\\{Thing;'],
  ['непарная скобка внутри класса', '<?php class Broken { ] public function ok() {} }'],
]) test('P0: прогресс парсера — ' + name, () => {
  const data = parseBounded(source);
  assert.ok(data.decls.length <= 1, 'повторных объявлений быть не должно');
});

for (const op of ['read', 'patch', 'create']) test('P1: ' + op + ' не выходит через junction за корень', (t) => {
  const base = project(t, { 'root/keep.php': '<?php\n', 'outside/existing.php': '<?php // before\n' });
  const root = path.join(base, 'root'), outside = path.join(base, 'outside');
  if (!junction(t, outside, path.join(root, 'escape'))) return;
  const args = op === 'read' ? { op, file: 'escape/existing.php' }
    : op === 'patch' ? { op, file: 'escape/existing.php', old: 'before', new: 'after' }
      : { op, file: 'escape/new/deep/file.php', text: '<?php // new', enc: 'utf8' };
  denied(cli(root, args));
  assert.equal(fs.readFileSync(path.join(outside, 'existing.php'), 'utf8'), '<?php // before\n');
  assert.equal(fs.existsSync(path.join(outside, 'new')), false);
});

test('P1: junction самого корня и внутренняя ссылка допустимы; отсутствующие предки создаются', (t) => {
  const base = project(t, { 'root/data/existing.php': '<?php // before\n' });
  const root = path.join(base, 'root');
  if (!junction(t, root, path.join(base, 'alias'))) return;
  if (!junction(t, path.join(root, 'data'), path.join(root, 'internal'))) return;
  success(cli(path.join(base, 'alias'), { op: 'patch', file: 'internal/existing.php', old: 'before', new: 'after' }));
  success(cli(root, { op: 'create', file: 'new/deep/file.php', text: '<?php', enc: 'utf8' }));
  assert.equal(fs.readFileSync(path.join(root, 'data/existing.php'), 'utf8'), '<?php // after\n');
  assert.equal(fs.existsSync(path.join(root, 'new/deep/file.php')), true);
});

test('P1: имя ..hidden.php не является выходом за корень', (t) => {
  const root = project(t);
  success(cli(root, { op: 'create', file: '..hidden.php', text: '<?php', enc: 'utf8' }));
});

test('P1: кэш индекса не записывается через внешнюю junction', (t) => {
  const base = project(t, { 'root/main.php': '<?php class Main {}\n', 'outside/keep.txt': 'keep' });
  const root = path.join(base, 'root'), outside = path.join(base, 'outside');
  if (!junction(t, outside, path.join(root, '.bx-cache'))) return;
  denied(cli(root, { op: 'build' }));
  assert.deepEqual(fs.readdirSync(outside), ['keep.txt']);
});

for (const [method, action] of [['GET', 'index'], ['POST', 'update'], ['delete', 'destroy'], ['PATCH', 'replace']]) {
  test('P1: Laravel route учитывает method=' + method, (t) => {
    const output = success(cli(project(t, laravelFiles), { op: 'route', url: '/docs', method }));
    assert.match(output, new RegExp('маршрут: [^\\n]+ → DocController@' + action + '(?:\\s|$)'));
    assert.doesNotMatch(output, /также подходят/);
  });
}

test('P1: Laravel route по умолчанию GET, а не первый POST', (t) => {
  const root = project(t, laravelFiles);
  assert.match(success(cli(root, { op: 'route', url: '/docs' })), /маршрут: GET[^\n]+DocController@index/);
  assert.match(success(cli(root, { op: 'route', url: '/only-post' })), /маршрут не найден/);
});

test('P1: Laravel route поддерживает HEAD для GET и ANY', (t) => {
  const root = project(t, laravelFiles);
  assert.match(success(cli(root, { op: 'route', url: '/head', method: 'HEAD' })), /DocController@index/);
  assert.match(success(cli(root, { op: 'route', url: '/any', method: 'OPTIONS' })), /DocController@any/);
});

test('P1: неизвестный HTTP-метод явно отклоняется', (t) => {
  const result = cli(project(t, laravelFiles), { op: 'route', url: '/docs', method: 'TYPO' });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /method|HTTP/);
});

test('P2: MODX исключает ядро, но не extras и их лексиконы; core=true включает ядро', (t) => {
  const root = project(t, modxFiles);
  const normal = index.buildIndex(index.makeCtx({ root })).index;
  assert.equal(normal.mode, 'modx');
  assert.equal(normal.nodes.some((n) => n.o === 'core'), false);
  assert.ok(normal.nodes.some((n) => n.p.includes('components/acme/lexicon')));
  assert.ok(normal.nodes.some((n) => n.el && n.el.id === 'acme:hello'));
  const core = index.ensureIndex(index.makeCtx({ root, core: true }));
  assert.ok(core.nodes.some((n) => n.p === 'core/model/modx/modx.class.php'));
  assert.equal(core.nodes.some((n) => n.p.includes('/vendor/')), false);
});

test('P2: MODX search соблюдает core', (t) => {
  const root = project(t, modxFiles);
  assert.match(success(cli(root, { op: 'search', query: 'CORE_ONLY_TOKEN' })), /совпадений нет/);
  assert.match(success(cli(root, { op: 'search', query: 'CORE_ONLY_TOKEN', core: true })), /core\/model\/modx/);
});

test('P2: ошибка профильной операции называет текущий режим MODX', (t) => {
  const result = cli(project(t, modxFiles), { op: 'component', id: 'bitrix:menu' });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /здесь режим — MODX/);
  assert.doesNotMatch(result.stdout, /здесь режим — Laravel/);
});

test('P2: атомарная запись не трогает чужой .bxtmp и использует уникальные имена', (t) => {
  const root = project(t, { 'main.php': 'before', 'main.php.bxtmp': 'keep' });
  const file = path.join(root, 'main.php'), temps = [];
  const original = fs.renameSync;
  fs.renameSync = (from, to) => { temps.push(from); return original(from, to); };
  try { fsx.writeAtomic(file, Buffer.from('one')); fsx.writeAtomic(file, Buffer.from('two')); }
  finally { fs.renameSync = original; }
  assert.equal(fs.readFileSync(file, 'utf8'), 'two');
  assert.equal(fs.readFileSync(file + '.bxtmp', 'utf8'), 'keep');
  assert.equal(new Set(temps).size, 2);
  assert.deepEqual(fs.readdirSync(root).sort(), ['main.php', 'main.php.bxtmp']);
});

test('P2: неудачный rename сохраняет исходник и убирает только собственный tmp', (t) => {
  const root = project(t, { 'main.php': 'before', 'keep.tmp': 'keep' });
  const file = path.join(root, 'main.php'), original = fs.renameSync;
  fs.renameSync = () => { throw Object.assign(new Error('test rename'), { code: 'EACCES' }); };
  try { assert.throws(() => fsx.writeAtomic(file, Buffer.from('after')), /test rename/); }
  finally { fs.renameSync = original; }
  assert.equal(fs.readFileSync(file, 'utf8'), 'before');
  assert.deepEqual(fs.readdirSync(root).sort(), ['keep.tmp', 'main.php']);
});

test('P2: saveJson не перезаписывает чужой фиксированный .tmp', (t) => {
  const root = project(t, { 'main.php': '<?php class Main {}', '.bx-cache/index.json.tmp': 'keep' });
  index.buildIndex(index.makeCtx({ root }));
  assert.equal(fs.readFileSync(path.join(root, '.bx-cache/index.json.tmp'), 'utf8'), 'keep');
});

test('P2: перекрывающиеся сборки индекса не делят один tmp', (t) => {
  const root = project(t, { 'main.php': '<?php class Main {}' });
  const ctx = index.makeCtx({ root });
  const original = fs.renameSync;
  let overlap = false;
  fs.renameSync = (from, to) => {
    if (!overlap && path.basename(to) === 'index.json') {
      overlap = true;
      index.buildIndex(ctx);
    }
    return original(from, to);
  };
  try { assert.equal(index.buildIndex(ctx).index.nodes.length, 1); }
  finally { fs.renameSync = original; }
  assert.equal(overlap, true, 'проверка должна попасть между записью tmp и rename');
  assert.equal(index.ensureIndex(ctx).nodes[0].decls[0].name, 'Main');
});

for (const boundary of ['stat', 'read']) test('P2: файл исчезает перед ' + boundary + ' — индекс жив, ID и рёбра согласованы', (t) => {
  const root = project(t, {
    'a-gone.php': '<?php class Gone {}', 'b-used.php': '<?php class Used {}',
    'c-user.php': '<?php require __DIR__ . "/b-used.php";',
  });
  const target = path.join(root, 'a-gone.php');
  const method = boundary === 'stat' ? 'statSync' : 'readFileSync';
  const original = fs[method];
  let calls = 0, removed = false;
  fs[method] = (file, ...rest) => {
    if (file === target && ++calls === (boundary === 'stat' ? 2 : 1)) { fs.unlinkSync(target); removed = true; }
    return original(file, ...rest);
  };
  let data;
  try { data = index.buildIndex(index.makeCtx({ root, mode: 'generic' })).index; }
  finally { fs[method] = original; }
  assert.equal(removed, true, 'repro должен удалить файл в нужной точке');
  assert.deepEqual(data.nodes.map((n) => [n.id, n.p]), [[1, 'b-used.php'], [2, 'c-user.php']]);
  assert.deepEqual(data.nodes[1].edges, [[1, 'i']]);
});

function utf16(text, be) {
  const body = Buffer.from(text, 'utf16le');
  if (be) body.swap16();
  return Buffer.concat([Buffer.from(be ? [0xFE, 0xFF] : [0xFF, 0xFE]), body]);
}

for (const be of [false, true]) {
  const enc = be ? 'utf16be' : 'utf16le';
  const text = '<?php\r\n// Привет, мир! 😀\r\nclass Greeting {}\r\n';
  test('P2: ' + enc + ' обнаруживается и round-trip сохраняет BOM/CRLF/Unicode', (t) => {
    const root = project(t, { 'greeting.php': utf16(text, be) });
    const data = fsx.readText(path.join(root, 'greeting.php'));
    assert.equal(data.enc.replace(/-/g, ''), enc);
    assert.equal(data.text, text);
    assert.equal(data.eol, 'crlf');
    assert.equal(data.bom, true);
    assert.deepEqual(fsx.encodeText(data.text, data.enc, data.bom), utf16(text, be));
  });
  test('P2: patch ' + enc + ' сохраняет байты вне замены', (t) => {
    const root = project(t, { 'greeting.php': utf16(text, be) });
    success(cli(root, { op: 'patch', file: 'greeting.php', old: 'Привет', new: 'Здравствуй' }));
    assert.deepEqual(fs.readFileSync(path.join(root, 'greeting.php')), utf16(text.replace('Привет', 'Здравствуй'), be));
    assert.match(success(cli(root, { op: 'symbol', name: 'Greeting' })), /Greeting\s+class/);
  });
  test('P2: create enc=' + enc + ' не подменяет UTF-16 на UTF-8', (t) => {
    const root = project(t);
    success(cli(root, { op: 'create', file: 'new.php', text, enc: be ? 'utf-16be' : 'utf-16le', eol: 'crlf' }));
    assert.deepEqual(fs.readFileSync(path.join(root, 'new.php')), utf16(text, be));
  });
  test('P2: некорректный ' + enc + ' явно отклоняется, не становится cp1251', (t) => {
    const root = project(t, { 'broken.php': Buffer.concat([utf16('', be), Buffer.from([0x41])]) });
    assert.throws(() => fsx.readText(path.join(root, 'broken.php')), /UTF-16|utf16|encoded data/i);
  });
}

test('P3: route не выдумывает путь отсутствующего или namespaced view', (t) => {
  const root = project(t, laravelFiles);
  const present = success(cli(root, { op: 'route', url: '/docs', method: 'GET' }));
  assert.match(present, /рендерит view: docs.index\s+→\s+resources\/views\/docs\/index.blade.php/);
  const missing = success(cli(root, { op: 'route', url: '/missing' }));
  assert.match(missing, /docs.missing/);
  assert.doesNotMatch(missing, /→\s+resources\/views\/docs\/missing.blade.php/);
  const namespaced = success(cli(root, { op: 'route', url: '/package' }));
  assert.match(namespaced, /mail::message/);
  assert.doesNotMatch(namespaced, /resources\/views\/mail::message/);
});

for (const file of ['status', 'robots.txt']) test('P3: route видит физический файл ' + file + ' без завершающего /', (t) => {
  const root = project(t, { ...bitrixFiles, [file]: 'ok\n' });
  assert.match(success(cli(root, { op: 'route', url: '/' + file })), /физический файл:/);
});

test('P3: PCRE с экранированным разделителем уже работает', () => {
  for (const [pattern, value] of [['#^/a\\#b/$#i', '/A#b/'], ['/^\\/a\\/b\\/$/i', '/a/b/'], ['~^a\\~b$~', 'a~b']]) {
    const rx = pcreToRegExp(pattern);
    assert.ok(rx && rx.test(value), pattern);
  }
});

test('P3: парные PCRE-разделители не теряют условие', () => {
  for (const pattern of ['{^/docs/[0-9]{2}$}i', '(^/docs/[0-9]{2}$)i', '[^/docs/[0-9]{2}$]i']) {
    const rx = pcreToRegExp(pattern);
    assert.ok(rx && rx.test('/DOCS/42') && !rx.test('/docs/4'), pattern);
  }
});

test('P3: пустые artisan и bitrix/ не включают чужой режим', (t) => {
  const root = project(t, { artisan: '', 'src/Main.php': '<?php class Main {}' });
  assert.equal(detectMode(root), 'generic');
  fs.unlinkSync(path.join(root, 'artisan'));
  fs.mkdirSync(path.join(root, 'bitrix'));
  assert.equal(detectMode(root), 'generic');
});

test('P3: реальные маркеры Laravel и Битрикса остаются рабочими', (t) => {
  assert.equal(detectMode(project(t, bitrixFiles)), 'bitrix');
  assert.equal(detectMode(project(t, { 'www/local/components/demo/list/component.php': '<?php' })), 'bitrix');
  assert.equal(detectMode(project(t, {
    artisan: '<?php define("LARAVEL_START", microtime(true)); require __DIR__."/bootstrap/app.php";',
    'bootstrap/app.php': '<?php return new Illuminate\\Foundation\\Application();',
  })), 'laravel');
  assert.equal(detectMode(project(t, { 'composer.json': '{"require-dev":{"laravel/lumen-framework":"^11.0"}}' })), 'laravel');
});

test('P3: подсказка про ядро не маскирует отсутствие своего файла/класса', (t) => {
  const root = project(t, bitrixFiles);
  const own = cli(root, { op: 'outline', file: 'local/missing.php' });
  assert.equal(own.status, 1);
  assert.doesNotMatch(own.stdout, /ядро не индексируется|ядро Битрикса/);
  assert.doesNotMatch(success(cli(root, { op: 'symbol', name: 'OwnMissing' })), /ядро Битрикса/);
  const core = cli(root, { op: 'outline', file: 'bitrix/modules/main/missing.php' });
  assert.equal(core.status, 1);
  assert.match(core.stdout, /ядро/);
});

test('P0: незакрытый групповой use после запятой не возвращает парсер назад', () => {
  const data = parseBounded('<?php use Other, Vendor\\{Thing;');
  assert.ok(data.imports.length <= 2);
});

test('P0: индекс Laravel и автокодировка create работают на классе с атрибутами', (t) => {
  const root = project(t, { ...laravelFiles,
    'app/Models/Attributed.php': '<?php #[Entity] class Attributed { #[Column] private string $name; #[Listener] public function handle() {} }',
  });
  assert.match(success(cli(root, { op: 'symbol', name: 'Attributed::handle' })), /Attributed::handle\s+method/);
  success(cli(root, { op: 'create', file: 'new.php', text: '<?php // Привет\n' }));
});

test('P1: Laravel resource update подходит для PUT и PATCH', (t) => {
  const root = project(t, { ...laravelFiles,
    'routes/web.php': '<?php Route::resource("docs", DocController::class)->only(["update"]);',
  });
  for (const method of ['PUT', 'PATCH']) {
    assert.match(success(cli(root, { op: 'route', url: '/docs/7', method })), /DocController@update/);
  }
});

test('P1: ссылки на файлы наружу не читаются и не индексируются', (t) => {
  const base = project(t, { 'root/main.php': '<?php class Main {}', 'outside/secret.php': '<?php // EXTERNAL_TOKEN' });
  const root = path.join(base, 'root');
  try { fs.symlinkSync(path.join(base, 'outside/secret.php'), path.join(root, 'linked.php'), 'file'); }
  catch (e) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(e.code)) { t.skip('файловые symlink недоступны: ' + e.code); return; }
    throw e;
  }
  denied(cli(root, { op: 'read', file: 'linked.php' }));
  denied(cli(root, { op: 'patch', file: 'linked.php', old: 'EXTERNAL_TOKEN', new: 'changed' }));
  assert.equal(fsx.listFiles(root, '', ['.php'], 'generic').includes('linked.php'), false);
  assert.match(success(cli(root, { op: 'search', query: 'EXTERNAL_TOKEN' })), /совпадений нет/);
});

test('P1: dangling junction не превращается в новые каталоги снаружи', (t) => {
  const base = project(t, { 'root/main.php': '<?php', 'outside/keep.txt': 'keep' });
  const root = path.join(base, 'root'), outside = path.join(base, 'outside');
  if (!junction(t, outside, path.join(root, 'escape'))) return;
  fs.rmSync(outside, { recursive: true });
  const result = cli(root, { op: 'create', file: 'escape/new/deep.php', text: '<?php', enc: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /путь/);
  assert.equal(fs.existsSync(outside), false);
});

test('P2: атомарный create не заменяет файл, появившийся перед публикацией', (t) => {
  const root = project(t), file = path.join(root, 'new.php'), original = fs.linkSync;
  let concurrent = false;
  fs.linkSync = (from, to) => { concurrent = true; fs.writeFileSync(to, 'other writer'); return original(from, to); };
  try { assert.throws(() => fsx.writeAtomic(file, Buffer.from('ours'), { root, create: true }), { code: 'EEXIST' }); }
  finally { fs.linkSync = original; }
  assert.equal(concurrent, true);
  assert.equal(fs.readFileSync(file, 'utf8'), 'other writer');
  assert.deepEqual(fs.readdirSync(root), ['new.php']);
});

test('P1: route не читает urlrewrite через внешний docroot-junction', (t) => {
  const base = project(t, {
    'root/main.php': '<?php', 'outside/bitrix/modules/main/include.php': '<?php',
    'outside/urlrewrite.php': '<?php $arUrlRewrite = [["CONDITION" => "#^/protected/#", "PATH" => "/outside.php"]];',
  });
  const root = path.join(base, 'root');
  if (!junction(t, path.join(base, 'outside'), path.join(root, 'www'))) return;
  denied(cli(root, { op: 'route', url: '/protected/' }));
});
