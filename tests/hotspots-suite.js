// Общий набор hotspots-сценариев для JS-скиллов (kt/java/php) и py-порта.
// Модуль git-signals.js у JS-скиллов общий байт в байт (проверяет tests/hotspots-copies.test.js).
// buildSignalsCacheSuite запускается там для каждой копии; buildHotspotsSuite проверяет CLI-клей.
// Сценарии — пункты 1–11 плана git-hotspots через CLI конкретного скилла.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');

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

function write(root, files) {
    for (const [file, text] of Object.entries(files)) {
        const target = path.join(root, file);
        fs.mkdirSync(path.dirname(target), {recursive: true});
        fs.writeFileSync(target, text);
    }
}

function commitAll(root, message, env = {}) {
    git(root, ['add', '-A']);
    git(root, ['commit', '-m', message], env);
}

const lines = (n, text = 'const value = 1;\n') => text.repeat(n);

/** Временный git-репозиторий с фиксированной идентичностью коммитов. */
function gitRepo(run, files = {}, prepare) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'te-hotspots-'));
    try {
        git(root, ['init']);
        if (prepare) prepare(root);
        write(root, files);
        return run(root);
    } finally {
        fs.rmSync(root, {recursive: true, force: true});
    }
}

function isolatedEnv(root, extra = {}) {
    return {...process.env, ...GIT_IDENTITY, NODE_OPTIONS: '', HOME: root, USERPROFILE: root, ...extra};
}

function envWithoutGit(root) {
    const env = isolatedEnv(root);
    delete env.PATH;
    delete env.Path;
    env.PATH = ''; // без PATH execvp на POSIX использует системный default; пустой PATH исключает git
    return env;
}

/**
 * Набор тестов для одного CLI. spawn(root, args, opts) → spawnSync-результат вызова
 * <скилл> root=<root> key=value…; opts.noPath — env без PATH/Path (git недоступен),
 * opts.env — дополнения env.
 */
