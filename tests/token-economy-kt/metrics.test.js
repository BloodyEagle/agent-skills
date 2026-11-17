const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const {performance} = require('node:perf_hooks');
const scripts = path.resolve(__dirname, '../../skills/token-economy-kt/scripts');
const {computeMetrics, parseMetricsArgs, metricsRows, formatMetrics} = require(path.join(scripts, 'lib', 'metrics'));

function graph(names, pairs, depth = 2) {
    return computeMetrics({files: names.map(id => ({id, path: id})),
        edges: pairs.map(([from, to]) => ({from, to, type: 'import'})), depth});
}
const row = (metrics, id) => metrics.perFile.find(item => item.id === id);
const diamond = {'A.kt': 'package fixture\nimport fixture.B\nimport fixture.C\nclass A(val b: B, val c: C)\n',
    'B.kt': 'package fixture\nimport fixture.D\nclass B(val d: D)\n',
    'C.kt': 'package fixture\nimport fixture.D\nclass C(val d: D)\n', 'D.kt': 'package fixture\nclass D\n'};
const chain = {'A.kt': 'class A(val b: B)\n', 'B.kt': 'class B(val c: C)\n',
    'C.kt': 'class C(val d: D)\n', 'D.kt': 'class D\n'};
const diamondPairs = [['A.kt', 'B.kt'], ['A.kt', 'C.kt'], ['B.kt', 'D.kt'], ['C.kt', 'D.kt']];
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function project(t, files = diamond) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-metrics-'));
    const root = path.join(dir, 'project');
    fs.mkdirSync(root);
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    const env = {...process.env, HOME: dir, USERPROFILE: dir, KT_JARS: ''};
    delete env.NODE_OPTIONS;
    delete env.NODE_PATH;
    const write = (rel, content) => {
        const file = path.join(root, rel);
        fs.mkdirSync(path.dirname(file), {recursive: true});
        fs.writeFileSync(file, content, 'utf8');
        return file;
    };
    for (const [rel, content] of Object.entries(files)) write(rel, content);
    const run = args => spawnSync(process.execPath, [path.join(scripts, 'kt.js'), 'root=' + root,
        ...Object.entries(args).map(([key, value]) => key + '=' + value)],
    {cwd: dir, env, encoding: 'utf8', timeout: 2500, maxBuffer: 1024 * 1024});
    return {root, write, run};
}

function ok(result) {
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout.trim();
}

function single(p, file, metrics) {
    const target = row(metrics, file);
    assert.equal(ok(p.run({op: 'metrics', file: './' + file, depth: metrics.depth})),
        formatMetrics([target], {depth: metrics.depth, single: true, cycles: metrics.cycles}));
}

function rejected(result, pattern) {
    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /^Ошибка: /);
    assert.match(result.stderr, pattern);
    assert.doesNotMatch(result.stderr, /\n\s+at |RangeError|TypeError|SyntaxError/);
}

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

test('CLI chain: local dependents, unbounded impact and fan-out', t => {
    const p = project(t, chain);
    const metrics = graph(Object.keys(chain), [['A.kt', 'B.kt'], ['B.kt', 'C.kt'], ['C.kt', 'D.kt']]);
    single(p, 'D.kt', metrics);
    single(p, 'A.kt', metrics);
    assert.match(ok(p.run({op: 'metrics', file: 'D.kt'})), /dependents\(2\) 2  impact 3/);
});

test('CLI diamond: unique fan-in and dependents agree with rdeps', t => {
    const p = project(t);
    single(p, 'D.kt', graph(Object.keys(diamond), diamondPairs));
    const reverse = ok(p.run({op: 'rdeps', file: 'D.kt'}));
    const paths = reverse.split('\n').filter(line => /^    /.test(line)).map(line => line.trim().split(':')[0]);
    assert.deepEqual([...new Set(paths)].sort(), ['B.kt', 'C.kt']);
});

test('CLI depth changes local dependents only and accepts the complete 1..5 range', t => {
    const p = project(t);
    for (const depth of [1, 2, 3, 4, 5]) single(p, 'D.kt', graph(Object.keys(diamond), diamondPairs, depth));
});

test('CLI warm cycle completes within two seconds without a nonexistent cycles hint', t => {
    const p = project(t, {'A.kt': 'class A(val b: B)\n', 'B.kt': 'class B(val a: A)\n'});
    ok(p.run({op: 'stats'}));
    const started = performance.now();
    const result = ok(p.run({op: 'metrics', file: 'A.kt'}));
    assert.ok(performance.now() - started < 2000);
    assert.match(result, /dependents\(2\) 1  impact 1/);
    assert.match(result, /\nциклов: 1$/);
    assert.doesNotMatch(result, /op=cycles/);
});

test('CLI PageRank ranks depended-upon nodes and text equals the common formatter', t => {
    const p = project(t);
    const metrics = graph(Object.keys(diamond), diamondPairs);
    assert.equal(ok(p.run({op: 'metrics'})), formatMetrics(metricsRows(metrics)));
    const output = ok(p.run({op: 'metrics', file: 'D.kt'}));
    assert.ok(Number(output.match(/pagerank ([\d.]+)/)[1]) > row(metrics, 'A.kt').pagerank);
});

test('CLI top=2 returns exactly two rows with a stable path tie-break', t => {
    const p = project(t);
    const output = ok(p.run({op: 'metrics', top: 2}));
    assert.equal(output.split('\n').length, 2);
    assert.match(output, /^1\. D\.kt/);
    assert.match(output, /\n2\. B\.kt/);
});

