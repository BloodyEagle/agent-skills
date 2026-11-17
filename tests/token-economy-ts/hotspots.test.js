// Тесты op=hotspots (git-сигналы) по плану git-hotspots: фикстура — временный каталог с git init.
// Дисциплина прогонов из плана: коммиты с фиксированным GIT_AUTHOR_*/GIT_COMMITTER_*,
// кириллица и даты фиксированы, PATH подменяется для проверки кэша без git.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {spawnSync} = require('child_process');
const {pathToFileURL} = require('url');

const scripts = path.resolve(__dirname, '..', '..', 'skills', 'token-economy-ts', 'scripts');
const graphTool = path.join(scripts, 'graph-tool.js');

const GIT_IDENTITY = {
    GIT_AUTHOR_NAME: 'Tester', GIT_AUTHOR_EMAIL: 'tester@example.com',
    GIT_COMMITTER_NAME: 'Tester', GIT_COMMITTER_EMAIL: 'tester@example.com',
};

function git(root, args, env = {}) {
    const r = spawnSync('git', ['-C', root].concat(args), {
        encoding: 'utf8', windowsHide: true, timeout: 15000,
        env: {...process.env, ...GIT_IDENTITY, ...env}, maxBuffer: 1024 * 1024,
    });
    assert.ifError(r.error);
    assert.equal(r.status, 0, 'git ' + args.join(' ') + ' упал: ' + r.stderr);
    return r;
}

function commitAll(root, message, env = {}) {
    git(root, ['add', '-A']);
    git(root, ['commit', '-m', message], env);
}

/** Временный git-репозиторий с фиксированной идентичностью коммитов. */
function gitRepo(run, files = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'te-hotspots-'));
    try {
        git(root, ['init']);
        write(root, files);
        return run(root);
    } finally {
        fs.rmSync(root, {recursive: true, force: true});
    }
}

function write(root, files) {
    for (const [file, text] of Object.entries(files)) {
        const target = path.join(root, file);
        fs.mkdirSync(path.dirname(target), {recursive: true});
        fs.writeFileSync(target, text);
    }
}

const lines = (n, text = 'const value = ' + Date.now() + ';\n') => text.repeat(n);

/** Вызов op=hotspots через graph-tool.js; noPath=true — env без PATH/Path (git недоступен). */
function hs(root, args = {}, {noPath = false} = {}) {
    const env = {...process.env, ...GIT_IDENTITY, NODE_OPTIONS: '', HOME: root, USERPROFILE: root};
    if (noPath) {
        delete env.PATH;
        delete env.Path;
    }
    return spawnSync(process.execPath, [graphTool].concat(Object.entries({op: 'hotspots', ...args}).map(([k, v]) => k + '=' + v)), {
        cwd: root, encoding: 'utf8', timeout: 20000, windowsHide: true, env, maxBuffer: 4 * 1024 * 1024,
    });
}

function runScript(root, script, args) {
    return spawnSync(process.execPath, [path.join(scripts, script)].concat(args), {
        cwd: root, encoding: 'utf8', timeout: 20000, windowsHide: true,
        env: {...process.env, NODE_OPTIONS: '', HOME: root, USERPROFILE: root}, maxBuffer: 4 * 1024 * 1024,
    });
}

const readCache = (root) => JSON.parse(fs.readFileSync(path.join(root, '.git-signals.json'), 'utf8'));
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('hotspots: три коммита по своим файлам — commits по 1, порядок top по churn', () => gitRepo(root => {
    write(root, {'src/a.ts': lines(30)});
    commitAll(root, 'feat: a');
    write(root, {'src/b.ts': lines(60)});
    commitAll(root, 'feat: b');
    write(root, {'src/c.ts': lines(100)});
    commitAll(root, 'feat: c');
    const r = hs(root, {top: 10});
    assert.equal(r.status, 0, r.stderr);
    const out = r.stdout.split('\n');
    assert.match(out[0], /^git-сигналы: 3 коммита, 3 файла, since /);
    assert.match(out[1], /^1\. src\/c\.ts\s+коммитов 1\s+churn 100\s+авторов 1\s+багфиксов 0 \(0%\)\s+churn\/стр 1\.00\s+p97$/);
    assert.match(out[2], /^2\. src\/b\.ts\s+коммитов 1\s+churn 60\s+авторов 1\s+багфиксов 0 \(0%\)\s+churn\/стр 1\.00\s+p97$/);
    // a.ts — 30 строк, меньше порога 50: относительный churn не определён
    assert.match(out[3], /^3\. src\/a\.ts\s+коммитов 1\s+churn 30\s+авторов 1\s+багфиксов 0 \(0%\)\s+p97$/);
    assert.equal(out.length, 5);
}));

