// hotspots для token-economy-php: клей диспетчера + исключения Битрикса (bitrix/modules, upload).
const {spawnSync} = require('child_process');
const {buildHotspotsSuite, isolatedEnv, envWithoutGit, gitRepo, write, commitAll} = require('../hotspots-suite');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {DOCROOTS} = require('../../skills/token-economy-php/scripts/lib/fsx');

const script = require('path').resolve(__dirname, '..', '..', 'skills', 'token-economy-php', 'scripts', 'bx.js');

const spawn = (root, args, opts = {}) => spawnSync(process.execPath, [script, 'root=' + root, ...Object.entries(args).map(([k, v]) => k + '=' + v)], {
    cwd: root, encoding: 'utf8', timeout: 60000, windowsHide: true,
    env: opts.noPath ? envWithoutGit(root) : isolatedEnv(root), maxBuffer: 8 * 1024 * 1024,
});

buildHotspotsSuite('token-economy-php', spawn, {bitrix: true});

const readCache = (root) => JSON.parse(fs.readFileSync(path.join(root, '.git-signals.json'), 'utf8'));

for (const docroot of ['', ...DOCROOTS]) {
    test('F06: hotspots docroot=' + (docroot || '<root>') + ' исключает modules/upload, сохраняет local/modules', () => gitRepo(root => {
        const prefix = docroot ? docroot + '/' : '';
        const custom = prefix + 'local/modules/acme.module/include.php';
        const app = prefix + 'index.php';
        write(root, {
            [prefix + 'bitrix/modules/main/include.php']: '<?php // vendor\n',
            [prefix + 'upload/cache.dat']: 'junk\n',
            [custom]: '<?php // user module\n',
            [app]: '<?php // app\n',
        });
        commitAll(root, 'feat: docroot fixture');
        const result = spawn(root, {op: 'hotspots', top: 20});
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        const cache = readCache(root);
        assert.deepEqual(cache.pathspec, [':(exclude)' + prefix + 'bitrix/modules', ':(exclude)' + prefix + 'upload']);
        assert.deepEqual(Object.keys(cache.files).sort(), [app, custom].sort());
        assert.ok(result.stdout.includes(custom));
        assert.doesNotMatch(result.stdout, /bitrix\/modules|upload\//);
        assert.equal(fs.existsSync(path.join(root, '.bx-cache')), false);
        const warm = spawn(root, {op: 'hotspots', top: 20}, {noPath: true});
        assert.equal(warm.status, 0, warm.stdout + warm.stderr);
        assert.equal(warm.stdout, result.stdout);
    }));
}

test('F06: смена docroot/pathspec инвалидирует кэш при неизменном HEAD', () => gitRepo(root => {
    write(root, {
        'www/bitrix/modules/main/include.php': '<?php // vendor\n',
        'www/upload/cache.dat': 'junk\n',
        'www/local/modules/acme.module/include.php': '<?php // user\n',
        'www/index.php': '<?php // app\n',
    });
    commitAll(root, 'feat: nested docroot');
    const first = spawn(root, {op: 'hotspots', top: 20});
    assert.equal(first.status, 0, first.stdout + first.stderr);
    const before = readCache(root);
    assert.ok(!before.files['www/upload/cache.dat']);
    // Новый untracked маркер корневого сайта меняет ctx.prefix, но не HEAD.
    fs.mkdirSync(path.join(root, 'local', 'modules'), {recursive: true});
    const second = spawn(root, {op: 'hotspots', top: 20});
    assert.equal(second.status, 0, second.stdout + second.stderr);
    const after = readCache(root);
    assert.equal(after.head, before.head);
    assert.deepEqual(after.pathspec, [':(exclude)bitrix/modules', ':(exclude)upload']);
    assert.notDeepEqual(after.pathspec, before.pathspec);
    assert.ok(after.files['www/bitrix/modules/main/include.php']);
    assert.ok(after.files['www/upload/cache.dat']);
    assert.ok(after.files['www/local/modules/acme.module/include.php']);
    assert.equal(fs.existsSync(path.join(root, '.bx-cache')), false);
}));
