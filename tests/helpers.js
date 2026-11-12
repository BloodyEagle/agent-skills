'use strict';
// Общее для тестов CLI: временные «репозитории» с мини-скиллами и запуск skills.js в них.
// Манифест фикстуры считается lib/hash.js — тем же правилом, что и в боевом manifest.json.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {hashDir} = require('../lib/hash');

const SKILLS_JS = path.join(__dirname, '..', 'skills.js');

function tmpRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'skills-test-'));
}

// Минимальный скилл: VERSION, SKILL.md с frontmatter, один скрипт.
function makeSkill(root, name, version = '1.0.0') {
    const dir = path.join(root, 'skills', name);
    fs.mkdirSync(path.join(dir, 'scripts'), {recursive: true});
    fs.writeFileSync(path.join(dir, 'VERSION'), version + '\n');
    fs.writeFileSync(path.join(dir, 'SKILL.md'),
        `---\nname: ${name}\ndescription: тестовый скилл\nversion: ${version}\n---\n\n# ${name}\n`);
    fs.writeFileSync(path.join(dir, 'scripts', 'tool.js'), '// tool\n');
    return dir;
}

function writeManifest(root) {
    const skillsDir = path.join(root, 'skills');
    const skills = [];
    for (const e of fs.readdirSync(skillsDir, {withFileTypes: true}).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        if (!e.isDirectory()) continue;
        const {hash, files} = hashDir(path.join(skillsDir, e.name));
        const version = fs.readFileSync(path.join(skillsDir, e.name, 'VERSION'), 'utf8').trim();
        skills.push({name: e.name, version, updated: '2026-11-06', files, sha256: hash, requires: ['node>=18']});
    }
    const manifest = {generated: '2026-11-06', skills};
    fs.writeFileSync(path.join(skillsDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    return manifest;
}

function readManifest(root) {
    return JSON.parse(fs.readFileSync(path.join(root, 'skills', 'manifest.json'), 'utf8'));
}

function writeManifestObj(root, manifest) {
    fs.writeFileSync(path.join(root, 'skills', 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}

// Запуск skills.js с --root на фикстуре; код и stdout/stderr без исключений.
function run(root, args) {
    try {
        return {code: 0, stdout: execFileSync(process.execPath, [SKILLS_JS, '--root', root, ...args], {encoding: 'utf8'}), stderr: ''};
    } catch (e) {
        return {code: e.status, stdout: String(e.stdout || ''), stderr: String(e.stderr || '')};
    }
}

function statuses(root, installDir) {
    const r = run(root, ['check', '--dir', installDir, '--json']);
    assertCode(r, 0, 'check --json');
    return JSON.parse(r.stdout);
}

function assertCode(r, expected, what) {
    if (r.code !== expected) {
        throw new Error(`${what}: код ${r.code}, ожидался ${expected}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    }
}

module.exports = {tmpRoot, makeSkill, writeManifest, readManifest, writeManifestObj, run, statuses, assertCode};
