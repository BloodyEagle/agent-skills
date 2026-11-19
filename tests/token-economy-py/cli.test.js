'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {test, after} = require('node:test');

const SCRIPT = path.resolve(__dirname, '../../skills/token-economy-py/scripts/te.py');
const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'te-py-runtime-'));
after(() => fs.rmSync(probeDir, {recursive: true, force: true}));

function findPython() {
    const candidates = process.platform === 'win32'
        ? [['python'], ['py', '-3'], ['python3']]
        : [['python3'], ['python'], ['py', '-3']];
    if (process.env.PYTHON) candidates.unshift([process.env.PYTHON]);
    for (const [command, ...prefix] of candidates) {
        const result = spawnSync(command, [...prefix, '-I', '-B', '-c',
            'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)'], {
            cwd: probeDir, encoding: 'utf8', timeout: 10000, windowsHide: true,
        });
        if (!result.error && result.status === 0) return {command, prefix};
    }
    return null;
}

const python = findPython();
const runtimeOptions = {skip: python ? false : 'Python 3.9+ is unavailable (set PYTHON to its executable)'};
const gitAvailable = spawnSync('git', ['--version'], {
    cwd: probeDir, encoding: 'utf8', timeout: 10000, windowsHide: true,
}).status === 0;

function write(file, text) {
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, text, 'utf8');
}

function fixture(t, git = false) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'te-py-cli-'));
    t.after(() => fs.rmSync(base, {recursive: true, force: true}));
    const root = path.join(base, 'project');
    const outside = path.join(base, 'project-outside');
    const cwd = path.join(base, 'runner');
    for (const dir of [root, outside, cwd]) fs.mkdirSync(dir);
    write(path.join(root, 'inside.py'), 'class InsideOnly:\n    pass\n');
    write(path.join(outside, 'inside.py'), "class OutsideOnly:\n    pass\nEXTERNAL_SECRET = 'synthetic-external-marker'\n");
    if (git) {
        const result = spawnSync('git', ['init', '--quiet', root], {
            cwd, encoding: 'utf8', timeout: 10000, windowsHide: true,
        });
        assert.equal(result.status, 0, result.stderr);
    }
    return {root, outside, cwd, base};
}

