'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');

const cli = path.resolve(__dirname, '../../skills/token-economy-kt/scripts/kt.js');

function project(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-audit-'));
  const root = path.join(base, 'project');
  const home = path.join(base, 'home');
  fs.mkdirSync(root);
  fs.mkdirSync(home);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, KT_JARS: '' };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  const write = (rel, content) => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, typeof content === 'string' ? 'utf8' : undefined);
    return file;
  };
  const run = (params, options = {}) => spawnSync(process.execPath,
    ['--max-old-space-size=96', cli, ...(Array.isArray(params) ? params : Object.entries(params).map(([k, v]) => `${k}=${v}`))],
    { cwd: root, env, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024, ...options });
  const payload = (params) => {
    write('.kt-cache/payload.json', JSON.stringify(params));
    return spawnSync(process.execPath, ['--max-old-space-size=96', cli, '@.kt-cache/payload.json'],
      { cwd: root, env, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 });
  };
  return { base, root, home, env, write, run, payload };
}

function ok(result) {
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function rejected(result, pattern) {
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /^Ошибка: /);
  assert.match(result.stderr, pattern);
  assert.doesNotMatch(result.stderr, /\n\s+at |RangeError|TypeError|SyntaxError|EISDIR/);
}

function utf16be(text, bom = true) {
  const bytes = Buffer.from(text, 'utf16le').swap16();
  return bom ? Buffer.concat([Buffer.from([0xfe, 0xff]), bytes]) : bytes;
}

function linkDir(t, target, link) {
  try { fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('Ссылки каталогов недоступны'); return false; }
    throw error;
  }
  return true;
}

function u2(n) { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; }
function u4(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; }

function classFile({ name = 'sample/Target', desc = '(I)Ljava/lang/String;', signature, fieldSignature } = {}) {
  const cp = [];
  const utf = (s) => { const b = Buffer.from(s, 'utf8'); cp.push(Buffer.concat([Buffer.from([1]), u2(b.length), b])); return cp.length; };
  const cls = (s) => { const i = utf(s); cp.push(Buffer.concat([Buffer.from([7]), u2(i)])); return cp.length; };
  const own = cls(name), sup = cls('java/lang/Object');
  const methodName = utf('ok'), methodDesc = utf(desc);
  const signatureName = signature !== undefined || fieldSignature !== undefined ? utf('Signature') : 0;
  const methodSig = signature !== undefined ? utf(signature) : 0;
  const fieldName = fieldSignature !== undefined ? utf('value') : 0;
  const fieldDesc = fieldSignature !== undefined ? utf('Ljava/lang/Object;') : 0;
  const fieldSig = fieldSignature !== undefined ? utf(fieldSignature) : 0;
  const attribute = (i) => Buffer.concat([u2(signatureName), u4(2), u2(i)]);
  const field = fieldSig ? Buffer.concat([u2(1), u2(0x0001), u2(fieldName), u2(fieldDesc), u2(1), attribute(fieldSig)]) : u2(0);
  const method = Buffer.concat([u2(1), u2(0x0401), u2(methodName), u2(methodDesc), u2(methodSig ? 1 : 0), ...(methodSig ? [attribute(methodSig)] : [])]);
  return Buffer.concat([u4(0xcafebabe), u2(0), u2(52), u2(cp.length + 1), ...cp,
    u2(0x0421), u2(own), u2(sup), u2(0), field, method, u2(0)]);
}

function repeatedMemberClass(descriptor, count = 60000, { method = false, signature, uniqueNames = false } = {}) {
  const cp = [];
  const utf = (s) => { const b = Buffer.from(s, 'utf8'); cp.push(Buffer.concat([Buffer.from([1]), u2(b.length), b])); return cp.length; };
  const cls = (s) => { const i = utf(s); cp.push(Buffer.concat([Buffer.from([7]), u2(i)])); return cp.length; };
  const own = cls('sample/Target'), sup = cls('java/lang/Object');
  const descriptorIndex = utf(descriptor);
  const signatureName = signature === undefined ? 0 : utf('Signature');
  const signatureIndex = signature === undefined ? 0 : utf(signature);
  const sharedName = uniqueNames ? 0 : utf('value');
  const members = [];
  for (let i = 0; i < count; i++) {
    const nameIndex = uniqueNames ? utf(`value${i}`) : sharedName;
    members.push(Buffer.concat([u2(0x0002), u2(nameIndex), u2(descriptorIndex), u2(signatureIndex ? 1 : 0),
      ...(signatureIndex ? [u2(signatureName), u4(2), u2(signatureIndex)] : [])]));
  }
  return Buffer.concat([u4(0xcafebabe), u2(0), u2(52), u2(cp.length + 1), ...cp,
    u2(0x0021), u2(own), u2(sup), u2(0), ...(method ? [u2(0), u2(count)] : [u2(count)]),
    ...members, ...(method ? [] : [u2(0)]), u2(0)]);
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(files, comment = Buffer.alloc(0)) {
  const locals = [], central = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const data = file.data;
    const method = file.method || 0;
    const raw = method === 8 ? zlib.deflateRawSync(data) : data;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(raw.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, raw);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc32(data), 16);
    cd.writeUInt32LE(raw.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += local.length + name.length + raw.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...locals, directory, end, comment]);
}

function jar(data = classFile(), method = 0) {
  return zip([{ name: 'sample/Target.class', data, method }]);
}

function corruptJar(t, make, extension = 'jar') {
  const p = project(t);
  p.write(`libs/bad-9.0.${extension}`, make());
  p.write('libs/good-1.0.jar', jar());
  const result = p.run({ op: 'sig', name: 'sample.Target' }, { timeout: 2500 });
  const output = ok(result);
  assert.match(output, /public class sample\.Target/);
  assert.match(output, /good-1\.0\.jar/);
  assert.match(result.stderr + output, /Предупреждение:[^\n]*bad-9\.0/);
  assert.doesNotMatch(result.stderr, /\n\s+at |RangeError|TypeError/);
}

