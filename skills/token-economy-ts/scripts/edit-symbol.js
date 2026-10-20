// edit-symbol.js — хирургическая замена тела функции/метода в .ts/.tsx (action: edit_symbol).
// Заменяет ТОЛЬКО содержимое между { и } тела указанного символа: подпись, JSDoc, декораторы
// и остальные байты файла не меняются (BOM, CRLF/LF и соседний код — байт в байт).
//
// Символы: save | UserService.save | UserService.constructor | get:prop | set:prop |
//          UserService.get:prop | arrow-свойства класса (onClick = (e) => {…}) |
//          const fn = () => {…} / const fn = function () {…} / export function fn() {…}.
// Перегрузки и сигнатуры без тела (строка кончается на «;») пропускаются автоматически —
// редактируется реализация. Стрелки с телом-выражением (=> x * 2, без {…}) не поддерживаются:
// для них нет внешних скобок, замена была бы не хирургической.
//
// Тело передаётся РОВНО одним из способов:
//   body_file=<путь>  — рекомендуется для многострочных тел (PowerShell запрещает переводы
//                       строк в argv); без значения используется .kilo-edit-body.txt в корне
//                       проекта (.txt в граф зависимостей не попадает); после успешной записи
//                       файл удаляется, если body_file_delete=true (по умолчанию);
//   body='…\n…'       — \n, \r, \t и \\ раскрываются;
//   body_b64=<base64> — для содержимого с любыми спецсимволами.
//
// Движок: engine=auto (по умолчанию) — если в проекте найден пакет typescript, используются
// точные позиции Compiler API и синтаксическая диагностика после замены; иначе — fallback:
// маскирование строк/шаблонов/комментариев/regex + скобочный баланс + проверка отступов.
// Ноль зависимостей: typescript подгружается только если он уже установлен в проекте.
//
// Отступы: indent=auto (по умолчанию) — наследуется минимальный отступ непустых строк старого
// тела (иначе отступ объявления + шаг, определяемый по соседним методам, дефолт 2 пробела);
// indent=2|4|tab — фиксированный шаг; indent=raw — тело вставляется как есть, без переиндентации.
//
// Безопасность: dry=true по умолчанию (файл НЕ перезаписывается, печатается отчёт); запись
// атомарная (tmp+rename); неоднозначность или подозрительный разбор — ошибка JSON со списком
// кандидатов, файл не меняется.
//
// Пример:
//   node edit-symbol.js file=src/app/services/user.service.ts symbol=UserService.save body_file=.kilo-edit-body.txt dry=false

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
// CLI-режим: голые аргументы заполняют file, затем symbol; body_file без «=» — флаг.
for (const a of process.argv.slice(2)) {
    if (a.startsWith('{')) continue;
    const i = a.indexOf('=');
    if (i === -1) {
        if (args.file === undefined) args.file = a;
        else if (args.symbol === undefined) args.symbol = a;
        else if (a === 'body_file') args.body_file = true;
    } else if (a.slice(0, i)) args[a.slice(0, i)] = a.slice(i + 1);
}
// stdin-режим (обратная совместимость) — только если аргументов нет вовсе
if (!Object.keys(args).length && process.stdin.isTTY !== true) {
    try {
        Object.assign(args, JSON.parse(fs.readFileSync(0, 'utf-8').trim() || '{}'));
    } catch (e) {
    }
}

const emit = (o) => console.log(JSON.stringify(o));
const fail = (msg, extra) => {
    const o = {error: msg};
    if (extra) Object.assign(o, extra);
    emit(o);
    process.exit(1);
};
const bool = (v, d) => v === undefined ? d : (v === true || v === 'true' || v === '1');

const dry = bool(args.dry, true);
const bodyFileDelete = bool(args.body_file_delete, true);
const engineMode = args.engine === undefined ? 'auto' : String(args.engine);
const indentMode = args.indent === undefined ? 'auto' : String(args.indent);
const cwd = process.cwd();

// ---------- 1. Валидация входа ----------

if (!args.file) fail('укажи file=<путь к .ts/.tsx> и symbol=<имя>; тело — через body_file= / body= / body_b64=');
const absFile = path.resolve(cwd, args.file);
{
    const rel = path.relative(cwd, absFile);
    if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel))
        fail('file вне рабочей директории запрещён: ' + args.file); // правило 11 скилла
}
if (!/\.(tsx?)$/i.test(absFile)) fail('допустимы только файлы .ts/.tsx: ' + args.file);
if (!fs.existsSync(absFile) || !fs.statSync(absFile).isFile()) fail('файл не найден: ' + args.file);
if (fs.statSync(absFile).size > 2 * 1024 * 1024) fail('файл больше 2 МБ — edit_symbol не предназначен для бандлов');

