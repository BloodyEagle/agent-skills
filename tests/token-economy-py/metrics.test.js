const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const {performance} = require('node:perf_hooks');
const {computeMetrics, metricsRows, formatMetrics} = require('../../skills/token-economy-ts/scripts/lib/metrics');
const script = path.resolve(__dirname, '../../skills/token-economy-py/scripts/te.py');
const tsScript = path.resolve(__dirname, '../../skills/token-economy-ts/scripts/graph-tool.js');
const candidates = process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python'];
if (process.env.PYTHON) candidates.unshift(process.env.PYTHON);
const python = candidates.find(command => spawnSync(command, ['-I', '-B', '-c',
    'import sys; sys.exit(0 if sys.version_info >= (3,9) else 1)'],
    {cwd: __dirname, timeout: 10000, windowsHide: true}).status === 0);
assert.ok(python, 'Python 3.9+ is required for metrics acceptance');

function run(args, root) {
    const result = spawnSync(python, ['-I', '-B', script, '--root', root, ...args], {
        cwd: __dirname, encoding: 'utf8', timeout: 30000, windowsHide: true,
        env: {...process.env, PYTHONIOENCODING: 'utf-8'}
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    return result;
}
function success(args, root) {
    const result = run(args, root);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout.trim();
}
function fixture(t, files = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'py-metrics-'));
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    for (const [rel, content] of Object.entries(files)) {
        const file = path.join(root, rel);
        fs.mkdirSync(path.dirname(file), {recursive: true});
        fs.writeFileSync(file, content, 'utf8');
    }
    return root;
}
function input(names, pairs, depth = 2) {
    return {files: names.map(id => ({id, path: id})), edges: pairs.map(([from, to]) => ({from, to})), depth};
}
function pythonMetrics(data) {
    const code = 'import importlib.util,json,sys; s=importlib.util.spec_from_file_location("te",sys.argv[1]); ' +
        'm=importlib.util.module_from_spec(s); s.loader.exec_module(m); result=m.compute_metrics(json.loads(sys.argv[2])); ' +
        'print(json.dumps({"result":result,"text":m.format_metrics(m.metrics_rows(result,top=99),result["depth"],False,result["cycles"])}))';
    const result = spawnSync(python, ['-I', '-B', '-c', code, script, JSON.stringify(data)], {
        cwd: __dirname, encoding: 'utf8', timeout: 30000, windowsHide: true,
        env: {...process.env, PYTHONIOENCODING: 'utf-8'}
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return JSON.parse(result.stdout);
}
const diamond = {'a.py': 'import b\nimport c\n', 'b.py': 'import d\n', 'c.py': 'import d\n', 'd.py': 'd = 1\n'};
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('Python formulas match TS: chain, diamond, depth, cycle, self-loop, duplicates and PageRank', () => {
    const cases = [input(['a', 'b', 'c', 'd'], [['a', 'b'], ['b', 'c'], ['c', 'd']]),
        ...[1, 2, 5].map(depth => input(['a', 'b', 'c', 'd'], [['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'd']], depth)),
        input(['a', 'b', 's', 'z'], [['a', 'b'], ['b', 'a'], ['s', 's']]),
        input(['a', 'b'], [['a', 'b'], ['a', 'b'], ['a', 'ext'], ['ext', 'b']]),
        input(['z', 'a'], []), input(Array.from({length: 32}, (_, i) => 'isolated-' + i), []), input([], [])];
    for (const data of cases) {
        const ts = computeMetrics(data);
        const {result: py, text} = pythonMetrics(data);
        assert.equal(py.cycles, ts.cycles);
        assert.equal(py.depth, ts.depth);
        assert.equal(py.perFile.length, ts.perFile.length);
        for (let i = 0; i < ts.perFile.length; i++) {
            const expected = ts.perFile[i], actual = py.perFile[i];
            assert.ok(Math.abs(actual.pagerank - expected.pagerank) <= 1e-9);
            assert.deepEqual({...actual, pagerank: expected.pagerank}, expected);
        }
        assert.equal(text, formatMetrics(metricsRows(ts, {top: 99}), {depth: ts.depth, cycles: ts.cycles}));
    }
    const chain = pythonMetrics(cases[0]).result.perFile.find(row => row.id === 'd');
    assert.equal(chain.dependents, 2);
    assert.equal(chain.impact, 3);
    const target = pythonMetrics(cases[1]).result.perFile.find(row => row.id === 'd');
    assert.equal(target.fan_in, 2);
    assert.equal(target.dependents, 2);
    assert.equal(target.impact, 3);
});

test('Python CLI diamond uses matching text and counts', t => {
    const root = fixture(t, diamond);
    const output = success(['graph', 'metrics', 'd.py'], root);
    assert.match(output, /^d\.py  fan-in 2 .*fan-out 0  dependents\(2\) 3  impact 3/);
    assert.match(success(['graph', 'metrics', 'd.py', '--depth', '1'], root), /dependents\(1\) 2  impact 3/);
    const data = input(['a.py', 'b.py', 'c.py', 'd.py'], [['a.py', 'b.py'], ['a.py', 'c.py'], ['b.py', 'd.py'], ['c.py', 'd.py']]);
    const ts = computeMetrics(data);
    assert.equal(output, formatMetrics(metricsRows(ts, {id: 'd.py'}), {single: true}));
});

test('Python CLI equals TS CLI on the same diamond topology', t => {
    const root = fixture(t, {...diamond, 'a.ts': "import './b'; import './c';\n", 'b.ts': "import './d';\n",
        'c.ts': "import './d';\n", 'd.ts': 'export const d = 1;\n'});
    const ts = spawnSync(process.execPath, [tsScript, 'op=metrics', 'top=4', 'json=1', 'root=' + root], {
        cwd: root, encoding: 'utf8', timeout: 5000, windowsHide: true
    });
    assert.ifError(ts.error);
    assert.equal(ts.status, 0, ts.stdout + ts.stderr);
    const text = success(['graph', 'metrics', '--top', '4'], root).replaceAll('.py', '.ts');
    assert.equal(text, formatMetrics(JSON.parse(ts.stdout).perFile));
});

test('Python top=2 is stable and prints two rows', t => {
    const root = fixture(t, diamond);
    const lines = success(['graph', 'metrics', '--top', '2'], root).split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^1\. d\.py/);
    assert.match(lines[1], /^2\. b\.py/);
});

test('Python adapter deduplicates imports and excludes external modules', t => {
    const root = fixture(t, {'a.py': 'import b\nfrom b import B\nimport external_package\n', 'b.py': 'B = 1\n'});
    assert.match(success(['graph', 'metrics', 'b.py'], root), /fan-in 1 .*dependents\(2\) 1  impact 1/);
    assert.match(success(['graph', 'metrics', 'a.py'], root), /fan-out 1/);
    assert.equal(success(['graph', 'metrics'], root).split('\n').length, 2);
});

test('Python invalid metrics arguments are explicit errors and default rdeps stays one', t => {
    const root = fixture(t, diamond);
    for (const args of [['missing.py'], ['--depth', '0'], ['--depth', '6'], ['--depth', 'x'], ['--top', '0'],
        ['--top', 'x'], ['d.py', '--top', '2'], ['d.py', 'b.py']]) {
        const result = run(['graph', 'metrics', ...args], root);
        assert.ok(result.status !== 0, result.stdout);
        assert.match(result.stdout + result.stderr, /Ошибка:|error:/);
        if (args[0] === 'missing.py') assert.match(result.stdout, /op=stats/);
    }
    assert.match(success(['graph', 'rdeps', 'd.py'], root), /глубина 1/);
});

test('Python empty graph is explicit', t => {
    assert.match(success(['graph', 'metrics'], fixture(t)), /Граф пуст: .*graph\.json/);
});

test('Python warm metrics leaves graph and parse cache byte-identical', t => {
    const root = fixture(t, diamond);
    success(['graph', 'stats'], root);
    const files = ['graph.json', 'cache.json'].map(file => path.join(root, '.token-economy', file));
    const before = files.map(digest);
    success(['graph', 'metrics'], root);
    assert.deepEqual(files.map(digest), before);
});

test('Python warm cycle terminates within two seconds, including lazy/types links', t => {
    const root = fixture(t, {'a.py': 'import b\n', 'b.py': 'def lazy():\n    import a\n'});
    success(['graph', 'stats'], root);
    const started = performance.now();
    const text = success(['graph', 'metrics', 'a.py'], root);
    assert.ok(performance.now() - started < 2000);
    assert.match(text, /impact 1/);
    assert.match(text, /циклов: 1 \(op=cycles\)/);
    assert.match(success(['graph', 'cycles'], root), /runtime-импортам\): 0/);
});
