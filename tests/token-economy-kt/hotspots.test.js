// hotspots для token-economy-kt: клей диспетчера (op=hotspots перехватывается до loadIndex).
const {spawnSync} = require('child_process');
const {buildHotspotsSuite, isolatedEnv, envWithoutGit} = require('../hotspots-suite');

const script = require('path').resolve(__dirname, '..', '..', 'skills', 'token-economy-kt', 'scripts', 'kt.js');

const spawn = (root, args, opts = {}) => spawnSync(process.execPath, [script, 'root=' + root, ...Object.entries(args).map(([k, v]) => k + '=' + v)], {
    cwd: root, encoding: 'utf8', timeout: 60000, windowsHide: true,
    env: opts.noPath ? envWithoutGit(root) : isolatedEnv(root), maxBuffer: 8 * 1024 * 1024,
});

buildHotspotsSuite('token-economy-kt', spawn);