// symbol: name | Class.name | Class.constructor | get:prop | set:prop | Class.get:prop
const IDENT = /^[$A-Za-z_][\w$]*$/;
function parseSymbol(s) {
    if (!s) return null;
    let cls = null, rest = String(s);
    const dot = rest.indexOf('.');
    if (dot >= 0) {
        cls = rest.slice(0, dot);
        rest = rest.slice(dot + 1);
        if (!IDENT.test(cls)) return null;
    }
    if (rest === 'constructor') return {cls, kind: 'ctor', name: 'constructor'};
    const acc = /^(get|set):([$A-Za-z_][\w$]*)$/.exec(rest);
    if (acc) return {cls, kind: acc[1], name: acc[2]};
    if (IDENT.test(rest)) return {cls, kind: 'plain', name: rest};
    return null;
}
const spec = parseSymbol(args.symbol);
if (!spec) fail('symbol не распознан: ' + args.symbol + ' — форматы: save | Class.save | Class.constructor | get:prop | set:prop | Class.get:prop');

// тело: ровно один источник
const bodyKeys = ['body', 'body_file', 'body_b64'].filter((k) => args[k] !== undefined);
if (bodyKeys.length > 1) fail('тело передано несколькими способами (' + bodyKeys.join(', ') + ') — оставь один');
let bodyRaw = null, bodyFilePath = null, absBodyFile = null;
if (bodyKeys.length === 0) fail('передай тело одним из способов: body_file=.kilo-edit-body.txt (рекомендуется) | body=\'…\\n…\' | body_b64=');
if (args.body !== undefined) {
    // \n, \r, \t и \\ раскрываются; последовательность «\\n» даёт литеральные «\n»
    bodyRaw = String(args.body).replace(/\\(.)/g, (m, c) => c === 'n' ? '\n' : c === 't' ? '\t' : c === 'r' ? '\r' : c);
} else if (args.body_file !== undefined) {
    const v = args.body_file;
    bodyFilePath = (v === true || v === 'true' || v === '1' || v === '') ? '.kilo-edit-body.txt' : String(v);
    absBodyFile = path.resolve(cwd, bodyFilePath);
    const rel = path.relative(cwd, absBodyFile);
    if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel))
        fail('body_file вне рабочей директории запрещён: ' + bodyFilePath);
    if (!fs.existsSync(absBodyFile) || !fs.statSync(absBodyFile).isFile())
        fail('body_file не найден: ' + bodyFilePath + ' — запиши новое тело в этот файл (.txt в граф зависимостей не попадает)');
    bodyRaw = fs.readFileSync(absBodyFile, 'utf8');
} else {
    try {
        bodyRaw = Buffer.from(String(args.body_b64), 'base64').toString('utf8');
    } catch (e) {
        fail('body_b64 не декодируется');
    }
}
if (Buffer.byteLength(bodyRaw, 'utf8') > 512 * 1024) fail('тело больше 512 КБ');
if (bodyRaw.charCodeAt(0) === 0xFEFF) bodyRaw = bodyRaw.slice(1); // BOM от PowerShell 5.1 (Set-Content -Encoding UTF8)

// исходник: снимаем BOM (вернём при записи), определяем EOL
let src = fs.readFileSync(absFile, 'utf8');
const bom = src.charCodeAt(0) === 0xFEFF;
if (bom) src = src.slice(1);
const nlPos = src.indexOf('\n');
const eol = nlPos > 0 && src[nlPos - 1] === '\r' ? '\r\n' : '\n';
const isTsx = /\.tsx$/i.test(absFile);

// строки/позиции
function lineStartsOf(text) {
    const starts = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
    return starts;
}
const STARTS = lineStartsOf(src);
function lineIndex(off) {
    let lo = 0, hi = STARTS.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (STARTS[mid] <= off) lo = mid; else hi = mid - 1;
    }
    return lo;
}
const lineStartOf = (off) => STARTS[lineIndex(off)];

// ---------- 2. Общие помощники разбора ----------

const WSC = /[ \t\r\n\uFEFF]/;
const skipWs = (m, j) => { while (j < m.length && WSC.test(m[j])) j++; return j; };
function prevNonWs(mask, pos) {
    let j = pos;
    while (j > 0 && /\s/.test(mask[j - 1])) j--;
    return j > 0 ? mask[j - 1] : '';
}
function prevWord(mask, pos) {
    let j = pos;
    while (j > 0 && /\s/.test(mask[j - 1])) j--;
    if (pos - j > 8) return ''; // «function save»/«get prop» — в пределах пары символов
    let e = j;
    while (e > 0 && /[\w$]/.test(mask[e - 1])) e--;
    return e === j ? '' : mask.slice(e, j);
}
function readWord(mask, j) {
    let e = j;
    while (e < mask.length && /[\w$]/.test(mask[e])) e++;
    return mask.slice(j, e);
}
// парность { } по маске (строки/комментарии уже замаскированы)
function matchBrace(mask, open) {
    let depth = 0;
    for (let j = open; j < mask.length; j++) {
        const c = mask[j];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (!depth) return j; }
    }
    return -1;
}
// парность (…) с учётом вложенных ( [ { — для списков параметров
function matchParen(mask, open) {
    const need = {')': '(', ']': '[', '}': '{'};
    const st = [mask[open]];
    for (let j = open + 1; j < mask.length; j++) {
        const c = mask[j];
        if (c === '(' || c === '[' || c === '{') st.push(c);
        else if (c === ')' || c === ']' || c === '}') {
            if (st.pop() !== need[c]) return -1;
            if (!st.length) return j;
        } else if (c === ';' && st.length === 1) return -1; // «;» на верхнем уровне параметров — не объявление
    }
    return -1;
}

