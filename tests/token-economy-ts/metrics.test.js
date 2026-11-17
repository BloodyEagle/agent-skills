const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {performance} = require('node:perf_hooks');
const {project, cli, json, scripts} = require('./helpers');
const {computeMetrics, parseMetricsArgs, metricsRows, formatMetrics} = require(path.join(scripts, 'lib', 'metrics'));

function graph(names, pairs, depth = 2) {
    return computeMetrics({files: names.map(id => ({id, path: id})),
        edges: pairs.map(([from, to]) => ({from, to, type: 'import'})), depth});
}
const row = (metrics, id) => metrics.perFile.find(item => item.id === id);
const diamond = {'a.ts': "import './b'; import './c';\n", 'b.ts': "import './d';\n",
    'c.ts': "import './d';\n", 'd.ts': 'export const d = 1;\n'};
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

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

test('argument validation preserves missing default and rejects invalid integers', () => {
    assert.deepEqual(parseMetricsArgs({}), {file: null, top: 15, depth: 2});
    assert.throws(() => parseMetricsArgs({file: 'a', top: 2}), /file.*top/);
    for (const value of ['', '0', '-1', '1.5', 'x', true, [], Infinity]) {
        assert.throws(() => parseMetricsArgs({depth: value}), /depth/);
        assert.throws(() => parseMetricsArgs({top: value}), /top/);
    }
    assert.throws(() => parseMetricsArgs({depth: 6}), /depth/);
    assert.throws(() => parseMetricsArgs({top: Number.MAX_SAFE_INTEGER + 1}), /top/);
    assert.throws(() => graph(['a'], [], 0), /depth/);
    assert.deepEqual(graph([], []), {perFile: [], cycles: 0, depth: 2});
});

test('CLI adapter exposes metrics fields and matches rdeps fan-in', () => project(root => {
    const metrics = json(root, 'graph-tool', {op: 'metrics', file: './d.ts', json: 1});
    const target = metrics.perFile[0];
    assert.equal(target.path, 'd.ts');
    assert.equal(target.fan_in, 2);
    assert.equal(target.fan_out, 0);
    assert.equal(target.dependents, 3);
    assert.equal(target.impact, 3);
    assert.equal(target.depth, 2);
    assert.equal(metrics.depth, 2);
    assert.equal(metrics.completeness.complete, true);
    const reverse = json(root, 'graph-tool', {op: 'rdeps', file: './d.ts', depth: 1});
    assert.equal(target.fan_in, new Set(reverse.importedBy.map(item => item.file)).size);
    const first = json(root, 'graph-tool', {op: 'metrics', file: './d.ts', depth: 1, json: true});
    assert.equal(first.perFile[0].dependents, 2);
    assert.equal(first.perFile[0].impact, 3);
}, diamond, {empty: true}));

test('CLI single text equals formatter and top=2 prints exactly two ranked rows', () => project(root => {
    const single = cli(root, 'graph-tool', {op: 'metrics', file: './d.ts'});
    assert.equal(single.status, 0, single.stdout);
    const payload = json(root, 'graph-tool', {op: 'metrics', file: './d.ts', json: 1});
    assert.equal(single.stdout.trim(), formatMetrics(payload.perFile, {depth: 2, single: true}));
    assert.match(single.stdout, /fan-in 2 .*dependents\(2\) 3  impact 3  pagerank/);
    const top = cli(root, 'graph-tool', {op: 'metrics', top: 2});
    assert.equal(top.status, 0, top.stdout);
    assert.equal(top.stdout.trim().split('\n').length, 2);
    assert.match(top.stdout, /^1\. d\.ts/);
    assert.match(top.stdout, /\n2\. b\.ts/);
}, diamond, {empty: true}));

test('CLI unknown file and invalid arguments are explicit errors', () => project(root => {
    const missing = cli(root, 'graph-tool', {op: 'metrics', file: './missing.ts'});
    assert.equal(missing.status, 1);
    assert.match(missing.stdout, /op=stats/);
    for (const args of [{depth: 0}, {depth: 6}, {depth: 'invalid'}, {depth: 1.5}, {top: 0},
        {top: 'invalid'}, {file: './d.ts', top: 2}]) {
        const result = cli(root, 'graph-tool', {op: 'metrics', ...args, json: 1});
        assert.equal(result.status, 1, JSON.stringify(args));
        assert.equal(JSON.parse(result.stdout).completeness.complete, false);
    }
}, diamond, {empty: true}));

test('empty graph has explicit JSON and text result', () => project(root => {
    const metrics = json(root, 'graph-tool', {op: 'metrics', json: 1});
    assert.equal(metrics.empty, true);
    assert.deepEqual(metrics.perFile, []);
    assert.equal(metrics.total, 0);
    const text = cli(root, 'graph-tool', {op: 'metrics'});
    assert.equal(text.status, 0);
    assert.match(text.stdout, /Граф пуст: .*graph-deps\.json/);
}, {}, {empty: true}));

test('warm metrics does not write graph or parse cache', () => project(root => {
    json(root, 'graph-tool', {op: 'stats'});
    const files = ['graph-deps.json', '.graph-deps-cache.json'].map(file => path.join(root, file));
    const before = files.map(digest);
    json(root, 'graph-tool', {op: 'metrics', json: 1});
    assert.deepEqual(files.map(digest), before);
}, diamond, {empty: true}));

test('warm cycle metrics finishes within two seconds and reports one cycle', () => project(root => {
    json(root, 'graph-tool', {op: 'stats'});
    const started = performance.now();
    const result = cli(root, 'graph-tool', {op: 'metrics', file: './a.ts'});
    assert.equal(result.status, 0, result.stdout);
    assert.ok(performance.now() - started < 2000);
    assert.match(result.stdout, /циклов: 1 \(op=cycles\)/);
    assert.match(result.stdout, /impact 1/);
}, {'a.ts': "import './b';\n", 'b.ts': "import './a';\n"}, {empty: true}));

test('batch preserves metrics options, errors and compact paths', () => project(root => {
    const requests = [{op: 'metrics', file: './d.ts'}, {op: 'metrics', top: 2, depth: 1},
        {op: 'metrics', file: './missing.ts'}];
    const result = json(root, 'graph-tool', {requests: JSON.stringify(requests)});
    assert.equal(result.failed, 1);
    assert.equal(result.results[0].perFile[0].impact, 3);
    assert.equal(result.results[0].depth, 2);
    assert.equal(result.results[1].depth, 1);
    assert.equal(result.results[1].perFile.length, 2);
    assert.equal(result.results[2].completeness.complete, false);
    const compact = json(root, 'graph-tool', {requests: JSON.stringify(requests), compact: 1});
    assert.equal(compact.paths[compact.results[0].perFile[0].path], 'd.ts');
    assert.equal(compact.paths[compact.results[0].file], 'd.ts');
    assert.deepEqual(compact.scope, result.results[0].scope);
    assert.equal(compact.results[0].perFile[0].impact, 3);
}, diamond, {empty: true}));

test('text warns about incomplete graph and JSON retains scope qualification', () => project(root => {
    const result = json(root, 'graph-tool', {op: 'metrics', json: 1});
    assert.equal(result.completeness.complete, false);
    assert.ok(result.completeness.reasons.length);
    assert.ok(result.scope.root);
    const text = cli(root, 'graph-tool', {op: 'metrics'});
    assert.match(text.stdout, /Предупреждение: граф неполный/);
}, {'a.ts': "import './missing';\n"}, {empty: true}));
