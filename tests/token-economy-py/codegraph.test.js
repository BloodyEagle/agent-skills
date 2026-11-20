'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

const {buildCodegraphSuite} = require('../codegraph-suite');

const SCRIPT = path.resolve(__dirname, '..', '..', 'skills', 'token-economy-py', 'scripts', 'te.py');

// Тот же порядок кандидатов, что в cli.test.js: PYTHON, python/py -3/python3.
// Возвращает абсолютный путь интерпретатора: тесты подменяют PATH, поэтому запуск
// по имени («python») внутри теста не найдёт исполняемый файл.
function findPython() {
    const candidates = process.platform === 'win32'
        ? [['python'], ['py', '-3'], ['python3']]
        : [['python3'], ['python'], ['py', '-3']];
    if (process.env.PYTHON) candidates.unshift([process.env.PYTHON]);
    const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'te-cg-py-probe-'));
    try {
        for (const [command, ...prefix] of candidates) {
            const result = spawnSync(command, [...prefix, '-I', '-B', '-c', 'import sys; print(sys.executable)'], {
                cwd: probe, encoding: 'utf8', timeout: 10000, windowsHide: true,
            });
            const exe = result.status === 0 ? String(result.stdout).trim() : null;
            if (!exe) continue;
            const ver = spawnSync(exe, ['-I', '-B', '-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)'], {
                cwd: probe, encoding: 'utf8', timeout: 10000, windowsHide: true,
            });
            if (!ver.error && ver.status === 0) return exe;
        }
    } finally {
        fs.rmSync(probe, {recursive: true, force: true});
    }
    return null;
}

const python = findPython();

buildCodegraphSuite('py', (root, args, env) => spawnSync(python, ['-I', '-B', SCRIPT, '--root', root, 'info', ...args], {
    cwd: root, encoding: 'utf8', timeout: 15000, windowsHide: true, env, maxBuffer: 4 * 1024 * 1024,
}), {
    json: false,
    disableArg: ['--integrations', '0'],
    fixture(root) {
        fs.mkdirSync(path.join(root, 'mypkg'), {recursive: true});
        fs.writeFileSync(path.join(root, 'mypkg', 'core.py'), '"""Минимальный модуль."""\n\n\nclass Core:\n    def run(self) -> str:\n        return "ok"\n');
    },
    skip: python ? false : 'Python 3.9+ is unavailable (set PYTHON to its executable)',
});
