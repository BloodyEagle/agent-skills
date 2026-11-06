#!/usr/bin/env node
'use strict';
// Версионирование скиллов: ответ на вопрос «у меня установлено то же, что в репозитории, или отстал?»
// Node >= 18, без внешних зависимостей: только node:fs, node:path, node:child_process.
// Хеш каталога — по единому правилу из lib/hash.js (его же используют check, bump, verify, manifest).

const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {hashDir, requiresOf} = require('./lib/hash');

// ---------- разбор аргументов ----------

function parseArgs(argv) {
    const flags = {};
    const pos = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) {
            const eq = a.indexOf('=');
            if (eq > 0) {
                flags[a.slice(0, eq)] = a.slice(eq + 1);
            } else if (['--dir', '--to', '--manifest', '--root'].includes(a) && i + 1 < argv.length) {
                flags[a] = argv[++i];
            } else {
                flags[a] = '';
            }
        } else {
            pos.push(a);
        }
    }
    return {flags, pos};
}

const {flags, pos} = parseArgs(process.argv.slice(2));

// --root: работать с другим каталогом репозитория (по умолчанию — каталог skills.js); нужен тестам.
const ROOT = flags['--root'] ? path.resolve(flags['--root']) : path.resolve(__dirname);
const SKILLS_DIR = path.join(ROOT, 'skills');
const MANIFEST_PATH = path.join(SKILLS_DIR, 'manifest.json');

// ---------- служебные ----------

function fail(msg, code = 1) {
    console.error('Ошибка: ' + msg);
    process.exit(code);
}

function today() {
    return new Date().toISOString().slice(0, 10);
}

// Разбор x.y.z без npm-пакета semver: десять строк.
function parseVersion(s) {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(s).trim());
    if (!m) return null;
    return {major: +m[1], minor: +m[2], patch: +m[3]};
}

function versionToString(v) {
    return `${v.major}.${v.minor}.${v.patch}`;
}

// -1: a старше b, 0: равны, 1: a новее b.
function compareVersions(a, b) {
    for (const k of ['major', 'minor', 'patch']) {
        if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
    }
    return 0;
}

function readVersionFile(dir, name) {
    const p = path.join(dir, 'VERSION');
    if (!fs.existsSync(p)) return null;
    return parseVersion(fs.readFileSync(p, 'utf8'));
}

// version: из frontmatter SKILL.md (блок между первым и вторым ---).
function frontmatterVersion(skillDir) {
    const p = path.join(skillDir, 'SKILL.md');
    if (!fs.existsSync(p)) return null;
    const parts = fs.readFileSync(p, 'utf8').split(/^---\s*$/m);
    const head = parts.length > 1 ? parts[1] : parts[0];
    const m = /^version:\s*(\S+)\s*$/m.exec(head);
    return m ? m[1] : null;
}

// Записывает version: в frontmatter: заменяет существующую строку или вставляет после description:.
function setFrontmatterVersion(skillDir, version) {
    const p = path.join(skillDir, 'SKILL.md');
    let text = fs.readFileSync(p, 'utf8');
    if (/^version:\s*\S+\s*$/m.test(text)) {
        text = text.replace(/^version:\s*\S+\s*$/m, 'version: ' + version);
    } else {
        if (!/^description:/m.test(text)) fail(`${skillDir}: в SKILL.md нет frontmatter с description: — некуда вставить version:`);
        text = text.replace(/^description:/m, 'version: ' + version + '\ndescription:');
    }
    fs.writeFileSync(p, text);
}

function loadManifest(manifestPath) {
    if (!fs.existsSync(manifestPath)) {
        fail(`манифест не найден: ${manifestPath}. Укажите --manifest <путь|URL> или сгенерируйте: node skills.js manifest`);
    }
    const raw = fs.readFileSync(manifestPath, 'utf8');
    const m = JSON.parse(raw);
    if (!m || !Array.isArray(m.skills)) fail(`битый манифест: ${manifestPath} — нет массива skills`);
    return m;
}

