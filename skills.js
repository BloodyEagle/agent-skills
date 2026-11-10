#!/usr/bin/env node
'use strict';
// Версионирование скиллов: ответ на вопрос «у меня установлено то же, что в репозитории, или отстал?»
// Node >= 18, без внешних зависимостей: только node:fs, node:path, node:child_process.
// Хеш каталога — по единому правилу из lib/hash.js (его же используют check, bump, verify, manifest).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
const {hashDir, requiresOf, isExcluded} = require('./lib/hash');

// ---------- разбор аргументов ----------

function parseArgs(argv) {
    const flags = {};
    const pos = [];
    const valueFlags = new Set(['--dir', '--to', '--manifest', '--root']);
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) {
            pos.push(a);
            continue;
        }
        const eq = a.indexOf('=');
        const name = eq > 0 ? a.slice(0, eq) : a;
        if (!valueFlags.has(name) && name !== '--json') fail(`неизвестный флаг: ${name}`);
        if (!valueFlags.has(name)) {
            flags[name] = eq > 0 ? a.slice(eq + 1) : '';
            continue;
        }
        const value = eq > 0 ? a.slice(eq + 1) : argv[i + 1];
        if (!value || value.startsWith('--')) fail(`укажите значение для ${name}`);
        flags[name] = value;
        if (eq < 0) i++;
    }
    return {flags, pos};
}

const {flags, pos} = parseArgs(process.argv.slice(2));

// --root: работать с другим каталогом репозитория (по умолчанию — каталог skills.js); нужен тестам.
const ROOT = flags['--root'] ? path.resolve(flags['--root']) : path.resolve(__dirname);
const SKILLS_DIR = path.join(ROOT, 'skills');
const MANIFEST_PATH = path.join(SKILLS_DIR, 'manifest.json');

// ---------- служебные ----------

const MANIFEST_SCHEMA = 1;
const SKILL_NAME = /^[a-z0-9][a-z0-9._-]*$/;

function validateName(name) {
    if (typeof name !== 'string' || !SKILL_NAME.test(name) || /[.]$/.test(name)) {
        throw new Error(`недопустимое имя скилла: ${name}`);
    }
    return name;
}

function insideDir(root, target) {
    const rel = path.relative(root, target);
    return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep));
}

function realPath(target) {
    const parts = [];
    let parent = path.resolve(target);
    for (;;) {
        try {
            fs.lstatSync(parent);
        } catch (e) {
            if (e.code !== 'ENOENT') throw e;
            const next = path.dirname(parent);
            if (next === parent) throw e;
            parts.push(path.basename(parent));
            parent = next;
            continue;
        }
        return path.join(fs.realpathSync(parent), ...parts.reverse());
    }
}

function skillDir(name) {
    validateName(name);
    const dir = path.resolve(SKILLS_DIR, name);
    if (!fs.existsSync(dir)) throw new Error(`скилл не найден: ${name}`);
    if (fs.lstatSync(dir).isSymbolicLink() || !fs.statSync(dir).isDirectory()
        || !insideDir(fs.realpathSync(SKILLS_DIR), fs.realpathSync(dir))) {
        throw new Error(`скилл вне каталога skills или не является каталогом: ${name}`);
    }
    return dir;
}

function readRegularFile(file) {
    if (!fs.lstatSync(file).isFile()) throw new Error(`ожидался обычный файл без ссылки: ${file}`);
    return fs.readFileSync(file, 'utf8');
}

function validateManifest(manifest, source) {
    if (!manifest || !Array.isArray(manifest.skills)) throw new Error(`битый манифест: ${source} — нет массива skills`);
    if (manifest.schemaVersion !== undefined && manifest.schemaVersion !== MANIFEST_SCHEMA) {
        throw new Error(`неподдерживаемая schemaVersion манифеста: ${manifest.schemaVersion}`);
    }
    const names = new Set();
    for (const entry of manifest.skills) {
        validateName(entry && entry.name);
        if (names.has(entry.name)) throw new Error(`дубликат скилла в манифесте: ${entry.name}`);
        names.add(entry.name);
        if (!parseVersion(entry.version) || !/^[a-f0-9]{64}$/.test(entry.sha256)
            || !Number.isSafeInteger(entry.files) || entry.files < 0) {
            throw new Error(`битая запись манифеста: ${entry.name}`);
        }
    }
    return manifest;
}