/**
 * Два последних значимых символа перед pos (пропуская пробелы):
 * возвращает [символ, символ перед ним] — нужно для распознавания «=> {…}» внутри типов.
 */
function prev2(mask, pos) {
    let k = pos;
    while (k > 0 && /\s/.test(mask[k - 1])) k--;
    return [k > 0 ? mask[k - 1] : '', k > 1 ? mask[k - 2] : ''];
}

/**
 * Маска кода: содержимое строк, шаблонов (вкл. вложенные ${…}), комментариев и regex
 * заменяется пробелами. Длина и переводы строк сохраняются 1:1, идентификаторы и знаки
 * остаются — по маске ищем имена и скобки, не боясь «}» внутри строки.
 */
function maskCode(text, isTsx) {
    const n = text.length;
    const out = new Array(n);
    const LETTER = /[A-Za-z0-9_$\u00C0-\u024F\u0370-\u04FF\u4E00-\u9FFF]/; // для апострофов JSX-текста
    const stack = [{m: 'code', nest: 0}]; // code | tpl
    let lastCode = '', lastWord = '';
    const REGEX_WORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'case', 'do', 'else', 'yield', 'await', 'throw']);
    let i = 0;
    const maskPlain = (from, to) => { for (let k = from; k < to; k++) out[k] = text[k] === '\n' ? '\n' : (text[k] === '\r' ? '\r' : ' '); };
    while (i < n) {
        const c = text[i];
        const top = stack[stack.length - 1];
        if (top.m === 'tpl') {
            if (c === '\\') { out[i] = ' '; if (i + 1 < n) out[i + 1] = ' '; i += 2; continue; }
            if (c === '`') { out[i] = ' '; stack.pop(); i++; lastCode = '`'; lastWord = ''; continue; }
            if (c === '$' && text[i + 1] === '{') { out[i] = ' '; out[i + 1] = ' '; stack.push({m: 'code', nest: 0}); i += 2; continue; }
            out[i] = (c === '\n' || c === '\r') ? c : ' ';
            i++;
            continue;
        }
        // --- режим кода ---
        if (c === "'" || c === '"') {
            // JSX-апостроф: буква'буква (don't, user's) — не строковый литерал
            if (c === "'" && i > 0 && LETTER.test(text[i - 1]) && i + 1 < n && LETTER.test(text[i + 1])) { out[i] = ' '; i++; continue; }
            // ищем закрывающую кавычку до конца строки; нет таковой — не строка (JSX-текст)
            let j = i + 1;
            let closed = -1;
            while (j < n) {
                if (text[j] === '\\') { j += 2; continue; }
                if (text[j] === '\n' || text[j] === '\r') break;
                if (text[j] === c) { closed = j; break; }
                j++;
            }
            if (closed < 0) { out[i] = c; lastCode = c; lastWord = ''; i++; continue; }
            maskPlain(i, closed + 1);
            lastCode = c; lastWord = '';
            i = closed + 1;
            continue;
        }
        if (c === '`') { out[i] = ' '; stack.push({m: 'tpl'}); i++; lastCode = '`'; lastWord = ''; continue; }
        if (c === '/' && text[i + 1] === '/') {
            let j = i + 2;
            while (j < n && text[j] !== '\n' && text[j] !== '\r') j++;
            maskPlain(i, j);
            i = j;
            continue;
        }
        if (c === '/' && text[i + 1] === '*') {
            let j = i + 2;
            while (j < n && !(text[j] === '*' && text[j + 1] === '/')) j++;
            const end = Math.min(n, j + 2);
            maskPlain(i, end);
            lastCode = ''; lastWord = '';
            i = end;
            continue;
        }
        if (c === '/') {
            // regex или деление: после ( , = : [ ! & | ? { } ; операторов и ключевых слов — regex
            const reStart = lastCode === '' || '([=!:&|?,;{+-*%^~<}'.includes(lastCode) || REGEX_WORDS.has(lastWord);
            if (reStart) {
                let j = i + 1, inClass = false, closed = false;
                while (j < n) {
                    const d = text[j];
                    if (d === '\\') { j += 2; continue; }
                    if (d === '\n' || d === '\r') break; // незакрытый regex — граница строки
                    if (d === '[') inClass = true;
                    else if (d === ']') inClass = false;
                    else if (d === '/' && !inClass) { j++; closed = true; break; }
                    j++;
                }
                if (closed) {
                    let k = j;
                    while (k < n && /[a-z]/.test(text[k])) k++; // флаги
                    maskPlain(i, k);
                    lastCode = '/'; lastWord = '';
                    i = k;
                } else {
                    out[i] = '/'; // незакрытый до конца строки — не regex, оставляем
                    lastCode = '/'; lastWord = '';
                    i++;
                }
                continue;
            }
            out[i] = c; lastCode = '/'; lastWord = '';
            i++;
            continue;
        }
        if (c === '{') {
            if (stack.length > 1) top.nest++;
            out[i] = c; lastCode = c; lastWord = '';
            i++;
            continue;
        }
        if (c === '}') {
            if (stack.length > 1) {
                if (top.nest > 0) { top.nest--; out[i] = c; }
                else { out[i] = ' '; stack.pop(); } // закрытие ${…}
                lastCode = ''; lastWord = '';
                i++;
                continue;
            }
            out[i] = c; lastCode = c; lastWord = '';
            i++;
            continue;
        }
        if (c === '\n' || c === '\r') { out[i] = c; i++; continue; }
        if (/\s/.test(c)) { out[i] = c; i++; continue; }
        if (/[\w$]/.test(c)) {
            let j = i;
            while (j < n && /[\w$]/.test(text[j])) j++;
            for (let k = i; k < j; k++) out[k] = text[k];
            lastWord = text.slice(i, j);
            lastCode = /\d/.test(lastWord[0]) ? '0' : 'w';
            i = j;
            continue;
        }
        out[i] = c; lastCode = c; lastWord = '';
        i++;
    }
    return out.join('');
}