test('patch сохраняет UTF-16BE, BOM, CRLF и символы вне BMP', (t) => {
  const p = project(t);
  const source = 'class Привет { val текст = "старый 𐐀" }\r\n';
  const file = p.write('Привет.kt', utf16be(source));
  const output = ok(p.payload({ op: 'patch', file: 'Привет.kt', old: 'старый', new: 'новый' }));
  assert.match(output, /utf-16be BOM, crlf/);
  assert.deepEqual(fs.readFileSync(file), utf16be(source.replace('старый', 'новый')));
  assert.match(ok(p.run({ op: 'read', file: 'Привет.kt' })), /новый 𐐀/);
});

test('create UTF-16BE пишет BOM и допускает последующий patch/read', (t) => {
  const p = project(t);
  ok(p.payload({ op: 'create', file: 'nested/Текст.kt', enc: 'utf-16be', text: 'val текст = "Привет 𐐀"' }));
  const file = path.join(p.root, 'nested/Текст.kt');
  assert.deepEqual(fs.readFileSync(file), utf16be('val текст = "Привет 𐐀"\n'));
  ok(p.payload({ op: 'patch', file: 'nested/Текст.kt', old: 'Привет', new: 'Спасибо' }));
  assert.deepEqual(fs.readFileSync(file), utf16be('val текст = "Спасибо 𐐀"\n'));
  assert.match(ok(p.run({ op: 'read', file: 'nested/Текст.kt' })), /Спасибо 𐐀/);
});

for (const all of [true, false]) {
  test(`patch отклоняет пустой old при all=${all} без изменения файла`, (t) => {
    const p = project(t);
    const before = Buffer.from('class Original {}\n');
    const file = p.write('Original.kt', before);
    rejected(p.payload({ op: 'patch', file: 'Original.kt', old: '', new: 'Z', all }), /пустой old/);
    assert.deepEqual(fs.readFileSync(file), before);
  });
}

test('patch UTF-8 BOM и UTF-16LE не меняет исходную кодировку', (t) => {
  const p = project(t);
  for (const [enc, prefix] of [['utf8', [0xef, 0xbb, 0xbf]], ['utf16le', [0xff, 0xfe]]]) {
    const file = p.write(`${enc}.kt`, Buffer.concat([Buffer.from(prefix), Buffer.from('val текст = "до"\r\n', enc)]));
    ok(p.payload({ op: 'patch', file: `${enc}.kt`, old: '"до"', new: '"после"' }));
    assert.deepEqual(fs.readFileSync(file), Buffer.concat([Buffer.from(prefix), Buffer.from('val текст = "после"\r\n', enc)]));
  }
});

test('внешний junction не допускает read/patch/create', (t) => {
  const p = project(t);
  const outside = path.join(p.base, 'outside');
  fs.mkdirSync(outside);
  const target = path.join(outside, 'Secret.kt');
  const before = 'class ExternalSecret {}\n';
  fs.writeFileSync(target, before);
  if (!linkDir(t, outside, path.join(p.root, 'linked'))) return;
  rejected(p.run({ op: 'read', file: 'linked/Secret.kt' }), /вне рабочей директории/);
  rejected(p.payload({ op: 'patch', file: 'linked/Secret.kt', old: 'ExternalSecret', new: 'Changed' }), /вне рабочей директории/);
  rejected(p.payload({ op: 'create', file: 'linked/new/Nested.kt', text: 'class Nested' }), /вне рабочей директории/);
  assert.equal(fs.readFileSync(target, 'utf8'), before);
  assert.equal(fs.existsSync(path.join(outside, 'new')), false);
});

test('обход и search не индексируют файлы внешнего junction', (t) => {
  const p = project(t);
  const outside = path.join(p.base, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'Secret.kt'), 'class ExternalSecret\nval secret = "OUTSIDE_SENTINEL"\n');
  p.write('Local.kt', 'class Local\n');
  if (!linkDir(t, outside, path.join(p.root, 'linked'))) return;
  assert.match(ok(p.run({ op: 'symbol', name: 'ExternalSecret' })), /Не найдено/);
  assert.doesNotMatch(ok(p.run({ op: 'search', query: 'OUTSIDE_SENTINEL' })), /Secret\.kt/);
  assert.match(ok(p.run({ op: 'symbol', name: 'Local' })), /Local\.kt/);
});

test('обход ссылок не размножает файлы и не зацикливается', (t) => {
  const p = project(t);
  p.write('src/Local.kt', 'class Local\n');
  if (!linkDir(t, p.root, path.join(p.root, 'src/loop'))) return;
  if (!linkDir(t, path.join(p.root, 'src'), path.join(p.root, 'alias'))) return;
  const output = ok(p.run({ op: 'symbol', name: 'Local' }, { timeout: 2500 }));
  assert.equal(output.split('\n').filter(line => line.includes('  class')).length, 1, output);
});

test('внутренний junction остаётся допустимым для точного read/patch/create', (t) => {
  const p = project(t);
  p.write('src/Local.kt', 'class Local\n');
  if (!linkDir(t, path.join(p.root, 'src'), path.join(p.root, 'alias'))) return;
  assert.match(ok(p.run({ op: 'read', file: 'alias/Local.kt' })), /class Local/);
  ok(p.payload({ op: 'patch', file: 'alias/Local.kt', old: 'Local', new: 'Changed' }));
  ok(p.payload({ op: 'create', file: 'alias/nested/New.kt', text: 'class New' }));
  assert.equal(fs.readFileSync(path.join(p.root, 'src/Local.kt'), 'utf8'), 'class Changed\n');
  assert.equal(fs.existsSync(path.join(p.root, 'src/nested/New.kt')), true);
});

test('кэш через внешний junction не пишет и не читает внешний индекс', (t) => {
  const p = project(t);
  p.write('Local.kt', 'class Local\n');
  const outside = path.join(p.base, 'outside-cache');
  fs.mkdirSync(outside);
  const marker = path.join(outside, 'index.json');
  fs.writeFileSync(marker, 'DO_NOT_TOUCH');
  if (!linkDir(t, outside, path.join(p.root, '.kt-cache'))) return;
  const result = p.run({ op: 'symbol', name: 'Local' });
  assert.match(ok(result), /Local\.kt/);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'DO_NOT_TOUCH');
  assert.equal(fs.existsSync(path.join(outside, '.gitignore')), false);
  assert.match(result.stderr + result.stdout, /Предупреждение:.*кэш/);
});

