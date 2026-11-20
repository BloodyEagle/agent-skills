'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

const {buildCodegraphSuite} = require('../codegraph-suite');

const SCRIPT = path.resolve(__dirname, '..', '..', 'skills', 'token-economy-java', 'scripts', 'jv.js');

buildCodegraphSuite('java', (root, args, env) => spawnSync(process.execPath, [SCRIPT, 'op=info', 'root=' + root, ...args], {
    cwd: root, encoding: 'utf8', timeout: 15000, windowsHide: true, env, maxBuffer: 4 * 1024 * 1024,
}), {
    json: false,
    disableArg: ['integrations=0'],
    fixture(root) {
        fs.mkdirSync(path.join(root, 'src', 'main', 'java', 'demo'), {recursive: true});
        fs.writeFileSync(path.join(root, 'src', 'main', 'java', 'demo', 'App.java'), 'package demo;\n\npublic class App {\n    public static void main(String[] args) {\n        System.out.println("hi");\n    }\n}\n');
    },
});
