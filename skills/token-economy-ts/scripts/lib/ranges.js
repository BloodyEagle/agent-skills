// ranges.js — консервативное вычисление диапазонов объявлений и тел по маскированному тексту.
// Работает по маске lib/mask.js (строки/комментарии/шаблоны/regex забиты пробелами, длины
// и переводы строк сохранены). Возврат содержит только те поля, которые определены надёжно:
// сомнительная граница не выдаётся вовсе, а не угадывается. Это fallback без TypeScript
// Compiler API; на неподдержанном синтаксисе конец отсутствует.

const {skipWs, matchBrace, matchParen} = require('./mask');

const MODIFIERS = new Set(['export', 'default', 'declare', 'abstract', 'async', 'public', 'private', 'protected', 'static', 'readonly', 'override', 'get', 'set']);
const PREFIX_TYPES = new Set(['typeof', 'keyof', 'readonly', 'new', 'infer', 'import', 'asserts']);
const DECL_KEYWORDS = new Set(['export', 'import', 'interface', 'type', 'class', 'enum', 'function', 'const', 'let', 'var', 'declare', 'abstract', 'async', 'public', 'private', 'protected', 'static', 'readonly', 'constructor', 'namespace', 'module']);
const STMT_KEYWORDS = new Set(['return', 'if', 'for', 'while', 'switch', 'try', 'throw', 'case', 'break', 'continue', 'do', 'else', 'yield', 'await', 'delete', 'void', 'typeof']);

const isIdStart = (c) => /[$_\p{ID_Start}]/u.test(c);

function wordAt(mask, p) {
    let e = p;
    while (e < mask.length && /[$_\u200C\u200D\p{ID_Continue}]/u.test(mask[e])) e++;
    return mask.slice(p, e);
}

function matchBracket(mask, open) {
    let depth = 0;
    for (let j = open; j < mask.length; j++) {
        if (mask[j] === '[') depth++;
        else if (mask[j] === ']') {
            depth--;
            if (!depth) return j;
        }
    }
    return -1;
}

/**
 * Баланс <…> для generics: «=>» не считается закрытием угла; внутри могут быть
 * object types и function types, поэтому «{»/«(» не прерывают скан.
 */
function skipAngle(mask, from) {
    let depth = 0;
    for (let j = from; j < mask.length; j++) {
        const c = mask[j];
        if (c === '<') depth++;
        else if (c === '>') {
            if (mask[j - 1] === '=') continue;
            depth--;
            if (depth === 0) return j + 1;
        } else if (c === ';') return -1;
    }
    return -1;
}

/**
 * Пропускает модификаторы объявления; возвращает позицию ключевого слова или имени.
 */
function skipModifiers(mask, p) {
    for (;;) {
        p = skipWs(mask, p);
        if (p >= mask.length) return p;
        const c = mask[p];
        if (c === '*') { p++; continue; }        // generator function*
        if (c === '#') { p++; continue; }        // приватный член
        const w = wordAt(mask, p);
        if (w && MODIFIERS.has(w)) { p += w.length; continue; }
        return p;
    }
}

/**
 * Конец «;» объявления после закрывающей скобки тела: включаем только «;», примыкающую
 * сразу за телом (через пробелы).
 */
function afterSemi(mask, close) {
    let n = close + 1;
    while (n < mask.length && (mask[n] === ' ' || mask[n] === '\t' || mask[n] === '\r')) n++;
    return mask[n] === ';' ? n : close;
}

/**
 * ASI-эвристика: продолжается ли оператор после перевода строки на позиции nl.
 */