test('Windows: различие регистра абсолютного пути не означает выход из root', { skip: process.platform !== 'win32' }, (t) => {
  const p = project(t);
  const file = p.write('Case.kt', 'class Case\n');
  assert.match(ok(p.run({ op: 'read', file: file.toUpperCase() })), /class Case/);
  ok(p.payload({ op: 'patch', file: file.toUpperCase(), old: 'Case', new: 'Next' }));
  assert.equal(fs.readFileSync(file, 'utf8'), 'class Next\n');
});

test('read каталога возвращает понятную ошибку без стека', (t) => {
  const p = project(t);
  fs.mkdirSync(path.join(p.root, 'folder'));
  rejected(p.run({ op: 'read', file: 'folder' }), /каталог|не является файлом/);
});

test('@файл с битым JSON возвращает понятную ошибку без стека', (t) => {
  const p = project(t);
  p.write('.kt-cache/bad.json', '{"op":');
  rejected(p.run(['@.kt-cache/bad.json']), /JSON|параметр/);
});

test('Unicode: классы, функции, параметры и свойства доступны по имени', (t) => {
  const p = project(t);
  p.write('Unicode.kt', 'package пример\nclass ПриветственныйЭкран(val заголовок: String) {\n  val номер = 1\n  fun привет(имя: String): String = имя\n}\nfun поздороваться() = 1\n');
  for (const name of ['ПриветственныйЭкран', 'ПриветственныйЭкран#привет', 'ПриветственныйЭкран.номер', 'поздороваться']) {
    const output = ok(p.run({ op: 'symbol', name }));
    assert.match(output, /Unicode\.kt:/, name);
    assert.doesNotMatch(output, /Не найдено/);
  }
  assert.match(ok(p.run({ op: 'outline', file: 'Unicode.kt' })), /имя: String/);
});

test('backticks: имена с пробелами и ключевыми словами не теряются', (t) => {
  const p = project(t);
  p.write('Escaped.kt', 'class `Класс с пробелом` {\n  fun `fun val class`() = 1\n  val `имя свойства` = 2\n}\nfun `верхняя функция`() = 3\n');
  for (const name of ['Класс с пробелом', 'Класс с пробелом#fun val class', 'Класс с пробелом.имя свойства', 'верхняя функция']) {
    assert.match(ok(p.run({ op: 'symbol', name })), /Escaped\.kt:/, name);
  }
});

test('Unicode-идентификаторы вне BMP сохраняются целиком', (t) => {
  const p = project(t);
  p.write('Astral.kt', 'class \u{10400}Screen\nfun \u{10400}call() = 1\n');
  for (const name of ['\u{10400}Screen', '\u{10400}call']) assert.match(ok(p.run({ op: 'symbol', name })), /Astral\.kt:/);
});

test('класс без тела не поглощает следующую декларацию', (t) => {
  const p = project(t);
  p.write('Plain.kt', 'class Plain\nfun after() = 1\n');
  assert.match(ok(p.run({ op: 'symbol', name: 'after' })), /Plain\.kt:/);
});

test('enum без точки с запятой индексирует все записи', (t) => {
  const p = project(t);
  p.write('Color.kt', 'enum class Color { RED, GREEN, BLUE }\n');
  for (const name of ['RED', 'GREEN', 'BLUE']) assert.match(ok(p.run({ op: 'symbol', name })), /enum entry/);
});

test('enum с конструкторами, Unicode и backticks не путает тела с записями', (t) => {
  const p = project(t);
  p.write('Tone.kt', 'enum class Tone(val value: Int) {\n Красный(1), `тёмно синий`(2) { fun local() = 3 },\n Зелёный(3),\n}\nenum class Kept { YES, NO; fun value() = 1 }\n');
  for (const name of ['Красный', 'тёмно синий', 'Зелёный', 'YES', 'NO']) assert.match(ok(p.run({ op: 'symbol', name })), /enum entry/, name);
  assert.match(ok(p.run({ op: 'symbol', name: 'Kept#value' })), /Tone\.kt:/);
});

test('деструктуризация не создаёт свойства с пустым именем', (t) => {
  const p = project(t);
  p.write('Destructure.kt', 'val (first, second) = Pair(1, 2)\nclass Kept\n');
  assert.match(ok(p.run({ op: 'info' })), /top-свойств 0/);
  assert.doesNotMatch(ok(p.run({ op: 'outline', file: 'Destructure.kt' })), /\bval\s*:/);
  assert.match(ok(p.run({ op: 'symbol', name: 'Kept' })), /Destructure\.kt:/);
});

test('Java record входит в symbol и граф смешанного проекта', (t) => {
  const p = project(t);
  p.write('Person.java', 'package sample;\npublic record Person(String name) {}\n');
  p.write('Use.kt', 'package sample\nclass Use(val person: Person)\n');
  assert.match(ok(p.run({ op: 'symbol', name: 'Person' })), /Person\.java:/);
  assert.match(ok(p.run({ op: 'deps', file: 'Use.kt' })), /Person\.java/);
});

test('Groovy include без скобок обнаруживает заявленные модули', (t) => {
  const p = project(t);
  p.write('settings.gradle', "rootProject.name = 'demo'\ninclude ':app', ':core'\ninclude(':feature:login')\n");
  const output = ok(p.run({ op: 'info' }));
  assert.match(output, /модулей: 3/);
  for (const name of [':app', ':core', ':feature:login']) assert.ok(output.includes(name), output);
});