function cli(f, args, root = f.root) {
    const result = spawnSync(python.command, [...python.prefix, '-I', '-B', SCRIPT, '--root', root, ...args], {
        cwd: f.cwd, encoding: 'utf8', timeout: 30000, windowsHide: true,
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    return {...result, output: result.stdout + result.stderr};
}

function success(result) {
    assert.equal(result.status, 0, result.output);
    return result.stdout;
}

function rejected(result) {
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /Ошибка:/u);
    assert.doesNotMatch(result.output, /Traceback/);
}

function symlink(t, target, link, directory = false) {
    try {
        fs.symlinkSync(target, link, directory ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file');
        return true;
    } catch (error) {
        if (!['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP'].includes(error.code)) throw error;
        t.skip(`Symlinks unavailable: ${error.code}`);
        return false;
    }
}

function cacheFixture(t, git = false) {
    const f = fixture(t, git);
    const source = path.join(f.root, 'app.py');
    const external = path.join(f.outside, 'target.json');
    write(source, '# Исходник нельзя изменять\r\nclass CacheSource:\r\n    pass\r\n');
    write(external, '{"external":"synthetic-cache-target"}\r\n');
    return {...f, source, external, cache: path.join(f.root, '.token-economy'), protectedBytes: new Map(
        [source, external, path.join(f.root, 'inside.py')].map(file => [file, fs.readFileSync(file)])),
    };
}

function unchangedSources(f) {
    for (const [file, bytes] of f.protectedBytes) assert.deepEqual(fs.readFileSync(file), bytes, file);
}

function cacheProbe(f, lines, ...args) {
    const code = ['import runpy, sys', 'te = runpy.run_path(sys.argv[1])', 'root = sys.argv[2]', ...lines].join('\n');
    const result = spawnSync(python.command, [...python.prefix, '-I', '-B', '-c', code, SCRIPT, f.root, ...args], {
        cwd: f.cwd, encoding: 'utf8', timeout: 10000, windowsHide: true,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result;
}

const cacheOperations = [
    {args: ['graph', 'build'], endpoints: ['graph.json', 'cache.json', '.gitignore'], git: false},
    {args: ['graph', 'hotspots'], endpoints: ['git-signals.json', '.gitignore'], git: true},
];

function cacheOptions(git) {
    return {...runtimeOptions, skip: runtimeOptions.skip || (git && !gitAvailable ? 'Git is unavailable' : false)};
}

for (const args of [['graph', 'stats'], ['graph', 'build'], ['outline', 'inside.py'], ['search', 'InsideOnly'], ['info'], ['sig', 'sys.exit']]) {
    for (const kind of ['missing', 'file']) {
        test(`${args.join(' ')} rejects ${kind} --root without creating a directory`, runtimeOptions, t => {
            const f = fixture(t);
            const root = path.join(f.base, kind);
            if (kind === 'file') write(root, 'not a directory\n');
            const result = cli(f, args, root);
            if (kind === 'missing') assert.equal(fs.existsSync(root), false, 'CLI created a phantom project root');
            else assert.equal(fs.readFileSync(root, 'utf8'), 'not a directory\n');
            rejected(result);
            assert.match(result.output, /корень/iu);
        });
    }
}

for (const git of [false, true]) {
    for (const directory of [false, true]) {
        test(`graph/search skip external ${directory ? 'directory' : 'file'} links (${git ? 'git' : 'walk'})`, {
            ...runtimeOptions, skip: runtimeOptions.skip || (git && !gitAvailable ? 'Git is unavailable' : false),
        }, t => {
            const f = fixture(t, git);
            const link = path.join(f.root, directory ? 'external-dir' : 'external-file.py');
            if (!symlink(t, directory ? f.outside : path.join(f.outside, 'inside.py'), link, directory)) return;
            const result = success(cli(f, ['graph', 'symbol', 'OutsideOnly']));
            assert.doesNotMatch(result, /external-(?:dir|file)/, 'External source was indexed');
            const search = success(cli(f, ['search', 'EXTERNAL_SECRET']));
            assert.match(search, /совпадений нет/u);
            assert.doesNotMatch(search, /synthetic-external-marker/);
            assert.match(success(cli(f, ['graph', 'symbol', 'InsideOnly'])), /inside\.py/);
        });
    }
}

for (const operation of [['outline'], ['graph', 'node'], ['graph', 'deps'], ['graph', 'rdeps'], ['graph', 'path']]) {
    for (const filter of ['absolute', 'parent', 'symlink', 'symlink-parent']) {
        test(`${operation.join(' ')} rejects an outside path (${filter})`, runtimeOptions, t => {
            const f = fixture(t);
            let target = filter === 'absolute' ? path.join(f.outside, 'inside.py') : '../project-outside/inside.py';
            if (filter.startsWith('symlink')) {
                if (!symlink(t, f.outside, path.join(f.root, 'external-dir'), true)) return;
                target = filter === 'symlink' ? 'external-dir/inside.py' : 'external-dir/../inside.py';
            }
            const args = [...operation, target];
            if (operation[1] === 'path') args.push('inside.py');
            const result = cli(f, args);
            rejected(result);
            assert.match(result.output, /вне рабочей директории/u);
            assert.equal(fs.existsSync(path.join(f.root, '.token-economy')), false, 'Invalid path created a cache');
        });
    }
}

for (const filter of ['absolute', 'parent', 'symlink', 'symlink-parent']) {
    test(`search rejects an outside --path (${filter})`, runtimeOptions, t => {
        const f = fixture(t);
        let target = filter === 'absolute' ? f.outside : '../project-outside';
        if (filter.startsWith('symlink')) {
            if (!symlink(t, f.outside, path.join(f.root, 'external-dir'), true)) return;
            target = filter === 'symlink' ? 'external-dir' : 'external-dir/../inside.py';
        }
        rejected(cli(f, ['search', 'EXTERNAL_SECRET', '--path', target]));
    });
}

for (const operation of [['outline'], ['graph', 'node'], ['graph', 'deps'], ['graph', 'rdeps'], ['graph', 'path']]) {
    test(`${operation.join(' ')} resolves an internal directory link`, runtimeOptions, t => {
        const f = fixture(t);
        const source = path.join(f.root, 'source');
        write(path.join(source, 'nested', 'child.py'), 'class Child:\n    pass\n');
        write(path.join(source, 'inside.py'), 'class LinkedOnly:\n    pass\n');
        if (!symlink(t, source, path.join(f.root, 'alias'), true)) return;
        const args = [...operation, 'alias/nested/../inside.py'];
        if (operation[1] === 'path') args.push('source/inside.py');
        const output = success(cli(f, args));
        assert.match(output, /source\/inside\.py/);
        if (operation[0] === 'outline' || operation[1] === 'node') assert.match(output, /LinkedOnly/);
    });
}

for (const git of [false, true]) {
    test(`internal directory aliases preserve import edges without duplicate nodes (${git ? 'git' : 'walk'})`, {
        ...runtimeOptions, skip: runtimeOptions.skip || (git && !gitAvailable ? 'Git is unavailable' : false),
    }, t => {
        const f = fixture(t, git);
        const source = path.join(f.root, 'source');
        write(path.join(source, 'pkg', '__init__.py'), '');
        write(path.join(source, 'pkg', 'mod.py'), 'class AliasedModule:\n    pass\n');
        write(path.join(f.root, 'main.py'), 'from alias.pkg import mod\n');
        if (!symlink(t, source, path.join(f.root, 'alias'), true)) return;
        const deps = success(cli(f, ['graph', 'deps', 'main.py', '--why']));
        assert.match(deps, /source\/pkg\/mod\.py.*L1/);
        assert.doesNotMatch(deps, /внешние пакеты: alias/u);
        const rdeps = success(cli(f, ['graph', 'rdeps', 'alias/pkg/mod.py', '--why']));
        assert.match(rdeps, /main\.py.*L1/);
        assert.match(success(cli(f, ['graph', 'path', 'main.py', 'alias/pkg/mod.py'])), /main\.py → source\/pkg\/mod\.py/);
        const symbol = success(cli(f, ['graph', 'symbol', 'AliasedModule']));
        assert.equal(symbol.trim().split(/\r?\n/).length, 1, 'Alias created a duplicate node');
        assert.match(success(cli(f, ['graph', 'node', 'alias.pkg.mod'])), /source\/pkg\/mod\.py/);
        assert.match(success(cli(f, ['graph', 'stats'])), /файлов: 4/u);
    });
}

test('warm graph refreshes import edges when an internal alias is added or removed', runtimeOptions, t => {
    const f = fixture(t);
    const source = path.join(f.root, 'source');
    write(path.join(source, 'pkg', '__init__.py'), '');
    write(path.join(source, 'pkg', 'mod.py'), 'class AliasedModule:\n    pass\n');
    write(path.join(f.root, 'main.py'), 'from alias.pkg import mod\n');
    assert.match(success(cli(f, ['graph', 'deps', 'main.py'])), /внешние пакеты: alias/u);
    const alias = path.join(f.root, 'alias');
    if (!symlink(t, source, alias, true)) return;
    assert.match(success(cli(f, ['graph', 'deps', 'main.py'])), /source\/pkg\/mod\.py/);
    fs.unlinkSync(alias);
    const after = success(cli(f, ['graph', 'deps', 'main.py']));
    assert.match(after, /внешние пакеты: alias/u);
    assert.doesNotMatch(after, /source\/pkg\/mod\.py/);
});

test('git directory-link entries preserve alias imports without traversing outside scope', runtimeOptions, t => {
    const f = fixture(t);
    const source = path.join(f.root, 'source');
    write(path.join(source, 'pkg', '__init__.py'), '');
    write(path.join(source, 'pkg', 'mod.py'), 'class AliasedModule:\n    pass\n');
    write(path.join(f.root, 'main.py'), 'from alias.pkg import mod\n');
    if (!symlink(t, source, path.join(f.root, 'alias'), true)) return;
    const code = [
        'import runpy, subprocess, sys',
        'original = subprocess.run',
        'def git_files(args, *rest, **kwargs):',
        '    if args[0] == "git":',
        '        files = ["inside.py", "main.py", "source/pkg/__init__.py", "source/pkg/mod.py", "alias"]',
        '        return subprocess.CompletedProcess(args, 0, (chr(0).join(files) + chr(0)).encode(), b"")',
        '    return original(args, *rest, **kwargs)',
        'subprocess.run = git_files',
        'script, root = sys.argv[1:]',
        'sys.argv = [script, "--root", root, "graph", "deps", "main.py"]',
        'runpy.run_path(script, run_name="__main__")',
    ].join('\n');
    const result = spawnSync(python.command, [...python.prefix, '-I', '-B', '-c', code, SCRIPT, f.root], {
        cwd: f.cwd, encoding: 'utf8', timeout: 10000, windowsHide: true,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /source\/pkg\/mod\.py/);
    assert.doesNotMatch(result.stdout, /внешние пакеты: alias/u);
});

test('search resolves internal links and normalizes parent segments', runtimeOptions, t => {
    const f = fixture(t);
    const source = path.join(f.root, 'source');
    write(path.join(source, 'nested', 'child.py'), 'class Child:\n    pass\n');
    write(path.join(source, 'inside.py'), 'class LinkedOnly:\n    pass\n');
    if (!symlink(t, source, path.join(f.root, 'alias'), true)) return;
    const output = success(cli(f, ['search', 'LinkedOnly', '--path', 'alias/nested/..']));
    assert.match(output, /source\/inside\.py/);
    assert.match(output, /LinkedOnly/);
});

for (const directory of [false, true]) {
    test(`internal ${directory ? 'directory' : 'file'} link shares the project containment rule`, runtimeOptions, t => {
        const f = fixture(t);
        const source = path.join(f.root, 'source');
        write(path.join(source, 'linked.py'), 'class LinkedOnly:\n    pass\n');
        const link = path.join(f.root, directory ? 'alias' : 'alias.py');
        if (!symlink(t, directory ? source : path.join(source, 'linked.py'), link, directory)) return;
        const target = directory ? 'alias/linked.py' : 'alias.py';
        assert.match(success(cli(f, ['outline', target])), /LinkedOnly/);
        assert.match(success(cli(f, ['graph', 'node', target])), /LinkedOnly/);
        assert.match(success(cli(f, ['search', 'LinkedOnly', '--path', target])), /LinkedOnly/);
    });
}

for (const args of [['graph', 'stats'], ['graph', 'build'], ['info']]) {
    test(`${args.join(' ')} does not write through an external cache directory`, runtimeOptions, t => {
        const f = fixture(t);
        if (!symlink(t, f.outside, path.join(f.root, '.token-economy'), true)) return;
        const before = fs.readdirSync(f.outside).sort();
        rejected(cli(f, args));
        assert.deepEqual(fs.readdirSync(f.outside).sort(), before, 'Cache files were written outside root');
    });
}

for (const {args, endpoints, git} of cacheOperations) {
    for (const endpoint of endpoints) {
        for (const targetKind of ['internal', 'external', 'dangling']) {
            test(`${args.join(' ')} rejects ${endpoint} ${targetKind} link without changing bytes`, cacheOptions(git), t => {
                const f = cacheFixture(t, git);
                success(cli(f, args));
                const file = path.join(f.cache, endpoint);
                const before = new Map(fs.readdirSync(f.cache).filter(name => name !== endpoint)
                    .map(name => [name, fs.readFileSync(path.join(f.cache, name))]));
                fs.unlinkSync(file);
                const target = targetKind === 'internal' ? f.source : targetKind === 'external' ? f.external
                    : path.join(f.outside, 'missing-target.json');
                if (!symlink(t, target, file)) return;
                rejected(cli(f, args));
                assert.ok(fs.lstatSync(file).isSymbolicLink(), 'Cache link was replaced');
                assert.equal(fs.readlinkSync(file), target);
                if (targetKind === 'external') {
                    cacheProbe(f, [
                        'from pathlib import Path',
                        'def forbidden_open(*args, **kwargs):',
                        '    raise AssertionError("cache alias was opened")',
                        'Path.open = forbidden_open',
                        'try:',
                        '    te["load_json"](root, sys.argv[3])',
                        'except ValueError:',
                        '    pass',
                        'else:',
                        '    raise AssertionError("cache alias was accepted")',
                    ], '.token-economy/' + endpoint);
                }
                assert.deepEqual(fs.readdirSync(f.cache).sort(), [...before.keys(), endpoint].sort(), 'Unexpected cache tmp leaked');
                for (const [name, bytes] of before) assert.deepEqual(fs.readFileSync(path.join(f.cache, name)), bytes);
                assert.equal(fs.existsSync(path.join(f.outside, 'missing-target.json')), false);
                unchangedSources(f);
            });
        }
        for (const targetKind of ['internal', 'external', 'dangling']) {
            test(`${args.join(' ')} ignores a fixed ${endpoint}.tmp ${targetKind} link`, cacheOptions(git), t => {
                const f = cacheFixture(t, git);
                fs.mkdirSync(f.cache);
                const tmp = path.join(f.cache, endpoint + '.tmp');
                const target = targetKind === 'internal' ? f.source : targetKind === 'external' ? f.external
                    : path.join(f.outside, 'missing-tmp-target.json');
                if (!symlink(t, target, tmp)) return;
                success(cli(f, args));
                assert.ok(fs.lstatSync(tmp).isSymbolicLink(), 'Unowned tmp was removed or replaced');
                assert.equal(fs.readlinkSync(tmp), target);
                assert.equal(fs.existsSync(path.join(f.outside, 'missing-tmp-target.json')), false);
                assert.deepEqual(fs.readdirSync(f.cache).sort(), [...new Set([...endpoints, endpoint + '.tmp'])].sort());
                unchangedSources(f);
            });
        }
        test(`${args.join(' ')} rejects a ${endpoint} directory`, cacheOptions(git), t => {
            const f = cacheFixture(t, git);
            fs.mkdirSync(path.join(f.cache, endpoint), {recursive: true});
            rejected(cli(f, args));
            assert.deepEqual(fs.readdirSync(f.cache), [endpoint]);
            unchangedSources(f);
        });
    }
    for (const kind of ['internal', 'external', 'dangling', 'file']) {
        test(`${args.join(' ')} rejects a ${kind} cache directory endpoint`, cacheOptions(git), t => {
            const f = cacheFixture(t, git);
            const target = kind === 'internal' ? path.join(f.root, 'redirected-cache')
                : kind === 'dangling' ? path.join(f.outside, 'missing-cache') : f.outside;
            if (kind === 'file') write(f.cache, 'not a directory\r\n');
            else {
                if (kind === 'internal') fs.mkdirSync(target);
                if (!symlink(t, target, f.cache, true)) return;
            }
            const before = kind === 'file' ? fs.readFileSync(f.cache)
                : kind === 'dangling' ? null : fs.readdirSync(target).sort();
            rejected(cli(f, args));
            if (kind === 'file') assert.deepEqual(fs.readFileSync(f.cache), before);
            else if (kind === 'dangling') assert.equal(fs.existsSync(target), false);
            else assert.deepEqual(fs.readdirSync(target).sort(), before);
            unchangedSources(f);
        });
    }
    test(`${args.join(' ')} publishes normal cache and leaves warm cache byte-identical`, cacheOptions(git), t => {
        const f = cacheFixture(t, git);
        success(cli(f, args));
        const files = fs.readdirSync(f.cache).sort();
        assert.deepEqual(files, endpoints.slice().sort());
        const before = new Map(files.map(name => [name, fs.readFileSync(path.join(f.cache, name))]));
        success(cli(f, git ? args : ['graph', 'stats']));
        for (const [name, bytes] of before) assert.deepEqual(fs.readFileSync(path.join(f.cache, name)), bytes);
        assert.equal(fs.readFileSync(path.join(f.cache, '.gitignore'), 'utf8'), '*\n');
        unchangedSources(f);
    });
}

for (const endpoint of ['graph.json', '.gitignore']) {
    test(`cache rejects a hard-linked ${endpoint} source alias`, runtimeOptions, t => {
        const f = cacheFixture(t);
        fs.mkdirSync(f.cache);
        try {
            fs.linkSync(f.source, path.join(f.cache, endpoint));
        } catch (error) {
            if (!['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP', 'EXDEV'].includes(error.code)) throw error;
            t.skip(`Hard links unavailable: ${error.code}`);
            return;
        }
        rejected(cli(f, ['graph', 'build']));
        unchangedSources(f);
    });
}

for (const rel of ['app.py', '.token-economy/../app.py', '.token-economy/nested/graph.json']) {
    test(`cache publisher rejects a non-direct cache path: ${rel}`, runtimeOptions, t => {
        const f = cacheFixture(t);
        cacheProbe(f, [
            'try:',
            '    te["save_json"](root, sys.argv[3], {"changed": True})',
            'except ValueError:',
            '    pass',
            'else:',
            '    raise AssertionError("invalid cache path was accepted")',
        ], rel);
        assert.equal(fs.existsSync(f.cache), false);
        unchangedSources(f);
    });
}

for (const stage of ['create', 'fdopen', 'write', 'replace', 'serialize']) {
    test(`cache publisher preserves previous bytes and cleans only owned tmp on ${stage} failure`, runtimeOptions, t => {
        const f = cacheFixture(t);
        fs.mkdirSync(f.cache);
        write(path.join(f.cache, '.gitignore'), '*\n');
        write(path.join(f.cache, 'graph.json'), '{"old":"cache"}\r\n');
        write(path.join(f.cache, 'graph.json.tmp'), 'unowned fixed tmp\r\n');
        const before = new Map(fs.readdirSync(f.cache).map(name => [name, fs.readFileSync(path.join(f.cache, name))]));
        cacheProbe(f, [
            'import os, tempfile',
            'stage = sys.argv[3]',
            'failure = OSError("synthetic publisher I/O failure")',
            'created = []',
            'original_mkstemp = tempfile.mkstemp',
            'def tracked_mkstemp(*args, **kwargs):',
            '    if stage == "create": raise failure',
            '    fd, name = original_mkstemp(*args, **kwargs)',
            '    assert os.path.dirname(name) == os.path.realpath(os.path.join(root, ".token-economy"))',
            '    assert os.fstat(fd).st_size == 0',
            '    assert os.fstat(fd).st_nlink == 1',
            '    assert os.stat(name).st_ino == os.fstat(fd).st_ino',
            '    assert name != os.path.join(root, ".token-economy", "graph.json.tmp")',
            '    created.append((fd, name))',
            '    return fd, name',
            'tempfile.mkstemp = tracked_mkstemp',
            'original_fdopen = os.fdopen',
            'class BrokenWriter:',
            '    def __init__(self, stream): self.stream = stream',
            '    def __enter__(self): return self',
            '    def __exit__(self, *args): self.stream.close()',
            '    def write(self, text):',
            '        self.stream.write(text[:3])',
            '        raise failure',
            'def failing_fdopen(*args, **kwargs):',
            '    if stage == "fdopen": raise failure',
            '    stream = original_fdopen(*args, **kwargs)',
            '    return BrokenWriter(stream) if stage == "write" else stream',
            'os.fdopen = failing_fdopen',
            'def failing_replace(*args, **kwargs): raise failure',
            'if stage == "replace": os.replace = failing_replace',
            'try:',
            '    te["save_json"](root, ".token-economy/graph.json", {"bad": object()} if stage == "serialize" else {"new": "cache"})',
            'except (OSError, TypeError) as error:',
            '    assert isinstance(error, TypeError) if stage == "serialize" else error is failure',
            'else:',
            '    raise AssertionError("I/O failure was swallowed")',
            'for fd, name in created:',
            '    assert not os.path.lexists(name), "owned tmp leaked"',
            '    try: os.fstat(fd)',
            '    except OSError: pass',
            '    else: raise AssertionError("owned descriptor leaked")',
        ], stage);
        assert.deepEqual(fs.readdirSync(f.cache).sort(), [...before.keys()].sort());
        for (const [name, bytes] of before) assert.deepEqual(fs.readFileSync(path.join(f.cache, name)), bytes);
        unchangedSources(f);
    });
}

test('cache publisher uses distinct exclusive tmp files in the canonical root cache', runtimeOptions, t => {
    const f = cacheFixture(t);
    const alias = path.join(f.base, 'root-cache-alias');
    if (!symlink(t, f.root, alias, true)) return;
    cacheProbe(f, [
        'import os, tempfile',
        'seen = set()',
        'original = tempfile.mkstemp',
        'original_open = os.open',
        'def exclusive_open(name, flags, *args, **kwargs):',
        '    assert flags & os.O_CREAT and flags & os.O_EXCL',
        '    return original_open(name, flags, *args, **kwargs)',
        'os.open = exclusive_open',
        'def tracked(*args, **kwargs):',
        '    fd, name = original(*args, **kwargs)',
        '    assert os.path.dirname(name) == os.path.realpath(os.path.join(root, ".token-economy"))',
        '    assert name not in seen',
        '    try: duplicate = original_open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL)',
        '    except FileExistsError: pass',
        '    else:',
        '        os.close(duplicate)',
        '        raise AssertionError("tmp was not exclusively created")',
        '    assert os.fstat(fd).st_size == 0 and os.fstat(fd).st_nlink == 1',
        '    assert os.fstat(fd).st_ino == os.stat(name).st_ino',
        '    seen.add(name)',
        '    return fd, name',
        'tempfile.mkstemp = tracked',
        'for value in range(2):',
        '    te["save_json"](sys.argv[3], ".token-economy/graph.json", {"value": value})',
        'assert len(seen) == 3',
        'assert te["load_json"](root, ".token-economy/graph.json") == {"value": 1}',
        'assert sorted(os.listdir(os.path.join(root, ".token-economy"))) == [".gitignore", "graph.json"]',
    ], alias);
    unchangedSources(f);
});

test('Python hotspots uses the same publisher and retains old cache on replace failure', runtimeOptions, t => {
    const f = cacheFixture(t);
    fs.mkdirSync(f.cache);
    write(path.join(f.cache, '.gitignore'), '*\n');
    write(path.join(f.cache, 'git-signals.json'), '{"old":"signals"}\r\n');
    const before = fs.readFileSync(path.join(f.cache, 'git-signals.json'));
    const result = cacheProbe(f, [
        'import os',
        'globals_ = te["_load_signals"].__globals__',
        'globals_["_git_dir"] = lambda root: {"dir": root}',
        'globals_["_read_head_sha"] = lambda root: "synthetic-head"',
        'globals_["collect_git_signals"] = lambda *args: {"fresh": "signals"}',
        'calls = []',
        'def broken_replace(tmp, endpoint):',
        '    assert os.path.dirname(tmp) == os.path.realpath(os.path.join(root, ".token-economy"))',
        '    assert os.path.basename(endpoint) == "git-signals.json"',
        '    calls.append(tmp)',
        '    raise OSError("synthetic hotspots publication failure")',
        'os.replace = broken_replace',
        'data, hit = te["_load_signals"](root, "2026-01-01", 10, [])',
        'assert data == {"fresh": "signals"} and hit is False',
        'assert len(calls) == 1 and not os.path.lexists(calls[0])',
    ]);
    assert.match(result.stderr, /кэш не записан.*synthetic hotspots publication failure/u);
    assert.deepEqual(fs.readFileSync(path.join(f.cache, 'git-signals.json')), before);
    assert.deepEqual(fs.readdirSync(f.cache).sort(), ['.gitignore', 'git-signals.json']);
    unchangedSources(f);
});

for (const directory of [false, true]) {
    test(`hardened cache keeps internal ${directory ? 'directory' : 'file'} source aliases`, runtimeOptions, t => {
        const f = cacheFixture(t);
        const directoryTarget = path.join(f.root, 'source-dir');
        if (directory) {
            const file = path.join(directoryTarget, 'app.py');
            write(file, f.protectedBytes.get(f.source));
            f.protectedBytes.set(file, fs.readFileSync(file));
        }
        const link = path.join(f.root, directory ? 'alias' : 'alias.py');
        if (!symlink(t, directory ? directoryTarget : f.source, link, directory)) return;
        const sourcePath = directory ? 'alias/app.py' : 'alias.py';
        const node = success(cli(f, ['graph', 'node', sourcePath]));
        assert.match(node, /app\.py/);
        assert.match(node, /CacheSource/);
        assert.match(success(cli(f, ['outline', sourcePath])), /CacheSource/);
        assert.match(success(cli(f, ['search', 'CacheSource', '--path', sourcePath])), /app\.py/);
        unchangedSources(f);
    });
}

test('a cached graph drops a directory replaced by an outside link', runtimeOptions, t => {
    const f = fixture(t);
    const dir = path.join(f.root, 'live');
    write(path.join(dir, 'cached.py'), 'class CachedOnly:\n    pass\n');
    assert.match(success(cli(f, ['graph', 'symbol', 'CachedOnly'])), /live\/cached\.py/);
    const data = fs.readFileSync(path.join(dir, 'cached.py'));
    const original = fs.statSync(path.join(dir, 'cached.py'));
    write(path.join(f.outside, 'cached.py'), data);
    fs.utimesSync(path.join(f.outside, 'cached.py'), original.atime, original.mtime);
    fs.rmSync(dir, {recursive: true});
    if (!symlink(t, f.outside, dir, true)) return;
    assert.match(success(cli(f, ['graph', 'symbol', 'CachedOnly'])), /не найдено/u);
    assert.match(success(cli(f, ['search', 'CachedOnly'])), /совпадений нет/u);
});

test('a symlink root is canonicalized without losing valid project files', runtimeOptions, t => {
    const f = fixture(t);
    const alias = path.join(f.base, 'root-alias');
    if (!symlink(t, f.root, alias, true)) return;
    assert.match(success(cli(f, ['graph', 'symbol', 'InsideOnly'], alias)), /inside\.py/);
    assert.match(success(cli(f, ['outline', 'inside.py'], alias)), /InsideOnly/);
    assert.match(success(cli(f, ['search', 'InsideOnly'], alias)), /inside\.py/);
});

test('Python snippet docs separate 120 content characters, markers and line prefix', () => {
    for (const name of ['SKILL.md', 'README.ru.md']) {
        const doc = fs.readFileSync(path.resolve(__dirname, '../../skills/token-economy-py', name), 'utf8');
        assert.match(doc, /120 символов содержимого плюс маркеры `…`/u, name);
        assert.match(doc, /префикс номера строки в этот лимит не входит/u, name);
    }
    const docEn = fs.readFileSync(path.resolve(__dirname, '../../skills/token-economy-py/README.md'), 'utf8');
    assert.match(docEn, /120/u);
    assert.match(docEn, /…/u);
    assert.match(docEn, /prefix/u);
});

for (const matchAt of [10, 100]) {
    test(`search retains 120 content characters plus markers (match at ${matchAt})`, runtimeOptions, t => {
        const f = fixture(t);
        const source = '# ' + 'a'.repeat(matchAt) + 'SnippetNeedle' + 'b'.repeat(200);
        write(path.join(f.root, 'snippet.py'), source + '\n');
        const output = success(cli(f, ['search', 'SnippetNeedle']));
        const hit = output.split(/\r?\n/).find(line => /^  1: /u.test(line));
        assert.ok(hit, output);
        const pos = Math.max(source.indexOf('SnippetNeedle') - 40, 0);
        const markers = pos ? 2 : 1;
        const snippet = hit.slice('  1: '.length);
        assert.equal(snippet, (pos ? '…' : '') + source.slice(pos, pos + 120) + '…');
        assert.equal(snippet.length, 120 + markers);
    });
}

test('search returns raw matching text; filenames-only mode does not expose values', runtimeOptions, t => {
    const f = fixture(t);
    write(path.join(f.root, 'config.yaml'), 'password: synthetic-test-value\n');
    assert.match(success(cli(f, ['search', 'password', '--ext', '.yaml'])), /synthetic-test-value/);
    const files = success(cli(f, ['search', 'password', '--ext', '.yaml', '-l']));
    assert.match(files, /config\.yaml/);
    assert.doesNotMatch(files, /synthetic-test-value/);
});
