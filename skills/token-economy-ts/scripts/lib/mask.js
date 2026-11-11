// mask.js — общая маска кода и сканеры скобок для edit-symbol и диапазонов объявлений.
// Алгоритм перенесён из edit-symbol.js без изменений поведения.

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

function lineStartsOf(text) {
    const starts = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
    return starts;
}

/**
 * Маска кода: содержимое строк, шаблонов (вкл. вложенные ${…}), комментариев и regex
 * заменяется пробелами. Длина и переводы строк сохраняются 1:1, идентификаторы и знаки
 * остаются — по маске ищем имена и скобки, не боясь «}» внутри строки.
 */
function maskCode(text, jsx) {
    const n = text.length;
    const out = new Array(n);
    const LETTER = /[A-Za-z0-9_$\u00C0-\u024F\u0370-\u04FF\u4E00-\u9FFF]/; // для апострофов JSX-текста
    const stack = [{m: 'code', nest: 0}]; // code | tpl | jsxText | jsxTag
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
        // JSX-разметка и текст не участвуют в балансе; выражения {…} остаются кодом.
        if (top.m === 'jsxText' || top.m === 'jsxTag') {
            if (c === '{') {
                out[i] = '{';
                stack.push({m: 'code', nest: 0, jsxExpr: true});
                lastCode = '{'; lastWord = '';
                i++;
                continue;
            }
            if (top.m === 'jsxText' && c === '<') {
                stack.push({m: 'jsxTag', closing: text[i + 1] === '/'});
            } else if (top.m === 'jsxTag' && (c === '"' || c === "'")) {
                let end = i + 1;
                while (end < n && text[end] !== c) { if (text[end] === '\\') end++; end++; }
                end = Math.min(n, end + 1);
                maskPlain(i, end);
                i = end;
                continue;
            } else if (top.m === 'jsxTag' && c === '>') {
                stack.pop();
                const parent = stack[stack.length - 1];
                if (top.closing) parent.depth--;
                else if (prevNonWs(text, i) !== '/') parent.depth++;
                if (parent.depth === 0) { stack.pop(); lastCode = 'w'; lastWord = ''; }
            }
            out[i] = c === '\n' || c === '\r' ? c : ' ';
            i++;
            continue;
        }
        // --- режим кода ---
        if (jsx && c === '<' && /^<(?:>|[A-Za-z][\w:.-]*(?=[\s/>]))/.test(text.slice(i))
            && (lastCode === '' || '([=,:?{>!&|'.includes(lastCode) || lastWord === 'return' || lastWord === 'yield')) {
            stack.push({m: 'jsxText', depth: 0}, {m: 'jsxTag', closing: false});
            out[i] = ' ';
            i++;
            continue;
        }
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
                else { out[i] = top.jsxExpr ? '}' : ' '; stack.pop(); } // закрытие JSX {…} или ${…}
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

module.exports = {WSC, skipWs, prevNonWs, prevWord, readWord, matchBrace, matchParen, prev2, lineStartsOf, maskCode};