function asiContinues(mask, nl) {
    let e = nl - 1;
    while (e >= 0 && (mask[e] === ' ' || mask[e] === '\t' || mask[e] === '\r')) e--;
    const last = e >= 0 ? mask[e] : '';
    let b = nl + 1;
    while (b < mask.length && (mask[b] === ' ' || mask[b] === '\t' || mask[b] === '\r' || mask[b] === '\n')) b++;
    if (b >= mask.length) return false;
    const nextWord = wordAt(mask, b);
    if (last && '|&?:.,=<>+-*/%([{'.includes(last)) return true;   // строка кончается оператором
    if (mask[b] === '}' || mask[b] === '@') return false;
    if (DECL_KEYWORDS.has(nextWord) || STMT_KEYWORDS.has(nextWord)) return false;
    if ('|&?:.,)]}([<'.includes(mask[b]) || (mask[b] === '=' && mask[b + 1] === '>')) return true;
    // идентификатор/число в начале следующей строки: для entity-операторов считаем концом
    // (ограничение: подставленные в продолжение выражения без оператора встречаются редко)
    return false;
}

/**
 * Конец оператора без тела: «;» на нулевой глубине либо ASI-эвристика. Углы считаются
 * с клампом (сравнения «a > b» не уводят глубину). null — надёжного конца нет.
 */
function stmtEnd(mask, from) {
    let paren = 0, brack = 0, brace = 0, angle = 0;
    for (let i = from; i < mask.length; i++) {
        const c = mask[i];
        if (c === ';') {
            if (!paren && !brack && !brace && !angle) return i;
            continue;
        }
        if (c === '(') paren++;
        else if (c === ')') {
            if (!paren && !brack && !brace && !angle) return i - 1 >= from ? i - 1 : null;
            paren--;
        } else if (c === '[') brack++;
        else if (c === ']') {
            if (!paren && !brack && !brace && !angle) return i - 1 >= from ? i - 1 : null;
            brack--;
        } else if (c === '{') brace++;
        else if (c === '}') {
            if (!paren && !brack && !brace && !angle) return i - 1 >= from ? i - 1 : null;
            brace--;
        } else if (c === '<') {
            if (!paren && !brack && !brace) angle++;
        } else if (c === '>') {
            if (!paren && !brack && !brace && angle) angle--;
        } else if (c === '\n') {
            if (paren || brack || brace || angle) continue;
            if (!asiContinues(mask, i)) {
                let e = i - 1;
                while (e >= from && (mask[e] === ' ' || mask[e] === '\t' || mask[e] === '\r')) e--;
                return e >= from ? e : null;
            }
        }
    }
    let e = mask.length - 1;
    while (e >= from && (mask[e] === ' ' || mask[e] === '\t' || mask[e] === '\r' || mask[e] === '\n')) e--;
    return e >= from ? e : null;
}

/**
 * Диапазон тела по открытой '{'. Включает примыкающую «;» в конец объявления.
 */
function bodySpan(mask, open) {
    const close = matchBrace(mask, open);
    if (close === -1) return {bodyOpen: open};
    return {bodyOpen: open, bodyClose: close, endPos: afterSemi(mask, close)};
}

/**
 * После списка параметров: тело / тип результата / стрелка / «;» (abstract, overload).
 */
function afterParams(mask, q) {
    q = skipWs(mask, q);
    const c = mask[q];
    if (c === '{') return bodySpan(mask, q);
    if (c === ':') {
        const t = typeScan(mask, q + 1);
        if (!t) return null;
        if (t.status === 'body') return bodySpan(mask, t.pos);
        if (t.status === 'arrow') return afterArrow(mask, t.pos + 2);
        if (t.status === 'end') return {endPos: t.pos};
        return null;
    }
    if (c === '=' && mask[q + 1] === '>') return afterArrow(mask, q + 2);
    return null;
}

/**
 * Тело-выражение стрелки: конец оператора или отказ.
 */
function afterArrow(mask, q) {
    const p = skipWs(mask, q);
    if (p < mask.length && mask[p] === '{') return bodySpan(mask, p);
    const end = stmtEnd(mask, q);
    return end == null ? null : {endPos: end};
}