function bracketsBalanced(text) {
    const mask = maskCode(text, false);
    const need = {')': '(', ']': '[', '}': '{'};
    const st = [];
    for (let i = 0; i < mask.length; i++) {
        const c = mask[i];
        if (c === '(' || c === '[' || c === '{') st.push(c);
        else if (c === ')' || c === ']' || c === '}') { if (st.pop() !== need[c]) return false; }
    }
    return st.length === 0;
}

// ---------- 3. Fallback-движок: поиск объявления по маске ----------

function findOccurrences(mask, name) {
    const res = [];
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('(?<![\\w$])' + esc + '(?![\\w$])', 'g');
    let m;
    while ((m = re.exec(mask))) {
        const pos = m.index;
        let k = pos;
        while (k > 0 && /[ \t]/.test(mask[k - 1])) k--;
        if (k > 0 && mask[k - 1] === '.') continue; // .name / ?.name — использование
        res.push(pos);
    }
    return res;
}

// классы файла (для квалифицированного адреса Class.method и подписей кандидатов)
function classSpans(mask) {
    const spans = [];
    const re = /\bclass\s+([A-Za-z_$][\w$]*)/g;
    let m;
    while ((m = re.exec(mask))) {
        let j = m.index + m[0].length;
        let angle = 0, open = -1;
        while (j < mask.length) {
            const c = mask[j];
            if (c === '<') angle++;
            else if (c === '>') { if (angle > 0) angle--; }
            else if (c === '{' && angle === 0) { open = j; break; }
            else if (c === ';') break;
            j++;
        }
        if (open < 0) continue;
        const end = matchBrace(mask, open);
        // не найден конец (незакрытая конструкция в файле) — считаем до конца файла,
        // чтобы квалифицированный адрес продолжал работать до места повреждения
        spans.push({name: m[1], start: m.index, open, end: end < 0 ? mask.length : end});
    }
    return spans;
}

/**
 * Разбор головы объявления от позиции имени до «{» тела.
 * Возвращает {bodyStart, arrow} | {stop:'skip'} (сигнатура/abstract) | {stop:'reject'} | {stop:'expr'}.
 */
