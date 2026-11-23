// Общий набор детект-сценариев CodeGraph для пяти скиллов (план codegraph-bridge, задача 6).
// CodeGraph в CI не устанавливается: PATH и домашние установки эмулируются фейковыми
// шимами, индекс — пустым файлом .codegraph/codegraph.db. Детект скилла ограничен 2 с;
// кейсы not_installed/timeout сохраняют общий предел 3 с на весь вызов info.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const IS_WIN = process.platform === 'win32';
const HINT_PREFIX = 'CodeGraph найден вне PATH. Интеграция работает. Для вызова codegraph из терминала добавьте «';
const homeHint = (directory) => HINT_PREFIX + directory + '» в пользовательский PATH и перезапустите приложение.';

function isolatedEnv(home, userProfile, shimDir, emptyPath) {
    const env = {...process.env};
    // Windows сравнивает имена переменных без учёта регистра; не оставляем дублей.
    for (const key of Object.keys(env)) {
        if (['PATH', 'HOME', 'USERPROFILE', 'NODE_OPTIONS'].includes(key.toUpperCase())) delete env[key];
    }
    if (IS_WIN) env.ComSpec = process.env.ComSpec || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
    return {...env, NODE_OPTIONS: '', HOME: home, USERPROFILE: userProfile, PATH: shimDir || emptyPath};
}