/**
 * Сканер типа результата после «:». Правила:
 * — '{' сразу после «:» или после «|»/«&» — object literal type (после «|» проверяем, что за
 *   закрывающей скобкой: тело функции тоже продолжается оператором, но не «{» типа);
 * — «=>» после «(…)» — function type, продолжаем; «=>» после прочего терма — тело-стрелка;
 * — «;» на нулевой глубине — конец объявления без тела.
 */
function typeScan(mask, from) {
    let p = skipWs(mask, from);
    let start = true;
    let union = false;
    let lastParen = false;
    let branch = false;    // следующее «{» — ветка conditional type, не тело
    let condColon = false; // ждём «:» ветки else conditional type
    for (;;) {
        p = skipWs(mask, p);
        if (p >= mask.length) return null;
        const c = mask[p];
        if (c === '{') {
            if (start || branch) {
                const e = matchBrace(mask, p);
                if (e === -1) return null;
                p = e + 1; start = false; lastParen = false; union = false; branch = false;
                continue;
            }
            if (union) {
                const e = matchBrace(mask, p);
                if (e === -1) return null;
                const n = skipWs(mask, e + 1);
                const d = mask[n];
                if (d === ';') return {status: 'end', pos: n}; // union объектных типов, тело нет
                if (d === '{' || d === '|' || d === '&' || d === '[') {
                    p = e + 1; start = false; lastParen = false; union = false;
                    continue;
                }
                const w = wordAt(mask, n);
                if (w === 'extends') {
                    p = e + 1; start = false; lastParen = false; union = false;
                    continue;
                }
                return {status: 'body', pos: p};
            }
            return {status: 'body', pos: p};
        }
        if (c === '.') {
            // postfix после любого завершённого терма: .имя
            p = skipWs(mask, p + 1);
            while (p < mask.length && /[$_\u200C\u200D\p{ID_Continue}]/u.test(mask[p])) p++;
            start = false; lastParen = false; union = false; branch = false;
            continue;
        }
        if (c === '(') {
            const e = matchParen(mask, p);
            if (e === -1) return null;
            p = e + 1; start = false; lastParen = true; union = false; branch = false;
            continue;
        }
        if (c === '[') {
            const e = matchBracket(mask, p);
            if (e === -1) return null;
            p = e + 1; start = false; lastParen = false; union = false; branch = false;
            continue;
        }
        if (c === '<') {
            const e = skipAngle(mask, p);
            if (e === -1) return null;
            p = e; start = false; lastParen = false; union = false; branch = false;
            continue;
        }
        if (isIdStart(c) || c === '_') {
            let e = p;
            while (e < mask.length && /[$_\u200C\u200D\p{ID_Continue}]/u.test(mask[e])) e++;
            const w = mask.slice(p, e);
            if (!w) return null; // страховка от зацикливания
            p = e;
            if (start && PREFIX_TYPES.has(w)) continue; // префикс термина — следующий кусок тот же термин
            start = false;
            if (w === 'extends') {
                // conditional type: следующий термин, затем ? … : …
                union = false; lastParen = false; branch = false;
                continue;
            }
            branch = false; // терм ветки consumed — дальше «{» может быть телом
            // postfix: .имя, <…>, […]
            for (;;) {
                const n = skipWs(mask, p);
                const d = mask[n];
                if (d === '.') {
                    p = skipWs(mask, n + 1);
                    while (p < mask.length && /[$_\u200C\u200D\p{ID_Continue}]/u.test(mask[p])) p++;
                    continue;
                }
                if (d === '<') {
                    const e2 = skipAngle(mask, n);
                    if (e2 === -1) return null;
                    p = e2;
                    continue;
                }
                if (d === '[') {
                    const e3 = matchBracket(mask, n);
                    if (e3 === -1) return null;
                    p = e3 + 1;
                    continue;
                }
                break;
            }
            lastParen = false; union = false;
            continue;
        }
        if (c === '|' || c === '&') {
            union = true; start = false; p++;
            continue;
        }
        if (c === '?' && !start) {
            branch = true; condColon = true; p++;   // ветка then conditional type — «{» будет типом
            continue;
        }
        if (c === ':' && condColon) {
            branch = true; condColon = false; p++;  // ветка else conditional type — «{» будет типом
            continue;
        }
        if (c === '=' && mask[p + 1] === '>') {
            if (lastParen) {
                p += 2; start = false; lastParen = false; union = false;
                continue; // function type — возвращаемый тип
            }
            return {status: 'arrow', pos: p};
        }
        if (c === ';') return {status: 'end', pos: p};
        return null;
    }
}

