const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');
const assert = require('node:assert/strict');

const crypto = require('crypto');
const scripts = path.resolve(__dirname, '..', '..', 'skills', 'token-economy-ts', 'scripts');

function inventory(root) {
    const result = {};
    function visit(dir) {
        for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            const file = path.join(dir, entry.name);
            if (entry.isSymbolicLink()) throw new Error('Fixture must not contain symlinks: ' + file);
            if (entry.isDirectory()) visit(file);
            else result[path.relative(root, file).replace(/\\/g, '/')] = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
        }
    }
    visit(root);
    return result;
}

function project(run, files = {}, options = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-economy-js-'));
    try {
        if (!options.empty) fs.cpSync(path.join(__dirname, 'fixtures'), root, {recursive: true});
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
    const before = inventory(root);
    const result = spawnSync(process.execPath, [path.join(scripts, script + '.js'), ...Object.entries(args).map(([key, value]) => key + '=' + value)], {
        cwd: root, encoding: 'utf8', timeout: 8000, windowsHide: true,
        env: {...process.env, NODE_OPTIONS: '', HOME: root, USERPROFILE: root}, maxBuffer: 4 * 1024 * 1024
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    const after = inventory(root);
    const allowed = new Set(['graph-deps.json', '.graph-deps-cache.json']);
    for (const [file, hash] of Object.entries(before)) {
        const expectedEdit = script === 'edit-symbol' && (args.dry === false || args.dry === 'false')
            && file === String(args.file).replace(/\\/g, '/');
        if (!allowed.has(file) && !expectedEdit) assert.equal(after[file], hash, 'Unexpected source write: ' + file);
    }
    for (const file of Object.keys(after)) if (!hasOwn(before, file)) assert.ok(allowed.has(file), 'Unexpected output: ' + file);
    return result;
}

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function json(root, script, args = {}) {
    const result = cli(root, script, args);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return JSON.parse(result.stdout);
}

module.exports = {project, cli, json, scripts};