// Все файлы подготовлены до первой замены; при ошибке записи возвращаем прежнее содержимое.
function writeFiles(changes) {
    const prepared = [];
    const committed = [];
    try {
        for (const [file, content] of changes) {
            let previous = null;
            let mode;
            try {
                const stat = fs.lstatSync(file);
                if (!stat.isFile()) throw new Error(`ожидался обычный файл без ссылки: ${file}`);
                previous = fs.readFileSync(file);
                mode = stat.mode;
            } catch (e) {
                if (e.code !== 'ENOENT') throw e;
            }
            const tmp = file + '.' + process.pid + '.' + crypto.randomUUID() + '.tmp';
            const change = {file, tmp, previous, mode};
            prepared.push(change);
            fs.writeFileSync(tmp, content, {flag: 'wx', mode});
        }
        for (const change of prepared) {
            fs.renameSync(change.tmp, change.file);
            committed.push(change);
        }
    } catch (e) {
        const errors = [];
        for (const change of committed.reverse()) {
            try {
                if (change.previous === null) fs.unlinkSync(change.file);
                else {
                    fs.writeFileSync(change.tmp, change.previous, {flag: 'wx', mode: change.mode});
                    fs.renameSync(change.tmp, change.file);
                }
            } catch (rollback) {
                change.preserve = true;
                errors.push(`${change.file}: ${rollback.message} (резерв: ${change.tmp})`);
            }
        }
        if (errors.length) throw new Error(`${e.message}; не удалось восстановить: ${errors.join('; ')}`);
        throw e;
    } finally {
        for (const change of prepared) {
            if (change.preserve) continue;
            try { fs.unlinkSync(change.tmp); } catch (e) {
                if (e.code !== 'ENOENT') console.error(`Предупреждение: не удалось удалить ${change.tmp}: ${e.message}`);
            }
        }
    }
}

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
    return parseVersion(readRegularFile(p));
}

// version: из frontmatter SKILL.md (блок между первым и вторым ---).
function frontmatterVersion(skillDir) {
    const p = path.join(skillDir, 'SKILL.md');
    if (!fs.existsSync(p)) return null;
    const parts = /^(?:\uFEFF?---[^\S\r\n]*\r?\n)([\s\S]*?)^---[^\S\r\n]*(?:\r?\n|$)/m.exec(readRegularFile(p));
    if (!parts || parts.index !== 0) return null;
    const m = /^version:\s*(\S+)\s*$/m.exec(parts[1]);
    return m ? m[1] : null;
}

// Готовит новый frontmatter без изменения файла; запись выполняется вместе с VERSION и манифестом.
function frontmatterText(skillDir, version) {
    const p = path.join(skillDir, 'SKILL.md');
    const text = readRegularFile(p);
    const match = /^(\uFEFF?---[^\S\r\n]*\r?\n)([\s\S]*?)(^---[^\S\r\n]*(?:\r?\n|$))/m.exec(text);
    if (!match || match.index !== 0) throw new Error(`${skillDir}: в SKILL.md нет frontmatter`);
    const eol = match[1].endsWith('\r\n') ? '\r\n' : '\n';
    let header = match[2];
    if (/^version:[^\r\n]*$/m.test(header)) {
        header = header.replace(/^version:[^\r\n]*$/m, 'version: ' + version);
    } else {
        if (!/^description:/m.test(header)) throw new Error(`${skillDir}: в SKILL.md нет description: в frontmatter`);
        header = header.replace(/^description:/m, 'version: ' + version + eol + 'description:');
    }
    return match[1] + header + match[3] + text.slice(match[0].length);
}

function loadManifest(manifestPath) {
    if (!fs.existsSync(manifestPath)) {
        fail(`манифест не найден: ${manifestPath}. Укажите --manifest <путь|URL> или сгенерируйте: node skills.js manifest`);
    }
    const raw = readRegularFile(manifestPath);
    return validateManifest(JSON.parse(raw), manifestPath);
}

async function loadManifestFromFlag(flag) {
    if (/^https?:\/\//.test(flag)) {
        const res = await fetch(flag, {signal: AbortSignal.timeout(10000)});
        if (!res.ok) fail(`манифест по URL недоступен: ${flag} — HTTP ${res.status}`);
        return validateManifest(JSON.parse(await res.text()), flag);
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
        return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim();
    } catch {
        return null;
    }
}

