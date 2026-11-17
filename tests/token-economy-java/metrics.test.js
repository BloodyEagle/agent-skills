const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {performance} = require('node:perf_hooks');
const {project: baseProject} = require('./helpers');
const scripts = path.resolve(__dirname, '../../skills/token-economy-java/scripts');
const {computeMetrics, parseMetricsArgs, metricsRows, formatMetrics} = require(path.join(scripts, 'lib', 'metrics'));

function graph(names, pairs, depth = 2) {
    return computeMetrics({files: names.map(id => ({id, path: id})),
        edges: pairs.map(([from, to]) => ({from, to, type: 'import'})), depth});
}
const row = (metrics, id) => metrics.perFile.find(item => item.id === id);
const diamond = {'A.java': 'package fixture; import fixture.B; import fixture.C; class A { B b; C c; }\n',
    'B.java': 'package fixture; import fixture.D; class B { D d; }\n',
    'C.java': 'package fixture; import fixture.D; class C { D d; }\n', 'D.java': 'package fixture; class D {}\n'};
const chain = {'A.java': 'package fixture; import fixture.B; class A { B b; }\n',
    'B.java': 'package fixture; import fixture.C; class B { C c; }\n',
    'C.java': 'package fixture; import fixture.D; class C { D d; }\n', 'D.java': 'package fixture; class D {}\n'};
const diamondPairs = [['A.java', 'B.java'], ['A.java', 'C.java'], ['B.java', 'D.java'], ['C.java', 'D.java']];
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function project(t, files = diamond) {
    const p = baseProject(t);
    for (const [rel, content] of Object.entries(files)) p.write(rel, content);
    const run = args => p.run(...Object.entries(args).map(([key, value]) => key + '=' + value));
    return {...p, run};
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
    assert.match(result.stdout, /^Ошибка: /);
    assert.match(result.stdout, pattern);
    assert.doesNotMatch(result.stdout + result.stderr, /\n\s+at |RangeError|TypeError|SyntaxError/);
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
    const metrics = graph(Object.keys(chain), [['A.java', 'B.java'], ['B.java', 'C.java'], ['C.java', 'D.java']]);
    single(p, 'D.java', metrics);
    single(p, 'A.java', metrics);
    assert.match(ok(p.run({op: 'metrics', file: 'D.java'})), /dependents\(2\) 2  impact 3/);
});

test('CLI diamond: unique fan-in and dependents agree with rdeps', t => {
    const p = project(t);
    single(p, 'D.java', graph(Object.keys(diamond), diamondPairs));
    const reverse = ok(p.run({op: 'rdeps', file: 'D.java', depth: 1}));
    assert.match(reverse, /используют — 2 \(глубина 1\)/);
    assert.match(reverse, /1 B\.java/);
    assert.match(reverse, /1 C\.java/);
});

test('CLI depth changes local dependents only and accepts the complete 1..5 range', t => {
    const p = project(t);
    for (const depth of [1, 2, 3, 4, 5]) single(p, 'D.java', graph(Object.keys(diamond), diamondPairs, depth));
});

test('CLI warm cycle completes within two seconds without a nonexistent cycles hint', t => {
    const p = project(t, {'A.java': 'package fixture; import fixture.B; class A { B b; }\n',
        'B.java': 'package fixture; import fixture.A; class B { A a; }\n'});
    ok(p.run({op: 'stats'}));
    const started = performance.now();
    const result = ok(p.run({op: 'metrics', file: 'A.java'}));
    assert.ok(performance.now() - started < 2000);
    assert.match(result, /dependents\(2\) 1  impact 1/);
    assert.match(result, /\nциклов: 1$/);
    assert.doesNotMatch(result, /op=cycles/);
});

test('CLI PageRank ranks depended-upon nodes and text equals the common formatter', t => {
    const p = project(t);
    const metrics = graph(Object.keys(diamond), diamondPairs);
    assert.equal(ok(p.run({op: 'metrics'})), formatMetrics(metricsRows(metrics)));
    const output = ok(p.run({op: 'metrics', file: 'D.java'}));
    assert.ok(Number(output.match(/pagerank ([\d.]+)/)[1]) > row(metrics, 'A.java').pagerank);
});

