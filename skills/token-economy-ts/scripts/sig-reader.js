// sig-reader.js — сигнатуры классов, интерфейсов, функций и членов сторонних библиотек
// из node_modules (.d.ts / .ts) без чтения исходников: package.json → types/exports →
// файл деклараций → компактный список. С member ищет именованные и export * реэкспорты;
// без member раскрывает export *, только если в текущем файле нет деклараций.
// Пути ограничены realpath проекта; bare dependencies — реальным корнем выбранного пакета.
// Итог: одна строка JSON с несколькими десятками сигнатур вместо Read файла на тысячи строк.

const fs = require('fs');
const path = require('path');

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
for (const a of process.argv.slice(2)) {
    if (a.startsWith('{')) continue;
    const i = a.indexOf('=');
    if (i !== -1 && a.slice(0, i)) args[a.slice(0, i)] = a.slice(i + 1);
}
if (!Object.keys(args).length && process.stdin.isTTY !== true) {
    try {
        Object.assign(args, JSON.parse(fs.readFileSync(0, 'utf-8').trim() || '{}'));
    } catch (e) {
        // невалидный stdin — работаем с пустыми аргументами
    }
}

const cwd = process.cwd();
const projectRoot = fs.realpathSync(cwd);
const MAX_SIG = 200;        // максимум символов в одной сигнатуре (full=1 отключает)
const MAX_DEPTH = 10;       // глубина прохода по реэкспортам
const MAX_STARS = 6;        // сколько export * проверяем в поиске члена
const MAX_AVAILABLE = 40;   // имен в списке доступных экспортов

const emit = (obj) => console.log(JSON.stringify(obj));
const fail = (msg) => {
    emit({error: msg});
    process.exit(1);
};
const truthy = (v) => v === true || v === '1' || v === 'true';
const fullSig = truthy(args.full);

/**
 * Пробелы схлопываются только вне строковых литералов: внутренние пробелы literal type
 * ('a  b') и шаблонов сохраняются дословно, внешние — нормализуются в один пробел.
 */
function oneline(s) {
    let out = '', str = null, pending = false, seen = false;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (str) {
            out += c;
            if (c === '\\') { out += s[i + 1] || ''; i++; }
            else if (c === str) str = null;
            continue;
        }
        if (c === '"' || c === "'" || c === '`') {
            if (pending && seen) out += ' ';
            pending = false;
            str = c;
            out += c;
            continue;
        }
        if (/\s/.test(c)) {
            if (seen) pending = true;
            continue;
        }
        if (pending && seen) { out += ' '; pending = false; }
        seen = true;
        out += c;
    }
    return out;
}

/**
 * Сигнатуры со счётчиком обрезанных позиций: обрезка по MAX_SIG помечается индексами,
 * full=1 возвращает текст целиком.
 */
function sigSlice(items, from, count, key = 'sig') {
    const shown = items.slice(from, from + count);
    const clipped = [];
    shown.forEach((x, i) => { if (key === 'sig' ? x.clipped : x.declClipped) clipped.push(i); });
    return {
        signatures: shown.map((x) => x[key]),
        ...(clipped.length ? {clippedSignatures: clipped} : {}),
        ...(items.length > from + shown.length ? {truncated: true} : {})
    };
}
const cut = (text) => fullSig ? {text, clipped: false} : {text: text.slice(0, MAX_SIG), clipped: text.length > MAX_SIG};
const toPosix = (p) => {
    const rel = path.relative(cwd, p);
    return rel.startsWith('..') ? p.replace(/\\/g, '/') : rel.replace(/\\/g, '/');
};

// ---------- разбор деклараций ----------

/**
 * Убирает комментарии из TS-кода, не трогая строки; переводы строк сохраняются,
 * поэтому номера строк совпадают с исходником.
 */
function stripTsComments(text) {
    let out = '', i = 0;
    const n = text.length;
    while (i < n) {
        const c = text[i], nx = text[i + 1];
        if (c === '"' || c === "'" || c === '`') {
            out += c;
            i++;
            while (i < n && text[i] !== c) {
                if (text[i] === '\\') {
                    out += text[i] + (text[i + 1] || '');
                    i += 2;
                    continue;
                }
                out += text[i++];
            }
            if (i < n) {
                out += text[i];
                i++;
            }
            continue;
        }
        if (c === '/' && nx === '/') {
            while (i < n && text[i] !== '\n') i++;
            continue;
        }
        if (c === '/' && nx === '*') {
            i += 2;
            while (i < n && !(text[i] === '*' && text[i + 1] === '/')) {
                if (text[i] === '\n') out += '\n';
                i++;
            }
            i += 2;
            continue;
        }
        out += c;
        i++;
    }
    return out;
}