test('строки сохраняются при любом порядке атрибутов и обоих видах кавычек', (t) => {
  const p = project(t);
  p.write('app/src/main/res/values/strings.xml', `<resources>
  <!-- <string name="ghost">Ghost</string> -->
  <string translatable="false" name="before_double">До &amp; после</string>
  <string name="after_double" translatable="false">Double</string>
  <string translatable='false' name='before_single'>Single</string>
  <string name='after_single' translatable='false'>Single after</string>
  <string tools:note="name='fake' > translatable='false'" translatable='true'
      name="visible">Привет <!-- скрыто -->мир</string>
  <string name="normal">Normal</string>
</resources>`);
  for (const key of ['before_double', 'after_double', 'before_single', 'after_single']) {
    assert.match(ok(p.run({ op: 'res', name: key })), /translatable=false/, key);
    assert.match(ok(p.run({ op: 'symbol', name: key })), /string.*strings\.xml/, key);
  }
  assert.match(ok(p.run({ op: 'res', name: 'before_double' })), /До & после/);
  const visible = ok(p.run({ op: 'res', name: 'visible' }));
  assert.match(visible, /Привет мир/);
  assert.doesNotMatch(visible, /translatable=false|скрыто/);
  assert.doesNotMatch(ok(p.run({ op: 'res', name: 'normal' })), /translatable=false/);
  assert.match(ok(p.run({ op: 'res' })), /ключей 6/);
  for (const key of ['ghost', 'fake']) {
    assert.match(ok(p.run({ op: 'symbol', name: key })), /Не найдено/);
    rejected(p.run({ op: 'res', name: key }), /строка не найдена/);
  }
});

test('missing строит все разделы только из default и настоящих локалей', (t) => {
  const p = project(t);
  p.write('app/src/main/res/values/strings.xml', `<resources>
    <string name="title">Title</string>
    <string name="missing_key">Missing</string>
    <string name="qualified_translation">Default remains translatable</string>
    <string translatable='false' name='not_translated'>Ignored</string>
  </resources>`);
  for (const locale of ['en', 'en-rGB', 'b+es']) {
    p.write(`app/src/main/res/values-${locale}/strings.xml`, `<resources>
      <string name="title">Title</string>
      <string name="locale_only">Locale</string>
    </resources>`);
  }
  const qualifiers = ['night', 'land', 'w600dp', 'en-night', 'en-rGB-land', 'b+es-night', 'car'];
  for (const [i, qualifier] of qualifiers.entries()) {
    p.write(`app/src/main/res/values-${qualifier}/strings.xml`, `<resources>
      <string name="qualified_only_${i}">Config</string>
      <string name="missing_key">Not a locale translation</string>
      <string translatable="false" name="qualified_translation">Config</string>
      <string name="locale_only">Config is not an extra locale</string>
    </resources>`);
  }
  const output = ok(p.run({ op: 'res', missing: 1 }));
  const missingLocales = /missing_key — нет в: ([^\n]+)/.exec(output);
  const extraLocales = /locale_only \(есть только в: ([^)]+)\)/.exec(output);
  const qualifiedLocales = /qualified_translation — нет в: ([^\n]+)/.exec(output);
  assert.ok(missingLocales, output);
  assert.ok(extraLocales, output);
  assert.ok(qualifiedLocales, output);
  assert.deepEqual(missingLocales[1].split(', ').sort(), ['b+es', 'en', 'en-rGB']);
  assert.deepEqual(extraLocales[1].split(', ').sort(), ['b+es', 'en', 'en-rGB']);
  assert.deepEqual(qualifiedLocales[1].split(', ').sort(), ['b+es', 'en', 'en-rGB']);
  assert.doesNotMatch(output, /qualified_only_|night|land|w600dp|\bcar\b|not_translated/);
  // Обзор и name= продолжают показывать конфигурационные ресурсы.
  assert.match(ok(p.run({ op: 'res' })), /values-night/);
  assert.match(ok(p.run({ op: 'res', name: 'qualified_only_0', missing: 1 })), /night: Config/);
});

test('missing без настоящих локалей не включает конфигурационные ключи', (t) => {
  const p = project(t);
  p.write('app/src/main/res/values/strings.xml', '<resources><string name="title">Title</string></resources>');
  for (const qualifier of ['night', 'land', 'en-night', 'car']) {
    p.write(`app/src/main/res/values-${qualifier}/strings.xml`, '<resources><string name="qualified_only">Config</string></resources>');
  }
  assert.match(ok(p.run({ op: 'res', missing: 1 })), /^Локалей со строками нет — проверять missing нечего\./);
});

test('info выбирает только корневой gradle/libs.versions.toml среди TOML до и после него', (t) => {
  const p = project(t);
  p.write('aa-before.toml', '[versions]\nagp = "before"\nkotlin = "before"\n');
  const catalog = p.write('gradle/libs.versions.toml', '[versions]\nagp = "8.8.1"\nkotlin = "2.1.10"\nroom = "2.7.0"\n');
  p.write('zz-after.toml', '[versions]\nagp = "after"\nkotlin = "after"\n');
  p.write('libs.versions.toml', '[versions]\nkotlin = "wrong-root"\n');
  p.write('app/gradle/libs.versions.toml', '[versions]\nkotlin = "nested"\n');
  p.write('gradle/other.versions.toml', '[versions]\nkotlin = "custom"\n');
  const output = ok(p.run({ op: 'info' }));
  assert.match(output, /Версии: AGP 8\.8\.1 \| Kotlin 2\.1\.10 \| Room 2\.7\.0/);
  assert.doesNotMatch(output, /before|after|wrong-root|nested|custom/);
  // Тёплый индекс не подменяет источник посторонним TOML; удаление catalog убирает версии.
  p.write('zz-after.toml', '[versions]\nkotlin = "changed"\n');
  assert.match(ok(p.run({ op: 'info' })), /Kotlin 2\.1\.10/);
  fs.unlinkSync(catalog);
  assert.doesNotMatch(ok(p.run({ op: 'info' })), /Версии:|Kotlin changed|Kotlin nested|Kotlin custom/);
});