async function loadManifestFromFlag(flag) {
    if (/^https?:\/\//.test(flag)) {
        const res = await fetch(flag);
        if (!res.ok) fail(`манифест по URL недоступен: ${flag} — HTTP ${res.status}`);
        const m = JSON.parse(await res.text());
        if (!m || !Array.isArray(m.skills)) fail(`битый манифест по URL: ${flag} — нет массива skills`);
        return m;
    }
    return loadManifest(path.resolve(flag));
}

// Каталог установки: свой флаг команды (--to/--dir), затем --dir, затем переменная окружения; угадывать нельзя.
function resolveInstallDir(flags, optName) {
    const chosen = flags[optName] !== undefined && flags[optName] !== '' ? flags[optName] : flags['--dir'];
    if (chosen !== undefined && chosen !== '') return path.resolve(chosen);
    if (process.env.AGENT_SKILLS_DIR) return path.resolve(process.env.AGENT_SKILLS_DIR);
    fail(`укажите каталог установки: ${optName} PATH или переменная AGENT_SKILLS_DIR`);
}

function gitCommit() {
    try {
        return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {cwd: ROOT, encoding: 'utf8'}).trim();
    } catch {
        return null;
    }
}

// ---------- команды ----------

function cmdHash(name) {
    const dir = path.join(SKILLS_DIR, name);
    if (!fs.existsSync(dir)) fail(`скилл не найден: ${name}`);
    const {hash, files} = hashDir(dir);
    console.log(`sha256: ${hash}`);
    console.log(`файлов: ${files}`);
}

// Пересобирает манифест из текущих VERSION (первичное заполнение и восстановление согласованности).
function cmdManifest() {
    const entries = [];
    for (const e of fs.readdirSync(SKILLS_DIR, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!e.isDirectory()) continue;
        const dir = path.join(SKILLS_DIR, e.name);
        if (!fs.existsSync(path.join(dir, 'SKILL.md'))) continue;
        const v = readVersionFile(dir, e.name);
        if (!v) fail(`skills/${e.name}: нет файла VERSION — сначала добавьте его (см. README, раздел «Версии и обновление»)`);
        const {hash, files} = hashDir(dir);
        entries.push({
            name: e.name,
            version: versionToString(v),
            updated: today(),
            files,
            sha256: hash,
            requires: requiresOf(dir),
        });
    }
    const manifest = {generated: today(), skills: entries};
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
    console.log(`манифест записан: ${path.relative(ROOT, MANIFEST_PATH)} (${entries.length} скиллов)`);
}

function cmdBump(name, level) {
    if (!['patch', 'minor', 'major'].includes(level)) {
        fail(`уровень должен быть patch | minor | major, получено: ${level}`);
    }
    const dir = path.join(SKILLS_DIR, name);
    if (!fs.existsSync(path.join(dir, 'SKILL.md'))) fail(`скилл не найден: ${name}`);
    const cur = readVersionFile(dir, name);
    if (!cur) fail(`skills/${name}: нет файла VERSION`);
    const next = {...cur};
    if (level === 'patch') next.patch += 1;
    if (level === 'minor') { next.minor += 1; next.patch = 0; }
    if (level === 'major') { next.major += 1; next.minor = 0; next.patch = 0; }
    const nextStr = versionToString(next);

    fs.writeFileSync(path.join(dir, 'VERSION'), nextStr + '\n');
    setFrontmatterVersion(dir, nextStr);

    const manifest = loadManifest(MANIFEST_PATH);
    const {hash, files} = hashDir(dir);
    let entry = manifest.skills.find((s) => s.name === name);
    if (!entry) {
        entry = {name, requires: requiresOf(dir)};
        manifest.skills.push(entry);
    }
    entry.version = nextStr;
    entry.updated = today();
    entry.files = files;
    entry.sha256 = hash;
    if (!Array.isArray(entry.requires)) entry.requires = requiresOf(dir);
    manifest.generated = today();
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
    console.log(`${name}: ${versionToString(cur)} → ${nextStr} (VERSION, SKILL.md, манифест обновлены)`);
}