function headScan(mask, pos, nameLen) {
    const n = mask.length;
    let j = pos + nameLen;
    const ws = () => { j = skipWs(mask, j); };
    ws();
    // <T, …> — угловая парность; «=>» внутри типов не считается закрытием
    if (mask[j] === '<') {
        let angle = 1;
        j++;
        while (j < n && angle > 0) {
            const c = mask[j];
            if (c === '<') angle++;
            else if (c === '>') { if (mask[j - 1] !== '=') angle--; }
            else if (c === ';' || c === '}') return {stop: 'reject'};
            j++;
        }
        if (angle > 0) return {stop: 'reject'};
        ws();
    }
    // (параметры)
    if (mask[j] === '(') {
        const e = matchParen(mask, j);
        if (e < 0) return {stop: 'reject'};
        j = e + 1;
        ws();
    } else if (mask[j] !== ':' && mask[j] !== '=') {
        return {stop: 'reject'}; // после имени нет «(», «:», «=» — не функция
    }
    // : возвращаемый тип — идём до «{» тела, пропуская {…}-литералы типов
    if (mask[j] === ':') {
        j++;
        ws();
        const guard = j + 2000;
        while (j < n && j < guard) {
            const c = mask[j];
            if (c === ';') return {stop: 'skip'};   // перегрузка/abstract/declare
            if (c === '}') return {stop: 'skip'};
            if (c === '=') {
                if (mask[j + 1] === '>') { j += 2; continue; } // тип-функция () => X
                return {stop: 'reject'};
            }
            if (c === '{') {
                const pv = prevNonWs(mask, j);
                const pb = prev2(mask, j)[1];
                const pw = prevWord(mask, j);
                const typeLiteral = pv === ':' || pv === '|' || pv === '&' || pv === ',' || pv === '(' || pv === '[' || pv === '<' || pv === '?' ||
                    (pv === '>' && pb === '=') || // => {…} — тип-функция с объектным результатом
                    pw === 'extends' || pw === 'keyof' || pw === 'typeof' || pw === 'infer' || pw === 'readonly' || pw === 'new';
                if (typeLiteral) {
                    const e = matchBrace(mask, j);
                    if (e < 0) return {stop: 'reject'};
                    j = e + 1;
                    continue;
                }
                return {bodyStart: j, arrow: false}; // тело
            }
            j++;
        }
        return {stop: 'reject'}; // слишком длинный/странный тип — отказ
    }
    // => { … } сразу после параметров
    if (mask[j] === '=' && mask[j + 1] === '>') {
        j += 2;
        ws();
        if (mask[j] === '{') return {bodyStart: j, arrow: true};
        return {stop: 'expr'}; // тело-выражение
    }
    // = инициализатор: стрелка или function-выражение
    if (mask[j] === '=' && mask[j + 1] !== '=') {
        j++;
        ws();
        let w = readWord(mask, j);
        if (w === 'async') { j += w.length; ws(); w = readWord(mask, j); }
        if (w === 'function') {
            j += w.length;
            ws();
            if (mask[j] === '*') { j++; ws(); }
            const w3 = readWord(mask, j);
            if (w3) { j += w3.length; ws(); } // необязательное имя
            if (mask[j] !== '(') return {stop: 'reject'};
            const e = matchParen(mask, j);
            if (e < 0) return {stop: 'reject'};
            j = e + 1;
            ws();
            if (mask[j] === ':') { // return-тип function-выражения
                j++;
                ws();
                const guard = j + 2000;
                let found = false;
                while (j < n && j < guard) {
                    const c = mask[j];
                    if (c === ';') return {stop: 'skip'};
                    if (c === '=' && mask[j + 1] === '>') { j += 2; continue; } // тип-функция () => X
                    if (c === '{') {
                        const pv = prevNonWs(mask, j);
                        const pb = prev2(mask, j)[1];
                        const pw = prevWord(mask, j);
                        if (pv === ':' || pv === '|' || pv === '&' || pv === ',' || pv === '(' || pv === '[' || pv === '<' || pv === '?' ||
                            (pv === '>' && pb === '=') ||
                            pw === 'extends' || pw === 'keyof' || pw === 'typeof' || pw === 'infer' || pw === 'readonly' || pw === 'new') {
                            const e2 = matchBrace(mask, j);
                            if (e2 < 0) return {stop: 'reject'};
                            j = e2 + 1;
                            continue;
                        }
                        found = true;
                        break;
                    }
                    if (c === '=' && mask[j + 1] !== '>') return {stop: 'reject'};
                    j++;
                }
                if (!found) return {stop: 'reject'};
            }
            if (mask[j] === '{') return {bodyStart: j, arrow: false};
            return {stop: 'reject'};
        }
        if (mask[j] === '(') { // стрелка после «=»/«= async»
            const e = matchParen(mask, j);
            if (e < 0) return {stop: 'reject'};
            j = e + 1;
            ws();
            if (mask[j] === ':') { // (x): T => { … }
                j++;
                ws();
                const guard = j + 2000;
                let arrowAfter = false;
                while (j < n && j < guard) {
                    const c = mask[j];
                    if (c === '=' && mask[j + 1] === '>') { j += 2; arrowAfter = true; break; }
                    if (c === '{') { const e2 = matchBrace(mask, j); if (e2 < 0) return {stop: 'reject'}; j = e2 + 1; continue; }
                    if (c === ';') return {stop: 'reject'};
                    j++;
                }
                if (!arrowAfter) return {stop: 'reject'};
                ws();
            }
            if (mask[j] === '=' && mask[j + 1] === '>') { j += 2; ws(); }
            if (mask[j] === '{') return {bodyStart: j, arrow: true};
            return {stop: 'expr'}; // тело-выражение
        }
        return {stop: 'reject'}; // не функция
    }
    if (mask[j] === '{') return {bodyStart: j, arrow: false};
    if (mask[j] === ';') return {stop: 'skip'};
    if (mask[j] === '}') return {stop: 'skip'};
    return {stop: 'reject'};
}

function kindLabel(mask, span, pos, arrow, name, kind) {
    const pw = prevWord(mask, pos);
    if (kind === 'get' || kind === 'set') return kind + ':' + name;
    if (pw === 'function') return 'function';
    if (pw === 'const' || pw === 'let' || pw === 'var') return arrow ? 'const-arrow' : 'const-function';
    if (name === 'constructor') return 'constructor';
    if (span) return arrow ? 'arrow' : 'method';
    return arrow ? 'const-arrow' : 'function';
}