test('nav отделяет root global actions от закрытых и self-closing destinations', (t) => {
  const p = project(t);
  p.write('app/src/main/res/navigation/main.xml', `<navigation app:startDestination='@id/home'>
    <fragment android:id='@+id/home' android:name='sample.Home' android:label='Home > Next'>
      <action app:destination='@id/next' android:id='@+id/local_next'>
        <argument android:name='count' android:defaultValue='1'/>
      </action>
    </fragment>
    <action android:id='@+id/global_between' app:destination='@id/next'/>
    <fragment android:id='@+id/empty' android:name='sample.Empty'/>
    <action android:id='@+id/global_after_empty' app:destination='@id/next'/>
    <fragment android:id='@+id/next' android:name='sample.Next'>
      <action android:id='@+id/local_home' app:destination='@id/home'/>
    </fragment>
    <action android:id='@+id/global_last' app:destination='@id/home'/>
  </navigation>`);
  const output = ok(p.run({ op: 'nav' }));
  assert.match(output, /\(start=@id\/home\)/);
  assert.match(output, /fragment home -> sample\.Home «Home > Next»\n    action local_next -> next/);
  assert.match(output, /fragment empty -> sample\.Empty\n  fragment next/);
  assert.match(output, /fragment next -> sample\.Next\n    action local_home -> home/);
  for (const key of ['global_between', 'global_after_empty', 'global_last']) {
    assert.match(output, new RegExp(`^  global action ${key} -> `, 'm'));
    assert.doesNotMatch(output, new RegExp(`^    action ${key} -> `, 'm'));
  }
  const next = ok(p.run({ op: 'nav', route: 'next' }));
  assert.match(next, /action local_next -> next \(from=home\)/);
  assert.match(next, /global action global_between -> next/);
  assert.match(next, /global action global_after_empty -> next/);
  assert.doesNotMatch(next, /global_last|local_home/);
  assert.match(ok(p.run({ op: 'nav', route: 'home' })), /global action global_last -> home/);
});

test('nav сохраняет владельцев вложенных navigation и destinations до и после детей', (t) => {
  const p = project(t);
  p.write('app/src/main/res/navigation/nested.xml', `<navigation app:startDestination="@id/section">
    <navigation android:id="@+id/section" app:startDestination="@id/child">
      <action android:id="@+id/section_before" app:destination="@id/outside"/>
      <custom android:id="@+id/parent" android:name="sample.Parent">
        <action android:id="@+id/parent_before" app:destination="@id/outside"/>
        <custom android:id="@+id/child" android:name="sample.Child">
          <action android:id="@+id/child_action" app:destination="@id/outside"/>
        </custom>
        <action android:id="@+id/parent_after" app:destination="@id/outside"/>
      </custom>
      <action android:id="@+id/section_after" app:destination="@id/outside"/>
    </navigation>
    <action android:id="@+id/root_global" app:destination="@id/outside"/>
    <activity android:id="@+id/outside" android:name="sample.Outside"/>
  </navigation>`);
  const output = ok(p.run({ op: 'nav' }));
  assert.match(output, /navigation section -> \?\n    action section_before -> outside\n    action section_after -> outside/);
  assert.match(output, /custom parent -> sample\.Parent\n    action parent_before -> outside\n    action parent_after -> outside/);
  assert.match(output, /custom child -> sample\.Child\n    action child_action -> outside/);
  assert.match(output, /^  global action root_global -> outside$/m);
  assert.doesNotMatch(output, /global action (section_|parent_|child_)/);
  const route = ok(p.run({ op: 'nav', route: 'outside' }));
  for (const [key, owner] of [['section_before', 'section'], ['section_after', 'section'], ['parent_before', 'parent'], ['parent_after', 'parent'], ['child_action', 'child']]) {
    assert.ok(route.includes(`action ${key} -> outside (from=${owner})`), route);
  }
  assert.match(route, /global action root_global -> outside/);
  assert.match(ok(p.run({ op: 'nav', route: 'section' })), /объявлен: nav-dest/);
});

test('nav игнорирует XML-комментарии и не размывает границы action/deepLink', (t) => {
  const p = project(t);
  p.write('app/src/main/res/navigation/comments.xml', `<navigation app:startDestination="@id/real">
    <!-- <fragment android:id="@+id/ghost"><action android:id="@id/fake" app:destination="@id/real"/></fragment> -->
    <fragment android:id="@+id/real" android:name="sample.Real">
      <!-- </fragment><action android:id="@id/comment_global" app:destination="@id/real"/> -->
      <action android:id="@id/local" app:destination="@id/real"/>
      <deepLink app:uri="https://example.test/real?next=>"/>
      <![CDATA[<action android:id="@id/cdata_fake" app:destination="@id/real"/>]]>
    </fragment>
    <!-- <deepLink app:uri="https://fake.test"/> -->
    <action android:id="@id/global" app:destination="@id/real"></action>
  </navigation>`);
  const output = ok(p.run({ op: 'nav' }));
  assert.match(output, /fragment real -> sample\.Real\n    action local -> real/);
  assert.match(output, /^  global action global -> real$/m);
  assert.match(output, /deepLink: https:\/\/example\.test\/real\?next=>/);
  assert.doesNotMatch(output, /ghost|fake|comment_global/);
  const route = ok(p.run({ op: 'nav', route: 'real' }));
  assert.match(route, /action local -> real \(from=real\)/);
  assert.match(route, /global action global -> real/);
  assert.doesNotMatch(route, /ghost|fake|comment_global/);
});

test('кэш с прежней parser revision пересобирает XML/resources/catalog без изменения исходников', (t) => {
  const p = project(t);
  p.write('app/src/main/res/values/strings.xml', '<resources><string translatable="false" name="fresh">Fresh</string></resources>');
  p.write('app/src/main/res/navigation/main.xml', '<navigation><fragment android:id="@id/home"/><action android:id="@id/global" app:destination="@id/home"/></navigation>');
  p.write('gradle/libs.versions.toml', '[versions]\nkotlin = "2.1.10"\n');
  ok(p.run({ op: 'info' }));
  const cache = path.join(p.root, '.kt-cache/index.json');
  const legacy = JSON.parse(fs.readFileSync(cache, 'utf8'));
  delete legacy.parserRevision;
  legacy.data.xml.values[0].strMap = {};
  legacy.data.xml.navs[0].globalActions = [];
  legacy.data.gradle.toml.versions.kotlin = 'stale';
  fs.writeFileSync(cache, JSON.stringify(legacy));
  assert.match(ok(p.run({ op: 'res', name: 'fresh' })), /Fresh \(translatable=false\)/);
  assert.match(ok(p.run({ op: 'nav' })), /global action global -> home/);
  assert.match(ok(p.run({ op: 'info' })), /Kotlin 2\.1\.10/);
  assert.doesNotMatch(ok(p.run({ op: 'info' })), /Kotlin stale/);
});