function cmdInstall(name, flags) {
    const src = path.join(SKILLS_DIR, name);
    if (!fs.existsSync(path.join(src, 'SKILL.md'))) fail(`скилл не найден: ${name}`);
    const to = resolveInstallDir(flags, '--to');
    const dest = path.join(to, name);
    fs.mkdirSync(dest, {recursive: true});
    fs.cpSync(src, dest, {recursive: true});
    const {hash, files} = hashDir(dest);
    const v = readVersionFile(dest, name);
    const meta = {
        name,
        version: v ? versionToString(v) : null,
        hash,
        files,
        date: today(),
        commit: gitCommit(),
    };
    fs.writeFileSync(path.join(dest, '.installed.json'), JSON.stringify(meta, null, 2) + '\n');
    console.log(`${name} → ${dest} (версия ${meta.version}, файлов ${files}, хеш записан в .installed.json)`);
}

// Статусы установки: актуально | изменён локально | устарело | не установлен | неизвестно (установлен вручную).
function collectStatuses(manifest, installDir) {
    return manifest.skills.map((s) => {
        const inst = path.join(installDir, s.name);
        if (!fs.existsSync(inst)) {
            return {name: s.name, manifest: s.version, status: 'не установлен'};
        }
        const metaPath = path.join(inst, '.installed.json');
        if (!fs.existsSync(metaPath)) {
            return {name: s.name, manifest: s.version, status: 'неизвестно (установлен вручную)'};
        }
        let meta;
        try {
            meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        } catch {
            return {name: s.name, manifest: s.version, status: 'неизвестно (битый .installed.json)'};
        }
        const mv = parseVersion(s.version);
        const iv = parseVersion(meta.version);
        if (mv && iv && compareVersions(mv, iv) > 0) {
            return {name: s.name, installed: meta.version, manifest: s.version, status: `устарело (${meta.version} → ${s.version})`};
        }
        const {hash} = hashDir(inst);
        if (meta.version === s.version && hash === s.sha256) {
            return {name: s.name, installed: meta.version, manifest: s.version, status: 'актуально'};
        }
        return {name: s.name, installed: meta.version, manifest: s.version, status: 'изменён локально'};
    });
}

async function cmdCheck(flags) {
    const manifest = await loadManifestFromFlag(flags['--manifest'] || MANIFEST_PATH);
    const installDir = resolveInstallDir(flags, '--dir');
    const rows = collectStatuses(manifest, installDir);
    if (flags['--json'] !== undefined) {
        console.log(JSON.stringify(rows));
        return;
    }
    if (!rows.length) {
        console.log('манифест пуст');
        return;
    }
    const wName = Math.max('скилл'.length, ...rows.map((r) => r.name.length));
    const wInst = Math.max('установлено'.length, ...rows.map((r) => (r.installed || '—').length));
    const wMan = Math.max('в манифесте'.length, ...rows.map((r) => (r.manifest || '—').length));
    const pad = (s, w) => s + ' '.repeat(Math.max(0, w - s.length));
    const lines = [
        pad('скилл', wName) + '  ' + pad('установлено', wInst) + '  ' + pad('в манифесте', wMan) + '  статус',
        pad('-'.repeat(wName), wName) + '  ' + pad('-'.repeat(wInst), wInst) + '  ' + pad('-'.repeat(wMan), wMan) + '  ------',
        ...rows.map((r) => pad(r.name, wName) + '  ' + pad(r.installed || '—', wInst) + '  ' + pad(r.manifest || '—', wMan) + '  ' + r.status),
    ];
    // Таблица короткая по построению; обрезаем только аномально длинные строки — предел 8 КБ.
    let out = lines.join('\n');
    if (out.length > 8192) out = out.slice(0, 8192) + '\n…';
    console.log(out);
}

