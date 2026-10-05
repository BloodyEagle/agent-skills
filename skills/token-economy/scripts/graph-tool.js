// graph-tool.js — граф зависимостей Angular-проекта: TS, HTML-шаблоны и стили (CSS/SCSS/Sass/Less).
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

let args = {};
// CLI-режим: node graph-tool.js build file=src/app/a.ts depth=2
for (const a of process.argv.slice(2)) {
    const i = a.indexOf('=');
    if (i === -1) {
        if (!args.op) args.op = a;
    } else if (a.slice(0, i)) args[a.slice(0, i)] = a.slice(i + 1);
}
// stdin-режим (команды скилла) — читаем пайп, только если op не задан аргументами
if (!args.op && process.stdin.isTTY !== true) {
    try {
        Object.assign(args, JSON.parse(fs.readFileSync(0, 'utf-8').trim() || '{}'));
    } catch (e) {
    }
}

const cwd = process.cwd();
const ROOT = path.resolve(cwd, args.root || 'src');
const GRAPH_FILE = path.join(cwd, 'graph-deps.json');
const CACHE_FILE = path.join(cwd, '.graph-deps-cache.json');
const GRAPH_VERSION = 2; // формат graph-deps.json и кэша; смена версии пересобирает всё
const MAX_BYTES = 1024 * 1024; // файлы крупнее (бандлы, вендорные стили) в граф не берём
const EXCLUDE = new Set(['node_modules', '.git', 'dist', '.kilocode', '.angular', 'coverage', 'build']);
const NG_KINDS = {
    Component: 'component',
    Directive: 'directive',
    Pipe: 'pipe',
    Injectable: 'injectable',
    NgModule: 'ngmodule'
};
const KIND_PRI = {component: 5, directive: 4, pipe: 3, injectable: 3, ngmodule: 2, class: 1};
const KNOWN_EXT = /\.(tsx?|html|css|scss|sass|less)$/i;
const ASSET_EXT = /\.(html|css|scss|sass|less)(\?.*)?$/i;
const CONFIG_FILES = ['angular.json', '.angular.json', 'tsconfig.json'];

const emit = (obj) => console.log(JSON.stringify(obj));
const fail = (msg) => {
    emit({error: msg});
    process.exit(1);
};
const toPosix = (p) => path.relative(cwd, p).replace(/\\/g, '/');
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

// Правило 11 скилла: пути вне рабочей директории отклоняются.
// root="." допустим (rel === ''); isAbsolute ловит переход на другой диск (Windows).
{
    const rel = path.relative(cwd, ROOT);
    if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel))
        fail('root вне рабочей директории запрещён: ' + (args.root || 'src'));
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
 * Тип файла по имени: 'ts' | 'html' | 'style' | null.
 */
function fileType(name) {
    if (/\.(ts|tsx)$/.test(name)) return 'ts';
    if (/\.html$/i.test(name)) return 'html';
    if (/\.(css|scss|sass|less)$/i.test(name)) return 'style';
    return null;
}

/**
 * Собирает файлы проекта: .ts/.tsx (без спеков и .d.ts), .html и стили (без *.min.css и файлов > 1 МБ).
 */