test('hotspots: fix-субъект считается багфиксом, feat — нет', () => gitRepo(root => {
    write(root, {'src/x.ts': lines(60)});
    commitAll(root, 'feat: add module');
    write(root, {'src/x.ts': lines(62)});
    commitAll(root, 'fix: patch edge case');
    const r = hs(root, {file: 'src/x.ts'});
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout.trim(), /^src\/x\.ts {2}коммитов 2 \(p\d+\) {2}churn \d+ \(p\d+\) {2}авторов 1 {2}багфиксов 1 \(50%, p\d+\) {2}(churn\/стр \d+\.\d+ {2})?последний \d{4}-\d{2}-\d{2}$/);
    const cache = readCache(root);
    assert.equal(cache.files['src/x.ts'].bugfix, 1);
}));

test('hotspots: два автора одного файла — авторов 2', () => gitRepo(root => {
    write(root, {'src/a.ts': lines(55)});
    commitAll(root, 'feat: base', {GIT_AUTHOR_NAME: 'Alice', GIT_COMMITTER_NAME: 'Alice'});
    write(root, {'src/a.ts': lines(57)});
    commitAll(root, 'fix: tweak', {GIT_AUTHOR_NAME: 'Bob', GIT_COMMITTER_NAME: 'Bob'});
    const r = hs(root, {file: 'src/a.ts'});
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /авторов 2/);
}));

test('hotspots: бинарный файл — коммит считается, churn нет, binary: true', () => gitRepo(root => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]);
    write(root, {'src/code.ts': lines(60), 'assets/img.bin': png});
    commitAll(root, 'feat: binary asset');
    const r = hs(root, {top: 5});
    assert.equal(r.status, 0, r.stderr);
    const entry = readCache(root).files['assets/img.bin'];
    assert.deepEqual({commits: entry.commits, churn: entry.churn, binary: entry.binary}, {commits: 1, churn: 0, binary: true});
    assert.match(r.stdout, /assets\/img\.bin\s+коммитов 1\s+churn 0/);
}));

test('hotspots: merge-коммит не считается (--no-merges)', () => gitRepo(root => {
    write(root, {'src/a.ts': lines(40)});
    commitAll(root, 'feat: base');
    git(root, ['checkout', '-b', 'feature']);
    write(root, {'src/a.ts': lines(45)});
    commitAll(root, 'fix: on feature');
    git(root, ['checkout', '-']);
    git(root, ['merge', '--no-ff', 'feature', '-m', 'Merge branch feature']);
    const r = hs(root, {});
    assert.equal(r.status, 0, r.stderr);
    const cache = readCache(root);
    assert.equal(cache.commitsTotal, 2);
    assert.equal(cache.files['src/a.ts'].commits, 2);
}));

test('hotspots: since отсекает старые коммиты', () => gitRepo(root => {
    const past = {GIT_AUTHOR_DATE: '2020-01-01T12:00:00', GIT_COMMITTER_DATE: '2020-01-01T12:00:00'};
    write(root, {'src/old.ts': lines(40)});
    commitAll(root, 'feat: ancient', past);
    write(root, {'src/new.ts': lines(40)});
    commitAll(root, 'feat: fresh');
    const r = hs(root, {});
    assert.equal(r.status, 0, r.stderr);
    const cache = readCache(root);
    assert.deepEqual(Object.keys(cache.files), ['src/new.ts']);
    assert.match(r.stdout, /^git-сигналы: 1 коммит, 1 файл, since /);
    // явная дата тоже работает и бьётся по ключу кэша
    const r2 = hs(root, {since: '2026-01-01'});
    assert.equal(r2.status, 0, r2.stderr);
    assert.match(r2.stdout, /^git-сигналы: 1 коммит, 1 файл, since 2026-01-01/);
}));

test('hotspots: валидный кэш отвечает без git в PATH (HEAD читается файлами)', () => gitRepo(root => {
    write(root, {'src/a.ts': lines(50)});
    commitAll(root, 'feat: base');
    const first = hs(root, {});
    assert.equal(first.status, 0, first.stderr);
    assert.ok(fs.existsSync(path.join(root, '.git-signals.json')));
    const second = hs(root, {}, {noPath: true});
    assert.equal(second.status, 0, 'кэш должен отдаваться без git: ' + second.stdout + second.stderr);
    assert.equal(second.stdout, first.stdout);
    assert.doesNotMatch(second.stdout, /Ошибка/);
}));

test('hotspots: новый коммит инвалидирует кэш — данные пересобираются, HEAD перечитан файлами', () => gitRepo(root => {
    write(root, {'src/a.ts': lines(50)});
    commitAll(root, 'feat: base');
    const first = hs(root, {});
    assert.equal(first.status, 0, first.stderr);
    const before = readCache(root);
    write(root, {'src/b.ts': lines(70)});
    commitAll(root, 'feat: second file');
    // пересбор требует git log — PATH не подменяется; HEAD при этом перечитывается из файлов
    const second = hs(root, {});
    assert.equal(second.status, 0, second.stderr);
    const after = readCache(root);
    assert.notEqual(after.head, before.head);
    assert.notEqual(after.collectedAt, before.collectedAt);
    assert.ok(after.files['src/b.ts'], 'новый файл появился в данных');
    assert.equal(after.commitsTotal, 2);
}));