/**
 * Функция/метод/стрелка: пропускаем имя и generics, находим «(…)» либо «=>» без параметров.
 */
function fnScan(mask, p) {
    let q = p;
    for (;;) {
        q = skipWs(mask, q);
        if (q >= mask.length) return null;
        const c = mask[q];
        if (c === '(') {
            const close = matchParen(mask, q);
            if (close === -1) return null;
            return afterParams(mask, close + 1);
        }
        if (c === '=' && mask[q + 1] === '>') return afterArrow(mask, q + 2);
        if (c === '<') {
            const e = skipAngle(mask, q);
            if (e === -1) return null;
            q = e;
            continue;
        }
        if (c === '[') {
            // computed-имя члена: [Symbol.iterator]
            const e = matchBracket(mask, q);
            if (e === -1) return null;
            q = e + 1;
            continue;
        }
        if (isIdStart(c) || c === '_' || /\d/.test(c)) { q += wordAt(mask, q).length; continue; }
        if (c === '?' || c === '.' || c === '=' || c === '!' || c === ',' || c === '*' || c === ':') { q++; continue; }
        return null;
    }
}

/**
 * class / interface / enum: тело — первая «{» на нулевой глубине скобок заголовка.
 */
function braceKind(mask, p) {
    let paren = 0, brack = 0;
    for (let i = p; i < mask.length; i++) {
        const c = mask[i];
        if (c === '(') paren++;
        else if (c === ')') paren--;
        else if (c === '[') brack++;
        else if (c === ']') brack--;
        else if (c === '{' && paren === 0 && brack === 0) return bodySpan(mask, i);
    }
    return null;
}

function compute(mask, declStart, kind) {
    const p = skipModifiers(mask, declStart);
    if (kind === 'class' || kind === 'interface' || kind === 'enum') return braceKind(mask, p);
    if (kind === 'method' || kind === 'function' || kind === 'const') return fnScan(mask, p);
    // type / property / export / прочее — оператор до «;» или ASI
    const end = stmtEnd(mask, p);
    return end == null ? null : {endPos: end};
}

/**
 * Диапазоны объявления. kind: class | interface | enum | type | function | const |
 * method | property. declStart — смещение первого символа объявления («export» или
 * ключевое слово). Возвращает только надёжно определённые поля:
 * {startLine, endLine, bodyStartLine, bodyEndLine}.
 */
function entityRanges(mask, declStart, kind, lineAt) {
    let r = null;
    try {
        r = compute(mask, declStart, kind);
    } catch (e) {
        r = null;
    }
    const out = {startLine: lineAt(declStart)};
    if (!r) return out;
    const end = r.endPos != null ? lineAt(r.endPos) : (r.bodyClose != null ? lineAt(r.bodyClose) : null);
    if (end != null && end >= out.startLine) out.endLine = end;
    if (r.bodyOpen != null && r.bodyClose != null) {
        const bs = lineAt(r.bodyOpen), be = lineAt(r.bodyClose);
        if (bs >= out.startLine && be >= bs && (out.endLine == null || be <= out.endLine)) {
            out.bodyStartLine = bs;
            out.bodyEndLine = be;
        }
    }
    return out;
}

module.exports = {entityRanges, stmtEnd};