function buildHotspotsSuite(label, spawn, {cacheFile = '.git-signals.json', bitrix = false} = {}) {
    const readCache = (root) => JSON.parse(fs.readFileSync(path.join(root, cacheFile), 'utf8'));

    test(label + ' hotspots: три коммита по своим файлам — порядок top по churn', () => gitRepo(root => {
        write(root, {'src/a.ts': lines(30)});
        commitAll(root, 'feat: a');
        write(root, {'src/b.ts': lines(60)});
        commitAll(root, 'feat: b');
        write(root, {'src/c.ts': lines(100)});
        commitAll(root, 'feat: c');
        const r = spawn(root, {op: 'hotspots', top: 10});
        assert.equal(r.status, 0, r.stderr);
        const out = r.stdout.split('\n');
        assert.match(out[0], /^git-сигналы: 3 коммита, 3 файла, since /);
        assert.match(out[1], /^1\. src\/c\.ts\s+коммитов 1\s+churn 100\s+авторов 1\s+багфиксов 0 \(0%\)\s+churn\/стр 1\.00\s+p97$/);
        assert.match(out[2], /^2\. src\/b\.ts\s+коммитов 1\s+churn 60\s+/);
        assert.match(out[3], /^3\. src\/a\.ts\s+коммитов 1\s+churn 30\s+/);
    }));

    test(label + ' hotspots: fix считается багфиксом, feat — нет (file=)', () => gitRepo(root => {
        write(root, {'src/x.ts': lines(60)});
        commitAll(root, 'feat: add module');
        write(root, {'src/x.ts': lines(62)});
        commitAll(root, 'fix: patch edge case');
        const r = spawn(root, {op: 'hotspots', file: 'src/x.ts'});
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout.trim(), /^src\/x\.ts {2}коммитов 2 \(p\d+\) {2}churn \d+ \(p\d+\) {2}авторов 1 {2}багфиксов 1 \(50%, p\d+\) {2}(churn\/стр \d+\.\d+ {2})?последний \d{4}-\d{2}-\d{2}$/);
        assert.equal(readCache(root).files['src/x.ts'].bugfix, 1);
    }));

    test(label + ' hotspots: два автора одного файла — авторов 2', () => gitRepo(root => {
        write(root, {'src/a.ts': lines(55)});
        commitAll(root, 'feat: base', {GIT_AUTHOR_NAME: 'Alice', GIT_COMMITTER_NAME: 'Alice'});
        write(root, {'src/a.ts': lines(57)});
        commitAll(root, 'fix: tweak', {GIT_AUTHOR_NAME: 'Bob', GIT_COMMITTER_NAME: 'Bob'});
        const r = spawn(root, {op: 'hotspots', file: 'src/a.ts'});
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /авторов 2/);
    }));

    test(label + ' hotspots: бинарный файл — коммит считается, churn нет, binary: true', () => gitRepo(root => {
        const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]);
        write(root, {'src/code.ts': lines(60), 'assets/img.bin': png});
        commitAll(root, 'feat: binary asset');
        const r = spawn(root, {op: 'hotspots', top: 5});
        assert.equal(r.status, 0, r.stderr);
        const entry = readCache(root).files['assets/img.bin'];
        assert.deepEqual({commits: entry.commits, churn: entry.churn, binary: entry.binary}, {commits: 1, churn: 0, binary: true});
        assert.match(r.stdout, /assets\/img\.bin\s+коммитов 1\s+churn 0/);
    }));

    test(label + ' hotspots: merge-коммит не считается (--no-merges)', () => gitRepo(root => {
        write(root, {'src/a.ts': lines(40)});
        commitAll(root, 'feat: base');
        git(root, ['checkout', '-b', 'feature']);
        write(root, {'src/a.ts': lines(45)});
        commitAll(root, 'fix: on feature');
        git(root, ['checkout', '-']);
        git(root, ['merge', '--no-ff', 'feature', '-m', 'Merge branch feature']);
        const r = spawn(root, {op: 'hotspots'});
        assert.equal(r.status, 0, r.stderr);
        const cache = readCache(root);
        assert.equal(cache.commitsTotal, 2);
        assert.equal(cache.files['src/a.ts'].commits, 2);
    }));

    test(label + ' hotspots: since отсекает старые коммиты', () => gitRepo(root => {
        const past = {GIT_AUTHOR_DATE: '2020-01-01T12:00:00', GIT_COMMITTER_DATE: '2020-01-01T12:00:00'};
        write(root, {'src/old.ts': lines(40)});
        commitAll(root, 'feat: ancient', past);
        write(root, {'src/new.ts': lines(40)});
        commitAll(root, 'feat: fresh');
        const r = spawn(root, {op: 'hotspots'});
        assert.equal(r.status, 0, r.stderr);
        const cache = readCache(root);
        assert.deepEqual(Object.keys(cache.files), ['src/new.ts']);
        assert.match(r.stdout, /^git-сигналы: 1 коммит, 1 файл, since /);
    }));

    test(label + ' hotspots: валидный кэш отвечает без git в PATH', () => gitRepo(root => {
        write(root, {'src/a.ts': lines(50)});
        commitAll(root, 'feat: base');
        const first = spawn(root, {op: 'hotspots'});
        assert.equal(first.status, 0, first.stderr);
        assert.ok(fs.existsSync(path.join(root, cacheFile)));
        const second = spawn(root, {op: 'hotspots'}, {noPath: true});
        assert.equal(second.status, 0, 'кэш должен отдаваться без git: ' + second.stdout + second.stderr);
        assert.equal(second.stdout, first.stdout);
    }));

    test(label + ' hotspots: новый коммит инвалидирует кэш', () => gitRepo(root => {
        write(root, {'src/a.ts': lines(50)});
        commitAll(root, 'feat: base');
        const first = spawn(root, {op: 'hotspots'});
        assert.equal(first.status, 0, first.stderr);
        const before = readCache(root);
        write(root, {'src/b.ts': lines(70)});
        commitAll(root, 'feat: second file');
        const second = spawn(root, {op: 'hotspots'});
        assert.equal(second.status, 0, second.stderr);
        const after = readCache(root);
        assert.notEqual(after.head, before.head);
        assert.notEqual(after.collectedAt, before.collectedAt);
        assert.ok(after.files['src/b.ts']);
        assert.equal(after.commitsTotal, 2);
    }));

    test(label + ' hotspots: каталог без git — exit 1 и сообщение', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'te-nogit-'));
        try {
            fs.writeFileSync(path.join(root, 'src.ts'), lines(30));
            const r = spawn(root, {op: 'hotspots'});
            assert.equal(r.status, 1);
            assert.match(r.stdout.trim(), /^Ошибка: не git-репозиторий/);
        } finally {
            fs.rmSync(root, {recursive: true, force: true});
        }
    });

    test(label + ' hotspots: rename при --no-renames — удаление + добавление', () => gitRepo(root => {
        write(root, {'src/old.ts': lines(30)});
        commitAll(root, 'feat: old location');
        git(root, ['mv', 'src/old.ts', 'src/new.ts']);
        commitAll(root, 'refactor: rename module');
        const r = spawn(root, {op: 'hotspots'});
        assert.equal(r.status, 0, r.stderr);
        const files = readCache(root).files;
        assert.equal(files['src/old.ts'].commits, 2);
        assert.equal(files['src/old.ts'].churn, 60);
        assert.equal(files['src/new.ts'].commits, 1);
        assert.equal(files['src/new.ts'].churn, 30);
        assert.ok(!Object.keys(files).some(k => k.includes('=>') || k.includes('{')), 'нет rename-путей');
    }));

    test(label + ' hotspots: индексная операция скилла работает при наличии кэша', () => gitRepo(root => {
        write(root, {'src/a.ts': lines(50)});
        commitAll(root, 'feat: base');
        const warm = spawn(root, {op: 'hotspots'});
        assert.equal(warm.status, 0, warm.stderr);
        const info = spawn(root, {op: 'info'});
        assert.equal(info.status, 0, info.stdout + info.stderr);
        assert.doesNotMatch(info.stdout, /\.git-signals/);
    }));

    if (bitrix) {
        test(label + ' hotspots: в Битриксе bitrix/modules и upload не считаются', () => gitRepo(root => {
            // маркер Битрикса: bitrix/ с типичным подкаталогом (см. bitrixMarkerAt в lib/fsx.js)
            fs.mkdirSync(path.join(root, 'bitrix', 'modules', 'custom.module'), {recursive: true});
            write(root, {
                'bitrix/modules/custom.module/install/index.php': '<?php // core\n',
                'upload/cache.dat': 'junk\n',
                'local/php_interface/include.php': '<?php // custom\n',
                'src/app.php': '<?php // app\n',
            });
            commitAll(root, 'feat: bitrix project');
            const r = spawn(root, {op: 'hotspots', top: 20});
            assert.equal(r.status, 0, r.stderr);
            const files = Object.keys(readCache(root).files);
            assert.deepEqual(files, ['local/php_interface/include.php', 'src/app.php']);
            assert.doesNotMatch(r.stdout, /bitrix\/modules|upload\//);
        }));
    }
}