function collectFiles(dir, acc = []) {
    if (!fs.existsSync(dir)) return acc;
    for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (!EXCLUDE.has(e.name)) collectFiles(p, acc);
            continue;
        }
        const type = fileType(e.name);
        if (!type) continue;
        if (type === 'ts' && (e.name.endsWith('.d.ts') || (!args.specs && /\.(spec|test)\.tsx?$/.test(e.name)))) continue;
        if (type === 'style' && /\.min\.css$/i.test(e.name)) continue;
        if (statOf(p).size > MAX_BYTES) continue;
        acc.push(p);
    }
    return acc;
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
function loadAliases() {
    try {
        const tsconfig = path.join(cwd, 'tsconfig.json');
        if (!fs.existsSync(tsconfig)) return null;
        const co = parseJsonc(fs.readFileSync(tsconfig, 'utf8')).compilerOptions || {};
        const base = co.baseUrl ? path.resolve(cwd, co.baseUrl) : cwd;
        const entries = Object.entries(co.paths || {}).map(([k, v]) => ({
            pre: k.endsWith('*') ? k.slice(0, -1) : k,
            star: k.endsWith('*'),
            targets: [].concat(v).map((t) => path.resolve(base, t))
        }));
        return (spec) => {
            for (const e of entries) {
                if (e.star) {
                    if (spec.startsWith(e.pre) && spec.length > e.pre.length)
                        return e.targets.map((t) => t.replace(/\*/g, spec.slice(e.pre.length)));
                } else if (spec === e.pre) return e.targets.slice();
            }
            return null;
        };
    } catch (e) {
        return null;
    }
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
 * Разбирает содержимое .ts: импорты, экспорты, объявления с номерами строк,
 * а для @Component — templateUrl, styleUrl(s) и использование в inline-template.
 */
function parseTs(content) {
    content = content.replace(/^\uFEFF/, '');
    const specifiers = [], entities = [], exports = [], fileRefs = [];
    let reexportAll = false, templateUrl = null, usages = null, m;
    const decorated = new Set();
    const lineAt = (idx) => content.slice(0, idx).split('\n').length;

    // Импорты и реэкспорты (включая динамические import()); многострочные поддержаны
    const reImps = [
        /import\s+[^;'"]*?from\s*['"]([^'"]+)['"]/g,
        /import\s*['"]([^'"]+)['"]/g,
        /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
        /export\s+[^;'"]*?from\s*['"]([^'"]+)['"]/g
    ];
    for (const re of reImps) while ((m = re.exec(content))) specifiers.push(m[1]);
    if (/export\s*\*\s*from/.test(content)) reexportAll = true;

    const reExp = /export\s*\{([^}]*)\}/g;
    while ((m = reExp.exec(content)))
        for (const part of m[1].split(',')) {
            const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop().trim();
            if (name && name !== '*') exports.push(name);
        }

    const reDecl = /(?:^|\n)[ \t]*(export\s+)?(?:default\s+)?(?:abstract\s+)?(class|interface|enum|type|function|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
    while ((m = reDecl.exec(content))) {
        const kind = m[2] === 'let' || m[2] === 'var' ? 'const' : m[2];
        entities.push({name: m[3], kind, line: lineAt(m.index)});
        if (m[1]) exports.push(m[3]);
    }

    // Angular-декораторы: вид сущности, selector / имя пайпа, шаблон и стили
    const reNg = /@(Component|Directive|Pipe|Injectable|NgModule)\s*\(([\s\S]{0,30000}?)\)\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g;
    while ((m = reNg.exec(content))) {
        const body = m[2];
        const entity = {name: m[3], kind: NG_KINDS[m[1]], line: lineAt(m.index)};
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
    return parseTs(content);
}

// ---------- резолвинг ссылок ----------

/**
 * Превращает спецификатор TS-импорта в файл проекта либо имя внешнего пакета.
 * Импорты ресурсов ('./x.scss?inline', './x.html') резолвятся по точному пути.
 */
function resolveSpec(spec, fromAbs, fileSet, alias) {
    if (ASSET_EXT.test(spec)) spec = spec.replace(/\?.*$/, '');
    let bases;
    if (spec.startsWith('.')) bases = [path.resolve(path.dirname(fromAbs), spec)];
    else {
        const hits = alias ? alias(spec) : null;
        if (!hits) return {external: spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]};
        bases = hits;
    }
    for (const b of bases)
        for (const v of [b, b + '.ts', b + '.tsx', path.join(b, 'index.ts')])
            if (fileSet.has(v)) return {file: v};
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
        for (const v of styleCandidates(b, styleFamily(fromAbs))) if (fileSet.has(v)) return {file: v};
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
        if (fileSet.has(b)) return b;
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
    const strong = (v) => {
        idx[v] = low[v] = cnt++;
        stack.push(v);
        on[v] = true;
        for (const w of nodes[v - 1].imports) {
            if (idx[w] < 0) {
                strong(w);
                low[v] = Math.min(low[v], low[w]);
            } else if (on[w]) low[v] = Math.min(low[v], idx[w]);
        }
        if (low[v] === idx[v]) {
            const comp = [];
            let w;
            do {
                w = stack.pop();
                on[w] = false;
                comp.push(w);
            } while (w !== v);
            if (comp.length > 1) sccs.push(comp.map((id) => nodes[id - 1].path).sort());
        }
    };
    for (let i = 1; i <= n; i++) if (idx[i] < 0) strong(i);
    return sccs;
}

/**
 * Строит граф с инкрементальным кэшем (парсятся только изменённые файлы).
 */
function buildGraph(files) {
    const t0 = Date.now();
    files = (files || collectAll()).sort();
    if (!files.length) fail('Не найдено .ts/.html/стилей в ' + (args.root || 'src'));

    const fileSet = new Set(files);
    const alias = loadAliases();
    const includePaths = loadStyleIncludePaths();
    let cache = {};
    try {
        cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    } catch (e) {
    }
    if (cache.__v !== GRAPH_VERSION) cache = {};
    const newCache = {__v: GRAPH_VERSION};
    let reparsed = 0;

    const nodes = files.map((f, i) => {
        const rel = toPosix(f);
        const st = statOf(f);
        const c = cache[rel];
        let data;
        if (c && c.mtime === st.mtimeMs && c.size === st.size) data = c.data;
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
        const abs = path.join(cwd, n.path);
        const type = fileType(n.path);
        for (const spec of n.specifiers || []) {
            const r = type === 'style' ? resolveStyleSpec(spec, abs, fileSet, includePaths) : resolveSpec(spec, abs, fileSet, alias);
            if (r && r.file) n.imports.push(idByAbs.get(r.file));
            else if (r && r.external) {
                n.external.push(r.external);
                externals.add(r.external);
            }
        }
        if (n.templateUrl) {
            const f = resolveFileRef(n.templateUrl, abs, fileSet);
            if (f) {
                n.imports.push(idByAbs.get(f));
                ownerOfTemplate.set(idByAbs.get(f), n.id);
            }
        }
        for (const ref of n.fileRefs || []) {
            const f = resolveFileRef(ref, abs, fileSet);
            if (f) n.imports.push(idByAbs.get(f));
        }
    }

    // 2. Индексы символов, селекторов и пайпов
    const symbols = Object.create(null), selectors = Object.create(null);
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
        for (const k of ['specifiers', 'fileRefs', 'templateUrl', 'usages']) delete n[k];
        const type = fileType(n.path);
        n.kind = type === 'html' ? 'template' : type === 'style' ? 'style' : nodeKind(n);
        byKind[n.kind] = (byKind[n.kind] || 0) + 1;
    }

    const cycles = tarjan(nodes);
    const graph = {
        version: GRAPH_VERSION,
        root: args.root || 'src',
        files: nodes,
        symbols, selectors,
        externals: [...externals].sort(),
        cycles,
        stats: {
            files: nodes.length,
            byKind,
            edges: nodes.reduce((s, n) => s + n.imports.length, 0),
            externalPackages: externals.size,
            cycles: cycles.length
        }
    };
    fs.writeFileSync(GRAPH_FILE, JSON.stringify(graph));
    fs.writeFileSync(CACHE_FILE, JSON.stringify(newCache));
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
    let stale = !graph || graph.version !== GRAPH_VERSION
        || graph.root !== (args.root || 'src')
        || files.length !== graph.files.length;
    if (!stale) {
        const known = new Set(graph.files.map((f) => f.path));
        stale = files.some((f) => !known.has(toPosix(f)));
    }
    if (!stale) {
        const gm = fs.statSync(GRAPH_FILE).mtimeMs;
        stale = files.some((f) => statOf(f).mtimeMs > gm)
            || CONFIG_FILES.some((c) => fs.existsSync(path.join(cwd, c)) && fs.statSync(path.join(cwd, c)).mtimeMs > gm);
    }
    return stale ? buildGraph(files) : {graph, reparsed: 0};
}

/**
 * Ищет узел по id / пути / имени файла; при неоднозначности — список кандидатов.
 * Запрос без расширения («profile.component») предпочитает .ts-файл его html/стилям-соседям.
 */
function findNode(graph, q) {
    q = String(q).replace(/\\/g, '/');
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
 */
function walk(graph, startId, depth, reverse) {
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
            out.push({file: f.path, kind: f.kind, level: d + 1});
            frontier.push([c, d + 1]);
        }
    }
    return out;
}