test('BCP47 локали участвуют в missing, конфигурационные values исключены', (t) => {
  const p = project(t);
  p.write('app/src/main/res/values/strings.xml', '<resources><string name="title">Title</string><string name="missing_key">Missing</string></resources>');
  for (const locale of ['b+es', 'b+sr+Latn+RS', 'b+en+US', 'night']) {
    p.write(`app/src/main/res/values-${locale}/strings.xml`, '<resources><string name="title">Title</string></resources>');
  }
  const output = ok(p.run({ op: 'res', missing: 1 }));
  for (const locale of ['b+es', 'b+sr+Latn+RS', 'b+en+US']) assert.ok(output.includes(locale), output);
  assert.match(output, /missing_key/);
  assert.doesNotMatch(output, /night/);
});

test('XML-комментарии не создают компоненты, разрешения и intent-фильтры', (t) => {
  const p = project(t);
  p.write('app/src/main/AndroidManifest.xml', '<manifest package="sample">\n<!-- <uses-permission android:name="fake.PERMISSION"/> -->\n<application>\n<!-- <activity android:name=".Ghost" android:exported="true"/> -->\n<activity android:name=".Real" android:exported="false">\n<!-- <intent-filter><action android:name="fake.ACTION"/></intent-filter> -->\n</activity>\n</application>\n</manifest>\n');
  const output = ok(p.run({ op: 'manifest' }));
  assert.match(output, /Real/);
  assert.doesNotMatch(output, /Ghost|fake\.PERMISSION|fake\.ACTION/);
});

test('кэш инвалидируется при одинаковых size и mtime', (t) => {
  const p = project(t);
  const file = p.write('Cached.kt', 'class Before\n');
  const stamp = new Date('2024-01-01T00:00:00.000Z');
  fs.utimesSync(file, stamp, stamp);
  assert.match(ok(p.run({ op: 'symbol', name: 'Before' })), /Cached\.kt:/);
  fs.writeFileSync(file, 'class After_\n');
  fs.utimesSync(file, stamp, stamp);
  assert.match(ok(p.run({ op: 'symbol', name: 'After_' })), /Cached\.kt:/);
  assert.match(ok(p.run({ op: 'symbol', name: 'Before' })), /Не найдено/);
});

test('новый и существующий кэш получают .gitignore со звёздочкой', (t) => {
  const p = project(t);
  p.write('Local.kt', 'class Local\n');
  ok(p.run({ op: 'info' }));
  const ignore = path.join(p.root, '.kt-cache/.gitignore');
  assert.equal(fs.readFileSync(ignore, 'utf8').trim(), '*');
  fs.unlinkSync(ignore);
  ok(p.run({ op: 'info' }));
  assert.equal(fs.readFileSync(ignore, 'utf8').trim(), '*');
});

test('uses-рёбра дедуплицируются по паре файлов и виду связи', (t) => {
  const p = project(t);
  p.write('Target.kt', 'class Target\n');
  p.write('Use.kt', 'class Use {\n' + Array.from({ length: 160 }, (_, i) => ` fun f${i}(value: Target): Target = value`).join('\n') + '\n}\n');
  const output = ok(p.run({ op: 'deps', file: 'Use.kt' }));
  assert.match(output, /uses \(1\)/);
  assert.equal(output.split('\n').filter(line => line.includes('Target.kt')).length, 1, output);
});

test('uses нескольких классов одного файла сохраняет единственное ребро с ранней строкой', (t) => {
  const p = project(t);
  p.write('Targets.kt', 'class Last\nclass First\n');
  p.write('Use.kt', 'fun early(value: First) = value\nfun late(value: Last) = value\n');
  const output = ok(p.run({ op: 'deps', file: 'Use.kt' }));
  assert.match(output, /uses \(1\)/);
  assert.match(output, /Targets\.kt:1\b/);
});

test('Unicode и backticks связываются без regex-ошибок и совпадений внутри другого имени', (t) => {
  const p = project(t);
  p.write('Target.kt', 'class Экран\nclass `A+B`\nfun `показать экран`() = 1\n');
  p.write('Use.kt', 'class Use(val value: Экран, val other: `A+B`) {\n fun display() = `показать экран`()\n}\n');
  p.write('Unrelated.kt', 'class Unrelated(val value: ДругойЭкран)\n');
  const output = ok(p.run({ op: 'deps', file: 'Use.kt' }));
  assert.match(output, /uses \(1\)/);
  assert.match(output, /calls \(1\)/);
  assert.doesNotMatch(ok(p.run({ op: 'deps', file: 'Unrelated.kt' })), /Target\.kt/);
});

test('кэш прежней схемы игнорируется даже с совпадающей старой метаинформацией', (t) => {
  const p = project(t);
  const file = p.write('Cached.kt', 'class Fresh\n');
  const st = fs.statSync(file);
  p.write('.kt-cache/index.json', JSON.stringify({
    version: '1.1.0', meta: { 'Cached.kt': `${st.size}:${Math.round(st.mtimeMs)}` },
    data: { root: p.root, classes: [], functions: [], files: [], tables: [], routes: [], xml: { layouts: [], values: [] } },
  }));
  assert.match(ok(p.run({ op: 'symbol', name: 'Fresh' })), /Cached\.kt:/);
  assert.match(ok(p.run({ op: 'symbol', name: 'Fresh' })), /Cached\.kt:/);
});

