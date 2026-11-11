// graph-tool.js — граф зависимостей TS/JS-проекта, HTML-шаблонов и стилей (CSS/SCSS/Sass/Less).
// Один раз строит graph-deps.json, дальше отвечает на навигационные вопросы без обхода
// репозитория: где определён символ, кто импортирует/использует файл, цепочка связей, циклы.
// Актуальность проверяет сам (mtime, список файлов, angular.json/tsconfig) и перестраивает
// инкрементально — парсятся только изменённые файлы.
//
// Рёбра (A → B = «A зависит от B»):
//   ts    → ts               import / export … from / import()
//   ts    → html, стиль      templateUrl, styleUrl(s), import './x.scss?inline'
//   ts    → ts               компонент/директива/пайп, использованные в inline-template
//   html  → ts               компонент/директива/пайп, использованные в шаблоне (по selector / name)
//   html  → стиль            <link rel="stylesheet" href="…"> (index.html)
//   стиль → стиль            @use / @forward / @import / @plugin
// Определения в стилях попадают в symbols: $var, @mixin, @function, Less @var и .mixin(), --custom-prop.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {SOURCE_EXT, IGNORED_DIRS, walk: walkFiles, isAngular, ANGULAR_ERROR, parseReactMajor} = require('./lib/files');
const {parseSymbols, sourceCodeMask, isArrowExpression} = require('./lib/symbols');
const {entityRanges} = require('./lib/ranges');
const {maskCode} = require('./lib/mask');

let args = {};
// Порядок разбора: argv-JSON (pwsh 7.3+/bash/cmd) → argv key=value → stdin (обратная совместимость).
const first = process.argv[2];
if (first && first.startsWith('{')) {
    try {
        Object.assign(args, JSON.parse(first));
    } catch (e) {
        // невалидный JSON — продолжаем со следующими источниками
    }
}
// CLI-режим: node graph-tool.js build file=src/app/a.ts depth=2; голый аргумент без = заполняет op
for (const a of process.argv.slice(2)) {
    if (a.startsWith('{')) continue; // argv-JSON уже разобран выше
    const i = a.indexOf('=');
    if (i === -1) {
        if (!args.op) args.op = a;
    } else if (a.slice(0, i)) args[a.slice(0, i)] = a.slice(i + 1);
}
// stdin-режим (обратная совместимость) — читаем пайп, только если аргументы не заданы вовсе
if (!Object.keys(args).length && process.stdin.isTTY !== true) {
    try {
        Object.assign(args, JSON.parse(fs.readFileSync(0, 'utf-8').trim() || '{}'));
    } catch (e) {
    }
}
// argv передаёт значения строками: приводим типы (stdin-JSON приходит нативным)
args.depth = Number(args.depth) || 1;
args.specs = args.specs === true || args.specs === 'true' || args.specs === '1';
args.why = args.why === true || args.why === 'true' || args.why === '1';
args.format = args.format === undefined || args.format === null ? '' : String(args.format);

const cwd = process.cwd();
// Scope-переменные: одиночный режим задаёт их из args, batch — из scope-группы запросов.
let ROOT_ARG = '';
let ROOT = '';
let SPECS = false;
/**
 * Устанавливает scope (root/specs) для одного запроса или группы; бросает OpError
 * при выходе root за пределы рабочей директории.
 */
function setScope(p) {
    ROOT_ARG = p.root || (fs.existsSync(path.join(cwd, 'src')) ? 'src' : '.');
    ROOT = path.resolve(cwd, ROOT_ARG);
    SPECS = p.specs === true;
    const rel = path.relative(cwd, ROOT);
    if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel))
        throw new OpError('root вне рабочей директории запрещён: ' + ROOT_ARG);
}
const GRAPH_FILE = path.join(cwd, 'graph-deps.json');
const CACHE_FILE = path.join(cwd, '.graph-deps-cache.json');
const GRAPH_VERSION = 9; // v9: диапазоны объявлений и тел в parsed entities (lib/ranges.js)
const MAX_BYTES = 1024 * 1024; // файлы крупнее (бандлы, вендорные стили) в граф не берём
const NG_KINDS = {
    Component: 'component',
    Directive: 'directive',
    Pipe: 'pipe',
    Injectable: 'injectable',
    NgModule: 'ngmodule'
};
const KIND_PRI = {component: 5, directive: 4, pipe: 3, injectable: 3, ngmodule: 2, class: 1};
const KNOWN_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|html|css|scss|sass|less)$/i;
const ASSET_EXT = /\.(html|css|scss|sass|less)(\?.*)?$/i;
const JSON_RESOURCE_EXT = /\.json(?:[?#].*)?$/i;
const CONFIG_FILES = ['angular.json', '.angular.json', 'tsconfig.json', 'package.json'];

const emit = (obj) => console.log(JSON.stringify(obj));
const fail = (msg) => {
    emit({error: msg, ...(['deps', 'rdeps', 'path'].includes(args.op)
        ? {scope: {root: cwd, scanRoot: toPosix(ROOT) || '.'}, completeness: {complete: false, reasons: ['request-error']}}
        : {})});
    process.exit(1);
};
const toPosix = (p) => path.relative(cwd, p).replace(/\\/g, '/');
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

// Ошибка запроса (batch-элемент или одиночный fail); root-границы проверяет setScope.
class OpError extends Error {
    constructor(msg) {
        super(msg);
        this.name = 'OpError';
    }
}

const statCache = new Map();
const statOf = (f) => {
    let s = statCache.get(f);
    if (!s) {
        s = fs.statSync(f);
        statCache.set(f, s);
    }
    return s;
};

/**
 * Тип файла по имени: 'ts' | 'js' | 'html' | 'style' | null.
 */
function fileType(name) {
    const ext = path.extname(name).toLowerCase();
    if (SOURCE_EXT.includes(ext)) return ext === '.ts' || ext === '.tsx' ? 'ts' : 'js';
    if (/\.html$/i.test(name)) return 'html';
    if (/\.(css|scss|sass|less)$/i.test(name)) return 'style';
    return null;
}

/**
 * Собирает исходники (без спеков и .d.ts), .html и стили (без *.min.css и файлов > 1 МБ).
 */
const scanExcluded = new Set();
const scanIssues = new Set();
function collectFiles(dir) {
    function check(directory) {
        let entries;
        try { entries = fs.readdirSync(directory, {withFileTypes: true}); }
        catch (e) { scanIssues.add('source-unreadable'); return; }
        for (const entry of entries) {
            if (entry.isSymbolicLink()) { scanIssues.add('source-symlink-skipped'); continue; }
            const name = process.platform === 'win32' ? entry.name.toLowerCase() : entry.name;
            if (entry.isDirectory() && !IGNORED_DIRS.includes(name) && name !== '.megamemory') check(path.join(directory, entry.name));
        }
    }
    check(dir);
    return walkFiles(dir, {ext: [...SOURCE_EXT, '.mts', '.cts', '.html', '.css', '.scss', '.sass', '.less'], ignored: [...IGNORED_DIRS, '.megamemory']})
        .filter((p) => {
            const type = fileType(p);
            if (/\.(mts|cts)$/i.test(p)) { scanExcluded.add(toPosix(p)); return false; }
            if ((type === 'ts' || type === 'js') && (/\.d\.ts$/i.test(p)
                || (!SPECS && /\.(spec|test)\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(p)))) return false;
            if (type === 'style' && /\.min\.css$/i.test(p)) return false;
            if (statOf(p).size > MAX_BYTES) { scanExcluded.add(toPosix(p)); return false; }
            return true;
        });
}

/**
 * Все файлы графа: обход ROOT плюс корневой index.html (Angular CLI держит его вне src/).
 * includes защищает от дубля при root="." — тогда index.html уже собран обходом.
 */
function collectAll() {
    const files = collectFiles(ROOT);
    const rootIndex = path.join(cwd, 'index.html');
    if (fs.existsSync(rootIndex) && !files.includes(rootIndex)
        && statOf(rootIndex).size <= MAX_BYTES) files.push(rootIndex);
    return files;
}

/**
 * JSONC без комментариев (для чтения tsconfig.json / angular.json).
 */
function parseJsonc(text) {
    let out = '', i = 0, str = false;
    while (i < text.length) {
        const c = text[i], n = text[i + 1];
        if (str) {
            out += c;
            if (c === '\\') {
                out += n || '';
                i += 2;
                continue;
            }
            if (c === '"') str = false;
            i++;
            continue;
        }
        if (c === '"') {
            str = true;
            out += c;
            i++;
            continue;
        }
        if (c === '/' && n === '/') {
            while (i < text.length && text[i] !== '\n') i++;
            continue;
        }
        if (c === '/' && n === '*') {
            i += 2;
            while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
            i += 2;
            continue;
        }
        out += c;
        i++;
    }
    return JSON.parse(out.replace(/,\s*([}\]])/g, '$1'));
}

/**
 * Резолвер алиасов импортов из tsconfig (paths/baseUrl).
 * @returns {Function|null} spec → массив абсолютных путей-кандидатов.
 */
const configInputs = new Map();
const configIssues = new Set();
const insideProject = file => {
    const rel = path.relative(cwd, file);
    return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
};
function readConfig(file) {
    if (!insideProject(file)) {
        configIssues.add('config-outside-project');
        return null;
    }
    const name = toPosix(file);
    try {
        if (!fs.existsSync(file)) {
            configInputs.set(name, {present: false});
            return null;
        }
        const bytes = fs.readFileSync(file);
        configInputs.set(name, {present: true, sha256: crypto.createHash('sha256').update(bytes).digest('hex')});
        const parsed = parseJsonc(bytes.toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid config object');
        return parsed;
    } catch (e) {
        configIssues.add('config-unreadable:' + name);
        return null;
    }
}

function loadAliases() {
    const active = new Set();
    function load(file) {
        if (active.has(file)) {
            configIssues.add('config-extends-cycle');
            return {};
        }
        active.add(file);
        const cfg = readConfig(file);
        if (!cfg) { active.delete(file); return {}; }
        let inherited = {};
        if (cfg.extends) {
            if (typeof cfg.extends !== 'string' || !cfg.extends.startsWith('.')) configIssues.add('unsupported-extends');
            else {
                let parent = path.resolve(path.dirname(file), cfg.extends);
                if (!path.extname(parent)) parent += '.json';
                if (!fs.existsSync(parent)) configIssues.add('config-extends-missing');
                inherited = load(parent);
            }
        }
        const own = cfg.compilerOptions || {};
        if (typeof own !== 'object' || Array.isArray(own) || (has(own, 'baseUrl') && typeof own.baseUrl !== 'string')
            || (has(own, 'paths') && (!own.paths || typeof own.paths !== 'object' || Array.isArray(own.paths)
                || !Object.values(own.paths).every(v => Array.isArray(v) && v.every(t => typeof t === 'string'))))) {
            configIssues.add('config-invalid-options');
            active.delete(file);
            return inherited;
        }
        if (own.moduleSuffixes || own.rootDirs || own.customConditions) configIssues.add('unsupported-module-resolution-options');
        const merged = {...inherited, ...own};
        if (has(own, 'baseUrl')) merged.baseUrl = path.resolve(path.dirname(file), own.baseUrl);
        if (has(own, 'paths')) merged.pathsOrigin = path.dirname(file);
        active.delete(file);
        return merged;
    }
    const co = load(path.join(cwd, 'tsconfig.json'));
    const base = co.baseUrl || co.pathsOrigin || cwd;
    const entries = Object.entries(co.paths || {}).map(([k, v]) => ({
        pre: k.endsWith('*') ? k.slice(0, -1) : k,
        star: k.endsWith('*'),
        targets: [].concat(v).map(t => path.resolve(base, t))
    }));
    const resolveAlias = spec => {
        for (const e of entries) {
            if (e.star) {
                if (spec.startsWith(e.pre) && spec.length > e.pre.length)
                    return e.targets.map(t => t.replace(/\*/g, spec.slice(e.pre.length)));
            } else if (spec === e.pre) return e.targets.slice();
        }
        return null;
    };
    resolveAlias.baseUrl = co.baseUrl || null;
    return resolveAlias;
}

function graphInputs() {
    configInputs.clear();
    configIssues.clear();
    for (const name of CONFIG_FILES) readConfig(path.join(cwd, name));
    const alias = loadAliases();
    const manifest = {algorithm: GRAPH_VERSION, projectRoot: cwd, scanRoot: ROOT, specs: SPECS,
        configs: Object.fromEntries([...configInputs].sort(([a], [b]) => a.localeCompare(b)))};
    return {alias, manifest};
}

/**
 * Каталоги поиска для @use/@import в стилях: stylePreprocessorOptions.includePaths из angular.json.
 * @returns {string[]} абсолютные пути.
 */
function loadStyleIncludePaths() {
    const out = new Set();
    for (const name of ['angular.json', '.angular.json']) {
        try {
            const file = path.join(cwd, name);
            if (!fs.existsSync(file)) continue;
            (function walkCfg(o) {
                if (!o || typeof o !== 'object') return;
                const sp = o.stylePreprocessorOptions;
                if (sp && typeof sp === 'object')
                    for (const p of [].concat(sp.includePaths || [])) if (typeof p === 'string') out.add(path.resolve(cwd, p));
                for (const v of Object.values(o)) walkCfg(v);
            })(parseJsonc(fs.readFileSync(file, 'utf8')));
        } catch (e) { /* битый angular.json — просто без includePaths */
        }
    }
    return [...out];
}

// ---------- разбор HTML ----------

/**
 * Убирает HTML-комментарии, сохраняя переводы строк.
 */
const stripHtmlComments = (s) => s.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ''));