// ---------- диспетчер ----------
const op = args.op;
if (!op) fail('Укажите op: build | node | deps | rdeps | symbol | selector | path | cycles | stats');

if (op === 'build') {
    const {graph, reparsed, ms} = buildGraph(null);
    emit({built: true, ...graph.stats, reparsed, ms});
    process.exit(0);
}

const {graph} = ensureGraph();
const byId = (id) => graph.files[id - 1];

if (op === 'stats') {
    const rev = reverseIndex(graph);
    emit({
        ...graph.stats,
        topImported: graph.files
            .map((f) => ({file: f.path, kind: f.kind, importers: (rev.get(f.id) || []).length}))
            .sort((a, b) => b.importers - a.importers).slice(0, 10)
    });
    process.exit(0);
}

if (op === 'cycles') {
    // большие циклические группы (сотни файлов) показываем выборкой — иначе вывод раздувается
    const cap = (c) => (c.length > 15 ? {size: c.length, sample: c.slice(0, 15)} : c);
    emit({count: graph.cycles.length, cycles: graph.cycles.slice(0, 20).map(cap)});
    process.exit(0);
}

if (op === 'symbol') {
    if (!args.name) fail('Укажите payload.name');
    const ids = has(graph.symbols, args.name) ? graph.symbols[args.name] : null;
    if (!ids) {
        emit({name: args.name, definedIn: []});
        process.exit(0);
    }
    emit({
        name: args.name,
        definedIn: [...new Set(ids)].map((id) => {
            const f = byId(id);
            const e = f.entities.find((x) => x.name === args.name || x.pipeName === args.name);
            return {
                file: f.path, kind: e ? e.kind : f.kind,
                ...(e && e.line ? {line: e.line} : {}),
                ...(e && e.selector ? {selector: e.selector} : {}),
                ...(e && e.pipeName ? {pipe: e.pipeName} : {})
            };
        })
    });
    process.exit(0);
}

