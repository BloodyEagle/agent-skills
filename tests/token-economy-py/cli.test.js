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

test('search returns raw matching text; filenames-only mode does not expose values', runtimeOptions, t => {
    const f = fixture(t);
    write(path.join(f.root, 'config.yaml'), 'password: synthetic-test-value\n');
    assert.match(success(cli(f, ['search', 'password', '--ext', '.yaml'])), /synthetic-test-value/);
    const files = success(cli(f, ['search', 'password', '--ext', '.yaml', '-l']));
    assert.match(files, /config\.yaml/);
    assert.doesNotMatch(files, /synthetic-test-value/);
});