test('hotspots: каталог без git — exit 1 и сообщение', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'te-nogit-'));
    try {
        fs.writeFileSync(path.join(root, 'src.ts'), lines(30));
        const r = hs(root, {});
        assert.equal(r.status, 1);
        assert.match(r.stdout.trim(), /^Ошибка: не git-репозиторий/);
        assert.ok(r.stdout.includes(root));
    } finally {
        fs.rmSync(root, {recursive: true, force: true});
    }
});

test('hotspots: rename при --no-renames — удаление + добавление, без придуманных путей', () => gitRepo(root => {
    write(root, {'src/old.ts': lines(30)});
    commitAll(root, 'feat: old location');
    git(root, ['mv', 'src/old.ts', 'src/new.ts']);
    commitAll(root, 'refactor: rename module');
    const r = hs(root, {});
    assert.equal(r.status, 0, r.stderr);
    const files = readCache(root).files;
    // старый путь затронут дважды: добавление в первом коммите и удаление в rename-коммите
    assert.equal(files['src/old.ts'].commits, 2);
    assert.equal(files['src/old.ts'].churn, 60);
    assert.equal(files['src/new.ts'].commits, 1);
    assert.equal(files['src/new.ts'].churn, 30);
    assert.ok(!Object.keys(files).some(k => k.includes('=>') || k.includes('{')), 'нет rename-путей: ' + Object.keys(files).join(', '));
    const oldLine = hs(root, {file: 'src/old.ts'});
    assert.doesNotMatch(oldLine.stdout, /churn\/стр/, 'файла нет на диске — относительный churn не определён');
}));

test('hotspots: .git-signals.json не ломает search/outline и не попадает в граф', () => gitRepo(root => {
    write(root, {'src/a.ts': 'const value = 1;\n'});
    commitAll(root, 'feat: base');
    const warm = hs(root, {});
    assert.equal(warm.status, 0, warm.stderr);
    const search = runScript(root, 'code-searcher.js', ['query=value', 'ext=.ts', 'root=.']);
    assert.equal(search.status, 0, search.stderr);
    assert.equal(JSON.parse(search.stdout).count, 1);
    const outline = runScript(root, 'symbol-index.js', ['file=src/a.ts']);
    assert.equal(outline.status, 0, outline.stderr);
    const info = runScript(root, 'graph-tool.js', ['op=info']);
    assert.equal(info.status, 0, info.stderr);
    assert.doesNotMatch(info.stdout, /git-signals/);
}));

test('hotspots: после прогрева графа op=hotspots не меняет graph-deps.json', () => gitRepo(root => {
    write(root, {'src/a.ts': 'import {b} from "./b";\n' + 'const a = b;\n', 'src/b.ts': 'export const b = 1;\n'});
    commitAll(root, 'feat: base');
    const stats = runScript(root, 'graph-tool.js', ['op=stats']);
    assert.equal(stats.status, 0, stats.stderr);
    const cacheFile = path.join(root, 'graph-deps.json');
    assert.ok(fs.existsSync(cacheFile));
    const before = sha256(cacheFile);
    const r = hs(root, {});
    assert.equal(r.status, 0, r.stderr);
    assert.equal(sha256(cacheFile), before, 'op=hotspots не должен трогать граф-кэш');
}));

test('hotspots: пустая история (unborn-ветка) — «коммитов за период нет», exit 0', () => gitRepo(root => {
    const r = hs(root, {});
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'коммитов за период нет');
    // повторный вызов отдаётся из кэша, тоже без ошибок
    const second = hs(root, {}, {noPath: true});
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.stdout.trim(), 'коммитов за период нет');
}));

test('hotspots: shallow-клон — данные считаются, первая строка предупреждает', () => gitRepo(root => {
    write(root, {'src/a.ts': lines(50)});
    commitAll(root, 'feat: base');
    const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'te-shallow-'));
    try {
        git(clone, ['clone', '--depth', '1', pathToFileURL(root).href, '.']);
        const r = hs(clone, {});
        assert.equal(r.status, 0, r.stderr);
        assert.equal(r.stdout.split('\n')[0], 'ВНИМАНИЕ: shallow-клон, история неполная');
        assert.match(r.stdout.split('\n')[1], /^git-сигналы: 1 коммит, 1 файл, since /);
    } finally {
        fs.rmSync(clone, {recursive: true, force: true});
    }
}));