if (op === 'selector') {
    if (!args.selector) fail('Укажите payload.selector');
    const s = String(args.selector).trim();
    const keys = Object.keys(graph.selectors);
    const norm = (x) => x.replace(/[\[\]]/g, '');
    const parts = (k) => parseSelector(k).length ? k.split(',').map((x) => x.trim()) : [k];
    const key = keys.find((k) => k === s)
        || keys.find((k) => parts(k).some((p) => p === s || norm(p) === norm(s) || p.includes('[' + norm(s) + ']')));
    if (!key) {
        emit({selector: s, file: null});
        process.exit(0);
    }
    const n = byId(graph.selectors[key]);
    const rev = reverseIndex(graph);
    const templates = (rev.get(n.id) || []).map(byId).filter((f) => f.kind === 'template').map((f) => f.path);
    emit({
        selector: key, file: n.path, kind: n.kind,
        usedInTemplatesTotal: templates.length,
        usedInTemplates: templates.slice(0, 30)
    });
    process.exit(0);
}

if (op === 'path') {
    if (!args.from || !args.to) fail('Укажите payload.from и payload.to');
    const a = findNode(graph, args.from), b = findNode(graph, args.to);
    if (a.error) fail(a.error);
    if (b.error) fail(b.error);
    if (a.ambiguous || b.ambiguous) {
        emit({ambiguous: true, matches: a.ambiguous || b.ambiguous});
        process.exit(0);
    }
    const prev = new Map([[a.node.id, null]]);
    const queue = [a.node.id];
    while (queue.length) {
        const cur = queue.shift();
        if (cur === b.node.id) break;
        for (const nxt of graph.files[cur - 1].imports)
            if (!prev.has(nxt)) {
                prev.set(nxt, cur);
                queue.push(nxt);
            }
    }
    if (!prev.has(b.node.id)) {
        emit({from: a.node.path, to: b.node.path, chain: null});
        process.exit(0);
    }
    const chain = [];
    for (let cur = b.node.id; cur != null; cur = prev.get(cur)) chain.unshift(graph.files[cur - 1].path);
    emit({from: a.node.path, to: b.node.path, chain});
    process.exit(0);
}

if (op === 'node' || op === 'deps' || op === 'rdeps') {
    if (!args.file) fail('Укажите payload.file');
    const r = findNode(graph, args.file);
    if (r.error) fail(r.error);
    if (r.ambiguous) {
        emit({ambiguous: true, matches: r.ambiguous});
        process.exit(0);
    }
    const n = r.node;

    if (op === 'node') {
        const rev = reverseIndex(graph);
        emit({
            file: n.path, id: n.id, kind: n.kind, loc: n.loc,
            entities: n.entities.slice(0, 50),
            ...(n.entities.length > 50 ? {entitiesTruncated: n.entities.length - 50} : {}),
            ...(n.reexportAll ? {reexportAll: true} : {}),
            imports: n.imports.map((id) => ({file: byId(id).path, kind: byId(id).kind})),
            importedBy: (rev.get(n.id) || []).slice(0, 30).map((id) => ({file: byId(id).path, kind: byId(id).kind})),
            ...(n.external.length ? {external: n.external} : {})
        });
        process.exit(0);
    }

    const depth = Math.min(Math.max(args.depth || 1, 1), 5);
    const list = walk(graph, n.id, depth, op === 'rdeps').slice(0, 60);
    emit(op === 'deps'
        ? {
            file: n.path,
            kind: n.kind,
            importsTotal: walk(graph, n.id, depth, false).length,
            imports: list, ...(n.external.length ? {external: n.external} : {})
        }
        : {file: n.path, kind: n.kind, importedByTotal: walk(graph, n.id, depth, true).length, importedBy: list});
    process.exit(0);
}

fail('Неизвестный op: ' + op);