// ---------- команды ----------

function cmdHash(name) {
    const dir = skillDir(name);
    const {hash, files} = hashDir(dir);
    console.log(`sha256: ${hash}`);
    console.log(`файлов: ${files}`);
}

// Пересобирает манифест из текущих VERSION (первичное заполнение и восстановление согласованности).
function cmdManifest() {
    let previous = {skills: []};
    if (fs.existsSync(MANIFEST_PATH)) {
        const raw = readRegularFile(MANIFEST_PATH);
        try { previous = validateManifest(JSON.parse(raw), MANIFEST_PATH); } catch (e) {
            console.error(`Предупреждение: прежний манифест пересоздан: ${e.message}`);
        }
    }
    const entries = [];
    for (const e of fs.readdirSync(SKILLS_DIR, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!e.isDirectory() && !e.isSymbolicLink()) continue;
        if (!fs.existsSync(path.join(SKILLS_DIR, e.name, 'SKILL.md'))) continue;
        const dir = skillDir(e.name);
        const v = readVersionFile(dir, e.name);
        if (!v) throw new Error(`skills/${e.name}: нет файла VERSION — сначала добавьте его (см. README, раздел «Версии и обновление»)`);
        const {hash, files} = hashDir(dir);
        const requires = requiresOf(dir);
        const old = previous.skills.find((s) => s.name === e.name);
        const version = versionToString(v);
        const unchanged = old && old.version === version && old.sha256 === hash && old.files === files
            && JSON.stringify(old.requires) === JSON.stringify(requires);
        entries.push({name: e.name, version, updated: unchanged ? old.updated : today(), files, sha256: hash, requires});
    }
    const manifest = {schemaVersion: MANIFEST_SCHEMA, generated: today(), skills: entries};
    writeFiles([[MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n']]);
    console.log(`манифест записан: ${path.relative(ROOT, MANIFEST_PATH)} (${entries.length} скиллов)`);
}

function cmdBump(name, level) {
    if (!['patch', 'minor', 'major'].includes(level)) {
        throw new Error(`уровень должен быть patch | minor | major, получено: ${level}`);
    }
    const dir = skillDir(name);
    const cur = readVersionFile(dir, name);
    if (!cur) throw new Error(`skills/${name}: нет файла VERSION`);
    const manifest = loadManifest(MANIFEST_PATH);
    const next = {...cur};
    if (level === 'patch') next.patch += 1;
    if (level === 'minor') { next.minor += 1; next.patch = 0; }
    if (level === 'major') { next.major += 1; next.minor = 0; next.patch = 0; }
    const nextStr = versionToString(next);
    const contents = new Map([['VERSION', nextStr + '\n'], ['SKILL.md', frontmatterText(dir, nextStr)]]);
    const {hash, files} = hashDir(dir, contents);
    let entry = manifest.skills.find((s) => s.name === name);
    if (!entry) {
        entry = {name};
        manifest.skills.push(entry);
    }
    Object.assign(entry, {version: nextStr, updated: today(), files, sha256: hash, requires: requiresOf(dir)});
    manifest.schemaVersion = MANIFEST_SCHEMA;
    manifest.generated = today();
    const changes = [...contents].map(([rel, content]) => [path.join(dir, rel), content]);
    changes.push([MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n']);
    writeFiles(changes);
    console.log(`${name}: ${versionToString(cur)} → ${nextStr} (VERSION, SKILL.md, манифест обновлены)`);
}

function cmdInstall(name, flags) {
    const src = skillDir(name);
    readRegularFile(path.join(src, 'SKILL.md'));
    const v = readVersionFile(src, name);
    if (!v) throw new Error(`skills/${name}: нет корректного VERSION`);
    const to = resolveInstallDir(flags, '--to');
    const dest = path.join(to, name);
    const srcReal = fs.realpathSync(src);
    const destReal = realPath(dest);
    if (insideDir(srcReal, destReal) || insideDir(destReal, srcReal)) {
        throw new Error('источник и назначение установки пересекаются');
    }
    if (!insideDir(realPath(to), destReal)) throw new Error(`назначение вне каталога установки: ${dest}`);
    let exists = false;
    try {
        const stat = fs.lstatSync(dest);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`назначение не является обычным каталогом: ${dest}`);
        exists = true;
    } catch (e) {
        if (e.code !== 'ENOENT') throw e;
    }
    fs.mkdirSync(to, {recursive: true});
    const stage = fs.mkdtempSync(path.join(to, '.' + name + '-install-'));
    const staged = path.join(stage, 'skill');
    const backup = path.join(stage, 'previous');
    let movedOld = false;
    let installed = false;
    let preserveBackup = false;
    let meta;
    try {
        fs.cpSync(src, staged, {
            recursive: true,
            filter: (file) => {
                const rel = path.relative(src, file).split(path.sep).join('/');
                if (rel && isExcluded(rel)) return false;
                if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`ссылки внутри скилла не устанавливаются: ${rel}`);
                return true;
            },
        });
        const {hash, files} = hashDir(staged);
        const version = readVersionFile(staged, name);
        if (!version) throw new Error(`skills/${name}: VERSION изменился во время копирования`);
        meta = {name, version: versionToString(version), hash, files, date: today(), commit: gitCommit()};
        fs.writeFileSync(path.join(staged, '.installed.json'), JSON.stringify(meta, null, 2) + '\n', {flag: 'wx'});
        if (exists) {
            fs.renameSync(dest, backup);
            movedOld = true;
        }
        fs.renameSync(staged, dest);
        installed = true;
    } catch (e) {
        if (movedOld && !installed) {
            try { fs.renameSync(backup, dest); } catch (rollback) {
                preserveBackup = true;
                throw new Error(`${e.message}; прежняя копия сохранена в ${backup}: ${rollback.message}`);
            }
        }
        throw e;
    } finally {
        if (!preserveBackup) {
            try { fs.rmSync(stage, {recursive: true, force: true}); } catch (e) {
                console.error(`Предупреждение: временный каталог сохранён ${stage}: ${e.message}`);
            }
        }
    }
    console.log(`${name} → ${dest} (версия ${meta.version}, файлов ${meta.files}, хеш записан в .installed.json)`);
}

// Статусы установки: актуально | изменён локально | устарело | не установлен | неизвестно (установлен вручную).
function collectStatuses(manifest, installDir) {
    return manifest.skills.map((s) => {
        const inst = path.join(installDir, s.name);
        if (!fs.existsSync(inst)) {
            return {name: s.name, manifest: s.version, status: 'не установлен'};
        }
        const stat = fs.lstatSync(inst);
        if (!stat.isDirectory() || stat.isSymbolicLink() || !insideDir(realPath(installDir), fs.realpathSync(inst))) {
            return {name: s.name, manifest: s.version, status: 'неизвестно (небезопасный каталог установки)'};
        }
        const metaPath = path.join(inst, '.installed.json');
        if (!fs.existsSync(metaPath)) {
            return {name: s.name, manifest: s.version, status: 'неизвестно (установлен вручную)'};
        }
        let meta;
        try {
            meta = JSON.parse(readRegularFile(metaPath));
            if (!meta || meta.name !== s.name || !parseVersion(meta.version) || !/^[a-f0-9]{64}$/.test(meta.hash)) {
                throw new Error('некорректная метка установки');
            }
        } catch {
            return {name: s.name, manifest: s.version, status: 'неизвестно (битый .installed.json)'};
        }
        const mv = parseVersion(s.version);
        const iv = parseVersion(meta.version);
        if (mv && iv && compareVersions(mv, iv) > 0) {
            return {name: s.name, installed: meta.version, manifest: s.version, status: `устарело (${meta.version} → ${s.version})`};
        }
        if (mv && iv && compareVersions(iv, mv) > 0) {
            return {name: s.name, installed: meta.version, manifest: s.version, status: `новее манифеста (${meta.version} > ${s.version})`};
        }
        let hash;
        try { ({hash} = hashDir(inst)); } catch (e) {
            if (e.code !== 'UNSAFE_SKILL_LINK') throw e;
            return {name: s.name, manifest: s.version, status: 'неизвестно (небезопасный каталог установки)'};
        }
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
        .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && fs.existsSync(path.join(SKILLS_DIR, e.name, 'SKILL.md')))
        .map((e) => e.name)
        .sort();

    for (const name of dirs) {
        const dir = skillDir(name);
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
        if (JSON.stringify(entry.requires) !== JSON.stringify(requiresOf(dir))) {
            errors.push(`skills/${name}: requires в манифесте не соответствуют составу файлов`);
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