function fallbackFind() {
    const mask = maskCode(src, isTsx);
    const occ = findOccurrences(mask, spec.name);
    if (!occ.length) return {error: 'символ не найден в ' + args.file + ': ' + args.symbol};
    const spans = classSpans(mask);
    const cands = [], sigOnly = [], exprBody = [];
    for (const pos of occ) {
        if (spec.kind === 'get' || spec.kind === 'set') {
            if (prevWord(mask, pos) !== spec.kind) continue;
        }
        if (spec.kind === 'ctor' && prevWord(mask, pos) === '.') continue;
        const r = headScan(mask, pos, spec.name.length);
        if (r.stop === 'reject') continue;
        if (r.stop === 'skip') { sigOnly.push(pos); continue; }
        if (r.stop === 'expr') { exprBody.push(pos); continue; }
        const span = spans.find((s) => pos > s.start && r.bodyStart < s.end) || null;
        const cls = span ? span.name : null;
        if (spec.cls && cls !== spec.cls) continue; // квалифицированный адрес — только этот класс
        cands.push({pos, cls, kind: kindLabel(mask, span, pos, r.arrow, spec.name, spec.kind), bodyStart: r.bodyStart});
    }
    if (cands.length > 1) {
        return {
            error: 'символ неоднозначен — уточни класс (Class.' + spec.name + '). Кандидаты:',
            candidates: cands.map((c) => (c.cls ? c.cls + '.' : '') + spec.name + ' [' + c.kind + '] L' + (lineIndex(c.pos) + 1))
        };
    }
    if (cands.length === 1) {
        const c = cands[0];
        const bodyEnd = matchBrace(mask, c.bodyStart);
        if (bodyEnd < 0) return {error: 'не найдена закрывающая «}» тела ' + args.symbol};
        // проверка отступа закрывающей скобки (если она первая в своей строке)
        const closePrefix = src.slice(lineStartOf(bodyEnd), bodyEnd);
        if (/^[ \t]+$/.test(closePrefix)) {
            const declIndent = /^[ \t]*/.exec(src.slice(lineStartOf(c.bodyStart), c.bodyStart))[0];
            if (closePrefix !== declIndent)
                return {error: 'подозрительный разбор: отступ закрывающей «}» (L' + (lineIndex(bodyEnd) + 1) + ') не совпадает с отступом объявления — операция отменена'};
        }
        return {cand: c, bodyEnd, mask};
    }
    if (exprBody.length)
        return {error: '«' + args.symbol + '» — стрелка с телом-выражением (без {…}); заменяются только блочные тела'};
    if (sigOnly.length)
        return {error: '«' + args.symbol + '» найден только как сигнатура без тела (перегрузка/abstract/interface)'};
    if (spec.cls)
        return {error: 'в классе ' + spec.cls + ' тело «' + spec.name + '» не найдено'};
    return {error: 'символ не найден: ' + args.symbol};
}

// ---------- 4. TS-движок: Compiler API ----------

function loadTS(fromDir, fromCwd) {
    const tries = [];
    try { tries.push(require.resolve('typescript', {paths: [fromDir, fromCwd]})); } catch (e) {}
    try { const p = require.resolve('typescript'); if (!tries.includes(p)) tries.push(p); } catch (e) {}
    for (const p of tries) {
        try {
            const m = require(p);
            // typescript@7 (нативный порт) не имеет классического JS API — пропускаем
            if (m && typeof m.createSourceFile === 'function' && m.SyntaxKind && m.ScriptTarget) return m;
        } catch (e) {}
    }
    return null;
}

let ts = null;
if (engineMode === 'auto' || engineMode === 'ts') {
    ts = loadTS(path.dirname(absFile), cwd);
    if (engineMode === 'ts' && !ts)
        fail('пакет typescript в проекте не найден (engine=ts); используй engine=auto — сработает fallback-режим');
} else if (engineMode !== 'fallback') {
    fail('engine= может быть auto | ts | fallback, получено: ' + engineMode);
}

