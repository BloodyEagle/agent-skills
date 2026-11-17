const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const {performance} = require('node:perf_hooks');
const {computeMetrics, metricsRows} = require('../../skills/token-economy-php/scripts/lib/metrics');
const {makeCtx, ensureIndex} = require('../../skills/token-economy-php/scripts/lib/index');
const bx = path.resolve(__dirname, '../../skills/token-economy-php/scripts/bx.js');

function graph(names, pairs, depth = 2) {
    return computeMetrics({files: names.map(id => ({id, path: id})),
        edges: pairs.map(([from, to]) => ({from, to, type: 'import'})), depth});
}
const row = (metrics, id) => metrics.perFile.find(item => item.id === id);

test('chain: local dependents, full impact and JSON-compatible object', () => {
    const metrics = graph(['a', 'b', 'c', 'd'], [['a', 'b'], ['b', 'c'], ['c', 'd']]);
    assert.equal(row(metrics, 'd').fan_in, 1);
    assert.equal(row(metrics, 'd').dependents, 2);
    assert.equal(row(metrics, 'd').impact, 3);
    assert.equal(row(metrics, 'a').fan_out, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(metrics)), metrics);
});

test('diamond: unique dependents and impact, depth does not grow beyond component', () => {
    const pairs = [['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'd']];
    for (const depth of [1, 2, 5]) {
        const target = row(graph(['a', 'b', 'c', 'd'], pairs, depth), 'd');
        assert.equal(target.fan_in, 2);
        assert.equal(target.dependents, depth === 1 ? 2 : 3);
        assert.equal(target.impact, 3);
    }
});

test('cycle and self-loop terminate and never count the target in impact', () => {
    const metrics = graph(['a', 'b', 's', 'z'], [['a', 'b'], ['b', 'a'], ['s', 's']]);
    assert.equal(metrics.cycles, 2);
    assert.equal(row(metrics, 'a').dependents, 1);
    assert.equal(row(metrics, 'a').impact, 1);
    assert.equal(row(metrics, 's').impact, 0);
    assert.equal(row(metrics, 's').dependents, 0);
    assert.equal(row(metrics, 'z').impact, 0);
});

test('typed duplicates and external endpoints do not inflate degree', () => {
    const metrics = computeMetrics({files: [{id: 1, path: 'a'}, {id: 2, path: 'b'}],
        edges: [{from: 1, to: 2, type: 'import'}, {from: 1, to: 2, type: 'uses'},
            {from: 1, to: 99}, {from: 99, to: 2}]});
    assert.equal(row(metrics, 1).fan_out, 1);
    assert.equal(row(metrics, 2).fan_in, 1);
    assert.equal(row(metrics, 2).impact, 1);
});

test('PageRank favours depended-upon nodes and preserves dangling mass', () => {
    const metrics = graph(['a', 'b', 'c', 'd'], [['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'd']]);
    assert.ok(row(metrics, 'd').pagerank > row(metrics, 'a').pagerank);
    assert.ok(Math.abs(metrics.perFile.reduce((sum, item) => sum + item.pagerank, 0) - 1) < 1e-12);
    const isolated = graph(['a', 'b'], []);
    assert.equal(row(isolated, 'a').pagerank, 0.5);
    assert.equal(row(isolated, 'b').pagerank, 0.5);
});

test('percentile uses midrank ties and top has deterministic path tie-break', () => {
    const metrics = graph(['z', 'b', 'a', 'd'], [['z', 'b'], ['z', 'a'], ['b', 'd'], ['a', 'd']]);
    assert.equal(row(metrics, 'z').percentile.fan_in, 12.5);
    assert.equal(row(metrics, 'a').percentile.fan_in, 50);
    assert.equal(row(metrics, 'b').percentile.fan_in, 50);
    assert.equal(row(metrics, 'd').percentile.fan_in, 87.5);
    assert.deepEqual(metricsRows(metrics, {top: 3}).map(item => item.path), ['d', 'a', 'b']);
    assert.deepEqual(metricsRows(graph(['z', 'a'], []), {top: 2}).map(item => item.path), ['a', 'z']);
});

function project(t, files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bx-metrics-'));
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    for (const [rel, text] of Object.entries(files)) {
        const target = path.join(root, rel);
        fs.mkdirSync(path.dirname(target), {recursive: true});
        fs.writeFileSync(target, text, 'utf8');
    }
    return root;
}
function cli(root, args) {
    const result = spawnSync(process.execPath, [bx, 'root=' + root,
        ...Object.entries(args).map(([key, value]) => key + '=' + value)], {
        cwd: __dirname, encoding: 'utf8', timeout: 5000, windowsHide: true,
        env: {...process.env, HOME: root, USERPROFILE: root, NODE_OPTIONS: ''}
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    return result;
}
function success(root, args) {
    const result = cli(root, {op: 'metrics', ...args});
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout.trim();
}
const diamond = {'composer.json': '{}', 'a.php': "<?php require __DIR__.'/b.php'; require __DIR__.'/c.php';\n",
    'b.php': "<?php require __DIR__.'/d.php';\n", 'c.php': "<?php require __DIR__.'/d.php';\n", 'd.php': '<?php $d = 1;\n'};
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('PHP diamond CLI exposes unique fan-in, dependents and impact', t => {
    const root = project(t, diamond);
    assert.match(success(root, {file: 'd.php'}), /^d\.php  fan-in 2 .*fan-out 0  dependents\(2\) 3  impact 3/);
    assert.match(success(root, {file: 'd.php', depth: 1}), /dependents\(1\) 2  impact 3/);
    const reverse = cli(root, {op: 'rdeps', file: 'd.php', depth: 1});
    assert.equal(reverse.status, 0);
    assert.match(reverse.stdout, /b\.php/);
    assert.match(reverse.stdout, /c\.php/);
});

test('PHP top=2 prints two rows in stable rank order', t => {
    const root = project(t, diamond);
    const output = success(root, {top: 2}).split('\n');
    assert.equal(output.length, 2);
    assert.match(output[0], /^1\. d\.php/);
    assert.match(output[1], /^2\. b\.php/);
});

test('PHP adapter keeps one file pair and excludes vendor', t => {
    const root = project(t, {'composer.json': '{}', 'a.php': "<?php require __DIR__.'/b.php'; require __DIR__.'/b.php'; new B();\n",
        'b.php': '<?php class B {}\n', 'vendor/ext.php': '<?php class External {}\n'});
    const index = ensureIndex(makeCtx({root}));
    assert.equal(index.nodes.length, 2);
    const a = index.nodes.find(n => n.p === 'a.php');
    assert.equal(a.edges.length, 1);
    assert.equal(index.nodes.find(n => n.id === a.edges[0][0]).p, 'b.php');
    assert.match(success(root, {file: 'b.php'}), /fan-in 1 .*dependents\(2\) 1  impact 1/);
});

test('PHP full impact exceeds local depth on a long chain', t => {
    const root = project(t, {...diamond, 'c.php': '<?php $c = 1;\n',
        'a.php': "<?php require __DIR__.'/b.php';\n", 'z.php': "<?php require __DIR__.'/a.php';\n"});
    assert.match(success(root, {file: 'd.php'}), /dependents\(2\) 2  impact 3/);
});

test('PHP invalid arguments and unknown file are explicit errors', t => {
    const root = project(t, diamond);
    for (const args of [{file: 'missing.php'}, {depth: 0}, {depth: 6}, {depth: 'x'}, {top: 0},
        {top: 'x'}, {file: 'd.php', top: 2}]) {
        const result = cli(root, {op: 'metrics', ...args});
        assert.equal(result.status, 1, result.stdout);
        assert.match(result.stdout, /Ошибка:/);
        if (args.file === 'missing.php') assert.match(result.stdout, /op=stats/);
    }
});

test('PHP empty graph is explicit', t => {
    const root = project(t, {'composer.json': '{}'});
    assert.match(success(root, {}), /Граф пуст: .*index\.json/);
});

test('PHP warm metrics does not rewrite graph or parse cache', t => {
    const root = project(t, diamond);
    const warm = cli(root, {op: 'stats'});
    assert.equal(warm.status, 0, warm.stdout);
    const files = ['index.json', 'cache.json'].map(file => path.join(root, '.bx-cache', file));
    const before = files.map(digest);
    success(root, {file: 'd.php'});
    assert.deepEqual(files.map(digest), before);
});

test('PHP warmed cycle finishes within two seconds and reports one cycle', t => {
    const root = project(t, {'composer.json': '{}', 'a.php': "<?php require __DIR__.'/b.php';\n",
        'b.php': "<?php require __DIR__.'/a.php';\n"});
    assert.equal(cli(root, {op: 'stats'}).status, 0);
    const started = performance.now();
    const output = success(root, {file: 'a.php'});
    assert.ok(performance.now() - started < 2000);
    assert.match(output, /impact 1/);
    assert.match(output, /циклов: 1$/);
});