test('CLI top=2 returns exactly two rows with a stable path tie-break', t => {
    const p = project(t);
    const output = ok(p.run({op: 'metrics', top: 2}));
    assert.equal(output.split('\n').length, 2);
    assert.match(output, /^1\. D\.java/);
    assert.match(output, /\n2\. B\.java/);
});

test('CLI unknown file is exit 1 with stats hint', t => {
    const p = project(t);
    rejected(p.run({op: 'metrics', file: './missing.java'}), /не найдено.*missing\.java.*op=stats/);
});

test('CLI warm metrics preserves graph and parse cache hashes and modification times', t => {
    const p = project(t);
    ok(p.run({op: 'stats'}));
    const files = ['index.json', 'cache.json'].map(file => path.join(p.root, '.jv-cache', file));
    const before = files.map(file => ({hash: digest(file), mtime: fs.statSync(file).mtimeMs}));
    ok(p.run({op: 'metrics'}));
    ok(p.run({op: 'metrics', file: 'D.java', depth: 1}));
    assert.deepEqual(files.map(file => ({hash: digest(file), mtime: fs.statSync(file).mtimeMs})), before);
});

test('strict depth/top validation rejects malformed and unsafe integers without coercion', t => {
    const p = project(t);
    assert.deepEqual(parseMetricsArgs({}), {file: null, top: 15, depth: 2});
    for (const value of ['', '0', '-1', '1.5', '1e2', '2x', 'true', ' 2', '9007199254740992']) {
        rejected(p.run({op: 'metrics', depth: value}), /depth/);
        rejected(p.run({op: 'metrics', top: value}), /top/);
    }
    rejected(p.run({op: 'metrics', depth: 6}), /depth/);
    rejected(p.run({op: 'metrics', file: 'D.java', top: 2}), /file.*top/);
    for (const value of [true, [], Infinity]) {
        assert.throws(() => parseMetricsArgs({depth: value}), /depth/);
        assert.throws(() => parseMetricsArgs({top: value}), /top/);
    }
});

test('empty graph reports its explicit cache path', t => {
    const p = project(t, {'pom.xml': '<project/>\n', 'notes.txt': 'not a graph node\n'});
    assert.equal(ok(p.run({op: 'metrics'})), 'Граф пуст: ' + path.join(p.root, '.jv-cache', 'index.json'));
    rejected(p.run({op: 'metrics', file: 'missing.java'}), /op=stats/);
});

test('adapter maps numeric endpoints to paths and counts multi-kind uses once', t => {
    const p = project(t, {'A.java': 'import external.Unknown; class A extends B { A(B b) {} B field; }\n',
        'B.java': 'class B {}\n'});
    const metrics = graph(['A.java', 'B.java'], [['A.java', 'B.java']]);
    single(p, 'A.java', metrics);
    single(p, 'B.java', metrics);
    const deps = ok(p.run({op: 'deps', file: 'A.java'}));
    assert.match(deps, /использует — 1/);
    assert.match(deps, /B\.java.*extends\/implements/);
    assert.equal(ok(p.run({op: 'metrics', top: 99})).split('\n').length, 2);
});

test('default top is 15 and existing rdeps keeps depth 1', t => {
    const files = Object.fromEntries(Array.from({length: 16}, (_, i) => ['F' + String(i).padStart(2, '0') + '.java', 'class F' + i + ' {}\n']));
    const p = project(t, files);
    const metrics = graph(Object.keys(files), []);
    assert.equal(ok(p.run({op: 'metrics'})), formatMetrics(metricsRows(metrics, {top: 15})));
    assert.equal(ok(p.run({op: 'metrics'})).split('\n').length, 15);
    const q = project(t, chain);
    const reverse = ok(q.run({op: 'rdeps', file: 'D.java'}));
    assert.match(reverse, /используют — 1 \(глубина 1\)/);
    assert.match(reverse, /C\.java/);
    assert.doesNotMatch(reverse, /B\.java|A\.java/);
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