/**
 * Закрывающая скобка для '{' в позиции openPos (с учётом строк и экранирования).
 */
function matchBrace(text, openPos) {
    let depth = 0, str = null;
    for (let i = openPos; i < text.length; i++) {
        const c = text[i];
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
        if (c === '{') depth++;
        else if (c === '}') {
            depth--;
            if (depth === 0) return i;
        }
    }
    return -1;
}

/**
 * Конец оператора: ';' на нулевой глубине скобок; '}', закрывающий чужой блок, тоже конец
 * (декларация с телом в .d.ts не встречается, но пусть не ломает разбор).
 */
function stmtEnd(text, from) {
    let paren = 0, brack = 0, brace = 0, str = null;
    for (let i = from; i < text.length; i++) {
        const c = text[i];
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
        if (c === '(') paren++;
        else if (c === ')') paren--;
        else if (c === '[') brack++;
        else if (c === ']') brack--;
        else if (c === '{') brace++;
        else if (c === '}') {
            brace--;
            if (brace < 0) return i;
        } else if (c === ';' && paren === 0 && brack === 0 && brace === 0) return i;
    }
    return text.length - 1;
}

/**
 * Тела блоков declare global / declare module (augmentation) вырезаются: их содержимое
 * не относится к публичному API пакета.
 */
function blankModuleBlocks(text) {
    const re = /(?:^|\n)[ \t]*declare\s+(global|module)\b/g;
    let out = text, m;
    while ((m = re.exec(text))) {
        const braceAt = text.indexOf('{', m.index + m[0].length);
        if (braceAt === -1) continue;
        const close = matchBrace(text, braceAt);
        if (close === -1) continue;
        out = out.slice(0, m.index) + out.slice(m.index, close + 1).replace(/[^\n]/g, ' ') + out.slice(close + 1);
        re.lastIndex = close + 1;
    }
    return out;
}

/**
 * Имя члена из его декларации (модификаторы отрезаются).
 */