function tsFind() {
    const scriptKind = isTsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sf = ts.createSourceFile(absFile, src, ts.ScriptTarget.Latest, false, scriptKind);
    const baseDiags = sf.parseDiagnostics.length;
    const identText = (n) => n && ts.isIdentifier(n) ? n.text : null;
    const usable = [], near = [];
    const lineOf = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    function push(node, bodyNode, kind, clsName) {
        usable.push({bodyNode, kind, clsName, line: lineOf(node)});
    }
    const checkFnLike = (node, init, kind, clsName) => {
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
            if (init.body && ts.isBlock(init.body)) push(node, init.body, kind, clsName);
            else near.push({kind, line: lineOf(node), why: 'тело-выражение (без {…})'});
        }
    };
    const visit = (node) => {
        if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
            const cname = identText(node.name);
            for (const m of node.members) {
                if (spec.cls && cname !== spec.cls) continue;
                const mname = identText(m.name);
                if (spec.kind === 'ctor') {
                    if (ts.isConstructorDeclaration(m)) {
                        if (m.body) push(m, m.body, 'constructor', cname);
                        else near.push({kind: 'constructor', line: lineOf(m), why: 'без тела'});
                    }
                    continue;
                }
                if (spec.kind === 'get' || spec.kind === 'set') {
                    const isAcc = spec.kind === 'get' ? ts.isGetAccessorDeclaration(m) : ts.isSetAccessorDeclaration(m);
                    if (isAcc && mname === spec.name) {
                        if (m.body) push(m, m.body, spec.kind + ':' + spec.name, cname);
                        else near.push({kind: spec.kind + ':' + spec.name, line: lineOf(m), why: 'без тела'});
                    }
                    continue;
                }
                if (mname !== spec.name) continue;
                if (ts.isMethodDeclaration(m)) {
                    if (m.body) push(m, m.body, 'method', cname);
                    else near.push({kind: 'method', line: lineOf(m), why: 'сигнатура без тела'});
                } else if (ts.isPropertyDeclaration(m) && m.initializer) {
                    checkFnLike(m, m.initializer, 'arrow', cname);
                } else if ((ts.isGetAccessorDeclaration(m) || ts.isSetAccessorDeclaration(m))) {
                    if (m.body) push(m, m.body, (ts.isGetAccessorDeclaration(m) ? 'get:' : 'set:') + spec.name, cname);
                }
            }
        }
        if (!spec.cls && spec.kind === 'plain') {
            if (ts.isFunctionDeclaration(node) && identText(node.name) === spec.name) {
                if (node.body) push(node, node.body, 'function', null);
                else near.push({kind: 'function', line: lineOf(node), why: 'сигнатура без тела'});
            }
            if (ts.isVariableDeclaration(node) && identText(node.name) === spec.name && node.initializer) {
                checkFnLike(node, node.initializer, 'const-arrow', null);
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
    const label = (u) => (u.clsName ? u.clsName + '.' : '') + spec.name + ' [' + u.kind + '] L' + u.line;
    if (usable.length > 1) {
        return {
            error: 'символ неоднозначен — уточни класс (Class.' + spec.name + '). Кандидаты:',
            candidates: usable.map(label)
        };
    }
    if (usable.length === 1) {
        const u = usable[0];
        const bodyStart = u.bodyNode.getStart(sf);
        const bodyEnd = u.bodyNode.end - 1;
        if (src[bodyStart] !== '{' || src[bodyEnd] !== '}')
            return {error: 'внутренняя ошибка: позиции тела не указывают на { и }'};
        return {cand: {bodyStart, kind: u.kind, cls: u.clsName}, bodyEnd, baseDiags};
    }
    if (near.length)
        return {error: '«' + args.symbol + '»: ' + near[0].why, candidates: near.map((x) => (x.clsName ? x.clsName + '.' : '') + spec.name + ' [' + x.kind + '] L' + x.line)};
    return {error: 'символ не найден: ' + args.symbol};
}

// ---------- 5. Отступы и сборка нового тела ----------

// шаг отступа, если старое тело пустое: смотрим ближайший соседний блок с тем же отступом объявления
function fallbackStep(mask, bodyEnd, declIndent) {
    let j = bodyEnd + 1;
    const limit = Math.min(mask.length, bodyEnd + 20000);
    while (j < limit) {
        if (mask[j] === '{') {
            if (src.slice(lineStartOf(j), j) === declIndent) {
                const e = matchBrace(mask, j);
                const m = /^[ \t]*/.exec(src.slice(j + 1, e));
                const first = m ? m[0] : '';
                if (first.length > declIndent.length) return first.slice(declIndent.length);
                j = e + 1;
                continue;
            }
            j++;
            continue;
        }
        j++;
    }
    return declIndent.indexOf('\t') >= 0 ? '\t' : '  ';
}

function computeIndents(mask, braceOpen, innerStart, innerEnd) {
    const declIndent = /^[ \t]*/.exec(src.slice(lineStartOf(braceOpen), braceOpen))[0];
    const oldInner = src.slice(innerStart, innerEnd);
    let minInd = null;
    for (const line of oldInner.split(/\r\n|\n|\r/)) {
        if (!line.trim()) continue;
        const ind = /^[ \t]*/.exec(line)[0];
        if (minInd === null || ind.length < minInd.length) minInd = ind;
    }
    let stepStr = null;
    if (minInd && minInd.length > declIndent.length && minInd.startsWith(declIndent)) {
        stepStr = minInd.slice(declIndent.length);
    } else {
        stepStr = fallbackStep(mask, innerEnd, declIndent);
    }
    return {declIndent, minInd, stepStr};
}

function normalizeBody(raw, ctx) {
    if (indentMode === 'raw') {
        let b = raw;
        if (b.endsWith('\r\n')) b = b.slice(0, -2);
        else if (b.endsWith('\n') || b.endsWith('\r')) b = b.slice(0, -1);
        return b;
    }
    let lines = raw.replace(/\r\n?/g, '\n').split('\n');
    while (lines.length && !lines[0].trim()) lines.shift();
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    if (!lines.length) return '';
    // если всё тело целиком обёрнуто в один внешний { … } — снимаем обёртку
    const t = lines.join('\n').trim();
    if (t.startsWith('{') && t.endsWith('}')) {
        const m = maskCode(t, false);
        if (matchBrace(m, 0) === m.length - 1) {
            lines = t.slice(1, -1).replace(/^\r?\n/, '').replace(/\r?\n[ \t]*$/, '').split('\n');
            while (lines.length && !lines[0].trim()) lines.shift();
            while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
        }
    }
    // дедент по минимальному общему отступу
    const inds = lines.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)[0]);
    const common = inds.reduce((a, b) => b.length < a.length ? b : a, inds[0]);
    const rel = lines.map((l) => l.startsWith(common) ? l.slice(common.length) : l.replace(/^[ \t]+/, ''));
    // базовый отступ
    let base;
    if (indentMode === '2' || indentMode === '4') base = ctx.declIndent + ' '.repeat(+indentMode);
    else if (indentMode === 'tab') base = ctx.declIndent + '\t';
    else if (ctx.minInd && ctx.minInd.length > ctx.declIndent.length) base = ctx.minInd; // наследуем старое тело
    else base = ctx.declIndent + ctx.stepStr;
    return rel.map((l) => l.trim() ? base + l : '').join(eol);
}