test('CLI unknown file is exit 1 with stats hint', t => {
    const p = project(t);
    rejected(p.run({op: 'metrics', file: './missing.kt'}), /missing\.kt.*не найден.*op=stats/);
});

test('CLI warm metrics preserves the index hash and modification time', t => {
    const p = project(t);
    ok(p.run({op: 'stats'}));
    const file = path.join(p.root, '.kt-cache', 'index.json');
    const before = {hash: digest(file), mtime: fs.statSync(file).mtimeMs};
    ok(p.run({op: 'metrics'}));
    ok(p.run({op: 'metrics', file: 'D.kt', depth: 1}));
    assert.deepEqual({hash: digest(file), mtime: fs.statSync(file).mtimeMs}, before);
});

test('strict depth/top validation rejects malformed and unsafe integers without coercion', t => {
    const p = project(t);
    assert.deepEqual(parseMetricsArgs({}), {file: null, top: 15, depth: 2});
    for (const value of ['', '0', '-1', '1.5', '1e2', '2x', 'true', ' 2', '9007199254740992']) {
        rejected(p.run({op: 'metrics', depth: value}), /depth/);
        rejected(p.run({op: 'metrics', top: value}), /top/);
    }
    rejected(p.run({op: 'metrics', depth: 6}), /depth/);
    rejected(p.run({op: 'metrics', file: 'D.kt', top: 2}), /file.*top/);
    for (const value of [true, [], Infinity]) {
        assert.throws(() => parseMetricsArgs({depth: value}), /depth/);
        assert.throws(() => parseMetricsArgs({top: value}), /top/);
    }
});

test('empty graph reports its explicit cache path', t => {
    const p = project(t, {'build.gradle.kts': 'plugins {}\n', 'notes.txt': 'not a graph node\n'});
    assert.equal(ok(p.run({op: 'metrics'})), 'Граф пуст: ' + path.join(p.root, '.kt-cache', 'index.json'));
    rejected(p.run({op: 'metrics', file: 'missing.kt'}), /op=stats/);
});

test('adapter collapses extends/inject/uses per file and excludes external nodes', t => {
    const p = project(t, {'A.kt': 'import external.Unknown\nclass A(val b: B) : B()\n',
        'B.kt': 'open class B\n'});
    const raw = ok(p.run({op: 'deps', file: 'A.kt'}));
    assert.match(raw, /extends/);
    assert.match(raw, /inject/);
    assert.match(raw, /uses/);
    single(p, 'A.kt', graph(['A.kt', 'B.kt'], [['A.kt', 'B.kt']]));
    single(p, 'B.kt', graph(['A.kt', 'B.kt'], [['A.kt', 'B.kt']]));
    assert.equal(ok(p.run({op: 'metrics', top: 99})).split('\n').length, 2);
});

test('KT universe includes sources and manifest/layout/navigation/values, not arbitrary files', t => {
    const files = {'A.kt': 'class A { val binding = MainBinding.inflate(); }\n',
        'Legacy.java': 'class Legacy {}\n', 'app/src/main/AndroidManifest.xml': '<manifest/>\n',
        'app/src/main/res/layout/main.xml': '<LinearLayout/>\n',
        'app/src/main/res/navigation/main.xml': '<navigation/>\n',
        'app/src/main/res/values/strings.xml': '<resources><string name="app">App</string></resources>\n',
        'app/src/main/res/values-ru/strings.xml': '<resources><string name="app">Приложение</string></resources>\n',
        'other.xml': '<ignored/>\n', 'README.txt': 'ignored\n', 'build.gradle.kts': 'plugins {}\n'};
    const p = project(t, files);
    const names = Object.keys(files).slice(0, 7);
    const metrics = graph(names, [['A.kt', 'app/src/main/res/layout/main.xml']]);
    assert.equal(ok(p.run({op: 'metrics', top: 99})), formatMetrics(metricsRows(metrics, {top: 99})));
    single(p, 'app/src/main/res/layout/main.xml', metrics);
    single(p, 'app/src/main/res/values-ru/strings.xml', metrics);
    rejected(p.run({op: 'metrics', file: 'other.xml'}), /op=stats/);
});

test('default top is 15; no shared depth default changes rdeps', t => {
    const files = Object.fromEntries(Array.from({length: 16}, (_, i) => ['F' + String(i).padStart(2, '0') + '.kt', 'class F' + i + '\n']));
    const p = project(t, files);
    const metrics = graph(Object.keys(files), []);
    assert.equal(ok(p.run({op: 'metrics'})), formatMetrics(metricsRows(metrics, {top: 15})));
    assert.equal(ok(p.run({op: 'metrics'})).split('\n').length, 15);
    const q = project(t, chain);
    const reverse = ok(q.run({op: 'rdeps', file: 'D.kt'}));
    assert.match(reverse, /C\.kt/);
    assert.doesNotMatch(reverse, /B\.kt|A\.kt/);
});

test('kernel bytes and first six formula tests match the TS source verbatim', () => {
    const tsKernel = path.resolve(__dirname, '../../skills/token-economy-ts/scripts/lib/metrics.js');
    assert.equal(digest(path.join(scripts, 'lib', 'metrics.js')), digest(tsKernel));
    const tsTests = fs.readFileSync(path.resolve(__dirname, '../token-economy-ts/metrics.test.js'), 'utf8');
    const ownTests = fs.readFileSync(__filename, 'utf8');
    const start = "test('chain: local dependents";
    const end = "\n\ntest('argument validation";
    const formulas = tsTests.slice(tsTests.indexOf(start), tsTests.indexOf(end));
    assert.ok(formulas.length > 2000);
    assert.ok(ownTests.includes(formulas));
});