test('битый кэш пересобирается; тёплый кэш замечает добавление и удаление', (t) => {
  const p = project(t);
  p.write('First.kt', 'class First\n');
  p.write('.kt-cache/index.json', '{broken');
  assert.match(ok(p.run({ op: 'symbol', name: 'First' })), /First\.kt:/);
  const added = p.write('Second.kt', 'class Second\n');
  assert.match(ok(p.run({ op: 'symbol', name: 'Second' })), /Second\.kt:/);
  fs.unlinkSync(added);
  assert.match(ok(p.run({ op: 'symbol', name: 'Second' })), /Не найдено/);
});

test('wildcard-import разрешает короткое имя sig, даже после другого wildcard', (t) => {
  const p = project(t);
  p.write('Use.kt', 'import other.missing.*\nimport sample.*\nclass Use(val value: Target)\n');
  p.write('libs/sample-1.0.jar', jar());
  assert.match(ok(p.run({ op: 'sig', name: 'Target' })), /public class sample\.Target/);
});

test('KT_JARS принимает относительный каталог так же, как абсолютный', (t) => {
  const p = project(t);
  p.write('archives/nested/sample-1.0.jar', jar());
  const query = { op: 'sig', name: 'sample.Target' };
  const absolute = ok(p.run(query, { env: { ...p.env, KT_JARS: path.join(p.root, 'archives') } }));
  assert.match(absolute, /public class sample\.Target/);
  const relative = ok(p.run(query, { env: { ...p.env, KT_JARS: ' archives ' } }));
  assert.equal(relative, absolute);
});

test('явный jars через внутренний junction сохраняет вложенные JAR', (t) => {
  const p = project(t);
  p.write('archives/nested/sample-1.0.jar', jar());
  if (!linkDir(t, path.join(p.root, 'archives'), path.join(p.root, 'alias'))) return;
  const output = ok(p.run({ op: 'sig', name: 'sample.Target', jars: 'alias' }));
  assert.match(output, /public class sample\.Target/);
  assert.match(output, /sample-1\.0\.jar/);
});

test('повторный private descriptor с 60000 измерениями ограничен по времени', (t) => {
  corruptJar(t, () => jar(repeatedMemberClass('['.repeat(60000) + 'I')));
});

test('повторный длинный private descriptor валидируется один раз', (t) => {
  const p = project(t);
  p.write('libs/sample-1.0.jar', jar(repeatedMemberClass('L' + 'a'.repeat(60000) + ';', 60000, { uniqueNames: true })));
  const output = ok(p.run({ op: 'sig', name: 'sample.Target' }, { timeout: 2500 }));
  assert.match(output, /public class sample\.Target/);
  assert.doesNotMatch(output, /Предупреждение/);
});

test('повторный длинный private Signature валидируется один раз', (t) => {
  const p = project(t);
  p.write('libs/sample-1.0.jar', jar(repeatedMemberClass('Ljava/lang/Object;', 60000,
    { signature: 'L' + 'a'.repeat(60000) + ';', uniqueNames: true })));
  const output = ok(p.run({ op: 'sig', name: 'sample.Target' }, { timeout: 2500 }));
  assert.match(output, /public class sample\.Target/);
  assert.doesNotMatch(output, /Предупреждение/);
});

for (const signature of [false, true]) {
  test(`JVM-массив с 256 измерениями отклоняется в ${signature ? 'Signature' : 'descriptor'}`, (t) => {
    corruptJar(t, () => jar(repeatedMemberClass(signature ? 'Ljava/lang/Object;' : '['.repeat(256) + 'I', 1,
      signature ? { signature: '['.repeat(256) + 'I' } : {})));
  });
  test(`JVM-массив с 255 измерениями допустим в ${signature ? 'Signature' : 'descriptor'}`, (t) => {
    const p = project(t);
    p.write('libs/sample-1.0.jar', jar(repeatedMemberClass(signature ? 'Ljava/lang/Object;' : '['.repeat(255) + 'I', 1,
      signature ? { signature: '['.repeat(255) + 'I' } : {})));
    const output = ok(p.run({ op: 'sig', name: 'sample.Target' }));
    assert.match(output, /public class sample\.Target/);
    assert.doesNotMatch(output, /Предупреждение/);
  });
}

test('повторная строка дескриптора проверяется отдельно как поле и метод', (t) => {
  corruptJar(t, () => jar(classFile({ desc: 'Ljava/lang/Object;', fieldSignature: 'Ljava/lang/Object;' })));
});

test('sig не обходит внешний junction из libs, но принимает явный jars', (t) => {
  const p = project(t);
  const outside = path.join(p.base, 'outside-jars');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'sample-1.0.jar'), jar());
  if (!linkDir(t, outside, path.join(p.root, 'libs'))) return;
  assert.match(ok(p.run({ op: 'sig', name: 'sample.Target' })), /не найден в jar/);
  assert.match(ok(p.run({ op: 'sig', name: 'sample.Target', jars: outside })), /public class sample\.Target/);
});

test('sig не обходит ссылки и циклы внутри каталога архивов', (t) => {
  const p = project(t);
  p.write('libs/good-1.0.jar', jar());
  const outside = path.join(p.base, 'outside-jars');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'external-9.0.jar'), jar());
  if (!linkDir(t, outside, path.join(p.root, 'libs/linked'))) return;
  if (!linkDir(t, path.join(p.root, 'libs'), path.join(p.root, 'libs/loop'))) return;
  const output = ok(p.run({ op: 'sig', name: 'sample.Target' }, { timeout: 2500 }));
  assert.match(output, /good-1\.0\.jar/);
  assert.doesNotMatch(output, /external-9\.0|других версий/);
});

test('внешняя файловая symlink не читается и не индексируется', (t) => {
  const p = project(t);
  const outside = path.join(p.base, 'Outside.kt');
  fs.writeFileSync(outside, 'class OutsideFile\n');
  try { fs.symlinkSync(outside, path.join(p.root, 'Linked.kt'), 'file'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('Ссылки файлов недоступны'); return; }
    throw error;
  }
  assert.match(ok(p.run({ op: 'symbol', name: 'OutsideFile' })), /Не найдено/);
  rejected(p.run({ op: 'read', file: 'Linked.kt' }), /вне рабочей директории/);
  rejected(p.payload({ op: 'patch', file: 'Linked.kt', old: 'OutsideFile', new: 'Changed' }), /вне рабочей директории/);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'class OutsideFile\n');
});

