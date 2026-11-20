'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

const {buildCodegraphSuite} = require('../codegraph-suite');

const SCRIPT = path.resolve(__dirname, '..', '..', 'skills', 'token-economy-kt', 'scripts', 'kt.js');

buildCodegraphSuite('kt', (root, args, env) => spawnSync(process.execPath, [SCRIPT, 'op=info', 'root=' + root, ...args], {
    cwd: root, encoding: 'utf8', timeout: 15000, windowsHide: true, env, maxBuffer: 4 * 1024 * 1024,
}), {
    json: false,
    disableArg: ['integrations=0'],
    fixture(root) {
        fs.mkdirSync(path.join(root, 'app', 'src', 'main', 'java', 'com', 'demo'), {recursive: true});
        fs.writeFileSync(path.join(root, 'app', 'src', 'main', 'java', 'com', 'demo', 'MainActivity.kt'), 'package com.demo\n\nclass MainActivity {\n    fun greet(): String = "hi"\n}\n');
    },
});
