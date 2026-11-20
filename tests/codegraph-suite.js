// Общий набор детект-сценариев CodeGraph для пяти скиллов (план codegraph-bridge, задача 6).
// CodeGraph в CI не устанавливается: доступные состояния эмулируются фейковым шимом в PATH
// и пустым файлом .codegraph/codegraph.db. Детект скилла обязан уложиться в 2 с по
// конструкции (таймаут запуска CLI), поэтому кейсы not_installed/timeout проверяют общий
// предел 3 с на весь вызов info, а не свой таймаут теста.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const IS_WIN = process.platform === 'win32';
// Минимальный PATH без CodeGraph: дети (cmd.exe, python, node) стартуют, шима там нет.
const SYSTEM_PATH = IS_WIN ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32') : '/usr/bin';

function isolatedEnv(root, {shimDir = null} = {}) {
    const env = {...process.env, NODE_OPTIONS: '', HOME: root, USERPROFILE: root};
    delete env.Path;
    env.PATH = [shimDir, SYSTEM_PATH].filter(Boolean).join(path.delimiter);
    return env;
}

// Фейковый CLI: на Windows .cmd (детект обязан запускать его через shell-механику cmd.exe),
// на POSIX — исполняемый sh-скрипт. hang висит дольше 2-секундного детекта.
function makeShimDir(t, kind) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'te-cg-shim-'));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    if (IS_WIN) {
        const eol = '\r\n';
        const text = kind === 'hang'
            ? '@cd /d %TEMP%' + eol + '@%SystemRoot%\\System32\\ping.exe -n 11 127.0.0.1 > NUL' + eol
            : '@echo 1.6.3' + eol;
        fs.writeFileSync(path.join(dir, 'codegraph.cmd'), text);
    } else {
        const text = kind === 'hang' ? '#!/bin/sh\nsleep 10\n' : '#!/bin/sh\necho 1.6.3\n';
        fs.writeFileSync(path.join(dir, 'codegraph'), text, {mode: 0o755});
    }
    return dir;
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
    const withFixture = (t, run, {shim = null, withIndex = false} = {}) => {
        const base = fs.mkdtempSync(path.join(os.tmpdir(), 'te-cg-'));
        t.after(() => fs.rmSync(base, {recursive: true, force: true}));
        const root = path.join(base, 'project');
        fs.mkdirSync(root);
        fixture(root);
        if (withIndex) {
            fs.mkdirSync(path.join(root, '.codegraph'));
            fs.writeFileSync(path.join(root, '.codegraph', 'codegraph.db'), '');
        }
        const env = isolatedEnv(root, {shimDir: shim ? makeShimDir(t, shim) : null});
        return Object.assign(run(root, env), {root});
    };
    const extract = (r) => (json ? JSON.parse(r.stdout).integrations.codegraph : integrationsFromText(r.stdout));
    const tryExtract = (r) => {
        try { return extract(r); } catch (e) { return null; }
    };
    const it = (name, fn) => (skip ? test(label + ' ' + name, {skip}, fn) : test(label + ' ' + name, fn));

    it('codegraph: без шима и индекса — not_installed, info не дольше 3 с', (t) => {
        const r = withFixture(t, (root, env) => timed(() => spawn(root, [], env)));
        assert.equal(r.status, 0, r.stdout + r.stderr);
        const cg = extract(r);
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
        assert.ok(r.elapsed <= 3000, 'info занял ' + r.elapsed + ' мс');
    });

    it('codegraph: отключение детекта — поля integrations нет вовсе', (t) => {
        const r = withFixture(t, (root, env) => spawn(root, disableArg, env), {shim: 'echo', withIndex: true});
        assert.equal(r.status, 0, r.stdout + r.stderr);
        if (json) assert.ok(!('integrations' in JSON.parse(r.stdout)));
        else assert.ok(!r.stdout.includes('integrations:'));
    });

    it('codegraph: регресс — info без поля integrations совпадает с отключённым детектом', (t) => {
        const base = withFixture(t, (root, env) => spawn(root, disableArg, env), {shim: 'echo', withIndex: true});
        assert.equal(base.status, 0, base.stdout + base.stderr);
        const full = withFixture(t, (root, env) => spawn(root, [], env), {shim: 'echo', withIndex: true});
        assert.equal(full.status, 0, full.stdout + full.stderr);
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
