const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');
const assert = require('node:assert/strict');

const scripts = path.resolve(__dirname, '..', 'scripts');

function project(run, files = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-economy-js-'));
    try {
        fs.cpSync(path.join(__dirname, 'fixtures'), root, {recursive: true});
        for (const [file, text] of Object.entries(files)) {
            const target = path.join(root, file);
            fs.mkdirSync(path.dirname(target), {recursive: true});
            fs.writeFileSync(target, text, 'utf8');
        }
        return run(root);
    } finally {
        fs.rmSync(root, {recursive: true, force: true});
    }
}

function cli(root, script, args = {}) {
    const result = spawnSync(process.execPath, [path.join(scripts, script + '.js'), ...Object.entries(args).map(([key, value]) => key + '=' + value)], {cwd: root, encoding: 'utf8', timeout: 30000});
    assert.ifError(result.error);
    return result;
}

function json(root, script, args = {}) {
    const result = cli(root, script, args);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return JSON.parse(result.stdout);
}

module.exports = {project, cli, json, scripts};
