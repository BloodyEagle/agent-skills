'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

const {buildCodegraphSuite} = require('../codegraph-suite');

const SCRIPT = path.resolve(__dirname, '..', '..', 'skills', 'token-economy-ts', 'scripts', 'graph-tool.js');

buildCodegraphSuite('ts', (root, args, env) => spawnSync(process.execPath, [SCRIPT, 'op=info', ...args], {
    cwd: root, encoding: 'utf8', timeout: 15000, windowsHide: true, env, maxBuffer: 4 * 1024 * 1024,
}), {
    json: true,
    disableArg: ['integrations=0'],
    fixture(root) {
        fs.writeFileSync(path.join(root, 'package.json'), '{"name":"fixture","version":"0.0.0"}\n');
        fs.mkdirSync(path.join(root, 'src', 'app'), {recursive: true});
        fs.writeFileSync(path.join(root, 'src', 'app', 'a.ts'), 'import {B} from "./b";\nexport class A { b = new B(); }\n');
        fs.writeFileSync(path.join(root, 'src', 'app', 'b.ts'), 'export class B {}\n');
    },
});