// Только встроенные команды cmd/sh и абсолютный sleep: системный PATH не нужен,
// поэтому реальная установка CodeGraph не может попасть в фикстуру.
function makeShim(dir, spec, observation) {
    const {kind = 'echo', version = '1.6.3', extension = IS_WIN ? '.cmd' : '', executable = true} =
        typeof spec === 'string' ? {kind: spec} : spec;
    fs.mkdirSync(dir, {recursive: true});
    const bin = path.join(dir, 'codegraph' + extension);
    if (kind === 'directory') {
        fs.mkdirSync(bin);
        return bin;
    }
    const text = IS_WIN
        ? '@echo off\r\n' +
            '>>"' + observation + '" echo args=%*\r\n' +
            '>>"' + observation + '" echo PATH=%PATH%\r\n' +
            '>>"' + observation + '" echo HOME=%HOME%\r\n' +
            '>>"' + observation + '" echo USERPROFILE=%USERPROFILE%\r\n' +
            (kind === 'hang' ? '@cd /d %TEMP%\r\n@%SystemRoot%\\System32\\ping.exe -n 11 127.0.0.1 > NUL\r\n'
                : kind === 'broken' ? 'exit /b 7\r\n' : 'echo ' + version + '\r\n')
        : '#!/bin/sh\nprintf \'%s\\n\' "args=$*" "PATH=$PATH" "HOME=$HOME" "USERPROFILE=$USERPROFILE" >> ' +
            "'" + observation.replace(/'/g, "'\\''") + "'\n" +
            (kind === 'hang' ? 'exec /bin/sleep 10\n' : kind === 'broken' ? 'exit 7\n' : 'echo ' + version + '\n');
    fs.writeFileSync(bin, text, {mode: 0o755});
    if (!IS_WIN && !executable) fs.chmodSync(bin, 0o644);
    return bin;
}

function profileSentinels(home) {
    for (const name of ['.profile', '.bashrc', '.bash_profile', '.zshrc', '.config/fish/config.fish',
        '.config/codegraph/config.json', 'Documents/WindowsPowerShell/Microsoft.PowerShell_profile.ps1',
        'Documents/PowerShell/Microsoft.PowerShell_profile.ps1']) {
        const file = path.join(home, name);
        fs.mkdirSync(path.dirname(file), {recursive: true});
        fs.writeFileSync(file, 'profile sentinel: ' + name + '\n');
    }
}

function snapshot(dir) {
    if (!fs.existsSync(dir)) return null;
    const stat = fs.statSync(dir);
    if (!stat.isDirectory()) return {bytes: fs.readFileSync(dir).toString('hex'), mode: stat.mode};
    return Object.fromEntries(fs.readdirSync(dir).sort().map((name) => [name, snapshot(path.join(dir, name))]));
}

function assertProbes(r, source) {
    for (const candidate of ['path', 'home']) {
        const log = r.observations[candidate];
        if (candidate !== source) {
            assert.equal(fs.existsSync(log), false, candidate + ': неожиданный запуск CLI');
            continue;
        }
        assert.deepEqual(fs.readFileSync(log, 'utf8').trimEnd().split(/\r?\n/), [
            'args=version', 'PATH=' + r.env.PATH, 'HOME=' + r.env.HOME, 'USERPROFILE=' + r.env.USERPROFILE,
        ], candidate + ': только version, без изменения окружения');
    }
}

function timed(spawn) {
    const started = Date.now();
    const r = spawn();
    return {...r, elapsed: Date.now() - started};
}

function integrationsFromText(stdout) {
    const m = stdout.match(/^integrations: (.+)$/m);
    return m ? JSON.parse(m[1]).codegraph : null;
}

// Пути фикстур попадают в вывод info (kt «Проект:», py «корень:») — выравниваем по
// маркеру mkdtemp-каталога, а не по точному пути: на CI Windows TEMP задан 8.3-именем
// (RUNNER~1), а py печатает канонический длинный путь через Path.resolve().
function normalize(s) {
    return s.replace(/te-cg-[A-Za-z0-9]+[\\/]project/g, '<ROOT>');
}

/**
 * buildCodegraphSuite(label, spawn, opts):
 * - spawn(root, args, env) — spawnSync-результат вызова info скилла (args — массив);
 * - opts.json — info отдаёт целиком JSON (ts-скилл), у остальных — текст со строкой
 *   `integrations: {...}`;
 * - opts.disableArg — массив-аргумент отключения детекта (`integrations=0` / `--integrations 0`);
 * - opts.fixture(root) — минимальный проект данного стека;
 * - opts.skip — причина пропуска всего набора (нет Python).
 */
function buildCodegraphSuite(label, spawn, {json = false, disableArg, fixture, skip} = {}) {
    const withFixture = (t, run, {shim = null, homeShim = null, withIndex = false, homeSpaces = false} = {}) => {
        const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'te-cg-')));
        t.after(() => fs.rmSync(base, {recursive: true, force: true}));
        const root = path.join(base, 'project');
        fs.mkdirSync(root);
        fixture(root);
        const indexDir = path.join(root, '.codegraph');
        if (withIndex) {
            fs.mkdirSync(indexDir);
            fs.writeFileSync(path.join(indexDir, 'codegraph.db'), '');
            fs.writeFileSync(path.join(indexDir, 'sentinel'), 'index sentinel\n');
        }
        // Разные чистые каталоги проверяют HOME на POSIX и USERPROFILE на Windows.
        const home = path.join(base, homeSpaces ? 'home with spaces' : 'home');
        const userProfile = path.join(base, homeSpaces ? 'user profile with spaces' : 'user-profile');
        profileSentinels(home);
        profileSentinels(userProfile);
        const homeDir = path.join(IS_WIN ? userProfile : home, '.local', 'bin');
        const pathDir = path.join(base, 'path-bin');
        const emptyPath = path.join(base, 'empty-path');
        fs.mkdirSync(emptyPath);
        const observations = {path: path.join(base, 'path-probe.txt'), home: path.join(base, 'home-probe.txt')};
        const pathBin = shim ? makeShim(pathDir, shim, observations.path) : null;
        const homeBin = homeShim ? makeShim(homeDir, homeShim, observations.home) : null;
        const env = isolatedEnv(home, userProfile, shim ? pathDir : null, emptyPath);
        const watched = [home, userProfile, pathDir, indexDir];
        const before = watched.map(snapshot);
        const envBefore = {...env};
        const parentBefore = {...process.env};
        const result = run(root, env);
        assert.deepEqual(env, envBefore, 'info не меняет переданное окружение');
        assert.deepEqual({...process.env}, parentBefore, 'info не меняет окружение родителя');
        assert.deepEqual(watched.map(snapshot), before, 'info не пишет в профили, шимы или .codegraph');
        return {...result, root, env, pathBin, homeBin, homeDir, observations};
    };
    const extract = (r) => {
        const cg = json ? JSON.parse(r.stdout).integrations.codegraph : integrationsFromText(r.stdout);
        assert.ok(cg, r.stdout + r.stderr);
        if (!json) {
            assert.equal(r.stdout.split(/\r?\n/).filter((line) => line.startsWith('integrations:')).length, 1);
            const hints = r.stdout.split(/\r?\n/).filter((line) => line.startsWith('CodeGraph найден вне PATH'));
            assert.deepEqual(hints, cg.hint === null ? [] : [cg.hint], 'hint — отдельная строка, не часть integrations JSON');
        }
        return cg;
    };
    const assertDetection = (r, expected) => {
        assert.equal(r.status, 0, r.stdout + r.stderr);
        assert.deepEqual(extract(r), {
            available: false, cli_version: null, index: false, db_path: null, reason: 'not_installed',
            executable: null, source: null, hint: null, ...expected,
        });
    };
    const candidate = (r, source) => ({executable: source === 'home' ? r.homeBin : r.pathBin, source, hint: null});
    const tryExtract = (r) => {
        try { return extract(r); } catch (e) { return null; }
    };
    const it = (name, fn) => (skip ? test(label + ' ' + name, {skip}, fn) : test(label + ' ' + name, fn));
    const runInfo = (t, options, {timeout = false} = {}) => {
        const attempt = () => withFixture(t, (root, env) => timed(() => spawn(root, [], env)), options);
        let r = attempt();
        const cg = tryExtract(r);
        // Тот же единственный повтор для старта свежего шима/фоновой нагрузки.
        // Ни 2-секундный probe, ни существующий 3-секундный предел не расширяются.
        if (r.elapsed > 3000 || (!timeout && cg && cg.reason === 'timeout')) r = attempt();
        return r;
    };

    it('codegraph: без шима и индекса — not_installed, info не дольше 3 с', (t) => {
        const r = withFixture(t, (root, env) => timed(() => spawn(root, [], env)));
        assert.equal(r.status, 0, r.stdout + r.stderr);
        const cg = extract(r);
        assertDetection(r, {});
        assertProbes(r, null);
        assert.equal(cg.available, false);
        assert.equal(cg.reason, 'not_installed');
        assert.equal(cg.index, false);
        assert.equal(cg.db_path, null);
        assert.ok(r.elapsed <= 3000, 'info занял ' + r.elapsed + ' мс');
    });

    it('codegraph: фейковый шим и пустой индекс — available, 1.6.3, index', (t) => {
        const attempt = () => withFixture(t, (root, env) => spawn(root, [], env), {shim: 'echo', withIndex: true});
        let r = attempt();
        // Первый запуск свежего .cmd-шима на Windows может попасть под скан антивируса и
        // не уложить старт cmd.exe в 2-секундный детект. Повторяем с новым шимом один раз,
        // не поднимая таймаутов: таймаут дважды на пустом echo — реальный дефект.
        let cg = tryExtract(r);
        if (r.status !== 0 || (cg && cg.available === false && cg.reason === 'timeout')) {
            r = attempt();
            cg = tryExtract(r);
        }
        assert.equal(r.status, 0, r.stdout + r.stderr);
        assert.equal(cg.available, true);
        assert.equal(cg.cli_version, '1.6.3');
        assert.equal(cg.index, true);
        assert.equal(cg.db_path, '.codegraph/codegraph.db');
        assert.equal(cg.reason, null);
        assertDetection(r, {available: true, cli_version: '1.6.3', index: true, db_path: '.codegraph/codegraph.db',
            reason: null, ...candidate(r, 'path')});
        assertProbes(r, 'path');
    });

    it('codegraph: висящий шим — timeout, info не дольше 3 с', (t) => {
        const attempt = () => withFixture(t, (root, env) => timed(() => spawn(root, [], env)), {shim: 'hang'});
        let r = attempt();
        // Детект сам ограничен 2 с по конструкции; поверх него — старт процесса и разбор
        // фикстуры, которые под фоновой нагрузкой могут съесть секундный запас. Один
        // повтор при превышении, таймауты не поднимаются: дважды — реальный дефект.
        if (r.elapsed > 3000) r = attempt();
        assert.equal(r.status, 0, r.stdout + r.stderr);
        const cg = extract(r);
        assert.equal(cg.available, false);
        assert.equal(cg.reason, 'timeout');
        assertDetection(r, {reason: 'timeout', ...candidate(r, 'path')});
        assert.ok(r.elapsed <= 3000, 'info занял ' + r.elapsed + ' мс');
    });

    for (const withIndex of [false, true]) {
        it('codegraph: домашний шим, пробелы в пути, index=' + withIndex + ' — fallback и точный hint', (t) => {
            const r = runInfo(t, {homeShim: 'echo', homeSpaces: true, withIndex});
            assertDetection(r, {available: true, cli_version: '1.6.3', index: withIndex,
                db_path: withIndex ? '.codegraph/codegraph.db' : null, reason: withIndex ? null : 'no_index',
                ...candidate(r, 'home'), hint: homeHint(r.homeDir)});
            assert.ok(path.isAbsolute(extract(r).executable));
            assertProbes(r, 'home');
        });
    }

    it('codegraph: PATH важнее домашнего шима с другой версией — hint отсутствует', (t) => {
        const r = runInfo(t, {shim: {version: '1.6.3'}, homeShim: {version: '9.8.7'}, withIndex: true});
        assertDetection(r, {available: true, cli_version: '1.6.3', index: true, db_path: '.codegraph/codegraph.db',
            reason: null, ...candidate(r, 'path')});
        assert.ok(path.isAbsolute(extract(r).executable));
        assertProbes(r, 'path');
    });

    it('codegraph: сломанный PATH-шим не маскируется рабочей домашней установкой', (t) => {
        const r = runInfo(t, {shim: 'broken', homeShim: 'echo', withIndex: true});
        assertDetection(r, {reason: 'error:7', index: true, db_path: '.codegraph/codegraph.db', ...candidate(r, 'path')});
        assertProbes(r, 'path');
    });

    it('codegraph: висящий PATH-шим не запускает домашний fallback, info не дольше 3 с', (t) => {
        const r = runInfo(t, {shim: 'hang', homeShim: 'echo'}, {timeout: true});
        assertDetection(r, {reason: 'timeout', ...candidate(r, 'path')});
        assert.equal(fs.existsSync(r.observations.home), false);
        assert.ok(r.elapsed <= 3000, 'info занял ' + r.elapsed + ' мс');
    });

    it('codegraph: индекс без домашнего шима — not_installed, info не дольше 3 с', (t) => {
        const r = runInfo(t, {withIndex: true});
        assertDetection(r, {index: true, db_path: '.codegraph/codegraph.db'});
        assertProbes(r, null);
        assert.ok(r.elapsed <= 3000, 'info занял ' + r.elapsed + ' мс');
    });

    for (const withIndex of [false, true]) {
        it('codegraph: сломанный домашний шим, index=' + withIndex + ' — error:7 без hint', (t) => {
            const r = runInfo(t, {homeShim: 'broken', withIndex});
            assertDetection(r, {reason: 'error:7', index: withIndex, db_path: withIndex ? '.codegraph/codegraph.db' : null,
                ...candidate(r, 'home')});
            assertProbes(r, 'home');
        });
    }

    it('codegraph: висящий домашний шим — timeout без hint, info не дольше 3 с', (t) => {
        const r = runInfo(t, {homeShim: 'hang'}, {timeout: true});
        assertDetection(r, {reason: 'timeout', ...candidate(r, 'home')});
        assert.equal(fs.existsSync(r.observations.path), false);
        assert.ok(r.elapsed <= 3000, 'info занял ' + r.elapsed + ' мс');
    });

    it('codegraph: каталог с именем домашнего шима — не установка', (t) => {
        const r = runInfo(t, {homeShim: 'directory'});
        assertDetection(r, {});
        assertProbes(r, null);
    });

    it('codegraph: каталог с именем PATH-шима не мешает домашнему fallback', (t) => {
        const r = runInfo(t, {shim: 'directory', homeShim: 'echo'});
        assertDetection(r, {available: true, cli_version: '1.6.3', reason: 'no_index',
            ...candidate(r, 'home'), hint: homeHint(r.homeDir)});
        assertProbes(r, 'home');
    });

    if (IS_WIN) {
        it('codegraph: домашний .bat с пробелами в пути — доступен', (t) => {
            const r = runInfo(t, {homeShim: {extension: '.bat'}, homeSpaces: true});
            assertDetection(r, {available: true, cli_version: '1.6.3', reason: 'no_index',
                ...candidate(r, 'home'), hint: homeHint(r.homeDir)});
            assertProbes(r, 'home');
        });
    } else {
        it('codegraph: домашний файл без права исполнения — not_installed', (t) => {
            const r = runInfo(t, {homeShim: {executable: false}});
            assertDetection(r, {});
            assertProbes(r, null);
        });
        it('codegraph: PATH-файл без права исполнения не мешает домашнему fallback', (t) => {
            const r = runInfo(t, {shim: {executable: false}, homeShim: 'echo'});
            assertDetection(r, {available: true, cli_version: '1.6.3', reason: 'no_index',
                ...candidate(r, 'home'), hint: homeHint(r.homeDir)});
            assertProbes(r, 'home');
        });
    }

    for (const homeShim of ['echo', 'hang']) {
        it('codegraph: отключение детекта не запускает домашний ' + homeShim + '-шим', (t) => {
            const r = withFixture(t, (root, env) => spawn(root, disableArg, env), {homeShim, withIndex: true});
            assert.equal(r.status, 0, r.stdout + r.stderr);
            if (json) assert.ok(!('integrations' in JSON.parse(r.stdout)));
            else {
                assert.ok(!r.stdout.includes('integrations:'));
                assert.ok(!r.stdout.includes('CodeGraph найден вне PATH'));
            }
            assertProbes(r, null);
        });
    }

    it('codegraph: отключение детекта — поля integrations нет вовсе', (t) => {
        const r = withFixture(t, (root, env) => spawn(root, disableArg, env), {shim: 'echo', withIndex: true});
        assert.equal(r.status, 0, r.stdout + r.stderr);
        if (json) assert.ok(!('integrations' in JSON.parse(r.stdout)));
        else assert.ok(!r.stdout.includes('integrations:'));
        assertProbes(r, null);
    });

    it('codegraph: регресс — info без поля integrations совпадает с отключённым детектом', (t) => {
        const base = withFixture(t, (root, env) => spawn(root, disableArg, env), {shim: 'echo', withIndex: true});
        assert.equal(base.status, 0, base.stdout + base.stderr);
        const full = withFixture(t, (root, env) => spawn(root, [], env), {shim: 'echo', withIndex: true});
        assert.equal(full.status, 0, full.stdout + full.stderr);
        assertDetection(full, {available: true, cli_version: '1.6.3', index: true, db_path: '.codegraph/codegraph.db',
            reason: null, ...candidate(full, 'path')});
        assertProbes(base, null);
        assertProbes(full, 'path');
        if (json) {
            const stripped = JSON.parse(full.stdout);
            delete stripped.integrations;
            assert.deepEqual(stripped, JSON.parse(base.stdout));
        } else {
            // Python пишет CRLF: в JS «.» не матчит \r, поэтому [^\n]* с явным \r?\n.
            const withoutLine = full.stdout.replace(/^integrations: [^\n]*\r?\n?/m, '');
            assert.equal(normalize(withoutLine), normalize(base.stdout));
        }
    });
}

module.exports = {buildCodegraphSuite};