/**
 * Имя атрибута шаблона без Angular-обёрток: [x] / [(x)] / (x) / *x → x.
 */
function normAttr(a) {
    if (a[0] === '*') return a.slice(1);
    if (a.startsWith('[(')) return a.slice(2, a.endsWith(')]') ? -2 : undefined);
    if (a[0] === '[') return a.slice(1, a.endsWith(']') ? -1 : undefined);
    if (a[0] === '(') return a.slice(1, a.endsWith(')') ? -1 : undefined);
    return a;
}

/**
 * Собирает из шаблона то, по чему находятся компоненты/директивы/пайпы:
 * элементы (тег + имена атрибутов + статические классы) и имена пайпов.
 * @param {string} text - HTML шаблона (без экранирования).
 * @returns {{els: Array<{t: string, a: string[], c: string[]}>, pipes: string[]}|null}
 */
function collectUsages(text) {
    const code = stripHtmlComments(text);
    const els = [], seen = new Set();
    const reTag = /<([A-Za-z][\w.:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
    const reAttr = /([^\s=<>"'\/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|[^\s>]+))?/g;
    let m;
    while ((m = reTag.exec(code))) {
        const attrs = new Set(), classes = new Set();
        let a;
        reAttr.lastIndex = 0;
        while ((a = reAttr.exec(m[2]))) {
            const name = normAttr(a[1]);
            if (!name || name[0] === '#' || name[0] === '@') continue;
            attrs.add(name);
            if (name === 'class' && a[1] === 'class') {
                for (const c of (a[2] || a[3] || '').split(/\s+/)) if (c && !c.includes('{{')) classes.add(c);
            }
        }
        const el = {t: m[1], a: [...attrs].sort(), c: [...classes].sort()};
        const key = el.t + '|' + el.a.join(',') + '|' + el.c.join(' ');
        if (!seen.has(key) && seen.size < 3000) {
            seen.add(key);
            els.push(el);
        }
    }
    const pipes = new Set();
    const rePipe = /(?<!\|)\|(?!\|)\s*([A-Za-z_$][\w$]*)/g;
    while ((m = rePipe.exec(code))) pipes.add(m[1]);
    return els.length || pipes.size ? {els, pipes: [...pipes]} : null;
}

/**
 * Объединяет два результата collectUsages.
 */
function mergeUsages(a, b) {
    if (!a) return b;
    if (!b) return a;
    return {els: a.els.concat(b.els), pipes: [...new Set(a.pipes.concat(b.pipes))]};
}

/**
 * Разбирает selector компонента/директивы: «app-x, [appY], button[appZ]:not(.q)» → части {tag, attrs, classes}.
 * Значения атрибутов и :not() игнорируются — достаточно присутствия имени.
 */
function parseSelector(sel) {
    const raw = [];
    let depth = 0, cur = '';
    for (const ch of sel) {
        if (ch === '(' || ch === '[') depth++;
        else if (ch === ')' || ch === ']') depth--;
        if (ch === ',' && depth === 0) {
            raw.push(cur);
            cur = '';
        } else cur += ch;
    }
    raw.push(cur);
    const parts = [];
    for (let p of raw) {
        p = p.replace(/:not\((?:[^()]|\([^()]*\))*\)/g, '').trim();
        if (!p) continue;
        const tag = p.match(/^([A-Za-z][\w-]*|\*)/);
        const attrs = [...p.matchAll(/\[\s*([\w.:-]+)\s*(?:[~|^$*]?=[^\]]*)?\]/g)].map((x) => x[1]);
        const classes = [...p.replace(/\[[^\]]*\]/g, '').matchAll(/\.([\w-]+)/g)].map((x) => x[1]);
        const t = tag && tag[1] !== '*' ? tag[1] : null;
        if (t || attrs.length || classes.length) parts.push({tag: t, attrs, classes});
    }
    return parts;
}

/**
 * Проверка: элемент шаблона подходит под часть селектора (все атрибуты и классы присутствуют).
 */
function partMatches(part, el) {
    if (part.tag && part.tag !== el.t) return false;
    for (const a of part.attrs) if (!el.a.includes(a)) return false;
    for (const c of part.classes) if (!el.c.includes(c)) return false;
    return true;
}

// ---------- разбор стилей ----------

/**
 * Убирает комментарии из CSS/SCSS/Sass/Less, не трогая строки и url(...); переводы строк сохраняются,
 * поэтому номера строк совпадают с исходником.
 * @param {string} code - исходник стиля.
 * @param {boolean} lineComments - удалять ли «//» (в чистом CSS их нет).
 */
function stripStyleComments(code, lineComments) {
    let out = '', i = 0;
    const n = code.length;
    while (i < n) {
        const c = code[i], nx = code[i + 1];
        if (c === '"' || c === "'") {
            out += c;
            i++;
            while (i < n && code[i] !== c && code[i] !== '\n') {
                if (code[i] === '\\') {
                    out += code[i] + (code[i + 1] || '');
                    i += 2;
                    continue;
                }
                out += code[i++];
            }
            if (i < n) {
                out += code[i];
                i++;
            }
            continue;
        }
        if (c === '/' && nx === '*') {
            i += 2;
            while (i < n && !(code[i] === '*' && code[i + 1] === '/')) {
                if (code[i] === '\n') out += '\n';
                i++;
            }
            i += 2;
            continue;
        }
        if (lineComments && c === '/' && nx === '/') {
            while (i < n && code[i] !== '\n') i++;
            continue;
        }
        if ((c === 'u' || c === 'U') && code.slice(i, i + 4).toLowerCase() === 'url(') {
            out += code.slice(i, i + 4);
            i += 4;
            let j = i;
            while (j < n && /\s/.test(code[j])) j++;
            if (code[j] !== '"' && code[j] !== "'") { // url(http://x) без кавычек — копируем до «)»
                while (i < n && code[i] !== ')' && code[i] !== '\n') out += code[i++];
            }
            continue;
        }
        out += c;
        i++;
    }
    return out;
}

/**
 * Разбирает стиль: @use/@forward/@import/@plugin и определения переменных, миксинов, функций, custom-свойств.
 */
function parseStyle(content, rel) {
    const ext = path.extname(rel).toLowerCase();
    const code = stripStyleComments(content.replace(/^\uFEFF/, ''), ext !== '.css');
    const lineAt = (idx) => code.slice(0, idx).split('\n').length;
    const specifiers = [], entities = [], seen = new Set();
    let m;

    const reAt = /@(use|forward|import|plugin)\b/g;
    while ((m = reAt.exec(code))) {
        let j = reAt.lastIndex, stmt = '';
        while (j < code.length && stmt.length < 600) {
            const ch = code[j];
            if (ch === ';' || ch === '{') break;
            if (ch === '\n' && !/,\s*$/.test(stmt)) break;
            stmt += ch;
            j++;
        }
        const found = [];
        const reStr = /"([^"]+)"|'([^']+)'|url\(\s*([^"')\s][^)]*?)\s*\)/gi;
        let s;
        while ((s = reStr.exec(stmt))) found.push(s[1] || s[2] || s[3]);
        if (m[1] !== 'import' && found.length) found.length = 1; // use/forward/plugin: только первый аргумент
        for (const f of found) specifiers.push(f);
    }

    const add = (name, kind, idx) => {
        if (seen.has(kind + name)) return;
        seen.add(kind + name);
        entities.push({name, kind, line: lineAt(idx)});
    };
    if (ext === '.scss' || ext === '.sass') {
        const reVar = /^[ \t]*(\$[\w-]+)\s*:/gm;
        while ((m = reVar.exec(code))) add(m[1], 'variable', m.index);
        const reDef = /@(mixin|function)\s+([\w-]+)/g;
        while ((m = reDef.exec(code))) add(m[2], m[1], m.index);
    }
    if (ext === '.less') {
        const reVar = /^[ \t]*(@[\w-]+)\s*:(?!:)/gm;
        while ((m = reVar.exec(code))) add(m[1], 'variable', m.index);
        const reMixin = /^[ \t]*(\.[\w-]+)\s*\([^)]*\)\s*(?:when\b[^{]*)?\{/gm;
        while ((m = reMixin.exec(code))) add(m[1], 'mixin', m.index);
    }
    const reProp = /(?:^|[;{\s])(--[\w-]+)\s*:/g;
    while ((m = reProp.exec(code))) add(m[1], 'custom-property', m.index);

    return {specifiers, entities, exports: [], reexportAll: false, loc: content.split('\n').length};
}

/**
 * Разбирает HTML: использование компонентов/директив/пайпов и подключённые стили (<link rel="stylesheet">).
 */
function parseHtml(content) {
    const code = stripHtmlComments(content.replace(/^\uFEFF/, ''));
    const fileRefs = [];
    const reLink = /<link\b[^>]*>/gi;
    let m;
    while ((m = reLink.exec(code))) {
        if (!/\brel\s*=\s*["']?stylesheet/i.test(m[0])) continue;
        const h = m[0].match(/\bhref\s*=\s*(?:"([^"]+)"|'([^']+)')/i);
        const href = h && (h[1] || h[2]);
        if (href && !/^(https?:|\/\/|data:|\{\{)/i.test(href)) fileRefs.push(href);
    }
    return {
        specifiers: [], fileRefs, usages: collectUsages(code),
        entities: [], exports: [], reexportAll: false, loc: content.split('\n').length
    };
}

// ---------- разбор TS ----------

/**
 * Первая '{' после from (строки пропускаются) или -1.
 */
function nextBrace(text, from) {
    let str = null;
    for (let i = from; i < text.length; i++) {
        const c = text[i];
        if (str) {
            if (c === '\\') i++;
            else if (c === str) str = null;
            continue;
        }
        if (c === '"' || c === "'" || c === '`') str = c;
        else if (c === '{') return i;
    }
    return -1;
}

/**
 * Закрывающая '{' из позиции open (строки пропускаются) или -1.
 */
function matchBrace(text, open) {
    let depth = 0, str = null;
    for (let i = open; i < text.length; i++) {
        const c = text[i];
        if (str) {
            if (c === '\\') i++;
            else if (c === str) str = null;
            continue;
        }
        if (c === '"' || c === "'" || c === '`') str = c;
        else if (c === '{') depth++;
        else if (c === '}') {
            depth--;
            if (depth === 0) return i;
        }
    }
    return -1;
}

/**
 * Члены тела класса/интерфейса (методы и свойства с номерами строк): куски до ';' на нулевой
 * глубине (свойства, абстрактные методы) либо до '}', закрывающего тело метода.
 * body/srcBody — срез тела по маске и по исходнику (одинаковые смещения), absBase — смещение
 * тела в полной маске файла; диапазоны членов считаются по полной маске (lib/ranges.js).
 */
function extractMembersTs(body, lineAt, absMask, absBase, srcBody) {
    const out = [];
    let start = -1, opened = false, str = null, depth = 0;
    const push = (end) => {
        if (start === -1) return;
        const raw = body.slice(start, end);
        const rawSrc = srcBody ? srcBody.slice(start, end) : raw;
        const line = lineAt(start);
        const absStart = absBase + start;
        start = -1;
        let t = raw.replace(/\s+/g, ' ').trim(), m;
        while ((m = t.match(/^(public|private|protected|static|readonly|abstract|override|async|declare|get|set)\s+/))) t = t.slice(m[0].length);
        let name = null, nameLen = 0;
        if ((m = t.match(/^([$_\p{ID_Start}][$\u200C\u200D\p{ID_Continue}]*)/u))) {
            name = m[1];
            nameLen = m[0].length;
        } else if ((m = t.match(/^(#[$_\p{ID_Start}][$\u200C\u200D\p{ID_Continue}]*)/u))) {
            name = m[1]; // имя с решёткой — так же, как в parseSymbols (private-method/property)
            nameLen = m[0].length;
        } else if (/^\[/.test(t)) {
            // computed-член: имя — содержимое скобок из исходника ([Symbol.iterator], ["prop"]);
            // index signature («[key: string]: T») членом не считается
            let d = 0, closeT = -1;
            for (let j = 0; j < t.length; j++) {
                if (t[j] === '[') d++;
                else if (t[j] === ']') {
                    d--;
                    if (!d) { closeT = j; break; }
                }
            }
            const src = rawSrc.trim();
            const open = src.indexOf('[');
            let sd = 0, closeS = -1;
            for (let j = open >= 0 ? open : 0; j < src.length; j++) {
                if (src[j] === '[') sd++;
                else if (src[j] === ']') {
                    sd--;
                    if (!sd) { closeS = j; break; }
                }
            }
            if (closeT !== -1 && closeS !== -1) {
                const inner = src.slice(open + 1, closeS).trim();
                if (inner && !inner.includes(':')) {
                    name = inner.replace(/^(['"`])|(['"`])$/g, '').replace(/\s+/g, ' ').trim();
                    nameLen = closeT + 1;
                }
            }
        }
        if (!name) return;
        const rest = t.slice(nameLen).replace(/^\s+/, '');
        const assignment = rest.indexOf('=');
        const isMethod = /^\??\(/.test(rest) || rest.startsWith('<')
            || (assignment >= 0 && isArrowExpression(rest.slice(assignment + 1)));
        const kind = name.startsWith('#') ? (isMethod ? 'private-method' : 'private-property') : (isMethod ? 'method' : 'property');
        const rangeKind = kind.startsWith('private-') ? kind.slice('private-'.length) : kind;
        // absMask/absStart — абсолютные; lineAt здесь относительный (от тела класса) — компенсируем
        const ranges = absMask ? entityRanges(absMask, absStart, rangeKind, (off) => lineAt(off - absBase)) : {};
        out.push({name, kind, line, ...ranges});
    };
    for (let i = 0; i < body.length; i++) {
        const c = body[i];
        if (start === -1) {
            if (/\s/.test(c)) continue;
            start = i;
        }
        if (str) {
            if (c === '\\') {
                i++;
                continue;
            }
            if (c === str) str = null;
            continue;
        }
        if (c === '"' || c === "'" || c === '`') {
            str = c;
            continue;
        }
        if (c === '{') {
            depth++;
            opened = true;
            continue;
        }
        if (c === '}') {
            depth--;
            if (depth === 0 && opened) {
                push(i + 1);
                opened = false;
            }
            continue;
        }
        if (c === ';' && !opened && depth === 0) push(i + 1);
    }
    if (start !== -1) push(body.length);
    return out;
}

/**
 * Разбирает содержимое TS/JS: импорты, экспорты, объявления с номерами строк
 * и диапазонами (lib/ranges.js), а для @Component — templateUrl, styleUrl(s)
 * и использование в inline-template.
 */
function parseTs(content, sourceType = 'ts', jsx = false) {
    content = content.replace(/^\uFEFF/, '');
    const specifiers = [], entities = [], exports = [], fileRefs = [];
    let reexportAll = false, templateUrl = null, usages = null, m;
    const decorated = new Set();
    const lineStarts = [0];
    for (let i = 0; i < content.length; i++) if (content[i] === '\n') lineStarts.push(i + 1);
    const lineAt = (idx) => {
        let lo = 0, hi = lineStarts.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (lineStarts[mid] <= idx) lo = mid;
            else hi = mid - 1;
        }
        return lo + 1;
    };
    const codeMask = sourceCodeMask(content);
    // отдельная JSX-aware маска для диапазонов объявлений (lib/ranges.js)
    const rmask = maskCode(content, jsx);

    // Импорты, реэкспорты, require и динамические import(); многострочные поддержаны.
    // Спецификаторы исходников хранятся объектами {m, line} для rdeps/deps why.
    const reImps = [
        /\bimport\s+[^;'"]*?from\s*['"]([^'"]+)['"]/g,
        /\bimport\s*['"]([^'"]+)['"]/g,
        /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
        /\bexport\s+[^;'"]*?from\s*['"]([^'"]+)['"]/g,
        /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g
    ];
    const seenSpecifiers = new Set();
    for (const re of reImps) while ((m = re.exec(content))) {
        if (!/[A-Za-z]/.test(codeMask[m.index])) continue;
        const key = m.index + ':' + m[1];
        if (seenSpecifiers.has(key)) continue;
        seenSpecifiers.add(key);
        specifiers.push({m: m[1], line: lineAt(m.index)});
    }
    if (/export\s*\*\s*from/.test(codeMask)) reexportAll = true;

    const reExp = /export\s*\{([^}]*)\}/g;
    while ((m = reExp.exec(codeMask)))
        for (const part of m[1].split(',')) {
            const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop().trim();
            if (name && name !== '*') exports.push(name);
        }

    const reDecl = /^[ \t]*(export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(class|interface|enum|type|function|const|let|var)\b\s*\*?\s*([$_\p{ID_Start}][$\u200C\u200D\p{ID_Continue}]*)/gmu;
    while (sourceType === 'ts' && (m = reDecl.exec(codeMask))) {
        const kind = m[2] === 'let' || m[2] === 'var' ? 'const' : m[2];
        entities.push({name: m[3], kind, line: lineAt(m.index + m[0].search(/\S/)),
            // диапазоны полного объявления и тела — только когда разбор надёжен
            ...entityRanges(rmask, m.index, kind, lineAt)});
        if (m[1]) exports.push(m[3]);
        // члены класса/интерфейса — для graph symbol по методам и свойствам
        if (kind === 'class' || kind === 'interface') {
            const brace = nextBrace(codeMask, m.index + m[0].length);
            if (brace !== -1) {
                const close = matchBrace(codeMask, brace);
                if (close !== -1)
                    entities[entities.length - 1].members =
                        extractMembersTs(codeMask.slice(brace + 1, close), (off) => lineAt(brace + 1 + off),
                            rmask, brace + 1, content.slice(brace + 1, close));
            }
        }
    }

    if (sourceType === 'js') {
        const symbols = parseSymbols(content, jsx).map((s) => ({...s, name: s.name.replace(/\(.*$/, '')}));
        const declarations = new Set(symbols.filter((s) => !s.owner && s.kind !== 'export').map((s) => s.name));
        const seen = new Set();
        for (const {owner, offset, ...symbol} of symbols) {
            if (owner) continue;
            if (symbol.kind === 'export') {
                exports.push(symbol.name);
                if (declarations.has(symbol.name)) continue;
            }
            const key = symbol.kind + ':' + symbol.name + ':' + symbol.line;
            if (seen.has(key)) continue;
            seen.add(key);
            entities.push(symbol);
        }
        for (const {owner, offset, ...member} of symbols) {
            if (!owner) continue;
            const entity = entities.find((e) => e.kind === 'class' && e.name === owner);
            if (entity) (entity.members = entity.members || []).push(member);
        }
    }

    // Angular-декораторы: вид сущности, selector / имя пайпа, шаблон и стили
    const reNg = /@(Component|Directive|Pipe|Injectable|NgModule)\s*\(([\s\S]{0,30000}?)\)\s*(?:export\s+)?(?:abstract\s+)?class\s+([$_\p{ID_Start}][$\u200C\u200D\p{ID_Continue}]*)/gu;
    while ((m = reNg.exec(content))) {
        if (codeMask[m.index] !== '@') continue;
        const body = m[2];
        // members собраны в reDecl-сущности «class» — переносим: дедупликация ниже оставит только эту
        const prev = entities.find((e) => e.name === m[3] && e.kind === 'class');
        // диапазоны не теряются при замене class-entity на Angular-entity: считаем от ключевого слова class
        let clsStart = -1;
        const reCls = /\bclass\b/g;
        let mc;
        while ((mc = reCls.exec(m[0]))) clsStart = m.index + mc.index;
        const entity = {name: m[3], kind: NG_KINDS[m[1]], line: lineAt(m.index),
            ...(clsStart !== -1 ? entityRanges(rmask, clsStart, 'class', lineAt) : {}),
            ...(prev && prev.members ? {members: prev.members} : {})};
        const sel = body.match(/\bselector\s*:\s*['"`]([^'"`]+)['"`]/);
        if (sel) entity.selector = sel[1];
        if (m[1] === 'Pipe') {
            const pn = body.match(/\bname\s*:\s*['"`]([^'"`]+)['"`]/);
            if (pn) entity.pipeName = pn[1];
        }
        if (m[1] === 'Component') {
            const tu = body.match(/\btemplateUrl\s*:\s*(['"`])([^'"`\n]+)\1/);
            if (tu) templateUrl = tu[2];
            const su = body.match(/\bstyleUrl\s*:\s*(['"`])([^'"`\n]+)\1/);
            if (su) fileRefs.push(su[2]);
            const sus = body.match(/\bstyleUrls\s*:\s*\[([^\]]*)\]/);
            if (sus) for (const q of sus[1].matchAll(/['"`]([^'"`\n]+)['"`]/g)) fileRefs.push(q[1]);
            const inl = body.match(/\btemplate\s*:\s*(`(?:\\[\s\S]|[^`\\])*`|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*")/);
            if (inl) usages = mergeUsages(usages, collectUsages(inl[1].slice(1, -1)));
        }
        entities.push(entity);
        exports.push(m[3]);
        decorated.add(m[3]);
    }
    // у декорированного класса оставляем одну запись (component/directive/…), без дубля «class»
    const uniqEntities = entities.filter((e) => !(e.kind === 'class' && decorated.has(e.name)));

    return {
        specifiers: [...new Set(specifiers)],
        entities: uniqEntities,
        exports: [...new Set(exports)],
        reexportAll,
        loc: content.split('\n').length,
        ...(templateUrl ? {templateUrl} : {}),
        ...(fileRefs.length ? {fileRefs} : {}),
        ...(usages ? {usages} : {})
    };
}

function parseFile(content, rel) {
    const type = fileType(rel);
    if (type === 'html') return parseHtml(content);
    if (type === 'style') return parseStyle(content, rel);
    return parseTs(content, type, /\.(tsx|jsx)$/i.test(rel));
}

// ---------- резолвинг ссылок ----------

const pathKey = file => process.platform === 'win32' ? file.toLowerCase() : file;

function jsonResourceExists(file) {
    if (!insideProject(file)) return false;
    try {
        const root = fs.realpathSync(cwd);
        const real = fs.realpathSync(file);
        const rel = path.relative(root, real);
        return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel) && fs.statSync(real).isFile();
    } catch (e) { return false; }
}

/**
 * Превращает спецификатор TS-импорта в файл проекта либо имя внешнего пакета.
 * Импорты ресурсов ('./x.scss?inline', './x.html') резолвятся по точному пути.
 */
function resolveSpec(spec, fromAbs, fileSet, alias, resources) {
    const isJson = JSON_RESOURCE_EXT.test(spec);
    if (isJson || ASSET_EXT.test(spec)) spec = spec.replace(/[?#].*$/, '');
    let bases, baseUrlFallback = false;
    if (spec.startsWith('.') || path.isAbsolute(spec)) bases = [path.resolve(path.dirname(fromAbs), spec)];
    else {
        const hits = alias ? alias(spec) : null;
        baseUrlFallback = !hits && !!(alias && alias.baseUrl);
        if (!hits && !baseUrlFallback) return {external: spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]};
        bases = hits || [path.resolve(alias.baseUrl, spec)];
    }
    for (const b of bases) {
        if (isJson) {
            const exists = jsonResourceExists(b);
            if (resources && insideProject(b)) resources[toPosix(b)] = exists;
            if (exists) return {resource: b};
            continue;
        }
        const js = [b + '.js', b + '.jsx', path.join(b, 'index.js'), path.join(b, 'index.jsx')];
        const ts = [b + '.ts', b + '.tsx', path.join(b, 'index.ts'), path.join(b, 'index.tsx')];
        const modules = [b + '.mjs', b + '.cjs', path.join(b, 'index.mjs'), path.join(b, 'index.cjs')];
        const source = /\.js$/i.test(b) ? [b.slice(0, -3) + '.ts', b.slice(0, -3) + '.tsx'] : [];
        const candidates = fileType(fromAbs) === 'js'
            ? [b, ...source, ...js, ...ts, ...modules]
            : [...source, b, ...ts, ...js, ...modules];
        for (const v of candidates) if (fileSet.has(pathKey(v))) return {file: fileSet.get(pathKey(v))};
    }
    if (baseUrlFallback) return {external: spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]};
    return null;
}

/**
 * Расширения, которые импортёр может подтянуть без указания расширения (Sass не подключает .less и наоборот).
 */
function styleFamily(fromAbs) {
    const e = path.extname(fromAbs).toLowerCase();
    if (e === '.less') return ['.less', '.css'];
    if (e === '.css') return ['.css'];
    return ['.scss', '.sass', '.css'];
}

/**
 * Кандидаты файла стиля для базового пути: расширения, партиалы (_name) и index.
 */
function styleCandidates(base, exts) {
    const dir = path.dirname(base), name = path.basename(base);
    const out = [];
    if (/\.(css|scss|sass|less)$/i.test(name)) out.push(base, path.join(dir, '_' + name));
    else for (const e of exts) out.push(path.join(dir, '_' + name + e), path.join(dir, name + e));
    for (const e of exts) out.push(path.join(base, '_index' + e), path.join(base, 'index' + e));
    return out;
}

/**
 * Резолвит @use/@import: относительно файла, затем includePaths из angular.json;
 * пакеты (@angular/material, ~pkg, папка в node_modules) — в external.
 */
function resolveStyleSpec(spec, fromAbs, fileSet, includePaths) {
    let s = spec.trim().replace(/[?#].*$/, '');
    if (!s || /^(https?:|data:|sass:|\/\/)/i.test(s)) return null;
    const tilde = s.startsWith('~');
    if (tilde) s = s.slice(1);
    const bases = [];
    if (!tilde) bases.push(path.resolve(path.dirname(fromAbs), s));
    if (!s.startsWith('.')) {
        for (const ip of includePaths) bases.push(path.resolve(ip, s));
        if (tilde) bases.push(path.resolve(cwd, s));
    }
    for (const b of bases)
        for (const v of styleCandidates(b, styleFamily(fromAbs))) if (fileSet.has(pathKey(v))) return {file: fileSet.get(pathKey(v))};
    if (s.startsWith('.') || s.startsWith('/')) return null;
    const pkg = s.startsWith('@') ? s.split('/').slice(0, 2).join('/') : s.split('/')[0];
    if (tilde || s.startsWith('@') || fs.existsSync(path.join(cwd, 'node_modules', pkg))) return {external: pkg};
    return null;
}

/**
 * Резолвит ссылку на ресурс (templateUrl, styleUrls, <link href>) по точному пути: от файла, затем от корня src.
 */
function resolveFileRef(ref, fromAbs, fileSet) {
    const clean = ref.replace(/[?#].*$/, '');
    if (!clean || /^(https?:|data:|\/)/i.test(clean)) return null;
    for (const b of [path.resolve(path.dirname(fromAbs), clean), path.resolve(ROOT, clean)])
        if (fileSet.has(pathKey(b))) return fileSet.get(pathKey(b));
    return null;
}

/**
 * Главный "род" узла: component > directive > pipe > injectable > ngmodule > class > barrel.
 */
function nodeKind(n) {
    let best = null, pri = -1;
    for (const e of n.entities) {
        const p = KIND_PRI[e.kind] || 0;
        if (p > pri) {
            pri = p;
            best = e.kind;
        }
    }
    if (best) return best;
    if (n.reexportAll) return 'barrel';
    return n.entities.length ? n.entities[0].kind : 'file';
}

/**
 * Циклические группы — алгоритм Тарьяна.
 */
function tarjan(nodes) {
    const n = nodes.length;
    const idx = new Array(n + 1).fill(-1), low = new Array(n + 1).fill(0), on = new Array(n + 1).fill(false);
    const stack = [], sccs = [];
    let cnt = 0;
    for (let root = 1; root <= n; root++) {
        if (idx[root] >= 0) continue;
        const frames = [{id: root, next: 0}];
        idx[root] = low[root] = cnt++;
        stack.push(root);
        on[root] = true;
        while (frames.length) {
            const frame = frames[frames.length - 1], v = frame.id;
            const imports = nodes[v - 1].imports;
            if (frame.next < imports.length) {
                const w = imports[frame.next++];
                if (idx[w] < 0) {
                    idx[w] = low[w] = cnt++;
                    stack.push(w);
                    on[w] = true;
                    frames.push({id: w, next: 0});
                } else if (on[w]) low[v] = Math.min(low[v], idx[w]);
                continue;
            }
            frames.pop();
            if (low[v] === idx[v]) {
                const comp = [];
                let w;
                do {
                    w = stack.pop();
                    on[w] = false;
                    comp.push(w);
                } while (w !== v);
                if (comp.length > 1) sccs.push(comp.map(id => nodes[id - 1].path).sort());
            }
            if (frames.length) {
                const parent = frames[frames.length - 1].id;
                low[parent] = Math.min(low[parent], low[v]);
            }
        }
    }
    return sccs;
}

/**
 * Строит граф с инкрементальным кэшем (парсятся только изменённые файлы).
 */
function validParsedData(data, type) {
    if (!data || typeof data !== 'object' || !Array.isArray(data.entities) || !Array.isArray(data.exports)
        || !data.exports.every(name => typeof name === 'string')
        || !Array.isArray(data.specifiers) || !Number.isInteger(data.loc) || data.loc < 1
        || typeof data.reexportAll !== 'boolean') return false;
    // диапазоны — положительные целые в пределах loc, конец ≥ начала; рекурсивно для members
    const validRange = (e) => {
        const chk = (a, b) => (a == null || (Number.isInteger(a) && a > 0 && a <= data.loc))
            && (b == null || (Number.isInteger(b) && b > 0 && b <= data.loc && (a == null || b >= a)));
        if (!chk(e.startLine, e.endLine) || !chk(e.bodyStartLine, e.bodyEndLine)) return false;
        if (e.bodyStartLine != null && e.startLine != null && e.bodyStartLine < e.startLine) return false;
        if (e.bodyEndLine != null && e.endLine != null && e.bodyEndLine > e.endLine) return false;
        return true;
    };
    const validEntity = (e) => e && typeof e.name === 'string' && typeof e.kind === 'string'
        && Number.isInteger(e.line) && e.line > 0 && validRange(e)
        && (!Array.isArray(e.members) || e.members.every(mm => mm && typeof mm.name === 'string'
            && typeof mm.kind === 'string' && Number.isInteger(mm.line) && mm.line > 0 && validRange(mm)));
    if (!data.entities.every(validEntity)) return false;
    if (!data.specifiers.every(s => type === 'ts' || type === 'js'
        ? s && typeof s.m === 'string' && Number.isInteger(s.line) && s.line > 0
        : typeof s === 'string')) return false;
    if (has(data, 'fileRefs') && (!Array.isArray(data.fileRefs) || !data.fileRefs.every(ref => typeof ref === 'string'))) return false;
    if (has(data, 'templateUrl') && typeof data.templateUrl !== 'string') return false;
    return type !== 'html' || (Array.isArray(data.fileRefs) && data.usages
        && Array.isArray(data.usages.els) && Array.isArray(data.usages.pipes));
}

function buildGraph(files, inputs = graphInputs()) {
    const t0 = Date.now();
    files = (files || collectAll()).sort();
    if (!files.length) throw new OpError('Не найдено TS/JS/HTML/стилей в ' + ROOT_ARG);

    const fileSet = new Map(files.map(file => [pathKey(file), file]));
    const resources = Object.create(null);
    const alias = inputs.alias;
    const includePaths = loadStyleIncludePaths();
    let cache = {};
    try {
        cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    } catch (e) {
    }
    if (!cache || typeof cache !== 'object' || cache.__v !== GRAPH_VERSION) cache = {};
    const newCache = {__v: GRAPH_VERSION};
    let reparsed = 0;

    const nodes = files.map((f, i) => {
        const rel = toPosix(f);
        const st = statOf(f);
        const c = cache[rel];
        let data;
        if (c && c.mtime === st.mtimeMs && c.size === st.size && validParsedData(c.data, fileType(f))) data = c.data;
        else {
            data = parseFile(fs.readFileSync(f, 'utf8'), rel);
            reparsed++;
        }
        newCache[rel] = {mtime: st.mtimeMs, size: st.size, data};
        return {id: i + 1, path: rel, ...data};
    });
    const idByAbs = new Map(files.map((f, i) => [f, i + 1]));

    // 1. Явные ссылки: импорты, @use/@import, templateUrl/styleUrls, <link>
    const externals = new Set();
    const ownerOfTemplate = new Map(); // id html → id компонента-владельца
    for (const n of nodes) {
        n.imports = [];
        n.external = [];
        n.unresolved = [];
        const abs = path.join(cwd, n.path);
        const type = fileType(n.path);
        for (const spec of n.specifiers || []) {
            // ts-спецификаторы приходят объектами {m, line}; стили — строками
            const isObj = spec && typeof spec === 'object';
            const s = isObj ? spec.m : spec;
            const r = type === 'style' ? resolveStyleSpec(s, abs, fileSet, includePaths) : resolveSpec(s, abs, fileSet, alias, resources);
            if (r && r.resource) continue;
            if (r && r.file) {
                const id = idByAbs.get(r.file);
                n.imports.push(id);
                if (isObj && (type === 'ts' || type === 'js'))
                    (n.importPairs = n.importPairs || []).push([id, spec.line]);
            } else if (r && r.external) {
                n.external.push(r.external);
                externals.add(r.external);
            } else if ((type === 'ts' || type === 'js')
                || (type === 'style' && !/^(https?:|data:|sass:|\/\/)/i.test(s.trim()))) {
                n.unresolved.push(s);
            }
        }
        if (n.templateUrl) {
            const f = resolveFileRef(n.templateUrl, abs, fileSet);
            if (f) {
                n.imports.push(idByAbs.get(f));
                ownerOfTemplate.set(idByAbs.get(f), n.id);
            } else if (!/^(https?:|data:|\/)/i.test(n.templateUrl)) n.unresolved.push(n.templateUrl);
        }
        for (const ref of n.fileRefs || []) {
            const f = resolveFileRef(ref, abs, fileSet);
            if (f) n.imports.push(idByAbs.get(f));
            else if (!/^(https?:|data:|\/)/i.test(ref)) n.unresolved.push(ref);
        }
    }

    // 2. Индексы символов, селекторов и пайпов
    const symbols = Object.create(null), selectors = Object.create(null);
    const selectorFiles = new Map();
    const byTag = new Map(), byAttr = new Map(), byClass = new Map(), pipes = new Map();
    const put = (map, key, val) => {
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(val);
    };
    for (const n of nodes) {
        for (const e of n.entities) {
            (symbols[e.name] = symbols[e.name] || []).push(n.id);
            if (e.pipeName) {
                (symbols[e.pipeName] = symbols[e.pipeName] || []).push(n.id);
                put(pipes, e.pipeName, n.id);
            }
            if (e.selector) {
                selectors[e.selector] = n.id;
                if (!selectorFiles.has(e.selector)) selectorFiles.set(e.selector, new Set());
                selectorFiles.get(e.selector).add(n.path);
                for (const part of parseSelector(e.selector)) {
                    const p = {...part, id: n.id};
                    if (part.tag) put(byTag, part.tag, p);
                    else if (part.attrs.length) put(byAttr, part.attrs[0], p);
                    else put(byClass, part.classes[0], p);
                }
            }
        }
        for (const ex of n.exports) if (!symbols[ex]) symbols[ex] = [n.id];
    }

    // 3. Использование в шаблонах (html и inline-template): шаблон → компонент/директива/пайп
    for (const n of nodes) {
        if (!n.usages) continue;
        const targets = new Set();
        for (const el of n.usages.els) {
            const cand = new Set(byTag.get(el.t) || []);
            for (const a of el.a) for (const p of byAttr.get(a) || []) cand.add(p);
            for (const c of el.c) for (const p of byClass.get(c) || []) cand.add(p);
            for (const p of cand) if (partMatches(p, el)) targets.add(p.id);
        }
        for (const name of n.usages.pipes) for (const id of pipes.get(name) || []) targets.add(id);
        const owner = ownerOfTemplate.get(n.id);
        // самого себя (рекурсивный компонент) и владельца шаблона не добавляем — иначе ts↔html даёт ложный цикл
        for (const t of targets) if (t !== n.id && t !== owner) n.imports.push(t);
    }

    // 4. Уборка временных полей, виды узлов
    const byKind = {};
    for (const n of nodes) {
        n.imports = [...new Set(n.imports)].sort((a, b) => a - b);
        n.external = [...new Set(n.external)].sort();
        n.unresolved = [...new Set(n.unresolved)].sort();
        // линия импорта для rdeps/deps --why: id → минимальный номер строки
        if (n.importPairs) {
            n.importLines = {};
            for (const [id, ln] of n.importPairs)
                if (!(id in n.importLines) || ln < n.importLines[id]) n.importLines[id] = ln;
        }
        for (const k of ['specifiers', 'fileRefs', 'templateUrl', 'usages', 'importPairs']) delete n[k];
        const type = fileType(n.path);
        n.kind = type === 'html' ? 'template' : type === 'style' ? 'style' : nodeKind(n);
        byKind[n.kind] = (byKind[n.kind] || 0) + 1;
    }

    const duplicateSelectors = [...selectorFiles].filter(([, files]) => files.size > 1)
        .map(([selector, files]) => ({selector, files: [...files]}));
    const cycles = tarjan(nodes);
    const graph = {
        version: GRAPH_VERSION,
        root: ROOT_ARG,
        inputs: inputs.manifest,
        resources,
        sourceStats: Object.fromEntries(files.map(f => [toPosix(f), {mtime: statOf(f).mtimeMs, size: statOf(f).size}])),
        configIssues: [...configIssues],
        files: nodes,
        symbols, selectors, duplicateSelectors,
        externals: [...externals].sort(),
        cycles,
        stats: {
            files: nodes.length,
            byKind,
            edges: nodes.reduce((s, n) => s + n.imports.length, 0),
            externalPackages: externals.size,
            unresolved: nodes.reduce((s, n) => s + n.unresolved.length, 0),
            cycles: cycles.length
        }
    };
    try {
        fs.writeFileSync(GRAPH_FILE, JSON.stringify(graph));
        fs.writeFileSync(CACHE_FILE, JSON.stringify(newCache));
    } catch (e) {
        graph.cacheIssue = 'cache-write-failed';
    }
    return {graph, reparsed, ms: Date.now() - t0};
}

/**
 * Отдаёт актуальный граф: при добавлении/удалении/переименовании/изменении файлов
 * (а также angular.json и tsconfig.json) перестраивает сам.
 */
function ensureGraph() {
    let graph = null;
    try {
        graph = JSON.parse(fs.readFileSync(GRAPH_FILE, 'utf8'));
    } catch (e) {
    }
    const files = collectAll();
    const inputs = graphInputs();
    let stale = !graph || graph.version !== GRAPH_VERSION
        || !Array.isArray(graph.files) || !graph.files.every((f, i) => f && f.id === i + 1 && typeof f.path === 'string'
            && Array.isArray(f.imports) && f.imports.every(id => Number.isInteger(id) && id > 0 && id <= graph.files.length)
            && Array.isArray(f.entities) && Array.isArray(f.unresolved) && Array.isArray(f.external))
        || !graph.symbols || !graph.selectors || !graph.stats || !Array.isArray(graph.cycles)
        || JSON.stringify(graph.inputs) !== JSON.stringify(inputs.manifest)
        || files.length !== graph.files.length;
    if (!stale) {
        const known = new Set(graph.files.map(f => f.path));
        stale = files.some(f => !known.has(toPosix(f)));
    }
    if (!stale) stale = files.some(f => {
        const old = graph.sourceStats && graph.sourceStats[toPosix(f)];
        const st = statOf(f);
        return !old || old.mtime !== st.mtimeMs || old.size !== st.size;
    });
    if (!stale) stale = !graph.resources || typeof graph.resources !== 'object'
        || Object.entries(graph.resources).some(([file, exists]) => typeof exists !== 'boolean'
            || jsonResourceExists(path.resolve(cwd, file)) !== exists);
    return stale ? buildGraph(files, inputs) : {graph, reparsed: 0};
}

/**
 * Ищет узел по id / пути / имени файла; при неоднозначности — список кандидатов.
 * Запрос без расширения («profile.component») предпочитает .ts-файл его html/стилям-соседям.
 */
function findNode(graph, q) {
    const original = String(q);
    q = original.replace(/\\/g, '/');
    if (q.includes('/') || path.isAbsolute(q) || /^[a-z]:/i.test(q) || q === '.' || q === '..') {
        const abs = path.resolve(cwd, q);
        const rel = path.relative(cwd, abs);
        if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)
            || (process.platform !== 'win32' && /^[a-z]:/i.test(q)))
            return {error: 'Путь вне рабочей директории запрещён: ' + original};
        const exact = toPosix(abs);
        const matches = graph.files.filter(f => process.platform === 'win32'
            ? f.path.toLowerCase() === exact.toLowerCase() : f.path === exact);
        return matches.length === 1 ? {node: matches[0]} : {error: 'Точный путь не найден в графе: ' + original};
    }
    if (/^\d+$/.test(q)) {
        const byId = graph.files.find((f) => f.id === +q);
        if (byId) return {node: byId};
    }
    const qs = q.toLowerCase();
    const isCode = (f) => f.kind !== 'template' && f.kind !== 'style';
    let list = graph.files.filter((f) => f.path === q || f.path.endsWith('/' + q));
    if (!list.length) list = graph.files.filter((f) => f.path.toLowerCase() === qs || f.path.toLowerCase().endsWith('/' + qs));
    if (!list.length) {
        const qbase = path.posix.basename(qs).replace(KNOWN_EXT, '');
        list = graph.files.filter((f) => {
            const b = path.posix.basename(f.path.toLowerCase());
            return b === qs || b.replace(KNOWN_EXT, '') === qbase;
        });
    }
    if (!list.length) list = graph.files.filter((f) => f.path.toLowerCase().includes(qs));
    if (!list.length) return {error: 'Файл не найден в графе: ' + q};
    if (list.length > 1 && !KNOWN_EXT.test(q)) {
        const code = list.filter(isCode);
        if (code.length === 1) list = code;
    }
    if (list.length > 1) return {ambiguous: list.slice(0, 15).map((f) => f.path + ' [' + f.kind + ']')};
    return {node: list[0]};
}

function selectorWarnings(graph, selector) {
    return (graph.duplicateSelectors || []).filter(item => !selector || item.selector === selector).slice(0, 5)
        .map(item => 'Дубликат селектора ' + item.selector + ': ' + item.files.slice(0, 5).join(', ')
            + (item.files.length > 5 ? ' (ещё ' + (item.files.length - 5) + ')' : ''));
}

/**
 * Диапазонные поля сущности/члена (только реально определённые).
 */
function rangeOf(e) {
    const r = {};
    if (!e) return r;
    for (const k of ['startLine', 'endLine', 'bodyStartLine', 'bodyEndLine'])
        if (e[k] != null) r[k] = e[k];
    return r;
}

function structuralStatus(graph, truncated = 0, extra = []) {
    const unresolved = graph.files.flatMap(f => f.unresolved.map(specifier => ({file: f.path, specifier})));
    const reasons = [...new Set([
        ...(unresolved.length ? ['unresolved-imports'] : []),
        ...(scanExcluded.size ? ['excluded-source-files'] : []),
        ...(graph.duplicateSelectors && graph.duplicateSelectors.length ? ['duplicate-selectors'] : []),
        ...scanIssues, ...configIssues, ...(graph.configIssues || []),
        ...(graph.cacheIssue ? [graph.cacheIssue] : []), ...extra
    ])];
    const samples = [...unresolved, ...[...scanExcluded].map(file => ({file, reason: 'excluded-source'}))];
    return {scope: {root: cwd, scanRoot: toPosix(ROOT) || '.', specs: SPECS},
        completeness: {complete: reasons.length === 0 && truncated === 0,
            ...(reasons.length ? {reasons: reasons.slice(0, 5), ...(reasons.length > 5 ? {reasonsTruncated: reasons.length - 5} : {})} : {}),
            ...(samples.length ? {samples: samples.slice(0, 5), ...(samples.length > 5 ? {samplesTruncated: samples.length - 5} : {})} : {}),
            ...(truncated ? {truncated} : {})}};
}

function unresolvedSummary(node) {
    return node.unresolved.length ? {unresolvedPaths: node.unresolved.slice(0, 5),
        ...(node.unresolved.length > 5 ? {unresolvedPathsTruncated: node.unresolved.length - 5} : {})} : {};
}

// ---------- op=read: точное чтение диапазонов ----------

const MAX_READ_LINES = 2000; // суммарный лимит строк за запрос: отказ, а не молчаливая усечка

/**
 * Читает диапазоны строк одного файла одним ответом: перекрытия и вплотную соседние
 * диапазоны объединяются, промежуток с зазором — нет (лишний source text не добавляется).
 * Полный текст строк без обрезки; контракт line-блоков: BOM снят, EOL нормализованы в \n.
 * Пути проверяются лексически и по realpath; диапазоны сверяются с фактическим файлом,
 * а не с координатами кэша графа.
 */
function readRanges(params) {
    const fileArg = String(params.file || '');
    if (!fileArg) return {error: 'Укажите payload.file'};
    const abs = path.resolve(cwd, fileArg);
    const rel = path.relative(cwd, abs);
    if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel))
        return {error: 'Путь вне рабочей директории запрещён: ' + fileArg};
    let real;
    try {
        real = fs.realpathSync(abs);
    } catch (e) {
        return {error: 'Файл не найден: ' + fileArg};
    }
    const relReal = path.relative(cwd, real);
    if (relReal === '..' || relReal.startsWith('..' + path.sep) || path.isAbsolute(relReal))
        return {error: 'Путь вне рабочей директории запрещён: ' + fileArg};
    let rangesArg = params.ranges;
    if (typeof rangesArg === 'string') rangesArg = rangesArg.split(',').map((s) => s.trim()).filter(Boolean);
    if (!Array.isArray(rangesArg) || !rangesArg.length)
        return {error: 'Укажите ranges: 10-20,30-40 либо массив [[10,20],[30,40]] (1-based, включительно)'};
    const parsed = [];
    for (const item of rangesArg) {
        let a, b;
        if (Array.isArray(item)) [a, b] = item;
        else {
            const m = String(item).trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
            if (!m) return {error: 'Некорректный диапазон: ' + JSON.stringify(item)};
            a = Number(m[1]);
            b = m[2] === undefined ? a : Number(m[2]);
        }
        if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < a)
            return {error: 'Некорректный диапазон: ' + JSON.stringify(item) + ' (1-based, конец ≥ начала)'};
        parsed.push([a, b]);
    }
    parsed.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    const merged = [];
    for (const [a, b] of parsed) {
        const last = merged[merged.length - 1];
        if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
        else merged.push([a, b]);
    }
    let text;
    try {
        text = fs.readFileSync(real, 'utf8');
    } catch (e) {
        return {error: 'Файл не найден: ' + fileArg};
    }
    const lines = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
    const loc = lines.length - (lines[lines.length - 1] === '' ? 1 : 0);
    for (const [a, b] of merged)
        if (b > loc) return {error: 'Диапазон ' + a + '-' + b + ' за пределами файла (' + loc + ' строк); сверитесь с источником, не с кэшем графа'};
    const total = merged.reduce((s, [a, b]) => s + (b - a + 1), 0);
    if (total > MAX_READ_LINES)
        return {error: 'Запрошено ' + total + ' строк (максимум ' + MAX_READ_LINES + ') — разбейте чтение на несколько запросов'};
    return {
        file: toPosix(real),
        loc,
        blocks: merged.map(([a, b]) => ({startLine: a, endLine: b, lines: lines.slice(a - 1, b)}))
    };
}

function reverseIndex(graph) {
    const rev = new Map();
    for (const f of graph.files)
        for (const t of f.imports) {
            if (!rev.has(t)) rev.set(t, []);
            rev.get(t).push(f.id);
        }
    return rev;
}

/**
 * BFS по графу до depth: список {file, kind, level} без повторов.
 * why=true добавляет via — номер строки импорта этого ребра (для ts-связей).
 */
function walk(graph, startId, depth, reverse, why) {
    const rev = reverse ? reverseIndex(graph) : null;
    const children = (id) => (reverse ? rev.get(id) || [] : graph.files[id - 1].imports);
    const seen = new Set([startId]);
    const frontier = [[startId, 0]];
    const out = [];
    while (frontier.length) {
        const [id, d] = frontier.shift();
        if (d >= depth) continue;
        for (const c of children(id)) {
            if (seen.has(c)) continue;
            seen.add(c);
            const f = graph.files[c - 1];
            const lines = why
                ? (reverse ? graph.files[c - 1].importLines : graph.files[id - 1].importLines) || {}
                : {};
            const ln = why ? lines[reverse ? id : c] : null;
            out.push({file: f.path, kind: f.kind, level: d + 1, ...(ln ? {via: 'L' + ln} : {})});
            frontier.push([c, d + 1]);
        }
    }
    return out;
}


// ---------- обработчики операций ----------
// Каждый обработчик возвращает payload ответа или бросает OpError (ошибка запроса).
// Это позволяет batch-режиму выполнять запросы без process.exit внутри элемента.

const BATCH_OPS = ['info', 'node', 'deps', 'rdeps', 'symbol', 'selector', 'path', 'cycles', 'stats', 'read'];

function opStats(g) {
    const rev = reverseIndex(g);
    return {
        ...g.stats,
        topImported: g.files
            .map((f) => ({file: f.path, kind: f.kind, importers: (rev.get(f.id) || []).length}))
            .sort((a, b) => b.importers - a.importers).slice(0, 10)
    };
}

function opInfo(g) {
    // Паспорт проекта одним вызовом вместо чтения package.json/tsconfig/angular.json вручную.
    const readJson = (name) => {
        try {
            return JSON.parse(fs.readFileSync(path.join(cwd, name), 'utf8'));
        } catch (e) {
            return null;
        }
    };
    const warnings = selectorWarnings(g);
    const pkg = readJson('package.json');
    if (!pkg) warnings.push('package.json не найден в ' + cwd);
    if (pkg && !fs.existsSync(path.join(cwd, 'node_modules'))) warnings.push('node_modules не найден — выполните npm install');
    const deps = {...(pkg && pkg.dependencies || {}), ...(pkg && pkg.devDependencies || {})};
    const KEY_DEPS = ['@angular/core', '@angular/cli', '@angular/material', '@angular/cdk', 'typescript', 'rxjs', 'zone.js',
        '@ngrx/store', '@ngrx/effects', '@ngrx/component-store', 'jest', 'karma', 'cypress', 'playwright', 'eslint', 'prettier',
        'react', 'react-dom', 'next',
        '@nestjs/core', '@nestjs/common', 'express', 'fastify', 'koa', '@hapi/hapi'];
    const key = {};
    for (const k of KEY_DEPS) if (deps[k]) key[k] = deps[k];
    const shown = new Set(Object.keys(key));
    const others = Object.keys(deps).filter((k) => !shown.has(k)).sort();
    const pm = [['package-lock.json', 'npm'], ['yarn.lock', 'yarn'], ['pnpm-lock.yaml', 'pnpm']]
        .find(([f]) => fs.existsSync(path.join(cwd, f)));
    let tc = null;
    try {
        tc = parseJsonc(fs.readFileSync(path.join(cwd, 'tsconfig.json'), 'utf8')).compilerOptions || {};
    } catch (e) { /* нет или не разобран — будет предупреждение */
    }
    if (!tc) warnings.push('tsconfig.json не найден или не разобран');
    const paths = tc && tc.paths ? Object.keys(tc.paths).slice(0, 10) : [];
    const aj = ['angular.json', '.angular.json'].some((f) => fs.existsSync(path.join(cwd, f)));
    // Тип проекта: angular | react | nest | node | ts — от него зависит, какой набор правил скилла применяет агент.
    const hasDep = (k) => !!deps[k];
    const serverDep = ['express', 'fastify', 'koa', '@hapi/hapi'].find(hasDep) || null;
    // react-пакет ищем во всех 4 секциях package.json (как isReact в lib/files.js); react-dom/next сами тип не задают.
    const reactSpec = pkg
        ? ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
            .map((k) => pkg[k] && pkg[k].react).find(Boolean) || null
        : null;
    const reactMajor = reactSpec ? parseReactMajor(reactSpec) : null;
    const reactDetected = !!reactSpec && (reactMajor === null || reactMajor >= 16);
    const projectType = (aj || hasDep('@angular/core')) ? 'angular'
        : reactDetected ? 'react'
            : Object.keys(deps).some((k) => k.startsWith('@nestjs/')) ? 'nest'
                : serverDep ? 'node' : 'ts';
    if (projectType === 'angular' && !aj)
        warnings.push('angular.json не найден: @angular/core есть в зависимостях, но CLI-конфига нет (workspace-пакет?)');
    if (reactSpec && reactMajor !== null && reactMajor < 16)
        warnings.push('react ' + reactSpec + ': поддерживается react >= 16, projectType=react не устанавливается');
    if (reactSpec && reactMajor === null)
        warnings.push('версия react (' + reactSpec + ') не распознана — projectType=react установлен по присутствию пакета');
    let gi = '';
    try {
        gi = fs.readFileSync(path.join(cwd, '.gitignore'), 'utf8');
    } catch (e) { /* нет .gitignore */
    }
    for (const f of ['graph-deps.json', '.graph-deps-cache.json'])
        if (!gi.includes(f)) warnings.push(f + ' не в .gitignore — добавь');
    const largest = [...g.files].sort((a, b) => (b.loc || 0) - (a.loc || 0)).slice(0, 10)
        .map((f) => ({file: f.path, kind: f.kind, loc: f.loc}));
    return {
        ...(pkg ? {project: {name: pkg.name || null, version: pkg.version || null}} : {}),
        ...(pm ? {packageManager: pm[1]} : {}),
        projectType,
        ...(projectType === 'node' ? {server: serverDep} : {}),
        keyDeps: key,
        otherDeps: {count: others.length, ...(others.length ? {names: others.slice(0, 15)} : {})},
        tsconfig: {strict: tc ? !!tc.strict : null, ...(tc && tc.target ? {target: tc.target} : {}), ...(paths.length ? {paths} : {})},
        ...(projectType === 'angular' ? {angularJson: aj} : {}),
        stats: g.stats,
        largest,
        ...(warnings.length ? {warnings} : {})
    };
}

function opCycles(g) {
    // большие циклические группы (сотни файлов) показываем выборкой — иначе вывод раздувается
    const cap = (c) => (c.length > 15 ? {size: c.length, sample: c.slice(0, 15)} : c);
    return {count: g.cycles.length, cycles: g.cycles.slice(0, 20).map(cap)};
}

function opSymbol(g, p) {
    if (!p.name) throw new OpError('Укажите payload.name');
    const byId = (id) => g.files[id - 1];
    const ids = has(g.symbols, p.name) ? g.symbols[p.name] : null;
    if (!ids) {
        // Член класса/интерфейса: метод, свойство, getter/setter; in=ИмяКласса сужает поиск
        const owner = p.in ? String(p.in) : null;
        const hits = [];
        for (const f of g.files) {
            for (const e of f.entities || []) {
                if (!e.members || (owner && e.name !== owner)) continue;
                for (const mm of e.members)
                    if (mm.name === p.name)
                        hits.push({file: f.path, kind: mm.kind, owner: e.name, line: mm.line, ...rangeOf(mm)});
            }
        }
        return {
            name: p.name,
            ...(owner ? {in: owner} : {}),
            ...(hits.length
                ? {
                    definedIn: hits.slice(0, 30),
                    ...(hits.length > 30 ? {total: hits.length, hint: 'совпадений больше 30 — уточните in=ИмяКласса'} : {})
                }
                : {definedIn: []})
        };
    }
    return {
        name: p.name,
        definedIn: [...new Set(ids)].map((id) => {
            const f = byId(id);
            const e = f.entities.find((x) => x.name === p.name || x.pipeName === p.name);
            return {
                file: f.path, kind: e ? e.kind : f.kind,
                ...(e && e.line ? {line: e.line} : {}),
                ...rangeOf(e),
                ...(e && e.selector ? {selector: e.selector} : {}),
                ...(e && e.pipeName ? {pipe: e.pipeName} : {})
            };
        })
    };
}

function opSelector(g, p) {
    if (!isAngular(cwd)) throw new OpError(ANGULAR_ERROR);
    if (!p.selector) throw new OpError('Укажите payload.selector');
    const byId = (id) => g.files[id - 1];
    const s = String(p.selector).trim();
    const keys = Object.keys(g.selectors);
    const norm = (x) => x.replace(/[\[\]]/g, '');
    const parts = (k) => parseSelector(k).length ? k.split(',').map((x) => x.trim()) : [k];
    const key = keys.find((k) => k === s)
        || keys.find((k) => parts(k).some((x) => x === s || norm(x) === norm(s) || x.includes('[' + norm(s) + ']')));
    if (!key) return {selector: s, file: null};
    const n = byId(g.selectors[key]);
    const rev = reverseIndex(g);
    const templates = (rev.get(n.id) || []).map(byId).filter((f) => f.kind === 'template').map((f) => f.path);
    const warnings = selectorWarnings(g, key);
    return {
        selector: key, file: n.path, kind: n.kind,
        ...(warnings.length ? {warnings} : {}),
        usedInTemplatesTotal: templates.length,
        usedInTemplates: templates.slice(0, 30)
    };
}

function opPath(g, p) {
    if (!p.from || !p.to) throw new OpError('Укажите payload.from и payload.to');
    const a = findNode(g, p.from), b = findNode(g, p.to);
    if (a.error) throw new OpError(a.error);
    if (b.error) throw new OpError(b.error);
    if (a.ambiguous || b.ambiguous)
        return {ambiguous: true, matches: a.ambiguous || b.ambiguous, ...structuralStatus(g, 0, ['ambiguous-query'])};
    const prev = new Map([[a.node.id, null]]);
    const queue = [a.node.id];
    while (queue.length) {
        const cur = queue.shift();
        if (cur === b.node.id) break;
        for (const nxt of g.files[cur - 1].imports)
            if (!prev.has(nxt)) {
                prev.set(nxt, cur);
                queue.push(nxt);
            }
    }
    if (!prev.has(b.node.id))
        return {from: a.node.path, to: b.node.path, chain: null, ...structuralStatus(g)};
    const chain = [];
    for (let cur = b.node.id; cur != null; cur = prev.get(cur)) chain.unshift(g.files[cur - 1].path);
    return {from: a.node.path, to: b.node.path, chain, ...structuralStatus(g)};
}

function opNode(g, p) {
    const byId = (id) => g.files[id - 1];
    const n = p.__node;
    const rev = reverseIndex(g);
    // члены не выводим: их задача — поиск в op=symbol, в node они только раздули бы ответ
    const bare = n.entities.map(({members, ...rest}) => rest);
    // Пагинация: offset/limit для entities/importedBy; imports целиком (кап не вводится).
    // Наличие срезов отражается счётчиками, полный доступ реален через offset.
    const offset = Math.max(0, Math.round(Number(p.offset) || 0));
    let limit = 0; // 0 — дефолтные пределы (50/30), как до пагинации
    if (p.limit !== undefined && p.limit !== null && p.limit !== '') {
        limit = Math.max(1, Math.round(Number(p.limit) || 1));
    }
    const entPage = bare.slice(offset, offset + (limit || 50));
    const importers = rev.get(n.id) || [];
    const impPage = importers.slice(offset, offset + (limit || 30));
    const omitted = (bare.length - entPage.length) + (importers.length - impPage.length);
    return {
        file: n.path, id: n.id, kind: n.kind, loc: n.loc,
        entitiesTotal: bare.length,
        entities: entPage,
        ...(bare.length > entPage.length ? {entitiesTruncated: bare.length - entPage.length} : {}),
        ...(n.reexportAll ? {reexportAll: true} : {}),
        importsTotal: n.imports.length,
        imports: n.imports.map((id) => {
            const ln = p.why ? (n.importLines || {})[id] : null;
            return {file: byId(id).path, kind: byId(id).kind, ...(ln ? {via: 'L' + ln} : {})};
        }),
        importedByTotal: importers.length,
        importedBy: impPage.map((id) => {
            const ln = p.why ? ((byId(id).importLines || {})[n.id]) : null;
            return {file: byId(id).path, kind: byId(id).kind, ...(ln ? {via: 'L' + ln} : {})};
        }),
        ...(importers.length > impPage.length ? {importedByTruncated: importers.length - impPage.length} : {}),
        unresolved: n.unresolved.length,
        ...unresolvedSummary(n),
        ...(n.external.length ? {external: n.external} : {}),
        ...structuralStatus(g, omitted)
    };
}

function opDepsRdeps(g, p, kind) {
    const n = p.__node;
    const depth = Math.min(Math.max(Number(p.depth) || 1, 1), 5);
    const all = walk(g, n.id, depth, kind === 'rdeps', p.why);
    const list = all.slice(0, 60);
    const status = structuralStatus(g, Math.max(0, all.length - 60));
    // format=table (opt-in): однородные списки рёбер — строки-массивы с общей схемой columns.
    // Все значения и порядок сохраняются; отсутствующий via передаётся null (он не был
    // самостоятельным значением), декодер восстанавливает объекты {file,kind,level,via?}.
    const table = p.format === 'table';
    const rows = table
        ? list.map((x) => [x.file, x.kind, x.level, x.via == null ? null : x.via])
        : list;
    return kind === 'deps'
        ? {
            file: n.path,
            kind: n.kind,
            importsTotal: all.length,
            ...status,
            unresolved: n.unresolved.length,
            ...unresolvedSummary(n),
            ...(table ? {columns: ['file', 'kind', 'level', 'via']} : {}),
            imports: rows, ...(n.external.length ? {external: n.external} : {})
        }
        : {
            file: n.path,
            kind: n.kind,
            importedByTotal: all.length,
            ...status,
            ...(table ? {columns: ['file', 'kind', 'level', 'via']} : {}),
            importedBy: rows
        };
}

/**
 * Диспетчер одного запроса. Общий для одиночного режима и batch.
 * file-запросы (node/deps/rdeps) резолвятся до вызова обработчика: ошибки пути и
 * неоднозначность — ответы запроса, а не ошибки выполнения.
 */
function dispatchOp(g, p) {
    if (['node', 'deps', 'rdeps'].includes(p.op)) {
        if (!p.file) throw new OpError('Укажите payload.file');
        const r = findNode(g, p.file);
        if (r.error) throw new OpError(r.error);
        if (r.ambiguous)
            return {ambiguous: true, matches: r.ambiguous, ...structuralStatus(g, 0, ['ambiguous-query'])};
        p.__node = r.node;
    }
    switch (p.op) {
        case 'stats': return opStats(g);
        case 'info': return opInfo(g);
        case 'cycles': return opCycles(g);
        case 'symbol': return opSymbol(g, p);
        case 'selector': return opSelector(g, p);
        case 'path': return opPath(g, p);
        case 'node': return opNode(g, p);
        case 'deps': return opDepsRdeps(g, p, 'deps');
        case 'rdeps': return opDepsRdeps(g, p, 'rdeps');
        default: throw new OpError('Неизвестный op: ' + p.op);
    }
}

/**
 * Обёртка: OpError → ответ с ошибкой (как fail в одиночном режиме: для deps/rdeps/path —
 * со scope/completeness); прочие исключения — программная ошибка, пробрасываются.
 */
function runQuery(g, p) {
    try {
        return {ok: true, payload: dispatchOp(g, p)};
    } catch (e) {
        if (e instanceof OpError) {
            const extras = ['deps', 'rdeps', 'path'].includes(p.op)
                ? {scope: {root: cwd, scanRoot: toPosix(ROOT) || '.'}, completeness: {complete: false, reasons: ['request-error']}}
                : {};
            return {ok: false, payload: {error: e.message, ...extras}};
        }
        throw e;
    }
}

// ---------- batch: явные пакетные запросы ----------

/**
 * Запуск массива requests: {batch, total, failed, results}. Каждый элемент получает свой
 * ответ либо {index, error}. Запросы группируются по scope (root+specs): граф и reverse
 * index строятся один раз на группу; разные scope не объединяются молча. op=read не требует
 * графа. Write-операции (build/generate/edit) в batch не входят — только BATCH_OPS.
 */
function runBatch() {
    let requests = args.requests;
    if (typeof requests === 'string') {
        // argv-режим передаёт requests строкой: JSON-массив запросов
        try {
            requests = JSON.parse(requests);
        } catch (e) {
            fail('Некорректный JSON в requests: ' + e.message);
        }
    }
    if (args.requests_file !== undefined && args.requests_file !== null && args.requests_file !== '') {
        const rf = String(args.requests_file);
        const rfAbs = path.resolve(cwd, rf);
        const rfRel = path.relative(cwd, rfAbs);
        if (rfRel === '..' || rfRel.startsWith('..' + path.sep) || path.isAbsolute(rfRel))
            fail('requests_file вне рабочей директории запрещён: ' + rf);
        try {
            requests = JSON.parse(fs.readFileSync(fs.realpathSync(rfAbs), 'utf8'));
        } catch (e) {
            fail('Не удалось прочитать requests_file: ' + e.message);
        }
    }
    if (!Array.isArray(requests) || !requests.length)
        fail('requests должен быть непустым JSON-массивом запросов {"op": ...}');
    for (let i = 0; i < requests.length; i++) {
        const r = requests[i];
        if (!r || typeof r !== 'object' || Array.isArray(r)) fail('requests[' + i + ']: элемент должен быть объектом');
        if (!BATCH_OPS.includes(r.op))
            fail('requests[' + i + ']: неизвестный или запрещённый op: ' + r.op + ' (batch не выполняет write-операции)');
    }
    // Группы scope в порядке первого вхождения.
    const groups = new Map();
    requests.forEach((r, i) => {
        if (r.op === 'read') {
            if (!groups.has('read')) groups.set('read', {read: true, idxs: []});
            groups.get('read').idxs.push(i);
            return;
        }
        const specs = r.specs === undefined ? args.specs : (r.specs === true || r.specs === 'true' || r.specs === '1');
        const root = path.resolve(cwd, r.root || args.root || (fs.existsSync(path.join(cwd, 'src')) ? 'src' : '.'));
        const key = JSON.stringify([root, specs]);
        if (!groups.has(key)) groups.set(key, {read: false, specs, root, idxs: []});
        groups.get(key).idxs.push(i);
    });
    const results = new Array(requests.length);
    let failed = 0;
    for (const grp of groups.values()) {
        if (grp.read) {
            for (const i of grp.idxs) {
                const r = readRanges(requests[i]);
                if (r.error) {
                    results[i] = {index: i, error: r.error};
                    failed++;
                } else {
                    results[i] = {index: i, ...r};
                }
            }
            continue;
        }
        const relRoot = path.relative(cwd, grp.root);
        try {
            setScope({root: relRoot === '' ? '.' : relRoot, specs: grp.specs});
        } catch (e) {
            for (const i of grp.idxs) {
                results[i] = {index: i, error: e.message};
                failed++;
            }
            continue;
        }
        // Свежесть графа проверяется на обычных условиях; scan-состояние scope-группы изолируется.
        scanExcluded.clear();
        scanIssues.clear();
        let graphCtx;
        try {
            graphCtx = ensureGraph();
        } catch (e) {
            for (const i of grp.idxs) {
                results[i] = {index: i, error: e.message};
                failed++;
            }
            continue;
        }
        for (const i of grp.idxs) {
            const res = runQuery(graphCtx.graph, requests[i]);
            if (res.ok) results[i] = {index: i, ...res.payload};
            else {
                results[i] = {index: i, error: res.payload.error};
                failed++;
            }
        }
    }
    const envelope = {batch: true, total: requests.length, failed, results};
    if (args.compact === true || args.compact === '1' || args.compact === 'true') applyCompactBatch(envelope);
    emit(envelope);
    // 0 — выполнен хотя бы один запрос; 1 — все запросы завершились ошибками.
    // partial errors: exit 0 при failed>0, «все успешно» не означает отсутствия failed.
    process.exit(failed === requests.length ? 1 : 0);
}

/**
 * compact=1 (opt-in): словарь путей на весь ответ + hoist точного равного scope/completeness.
 * Индексы заменяют строки только в документированных позициях; похожие пути в разных папках
 * не склеиваются — интернируется точная строка. Свежесть/semantics не меняются.
 */
function applyCompactBatch(envelope) {
    const paths = [];
    const pathIdx = new Map();
    const intern = (s) => {
        if (typeof s !== 'string') return s;
        if (!pathIdx.has(s)) {
            pathIdx.set(s, paths.length);
            paths.push(s);
        }
        return pathIdx.get(s);
    };
    // Строковые пути верхнего уровня и известные списки: объекты с .file, массивы строк,
    // table-строки (columns) — первая колонка.
    const ROW_LISTS = ['imports', 'importedBy', 'definedIn', 'topImported', 'usedInTemplates', 'chain'];
    for (const res of envelope.results) {
        if (res.error) continue;
        for (const k of ['file', 'from', 'to'])
            if (typeof res[k] === 'string') res[k] = intern(res[k]);
        for (const k of ROW_LISTS) {
            const list = res[k];
            if (!Array.isArray(list)) continue;
            if (k === 'chain' || k === 'usedInTemplates') {
                res[k] = list.map((s) => typeof s === 'string' ? intern(s) : s);
            } else if (Array.isArray(res.columns) && (k === 'imports' || k === 'importedBy')) {
                res[k] = list.map((row) => Array.isArray(row) && typeof row[0] === 'string' ? [intern(row[0]), ...row.slice(1)] : row);
            } else {
                res[k] = list.map((item) => item && typeof item === 'object' && typeof item.file === 'string'
                    ? {...item, file: intern(item.file)}
                    : item);
            }
        }
    }
    // Hoist: scope/completeness выносятся наверх только при точном (deep) равенстве у всех
    // успешных ответов; иначе остаются в каждом элементе.
    const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    for (const key of ['scope', 'completeness']) {
        const present = envelope.results.filter((r) => !r.error && r[key] !== undefined);
        if (present.length && present.length === envelope.results.filter((r) => !r.error).length
            && present.every((r) => deepEq(r[key], present[0][key]))) {
            envelope[key] = present[0][key];
            for (const r of present) delete r[key];
        }
    }
    if (paths.length) envelope.paths = paths;
}

// ---------- одиночный режим ----------

if (args.requests !== undefined && args.requests !== null || args.requests_file !== undefined && args.requests_file !== null && args.requests_file !== '') {
    runBatch();
}

try {
    setScope(args);
} catch (e) {
    fail(e.message);
}

const op = args.op;
if (!op) fail('Укажите op: info | build | node | deps | rdeps | symbol | selector | path | cycles | stats | read');
if (!['info', 'build', 'node', 'deps', 'rdeps', 'symbol', 'selector', 'path', 'cycles', 'stats', 'read', 'selftest'].includes(op))
    fail('Неизвестный op: ' + op);
if (args.format && args.format !== 'table') fail('format поддерживает только table');

// read не требует графа — отвечает до ensureGraph
if (op === 'read') {
    const r = readRanges(args);
    if (r.error) fail(r.error);
    emit(r);
    process.exit(0);
}

if (op === 'selector' && !isAngular(cwd)) {
    console.log(ANGULAR_ERROR);
    process.exit(1);
}

if (op === 'selftest') {
    // Самопроверка всех скриптов скилла на временном мини-проекте: граф реального проекта не нужен.
    const os = require('os');
    const cp = require('child_process');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'te-ts-'));
    const w = (rel, text) => {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), {recursive: true});
        fs.writeFileSync(path.join(dir, rel), text);
    };
    w('package.json', '{"name":"selftest-app","dependencies":{"fake-lib":"^1.0.0"}}');
    w('angular.json', '{}');
    w('node_modules/fake-lib/package.json', '{"name":"fake-lib","version":"1.0.0","types":"./index.d.ts"}');
    w('node_modules/fake-lib/index.d.ts', 'export declare class Widget {\n    render(x: number): string;\n}\n');
    w('src/app/app.component.ts', "import {Component} from './nothing';\n@Component({selector: 'app-root', templateUrl: './app.component.html'})\nexport class AppComponent {}\n");
    w('src/app/app.component.html', '<app-profile></app-profile>\n{{ title | bold }}\n');
    w('src/app/profile/profile.component.ts', "@Component({selector: 'app-profile', template: '<app-widget></app-widget>'})\nexport class ProfileComponent {}\n");
    w('src/app/widget/widget.component.ts', "@Component({selector: 'app-widget', template: 'w'})\nexport class WidgetComponent {}\n");
    w('src/app/pipes/bold.pipe.ts', "@Pipe({name: 'bold'})\nexport class BoldPipe {}\n");
    w('src/app/services/user.service.ts', 'export class UserService {\n    save(id: number): number {\n        return 1;\n    }\n}\n');
    w('src/app/styles/_vars.scss', '$primary: #333;\n@mixin card {\n    border: 1px solid;\n}\n');
    // execFileSync: ненулевой код выхода (ожидаем для scaffold-helper) отдаём как stdout
    const run = (script, argv) => {
        try {
            return cp.execFileSync(process.execPath, [path.join(__dirname, script), ...argv], {cwd: dir, encoding: 'utf8'});
        } catch (e) {
            return String(e.stdout || '');
        }
    };
    const json = (script, argv) => JSON.parse(run(script, argv));
    let total = 0;
    const bad = [];
    const chk = (name, cond, extra) => {
        total++;
        console.log((cond ? 'ok    ' : 'FAIL  ') + name + (cond ? '' : ' — ' + String(extra).slice(0, 200)));
        if (!cond) bad.push(name);
    };

    // code-searcher
    const s1 = json('code-searcher.js', ['query=ProfileComponent']);
    chk('search: совпадение в .ts', !!s1.matches && s1.matches.some((m) => m.file.includes('profile.component.ts')), s1.error || JSON.stringify(s1));
    const s2 = json('code-searcher.js', ['query=app-profile', 'ext=.html', 'files=1']);
    chk('search: ext=.html + files=1', s2.files && s2.files.some((f) => f.file.includes('app.component.html')), s2.error || JSON.stringify(s2));

    // graph-tool
    const g1 = json('graph-tool.js', ['op=symbol', 'name=UserService']);
    chk('graph: symbol → файл и строка', g1.definedIn && g1.definedIn.length === 1 && g1.definedIn[0].file.endsWith('user.service.ts') && g1.definedIn[0].line === 1, g1.error || JSON.stringify(g1));
    const g2 = json('graph-tool.js', ['op=symbol', 'name=$primary']);
    chk('graph: symbol $var в scss', g2.definedIn && g2.definedIn.some((d) => d.file.endsWith('_vars.scss')), g2.error || JSON.stringify(g2));
    const g3 = json('graph-tool.js', ['op=selector', 'selector=app-profile']);
    chk('graph: selector → файл и шаблоны', g3.file && g3.file.endsWith('profile.component.ts') && g3.usedInTemplates.some((t) => t.endsWith('app.component.html')), g3.error || JSON.stringify(g3));
    const g4 = json('graph-tool.js', ['op=rdeps', 'file=src/app/profile/profile.component.ts', 'depth=2']);
    const files4 = (g4.importedBy || []).map((x) => x.file);
    chk('graph: rdeps через selector и templateUrl', files4.some((f) => f.endsWith('app.component.html')) && files4.some((f) => f.endsWith('app.component.ts')), g4.error || JSON.stringify(g4));
    const g5 = json('graph-tool.js', ['op=deps', 'file=src/app/app.component.html']);
    const files5 = (g5.imports || []).map((x) => x.file);
    chk('graph: пайп в шаблоне → deps', files5.some((f) => f.endsWith('bold.pipe.ts')), g5.error || JSON.stringify(g5));

    // symbol-index (outline)
    const o1 = json('symbol-index.js', ['file=src/app/services/user.service.ts']);
    chk('outline: методы класса', o1.outline && o1.outline.includes('save') && o1.count >= 2, o1.error || JSON.stringify(o1));

    // sig-reader
    const q1 = run('sig-reader.js', ['name=fake-lib#Widget', 'member=render']);
    chk('sig: сигнатура члена из node_modules', q1.includes('render') && q1.includes('number'), q1);
    const q2 = run('sig-reader.js', ['name=fake-lib#Widget', 'member=absent']);
    chk('sig: ненайденный член → available', q2.includes('available') && q2.includes('render'), q2);

    // edit-symbol
    const svc = path.join(dir, 'src/app/services/user.service.ts');
    const before = fs.readFileSync(svc, 'utf8');
    const e1 = json('edit-symbol.js', ['file=src/app/services/user.service.ts', 'symbol=UserService.save', 'body=return 2;']);
    chk('edit_symbol: dry-run не пишет файл', e1.ok === true && e1.dry === true && fs.readFileSync(svc, 'utf8') === before, JSON.stringify(e1));
    const e2 = json('edit-symbol.js', ['file=src/app/services/user.service.ts', 'symbol=UserService.save', 'body=return 2;', 'dry=false']);
    const after = fs.readFileSync(svc, 'utf8');
    chk('edit_symbol: запись только тела', e2.ok === true && e2.written === true && after.includes('return 2;') && after.includes('save(id: number)'), JSON.stringify(e2));

    // scaffold-helper: без локального ng — вежливый отказ, не падение
    const sf = run('scaffold-helper.js', ['type=component', 'name=x']);
    chk('generate: отказ без Angular CLI', sf.includes('Angular CLI не найден'), sf);

    // info: детекция типа проекта (projectType) — на отдельном чистом мини-проекте:
    // в основном angular.json создан выше для тестов selector/generate, он всё переопределял бы.
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'te-ts-type-'));
    fs.mkdirSync(path.join(dir2, 'src'), {recursive: true});
    fs.writeFileSync(path.join(dir2, 'src', 'main.ts'), 'export const main = 1;\n');
    const info2 = () => {
        try {
            return JSON.parse(cp.execFileSync(process.execPath, [path.join(__dirname, 'graph-tool.js'), 'op=info'], {cwd: dir2, encoding: 'utf8'}));
        } catch (e) {
            return JSON.parse(String(e.stdout || '{}'));
        }
    };
    fs.writeFileSync(path.join(dir2, 'package.json'), '{"name":"selftest-app","dependencies":{"fake-lib":"^1.0.0"}}');
    const i1 = info2();
    chk('info: чистый TS → projectType=ts', i1.projectType === 'ts', JSON.stringify(i1).slice(0, 160));
    fs.writeFileSync(path.join(dir2, 'package.json'), '{"name":"selftest-app","dependencies":{"express":"^4.19.0"}}');
    const i2 = info2();
    chk('info: express → projectType=node и server', i2.projectType === 'node' && i2.server === 'express', JSON.stringify(i2).slice(0, 160));
    fs.writeFileSync(path.join(dir2, 'package.json'), '{"name":"selftest-app","dependencies":{"@nestjs/core":"^10.0.0"}}');
    const i3 = info2();
    chk('info: @nestjs/* → projectType=nest', i3.projectType === 'nest', JSON.stringify(i3).slice(0, 160));
    fs.writeFileSync(path.join(dir2, 'package.json'), '{"name":"selftest-app","dependencies":{"fake-lib":"^1.0.0"}}');
    fs.writeFileSync(path.join(dir2, 'angular.json'), '{"version":1,"projects":{}}');
    const i4 = info2();
    chk('info: angular.json → projectType=angular', i4.projectType === 'angular' && i4.angularJson === true, JSON.stringify(i4).slice(0, 160));
    // задача 2: react projectType и keyDeps
    fs.rmSync(path.join(dir2, 'angular.json'), {force: true}); // angular.json из прошлой проверки переопределял бы react
    fs.writeFileSync(path.join(dir2, 'package.json'), '{"name":"selftest-app","dependencies":{"react":"^18.0.0"}}');
    const i5 = info2();
    chk('info: react ^18 → projectType=react и keyDeps.react', i5.projectType === 'react' && i5.keyDeps && i5.keyDeps.react === '^18.0.0', JSON.stringify(i5).slice(0, 160));
    fs.writeFileSync(path.join(dir2, 'package.json'), '{"name":"selftest-app","dependencies":{"react":"15.6"}}');
    const i6 = info2();
    chk('info: react 15.6 → projectType=ts и warning', i6.projectType === 'ts' && (i6.warnings || []).some((w) => w.includes('react >= 16')), JSON.stringify(i6).slice(0, 160));
    fs.rmSync(dir2, {recursive: true, force: true});

    fs.rmSync(dir, {recursive: true, force: true});
    console.log(bad.length ? '\nпровалено: ' + bad.join(', ') : '\nвсе проверки пройдены (' + total + ')');
    process.exit(bad.length ? 1 : 0);
}

if (op === 'build') {
    try {
        const {graph, reparsed, ms} = buildGraph(null);
        emit({built: true, ...graph.stats, reparsed, ms});
    } catch (e) {
        fail(e.message);
    }
    process.exit(0);
}

let graphCtx;
try {
    graphCtx = ensureGraph();
} catch (e) {
    fail(e.message);
}

const result = runQuery(graphCtx.graph, args);
emit(result.payload);
process.exit(result.ok ? 0 : 1);