function linkOrSkip(t, target, alias, type) {
    try {
        fs.symlinkSync(target, alias, type);
        return true;
    } catch (e) {
        if (!['EPERM', 'EACCES', 'ENOTSUP', 'ENOSYS'].includes(e.code)) throw e;
        t.skip('ОС не разрешает symlink (' + e.code + '): ' + e.message);
        return false;
    }
}

/** Общие F03-регрессии непосредственно для каждой JS-копии, не только адаптеров. */
function buildSignalsCacheSuite(label, moduleFile) {
    const signals = require(moduleFile);
    const opts = {since: '2000-01-01', maxCommits: 2000, pathspec: []};
    const withoutGit = (root, options = opts) => spawnSync(process.execPath, ['-e',
        'const s = require(process.argv[1]); console.log(JSON.stringify(s.loadSignals(process.argv[2], JSON.parse(process.argv[3]))));',
        moduleFile, root, JSON.stringify(options)], {
        cwd: root, env: {...envWithoutGit(root), NODE_OPTIONS: ''}, encoding: 'utf8',
        timeout: 15000, windowsHide: true,
    });
    const repo = (run) => gitRepo(root => {
        // Последующие коммиты не должны захватить cache/tmp самого теста.
        fs.writeFileSync(path.join(root, '.git', 'info', 'exclude'), signals.CACHE_FILE + '*\n');
        write(root, {'src/source.ts': lines(60), 'src/other.ts': lines(50)});
        commitAll(root, 'feat: cache fixture');
        return run(root);
    });
    const tmpFiles = (root) => fs.readdirSync(root).filter(name => name.startsWith(signals.CACHE_FILE + '.') && name.endsWith('.tmp'));

    test(label + ' cache safety: normal publish and warm-hit without git preserve bytes', () => repo(root => {
        const untouched = ['graph-deps.json', '.graph-deps-cache.json', '.jv-cache/index.json', '.kt-cache/index.json', '.bx-cache/index.json'];
        write(root, Object.fromEntries(untouched.map(file => [file, 'index sentinel: ' + file])));
        const first = signals.loadSignals(root, opts);
        assert.equal(first.fromCache, false);
        const file = path.join(root, signals.CACHE_FILE), bytes = fs.readFileSync(file);
        assert.ok(fs.lstatSync(file).isFile());
        const warm = withoutGit(root);
        assert.ifError(warm.error);
        assert.equal(warm.status, 0, warm.stdout + warm.stderr);
        assert.deepEqual(JSON.parse(warm.stdout), {data: first.data, fromCache: true});
        assert.deepEqual(fs.readFileSync(file), bytes);
        for (const name of untouched) assert.equal(fs.readFileSync(path.join(root, name), 'utf8'), 'index sentinel: ' + name);
        assert.deepEqual(tmpFiles(root), []);
    }));

    for (const kind of ['internal', 'external', 'dangling']) {
        test(label + ' cache safety: reject ' + kind + ' endpoint symlink for read and publish', t => repo(root => {
            const initial = signals.loadSignals(root, opts).data;
            const file = path.join(root, signals.CACHE_FILE);
            const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'te-cache-outside-'));
            try {
                const target = kind === 'external' ? path.join(outside, 'cache.json') : path.join(root, kind === 'dangling' ? 'missing.json' : 'src/source.ts');
                const bytes = Buffer.from(JSON.stringify(initial)); // валидная опора не должна стать warm-hit через ссылку
                if (kind !== 'dangling') fs.writeFileSync(target, bytes);
                const source = fs.readFileSync(path.join(root, 'src/source.ts'));
                const other = fs.readFileSync(path.join(root, 'src/other.ts'));
                fs.unlinkSync(file);
                if (!linkOrSkip(t, target, file, 'file')) return;
                const link = fs.readlinkSync(file);
                assert.equal(signals.readSignalsCache(root), null);
                const noGit = withoutGit(root);
                assert.ifError(noGit.error);
                assert.notEqual(noGit.status, 0, 'ссылочный кэш не должен отвечать без git');
                assert.match(noGit.stderr, /git не найден в PATH/);
                assert.throws(() => signals.publishSignalsCache(root, initial), /обычным файлом, не ссылкой/);
                const fresh = signals.loadSignals(root, opts);
                assert.equal(fresh.fromCache, false); // история доступна, запись best-effort отклоняется
                assert.equal(fs.readlinkSync(file), link);
                assert.deepEqual(fs.readFileSync(path.join(root, 'src/source.ts')), source);
                assert.deepEqual(fs.readFileSync(path.join(root, 'src/other.ts')), other);
                if (kind === 'dangling') assert.equal(fs.existsSync(target), false);
                else assert.deepEqual(fs.readFileSync(target), bytes);
                assert.deepEqual(tmpFiles(root), []);
            } finally {
                fs.rmSync(outside, {recursive: true, force: true});
            }
        }));
    }

    test(label + ' cache safety: directory endpoint rejected, no descendant changes', () => repo(root => {
        const file = path.join(root, signals.CACHE_FILE);
        fs.mkdirSync(file);
        fs.writeFileSync(path.join(file, 'keep'), 'unchanged');
        assert.equal(signals.readSignalsCache(root), null);
        assert.throws(() => signals.publishSignalsCache(root, {}), /обычным файлом/);
        assert.equal(fs.readFileSync(path.join(file, 'keep'), 'utf8'), 'unchanged');
        assert.deepEqual(tmpFiles(root), []);
    }));

    test(label + ' cache safety: root junction/symlink uses canonical directory and warm-hit', t => repo(root => {
        const aliases = fs.mkdtempSync(path.join(os.tmpdir(), 'te-cache-alias-'));
        const alias = path.join(aliases, 'root');
        try {
            if (!linkOrSkip(t, root, alias, process.platform === 'win32' ? 'junction' : 'dir')) return;
            const first = signals.loadSignals(alias, opts);
            assert.equal(first.fromCache, false);
            assert.deepEqual(signals.readSignalsCache(root), first.data);
            const warm = withoutGit(alias);
            assert.ifError(warm.error);
            assert.equal(warm.status, 0, warm.stdout + warm.stderr);
            assert.equal(JSON.parse(warm.stdout).fromCache, true);
            assert.deepEqual(tmpFiles(root), []);
        } finally {
            if (fs.existsSync(alias)) fs.unlinkSync(alias);
            fs.rmSync(aliases, {recursive: true, force: true});
        }
    }));

    test(label + ' cache safety: HEAD/since/maxCommits/pathspec still invalidate cache', () => repo(root => {
        const first = signals.loadSignals(root, opts).data;
        // 2099, не 2100: с года 2100 git перестаёт применять --since и возвращает всю
        // историю — тест на инвалидацию превращался в проверку игнорирования фильтра.
        for (const changed of [{...opts, since: '2099-01-01'}, {...opts, maxCommits: 1}, {...opts, pathspec: ['src/source.ts']}]) {
            signals.publishSignalsCache(root, first);
            const miss = withoutGit(root, changed);
            assert.ifError(miss.error);
            assert.notEqual(miss.status, 0, 'изменённый ключ не может быть warm-hit');
            const collected = signals.loadSignals(root, changed);
            assert.equal(collected.fromCache, false);
            assert.equal(collected.data.since, changed.since);
            assert.equal(collected.data.maxCommits, changed.maxCommits);
            assert.deepEqual(collected.data.pathspec, changed.pathspec);
            if (changed.since === '2099-01-01') assert.equal(collected.data.commitsTotal, 0);
            if (changed.maxCommits === 1) assert.equal(collected.data.ceiling, true);
            if (changed.pathspec.length) assert.deepEqual(Object.keys(collected.data.files), ['src/source.ts']);
        }
        signals.publishSignalsCache(root, first);
        write(root, {'src/source.ts': lines(61)});
        commitAll(root, 'fix: changed HEAD');
        const miss = withoutGit(root);
        assert.ifError(miss.error);
        assert.notEqual(miss.status, 0);
        const next = signals.loadSignals(root, opts);
        assert.equal(next.fromCache, false);
        assert.notEqual(next.data.head, first.head);
    }));

    for (const operation of ['openSync', 'writeFileSync', 'renameSync']) {
        test(label + ' cache safety: ' + operation + ' failure preserves old cache and source, cleans own tmp', () => repo(root => {
            const data = signals.loadSignals(root, opts).data;
            const file = path.join(root, signals.CACHE_FILE), before = fs.readFileSync(file);
            const source = fs.readFileSync(path.join(root, 'src/source.ts'));
            const decoy = path.join(root, signals.CACHE_FILE + '.unrelated.tmp');
            fs.writeFileSync(decoy, 'not ours');
            const original = fs[operation];
            fs[operation] = function (...args) {
                const writingTmp = operation === 'openSync' ? args[1] === 'wx' : operation === 'writeFileSync' ? typeof args[0] === 'number' : path.basename(args[1]) === signals.CACHE_FILE;
                if (writingTmp) {
                    if (operation === 'writeFileSync') original.call(fs, args[0], '{partial', 'utf8');
                    throw Object.assign(new Error('injected ' + operation + ' failure'), {code: 'EACCES'});
                }
                return original.apply(fs, args);
            };
            try {
                assert.throws(() => signals.publishSignalsCache(root, {...data, collectedAt: 'changed'}), /injected/);
            } finally {
                fs[operation] = original;
            }
            assert.deepEqual(fs.readFileSync(file), before);
            assert.deepEqual(fs.readFileSync(path.join(root, 'src/source.ts')), source);
            assert.equal(fs.readFileSync(decoy, 'utf8'), 'not ours');
            assert.deepEqual(tmpFiles(root), [path.basename(decoy)]);
        }));
    }

    test(label + ' cache safety: pre-existing fixed tmp symlink is never opened or removed', t => repo(root => {
        const sourceFile = path.join(root, 'src/source.ts'), source = fs.readFileSync(sourceFile);
        const fixedTmp = path.join(root, signals.CACHE_FILE + '.tmp');
        if (!linkOrSkip(t, sourceFile, fixedTmp, 'file')) return;
        const link = fs.readlinkSync(fixedTmp);
        const data = signals.loadSignals(root, opts);
        assert.equal(data.fromCache, false);
        assert.deepEqual(fs.readFileSync(sourceFile), source);
        assert.equal(fs.readlinkSync(fixedTmp), link);
        assert.deepEqual(tmpFiles(root), [path.basename(fixedTmp)]);
        assert.deepEqual(signals.readSignalsCache(root), data.data);
    }));

    test(label + ' cache safety: unique tmp collision retries exclusively and leaves collided path alone', () => repo(root => {
        const data = signals.loadSignals(root, opts).data;
        const original = fs.openSync, names = [];
        let collision;
        fs.openSync = function (file, flags, ...rest) {
            if (flags === 'wx') {
                names.push(file);
                if (!collision) {
                    collision = file;
                    const fd = original.call(fs, file, 'wx', 0o600);
                    fs.writeFileSync(fd, 'not ours');
                    fs.closeSync(fd);
                }
            }
            return original.call(fs, file, flags, ...rest);
        };
        try {
            signals.publishSignalsCache(root, data);
        } finally {
            fs.openSync = original;
        }
        assert.equal(names.length, 2);
        assert.notEqual(names[0], names[1]);
        assert.equal(fs.readFileSync(collision, 'utf8'), 'not ours');
        assert.deepEqual(tmpFiles(root), [path.basename(collision)]);
        assert.deepEqual(signals.readSignalsCache(root), data);
    }));
}

module.exports = {buildHotspotsSuite, buildSignalsCacheSuite, git, gitRepo, write, commitAll, lines, isolatedEnv, envWithoutGit, GIT_IDENTITY};