function buildContent(innerStart, innerEnd, newBody, declIndent) {
    const oldInner = src.slice(innerStart, innerEnd);
    const closeIsFirst = src.slice(lineStartOf(innerEnd), innerEnd).trim() === '';
    let inner;
    if (!newBody) inner = '';
    else if (closeIsFirst) {
        inner = eol + newBody + eol + src.slice(lineStartOf(innerEnd), innerEnd);
    } else if (!oldInner) {
        // пустое старое тело {…} на одной строке — разворачиваем в блок
        inner = eol + newBody + eol + declIndent;
    } else {
        inner = ' ' + newBody + ' '; // однострочный стиль — держим в тех же скобках
    }
    return src.slice(0, innerStart) + inner + src.slice(innerEnd);
}

// ---------- 6. Главная логика ----------

let mask, found, baseDiags = 0;
if (ts) {
    found = tsFind();
    if (found.error) fail(found.error, found.candidates ? {candidates: found.candidates} : undefined);
    baseDiags = found.baseDiags;
    mask = maskCode(src, isTsx); // для расчёта отступа соседних блоков
} else {
    found = fallbackFind();
    if (found.error) fail(found.error, found.candidates ? {candidates: found.candidates} : undefined);
    mask = found.mask;
}

const braceOpen = found.cand.bodyStart;
const innerStart = braceOpen + 1;
const innerEnd = found.bodyEnd;
if (src[braceOpen] !== '{' || src[innerEnd] !== '}')
    fail('внутренняя ошибка: позиции тела некорректны');

const indents = computeIndents(mask, braceOpen, innerStart, innerEnd);
const newBody = normalizeBody(bodyRaw, indents);
let newContent = buildContent(innerStart, innerEnd, newBody, indents.declIndent);

// валидация нового содержимого
if (ts) {
    const scriptKind = isTsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sfNew = ts.createSourceFile(absFile, newContent, ts.ScriptTarget.Latest, false, scriptKind);
    if (sfNew.parseDiagnostics.length > baseDiags) {
        const d = sfNew.parseDiagnostics[baseDiags];
        const msg = ts.flattenDiagnosticMessageText(d.messageText, ' ');
        const line = d.start === undefined ? '?' : sfNew.getLineAndCharacterOfPosition(d.start).line + 1;
        fail('новое тело не проходит синтаксическую проверку TypeScript (L' + line + '): ' + msg + ' — файл НЕ изменён');
    }
} else {
    if (bracketsBalanced(src) && !bracketsBalanced(newContent))
        fail('новое тело нарушает баланс скобок — файл НЕ изменён');
}

// строки отчёта — по НОВОМУ содержимому
const NEW_STARTS = lineStartsOf(newContent);
function newLineIndex(off) {
    let lo = 0, hi = NEW_STARTS.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (NEW_STARTS[mid] <= off) lo = mid; else hi = mid - 1;
    }
    return lo;
}
const closeBraceNew = newContent.length - (src.length - innerEnd); // позиция «}» в новом тексте
const fromLine = newLineIndex(braceOpen) + 1;
const toLine = newLineIndex(closeBraceNew) + 1;

const result = {
    ok: true,
    file: path.relative(cwd, absFile).replace(/\\/g, '/'),
    symbol: args.symbol,
    engine: ts ? 'ts' : 'fallback',
    body: {from: fromLine, to: toLine},
    indent: indentMode,
    eol: eol === '\r\n' ? 'crlf' : 'lf',
    bom,
    dry,
    written: !dry,
    bytes: Buffer.byteLength(newContent, 'utf8')
};

if (!dry) {
    const mode = fs.statSync(absFile).mode;
    const tmp = absFile + '.edit-symbol-tmp';
    try {
        fs.writeFileSync(tmp, (bom ? '\uFEFF' : '') + newContent, {mode});
        fs.renameSync(tmp, absFile);
    } catch (e) {
        try {
            fs.unlinkSync(absFile);
            fs.renameSync(tmp, absFile);
        } catch (e2) {
            try { fs.unlinkSync(tmp); } catch (e3) {}
            fail('не удалось записать файл (атомарная запись): ' + e.message);
        }
    }
    if (absBodyFile && bodyFileDelete) {
        try {
            fs.unlinkSync(absBodyFile);
            result.deleted_body_file = bodyFilePath;
        } catch (e) {
        }
    }
}
emit(result);
