// hotspots для token-economy-py: порт te.py (аргументы argparse: --top/--file/--since/--max-commits).
// Плюс тест формата: строка top собирается тем же шаблоном, что в ts (план, раздел F2/F3).
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

const {buildHotspotsSuite, gitRepo, write, commitAll, lines, isolatedEnv, envWithoutGit} = require('../hotspots-suite');

const TE_PY = path.resolve(__dirname, '../../skills/token-economy-py/scripts/te.py');
const TS_GRAPH = path.resolve(__dirname, '../../skills/token-economy-ts/scripts/graph-tool.js');
const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'te-py-hotspots-'));
const cleanup = () => fs.rmSync(probeDir, {recursive: true, force: true});

function findPython() {
    const candidates = process.platform === 'win32'
        ? [['python'], ['py', '-3'], ['python3']]
        : [['python3'], ['python'], ['py', '-3']];
    if (process.env.PYTHON) candidates.unshift([process.env.PYTHON]);
    for (const [command, ...prefix] of candidates) {
        const result = spawnSync(command, [...prefix, '-I', '-B', '-c',
            'import sys; print(sys.executable if sys.version_info >= (3, 9) else "")'], {
            cwd: probeDir, encoding: 'utf8', timeout: 10000, windowsHide: true,
        });
        const exe = result.status === 0 ? String(result.stdout || '').trim() : '';
        if (exe) return exe;
    }
    return null;
}

const python = findPython();
const runtimeOptions = {skip: python ? false : 'Python 3.9+ is unavailable (set PYTHON to its executable)'};
process.on('exit', cleanup);

const run = (root, args, opts = {}) => {
    // te.py выводит CRLF в текстовом режиме Windows — сравнения в suite идут по \n
    const norm = (r) => {
        if (r.stdout) r.stdout = r.stdout.replace(/\r\n/g, '\n');
        if (r.stderr) r.stderr = r.stderr.replace(/\r\n/g, '\n');
        return r;
    };
    // info в te.py — самостоятельная команда, а не op узла graph
    const argv = args.op === 'info' ? [TE_PY, 'info'] : [TE_PY, 'graph'];
    for (const [k, v] of Object.entries(args)) {
        if (k === 'op' && args.op === 'info') continue;
        if (k === 'op') argv.push(String(v));
        else if (k === 'top') argv.push('--top', String(v));
        else if (k === 'file') argv.push('--file', String(v));
        else if (k === 'since') argv.push('--since', String(v));
        else if (k === 'max_commits') argv.push('--max-commits', String(v));
    }
    return norm(spawnSync(python, ['-I', '-B', ...argv], {
        cwd: root, encoding: 'utf8', timeout: 60000, windowsHide: true,
        env: opts.noPath ? envWithoutGit(root) : isolatedEnv(root), maxBuffer: 8 * 1024 * 1024,
    }));
};

const test = require('node:test');

if (python) {
    buildHotspotsSuite('token-economy-py', run, {cacheFile: '.token-economy/git-signals.json'});
} else {
    test('token-economy-py hotspots: пропущено', {skip: 'Python 3.9+ недоступен (set PYTHON to its executable)'}, () => {});
}

test('hotspots: формат вывода py совпадает с ts на одной фикстуре', runtimeOptions, () => gitRepo(root => {
    write(root, {'src/a.ts': lines(60), 'src/b.ts': lines(100)});
    commitAll(root, 'feat: a');
    write(root, {'src/b.ts': lines(105)});
    commitAll(root, 'fix: b');
    const py = run(root, {op: 'hotspots'});
    const ts = spawnSync(process.execPath, [TS_GRAPH, 'op=hotspots'], {
        cwd: root, encoding: 'utf8', timeout: 60000, windowsHide: true,
        env: isolatedEnv(root), maxBuffer: 8 * 1024 * 1024,
    });
    assert.equal(ts.status, 0, ts.stderr);
    assert.equal(py.status, 0, py.stderr);
    assert.equal(py.stdout.trim(), ts.stdout.trim(), 'строка top собирается одним шаблоном');
    const pyFile = run(root, {op: 'hotspots', file: 'src/a.ts'});
    const tsFile = spawnSync(process.execPath, [TS_GRAPH, 'op=hotspots', 'file=src/a.ts'], {
        cwd: root, encoding: 'utf8', timeout: 60000, windowsHide: true,
        env: isolatedEnv(root), maxBuffer: 8 * 1024 * 1024,
    });
    assert.equal(tsFile.status, 0, tsFile.stderr);
    assert.equal(pyFile.status, 0, pyFile.stderr);
    assert.equal(pyFile.stdout.trim(), tsFile.stdout.trim(), 'строка file= собирается одним шаблоном');
}));