function memberName(chunk) {
    let t = chunk.replace(/^\s+/, '');
    let m;
    while ((m = t.match(/^(export\s+|declare\s+|public\s+|private\s+|protected\s+|static\s+|readonly\s+|abstract\s+|override\s+|async\s+|get\s+|set\s+|\*|[+#-]\s*)/))) t = t.slice(m[0].length);
    m = t.match(/^([$_\p{ID_Start}][$\u200C\u200D\p{ID_Continue}]*)/u);
    return m ? m[1] : '';
}

/**
 * Члены тела класса/интерфейса: куски до ';' на нулевой глубине скобок
 * либо до '}', закрывающего вложенный блок.
 */
function extractMembers(body, baseLine) {
    const items = [];
    let start = -1, str = null, brace = 0, paren = 0, brack = 0;
    const push = (end) => {
        const chunk = body.slice(start, end);
        const text = oneline(chunk);
        if (text) {
            const c = cut(text);
            items.push({
                name: memberName(chunk),
                line: baseLine + body.slice(0, start).split('\n').length - 1,
                sig: c.text,
                clipped: c.clipped
            });
        }
        start = -1;
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
        if (c === '{') brace++;
        else if (c === '(') paren++;
        else if (c === '[') brack++;
        else if (c === '}') {
            brace--;
            if (brace === 0 && paren === 0 && brack === 0) {
                push(i + 1);
                continue;
            }
        } else if (c === ')') paren--;
        else if (c === ']') brack--;
        else if (c === ';') {
            if (brace === 0 && paren === 0 && brack === 0) push(i + 1);
            continue;
        }
    }
    if (start !== -1) push(body.length);
    return items;
}

/**
 * Члены enum: куски между запятыми верхнего уровня.
 */
function enumMembers(body) {
    const items = [];
    let chunk = '', str = null, depth = 0;
    for (let i = 0; i < body.length; i++) {
        const c = body[i];
        if (str) {
            chunk += c;
            if (c === '\\') {
                chunk += body[i + 1] || '';
                i++;
                continue;
            }
            if (c === str) str = null;
            continue;
        }
        if (c === '"' || c === "'" || c === '`') {
            str = c;
            chunk += c;
            continue;
        }
        if ('{(['.includes(c)) depth++;
        if ('})]'.includes(c)) depth--;
        if (c === ',' && depth === 0) {
            if (chunk.trim()) {
                const c = cut(oneline(chunk));
                items.push({name: memberName(chunk), sig: c.text, clipped: c.clipped});
            }
            chunk = '';
            continue;
        }
        chunk += c;
    }
    if (chunk.trim()) {
        const c = cut(oneline(chunk));
        items.push({name: memberName(chunk), sig: c.text, clipped: c.clipped});
    }
    return items;
}

/**
 * Верхнеуровневые декларации файла. Вложения пропускаются смещением lastIndex за конец
 * предыдущей декларации, поэтому вложенные class/type не попадают в список.
 */
function scanDecls(text) {
    const lineStarts = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
    const lineAt = (idx) => {
        let lo = 0, hi = lineStarts.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (lineStarts[mid] <= idx) lo = mid;
            else hi = mid - 1;
        }
        return lo + 1;
    };
    const re = /^[ \t]*(export\s+)?(declare\s+)?(abstract\s+)?(async\s+)?(class|interface|enum|namespace|function|const|let|var|type)\s+([$_\p{ID_Start}][$\u200C\u200D\p{ID_Continue}]*)/gmu;
    const decls = [];
    let skipUntil = -1, m;
    while ((m = re.exec(text))) {
        if (m.index < skipUntil) continue;
        const kind = m[5], name = m[6];
        const nameEnd = m.index + m[0].length;
        if (kind === 'class' || kind === 'interface' || kind === 'enum' || kind === 'namespace') {
            const brace = text.indexOf('{', nameEnd);
            if (brace === -1) continue;
            const close = matchBrace(text, brace);
            if (close === -1) continue;
            const body = text.slice(brace + 1, close);
            const members = kind === 'enum' ? enumMembers(body) : extractMembers(body, lineAt(brace + 1));
            const header = cut(oneline(text.slice(m.index, brace)));
            decls.push({
                kind, name, line: lineAt(m.index),
                decl: header.text,
                declClipped: header.clipped,
                // Полный список членов: cap не ставится, усечение выдачи делает limit/offset.
                members, membersTotal: members.length
            });
            skipUntil = close + 1;
            re.lastIndex = close + 1;
        } else {
            const end = stmtEnd(text, nameEnd - name.length - kind.length - 1);
            const d = cut(oneline(text.slice(m.index, end + 1)));
            decls.push({kind, name, line: lineAt(m.index), decl: d.text, declClipped: d.clipped});
            skipUntil = end + 1;
        }
    }
    return decls;
}

/**
 * Именованные и звёздочные реэкспорты файла.
 */
function collectReexports(text) {
    const named = new Map(), stars = [];
    let m;
    const reNamed = /export\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
    while ((m = reNamed.exec(text))) {
        for (const part of m[1].split(',')) {
            const t = part.trim();
            if (!t) continue;
            const name = (t.split(/\s+as\s+/).pop() || '').trim();
            if (name && name !== '*' && name !== 'default') named.set(name, m[2]);
        }
    }
    const reStar = /export\s*\*\s*(?:as\s+[\w$]+\s*)?from\s*['"]([^'"]+)['"]/g;
    while ((m = reStar.exec(text))) stars.push(m[1]);
    return {named, stars};
}

// ---------- резолвинг пакетов ----------

function insideDir(root, file) {
    const rel = path.relative(root, file);
    return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

function confinedFile(file, root) {
    if (!insideDir(root, file)) return null;
    try {
        const real = fs.realpathSync(file);
        if (insideDir(root, real) && fs.statSync(real).isFile()) return {file: real, root};
    } catch (e) { /* отсутствует или недоступен */ }
    return null;
}

function probeFile(p, root) {
    const ext = path.extname(p);
    const list = [];
    if (!ext) list.push(p + '.d.ts', path.join(p, 'index.d.ts'), p);
    if (/\.js$/i.test(p)) list.push(p.slice(0, -3) + '.d.ts');
    if (/\.mjs$/i.test(p)) list.push(p.slice(0, -4) + '.d.mts');
    if (/\.cjs$/i.test(p)) list.push(p.slice(0, -4) + '.d.cts');
    // Runtime exports — лишь адрес для поиска деклараций, не успешный результат sig.
    if (!/\.[cm]?js$/i.test(p)) list.push(p);
    if (ext && ext !== '.d.ts') {
        const noExt = p.slice(0, p.length - ext.length);
        list.push(noExt + '.d.ts', path.join(noExt, 'index.d.ts'));
    }
    for (const f of list) {
        const hit = confinedFile(f, root);
        if (hit) return hit;
    }
    return null;
}

/**
 * Цель поля exports (строка | массив условий | объект условий) → файл деклараций.
 */
function pickTypesFromTarget(target, pkgDir, star, depth) {
    if (depth > 4 || target == null) return null;
    if (typeof target === 'string') return probeFile(path.resolve(pkgDir, star === null ? target : target.replace(/\*/g, star)), pkgDir);
    if (Array.isArray(target)) {
        for (const t of target) {
            const r = pickTypesFromTarget(t, pkgDir, star, depth + 1);
            if (r) return r;
        }
        return null;
    }
    for (const key of ['types', 'typings', 'import', 'require', 'node', 'default']) {
        if (target[key]) {
            const r = pickTypesFromTarget(target[key], pkgDir, star, depth + 1);
            if (r) return r;
        }
    }
    return null;
}

/**
 * Bare-спецификатор → декларации установленного пакета; поиск node_modules от импортёра вверх.
 */
function resolveModuleFile(spec, fromDir = cwd) {
    const clean = spec.replace(/^node_modules\//, '').replace(/[?#].*$/, '');
    const parts = clean.split('/');
    if (parts.some(p => !p || p === '.' || p === '..' || /[\\:]/.test(p))
        || (clean.startsWith('@') && parts.length < 2)) throw new Error('недопустимое имя пакета: ' + spec);
    const pkgName = clean.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    const sub = clean.slice(pkgName.length).replace(/^\//, '');
    let pkgDir = null;
    for (let dir = path.resolve(fromDir); ; dir = path.dirname(dir)) {
        const candidate = path.join(dir, 'node_modules', pkgName);
        try {
            if (fs.statSync(candidate).isDirectory()) { pkgDir = fs.realpathSync(candidate); break; }
        } catch (e) { /* пакет может быть установлен в родительском workspace */ }
        if (path.dirname(dir) === dir) break;
    }
    if (!pkgDir) throw new Error('пакет ' + pkgName + ' не найден в node_modules (установлен?)');
    let pj = null;
    try {
        const manifest = confinedFile(path.join(pkgDir, 'package.json'), pkgDir);
        if (manifest) pj = JSON.parse(fs.readFileSync(manifest.file, 'utf8'));
    } catch (e) { /* нет package.json — работаем прямыми пробами файлов */ }

    // 1) exports: корень '.', shorthand/условия корня, точный subpath, затем '*'.
    if (pj && pj.exports != null) {
        const exp = pj.exports;
        const key = sub ? './' + sub : '.';
        const subpaths = exp && typeof exp === 'object' && !Array.isArray(exp)
            && Object.keys(exp).some(k => k.startsWith('.'));
        let hit = subpaths && hasKey(exp, key) ? pickTypesFromTarget(exp[key], pkgDir, null, 0)
            : !subpaths && !sub ? pickTypesFromTarget(exp, pkgDir, null, 0) : null;
        if (!hit && subpaths) {
            for (const [k, v] of Object.entries(exp)) {
                if (!k.includes('*')) continue;
                const cut = k.indexOf('*');
                if (key.startsWith(k.slice(0, cut)) && key.endsWith(k.slice(cut + 1))) {
                    const star = key.slice(cut, key.length - (k.length - cut - 1));
                    hit = pickTypesFromTarget(v, pkgDir, star, 0);
                    if (hit) break;
                }
            }
        }
        if (hit) return hit;
    }

    // 2) прямые пробы файлов, ограниченные реальным корнем выбранного пакета.
    if (sub) {
        const base = path.join(pkgDir, sub);
        const hit = probeFile(base + '.d.ts', pkgDir) || probeFile(path.join(base, 'index.d.ts'), pkgDir) || probeFile(base, pkgDir);
        if (hit) return hit;
    } else if (pj) {
        for (const k of ['types', 'typings']) {
            if (typeof pj[k] === 'string') {
                const hit = probeFile(path.resolve(pkgDir, pj[k]), pkgDir);
                if (hit) return hit;
            }
        }
    }
    const fallback = sub ? null : probeFile(path.join(pkgDir, 'index.d.ts'), pkgDir);
    if (fallback) return fallback;
    throw new Error('не удалось найти декларации для ' + clean + ' (в package.json нет exports/types, файлы .d.ts не найдены)');
}

function hasKey(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * Спецификатор реэкспорта → файл (относительный путь или другой пакет).
 */
function followSpec(spec, fromFile, root) {
    if (spec.startsWith('.')) return probeFile(path.resolve(path.dirname(fromFile), spec), root);
    if (!/^[a-z@]/i.test(spec)) return null;
    try {
        return resolveModuleFile(spec, path.dirname(fromFile));
    } catch (e) {
        return null;
    }
}

/**
 * Ищет декларации в файле, при необходимости проходя по реэкспортам.
 * С member: сначала декларация с этим именем, затем реэкспорты; если в файле есть
 * классы/интерфейсы — отдаём их, main поищет member среди членов.
 */
function analyze(target, member, depth, visited) {
    const checked = confinedFile(target.file, target.root);
    if (!checked) return null;
    const fileAbs = checked.file;
    if (visited.has(fileAbs)) return null;
    visited.add(fileAbs);
    let text;
    try {
        text = fs.readFileSync(fileAbs, 'utf8');
    } catch (e) {
        return null;
    }
    const stripped = blankModuleBlocks(stripTsComments(text.replace(/^\uFEFF/, '')));
    const decls = scanDecls(stripped);
    const {named, stars} = collectReexports(stripped);
    const follow = () => {
        const found = [];
        if (depth < MAX_DEPTH && member && named.has(member)) {
            const f = followSpec(named.get(member), fileAbs, target.root);
            if (f) found.push(f);
        }
        if (depth < MAX_DEPTH) for (const s of stars.slice(0, member ? MAX_STARS : 3)) {
            const f = followSpec(s, fileAbs, target.root);
            if (f) found.push(f);
        }
        return found;
    };

    if (member) {
        const hits = decls.filter((d) => d.name === member);
        if (hits.length) return {file: fileAbs, decls: hits};
        let pending = null;
        for (const f of follow()) {
            const r = analyze(f, member, depth + 1, visited);
            if (r && r.decls.length) {
                if (r.decls.some((d) => d.name === member || (d.members || []).some((x) => x.name === member))) return r;
                if (!pending) pending = r;
            }
        }
        if (pending) return pending;
        const containers = decls.filter((d) => d.members);
        if (containers.length) return {file: fileAbs, decls: containers};
        const available = [...decls.map((d) => d.name), ...named.keys()].filter(Boolean).sort();
        return {file: fileAbs, decls: [], available: available.slice(0, MAX_AVAILABLE)};
    }

    if (decls.length) return {file: fileAbs, decls};
    const merged = [];
    for (const f of follow()) {
        const r = analyze(f, null, depth + 1, visited);
        if (r) for (const d of r.decls) {
            merged.push(d);
            if (merged.length >= 400) break;
        }
        if (merged.length >= 400) break;
    }
    if (merged.length) return {file: fileAbs, decls: merged};
    const available = [...decls.map((d) => d.name), ...named.keys()].filter(Boolean).sort();
    return {file: fileAbs, decls: [], available: available.slice(0, MAX_AVAILABLE)};
}

// ---------- main ----------

(function main() {
    if (!args.name) fail('Укажите name: пакет с подпутем и членом через # (rxjs, rxjs/operators, @angular/core#Injector, rxjs/operators#map)');
    let [spec, member] = String(args.name).split('#');
    member = args.member || member || null;
    const limit = Math.max(1, Number(args.limit) || 40);
    const offset = Math.max(0, Number(args.offset) || 0);

    // Прямые пути проверяются и лексически, и по realpath до чтения деклараций.
    const direct = path.isAbsolute(spec) || /^[a-z]:/i.test(spec) || /^\.{1,2}(?:[\\/]|$)/.test(spec)
        || spec.includes('\\') || (/\.d\.[cm]?ts$/i.test(spec) && fs.existsSync(path.resolve(cwd, spec)));
    let target;
    if (direct) {
        const abs = path.resolve(cwd, spec);
        if (!insideDir(cwd, abs) || (process.platform !== 'win32' && /^[a-z]:/i.test(spec)))
            fail('Путь вне рабочей директории запрещён: ' + spec);
        try {
            const real = fs.realpathSync(abs);
            if (!insideDir(projectRoot, real)) fail('Путь вне рабочей директории запрещён: ' + spec);
            target = confinedFile(real, projectRoot);
        } catch (e) { /* ниже — единая ошибка отсутствующего файла */ }
        if (!target) fail('Файл деклараций не найден: ' + spec);
    } else {
        try { target = resolveModuleFile(spec); }
        catch (e) { fail(e.message); }
    }

    const r = analyze(target, member, 0, new Set());
    if (!r) fail('Файл деклараций недоступен: ' + spec);
    const rel = toPosix(r.file);
    const base = {name: String(args.name), member: member || null, file: rel};

    if (member) {
        if (!r.decls.length) {
            emit({...base, found: false, ...(r.available && r.available.length ? {available: r.available} : {})});
            process.exit(0);
        }
        const containers = r.decls.filter((x) => x.members);
        const withMember = containers.find((x) => x.members.some((y) => y.name === member));
        const d = withMember || containers[0] || r.decls[0];

        // member — сам класс/интерфейс/enum: карточка целиком
        if (d.members && d.name === member) {
            emit({
                ...base,
                found: true,
                kind: d.kind,
                owner: d.name,
                line: d.line,
                decl: d.decl,
                ...(d.declClipped ? {declClipped: true} : {}),
                ...sigSlice(d.members, offset, limit),
                signaturesTotal: d.membersTotal
            });
            process.exit(0);
        }
        // member — член класса/интерфейса
        if (d.members) {
            const matched = d.members.filter((x) => x.name === member);
            if (matched.length) {
                emit({
                    ...base,
                    found: true,
                    kind: d.kind,
                    owner: d.name,
                    line: matched[0].line,
                    decl: d.decl,
                    ...(d.declClipped ? {declClipped: true} : {}),
                    ...sigSlice(matched, offset, limit),
                    signaturesTotal: matched.length
                });
            } else {
                const inClass = [...new Set(d.members.map((x) => x.name).filter(Boolean))];
                emit({
                    ...base,
                    found: false,
                    owner: d.name,
                    decl: d.decl,
                    available: (inClass.length ? inClass : r.available || []).slice(0, MAX_AVAILABLE)
                });
            }
            process.exit(0);
        }
        // member — функция/const/type: все перегрузки
        emit({
            ...base,
            found: true,
            kind: d.kind,
            line: d.line,
            ...sigSlice(r.decls, offset, limit, 'decl'),
            signaturesTotal: r.decls.length
        });
        process.exit(0);
    }

    // Без члена: классы/интерфейсы — с членами, функции/типы — своими сигнатурами
    const page = r.decls.slice(offset, offset + limit);
    const items = page.map((d) => {
        const shownMembers = (d.members || []).slice(0, limit);
        const clippedMembers = [];
        shownMembers.forEach((x, i) => { if (x.clipped) clippedMembers.push(i); });
        return {
            kind: d.kind, name: d.name, line: d.line, decl: d.decl,
            ...(d.declClipped ? {clipped: true} : {}),
            ...(d.members
                ? {members: shownMembers.map((x) => x.sig), membersTotal: d.membersTotal,
                    ...(clippedMembers.length ? {clippedMembers} : {}),
                    ...(d.membersTotal > shownMembers.length ? {membersTruncated: d.membersTotal - shownMembers.length} : {})}
                : {})
        };
    });
    const truncated = r.decls.length > offset + items.length || page.some((d) => (d.membersTotal || 0) > limit);
    emit({
        ...base,
        found: r.decls.length > 0,
        declarations: items,
        ...(r.decls.length > offset + items.length ? {declarationsTotal: r.decls.length} : {}),
        ...(truncated ? {hint: 'вывод усечён (limit=' + limit + '); точечный запрос: name=' + spec + '#ИмяЧлена'} : {}),
        ...(!r.decls.length && r.available && r.available.length ? {available: r.available} : {})
    });
})();