function cmdVerify() {
    const errors = [];
    const manifest = loadManifest(MANIFEST_PATH);
    const dirs = fs.readdirSync(SKILLS_DIR, {withFileTypes: true})
        .filter((e) => e.isDirectory() && fs.existsSync(path.join(SKILLS_DIR, e.name, 'SKILL.md')))
        .map((e) => e.name)
        .sort();

    for (const name of dirs) {
        const dir = path.join(SKILLS_DIR, name);
        const vf = readVersionFile(dir, name);
        if (!vf) {
            errors.push(`skills/${name}: нет файла VERSION`);
            continue;
        }
        const fv = frontmatterVersion(dir);
        if (!fv) {
            errors.push(`skills/${name}: в SKILL.md нет version: в frontmatter`);
        } else if (fv !== versionToString(vf)) {
            errors.push(`skills/${name}: VERSION (${versionToString(vf)}) и version: в SKILL.md (${fv}) расходятся`);
        }
        const entry = manifest.skills.find((s) => s.name === name);
        if (!entry) {
            errors.push(`skills/${name}: нет записи в манифесте — прогоните node skills.js bump или manifest`);
            continue;
        }
        if (entry.version !== versionToString(vf)) {
            errors.push(`skills/${name}: версия в манифесте (${entry.version}) ≠ VERSION (${versionToString(vf)})`);
        }
        const {hash, files} = hashDir(dir);
        if (entry.sha256 !== hash) {
            errors.push(`skills/${name}: хеш устарел — файлы менялись без bump (прогоните node skills.js manifest или bump ${name} patch)`);
        } else if (entry.files !== files) {
            errors.push(`skills/${name}: счётчик файлов в манифесте (${entry.files}) ≠ фактического (${files})`);
        }
    }

    for (const s of manifest.skills) {
        if (!dirs.includes(s.name)) errors.push(`в манифесте лишняя запись: ${s.name} — каталога skills/${s.name} нет`);
    }

    if (errors.length) {
        console.error('Несогласованности:');
        for (const e of errors) console.error('  ' + e);
        process.exit(1);
    }
    console.log(`ok: ${dirs.length} скиллов согласованы (VERSION = version: = манифест, хеши совпадают)`);
}

// ---------- разбор аргументов: см. начало файла ----------

const [cmd, arg1, arg2] = pos;

(async () => {
    if (cmd === 'hash') cmdHash(requireArg(arg1, 'hash <name>'));
    else if (cmd === 'manifest') cmdManifest();
    else if (cmd === 'bump') cmdBump(requireArg(arg1, 'bump <name> <patch|minor|major>'), requireArg(arg2, 'bump <name> <patch|minor|major>'));
    else if (cmd === 'install') cmdInstall(requireArg(arg1, 'install <name> [--to PATH]'), flags);
    else if (cmd === 'check') await cmdCheck(flags);
    else if (cmd === 'verify') cmdVerify();
    else usage();
})().catch((e) => fail(e && e.message || String(e)));

function requireArg(v, usageLine) {
    if (!v) fail('укажите аргументы: ' + usageLine);
    return v;
}

function usage() {
    console.log(`Версионирование скиллов. Node >= 18, без зависимостей.

Команды:
  node skills.js check [--dir PATH] [--manifest ПУТЬ|URL] [--json]
      сравнить установленные скиллы с манифестом (таблица статусов).
      Каталог установки: --dir, иначе переменная AGENT_SKILLS_DIR.
  node skills.js install <name> [--to PATH]
      скопировать скилл и записать .installed.json (версия, хеш, дата, коммит).
  node skills.js bump <name> <patch|minor|major>
      поднять VERSION, version: в SKILL.md и строку в манифесте.
  node skills.js verify
      согласованность: VERSION = version: = манифест, хеши совпадают; код 1 при расхождении.
  node skills.js manifest
      пересобрать манифест из текущих VERSION (первичное заполнение).
  node skills.js hash <name>
      напечатать хеш каталога скилла.

Флаг --root PATH — работать с другим каталогом репозитория (используется тестами).
Переменная окружения: AGENT_SKILLS_DIR — каталог установленных скиллов по умолчанию.`);
    process.exit(cmd ? 1 : 0);
}