test('обычный импорт и корректный сжатый JAR сохраняют sig', (t) => {
  const p = project(t);
  p.write('Use.kt', 'import sample.Target\nclass Use(val value: Target)\n');
  p.write('libs/sample-1.0.jar', jar(classFile({ signature: '(I)Ljava/util/List<Ljava/lang/String;>;' }), 8));
  const output = ok(p.run({ op: 'sig', name: 'Target' }));
  assert.match(output, /public class sample\.Target/);
  assert.match(output, /java\.util\.List<java\.lang\.String>/);
});

test('sig сохраняет generic type-параметры, wildcard, массивы и throws', (t) => {
  const p = project(t);
  p.write('Use.kt', 'import sample.Target as Renamed\n');
  p.write('libs/sample-1.0.jar', jar(classFile({
    signature: '<T:Ljava/lang/Object;>([TT;Ljava/util/List<+TT;>;)Ljava/util/Map<Ljava/lang/String;TT;>;^Ljava/io/IOException;',
    fieldSignature: 'Ljava/util/List<*>;',
  })));
  const output = ok(p.run({ op: 'sig', name: 'Renamed' }));
  assert.match(output, /public class sample\.Target/);
  assert.match(output, /java\.util\.List<\?> value/);
  assert.match(output, /java\.util\.Map<java\.lang\.String, T>/);
  assert.match(output, /arg0: T\[\]/);
  assert.match(output, /arg1: java\.util\.List<\? extends T>/);
});

test('create UTF-16LE тоже пишет BOM, неизвестная кодировка отклоняется', (t) => {
  const p = project(t);
  ok(p.payload({ op: 'create', file: 'Little.kt', enc: 'utf-16le', text: 'val текст = "Привет"' }));
  assert.deepEqual(fs.readFileSync(path.join(p.root, 'Little.kt')), Buffer.concat([
    Buffer.from([0xff, 0xfe]), Buffer.from('val текст = "Привет"\n', 'utf16le'),
  ]));
  rejected(p.payload({ op: 'create', file: 'Unknown.kt', enc: 'wrong', text: 'val x = 1' }), /кодировка/);
  assert.equal(fs.existsSync(path.join(p.root, 'Unknown.kt')), false);
});

test('sig предупреждает, когда единственный архив повреждён', (t) => {
  const p = project(t);
  p.write('libs/bad-1.0.jar', Buffer.from('broken'));
  const output = ok(p.run({ op: 'sig', name: 'sample.Target' }));
  assert.match(output, /Предупреждение:.*bad-1\.0\.jar/);
  assert.match(output, /не найден в jar/);
});

test('корректный AAR с classes.jar поддерживается', (t) => {
  const p = project(t);
  p.write('libs/sample-1.0.aar', zip([{ name: 'classes.jar', data: jar(), method: 8 }]));
  assert.match(ok(p.run({ op: 'sig', name: 'sample.Target' })), /sample-1\.0\.aar/);
});

const corruptions = {
  'нет EOCD': () => Buffer.from('not a jar'),
  'EOCD указывает за буфер': () => { const b = jar(); b.writeUInt32LE(0xfffffff0, b.length - 6); return b; },
  'обрезанный central directory': () => { const b = jar(); b.writeUInt32LE(b.length - 24, b.length - 6); return b; },
  'имя central entry за границей': () => { const b = jar(); const cd = b.readUInt32LE(b.length - 6); b.writeUInt16LE(0xffff, cd + 28); return b; },
  'local header за границей': () => { const b = jar(); const cd = b.readUInt32LE(b.length - 6); b.writeUInt32LE(0xfffffff0, cd + 42); return b; },
  'local extra за границей': () => { const b = jar(); b.writeUInt16LE(0xffff, 28); return b; },
  'данные entry за границей': () => { const b = jar(); const cd = b.readUInt32LE(b.length - 6); b.writeUInt32LE(0xffffff00, cd + 20); return b; },
  'повреждённый deflate': () => { const b = jar(classFile(), 8); const start = 30 + b.readUInt16LE(26); b.fill(0xff, start, start + 8); return b; },
  'распаковка больше объявленного размера': () => { const b = jar(classFile(), 8); const cd = b.readUInt32LE(b.length - 6); b.writeUInt32LE(1, cd + 24); return b; },
  'усечённый constant pool': () => jar(classFile().subarray(0, 13)),
  'усечённые class attributes': () => jar(classFile().subarray(0, -1)),
  'дескриптор без закрывающей точки с запятой': () => jar(classFile({ desc: '(Ljava/lang/String)V' })),
  'generic type variable без закрывающей точки с запятой': () => jar(classFile({ signature: '(TT)Ljava/lang/String;' })),
  'вложенный generic без закрывающих разделителей': () => jar(classFile({ fieldSignature: 'Ljava/util/List<TT' })),
  'generic возвращаемого типа без закрытия': () => jar(classFile({ signature: '()Ljava/util/List<Ljava/lang/String;' })),
};
for (const [name, make] of Object.entries(corruptions)) test(`sig пропускает битый JAR с предупреждением: ${name}`, (t) => corruptJar(t, make));

test('sig пропускает битый внутренний classes.jar в AAR', (t) => {
  corruptJar(t, () => zip([{ name: 'classes.jar', data: Buffer.from('broken') }]), 'aar');
});

test('ложный EOCD в ZIP-комментарии не скрывает корректный JAR', (t) => {
  const p = project(t);
  const comment = Buffer.alloc(22);
  comment.writeUInt32LE(0x06054b50);
  comment.writeUInt16LE(1, 10);
  comment.writeUInt32LE(0xfffffff0, 16);
  p.write('libs/sample-1.0.jar', zip([{ name: 'sample/Target.class', data: classFile() }], comment));
  assert.match(ok(p.run({ op: 'sig', name: 'sample.Target' })), /public class sample\.Target/);
});
