const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'new', 'else', 'do', 'try', 'finally', 'typeof', 'instanceof', 'in', 'of', 'case', 'throw', 'await']);
const {entityRanges} = require('./ranges');

/**
 * Маскирует строки, комментарии и regex; выражения ${…} остаются кодом.
 * @param {string} text Исходный текст.
 * @returns {string} Маска той же длины с сохранёнными переводами строк.
 */
function sourceCodeMask(text) {
    const out = text.split('');
    const stack = [{kind: 'code', depth: 0}];
    const parens = [];
    const controlWords = new Set(['if', 'while', 'for', 'with', 'switch', 'catch']);
    const regexWords = new Set(['return', 'throw', 'case', 'typeof', 'void', 'delete', 'yield', 'await', 'new', 'instanceof', 'in', 'of', 'else', 'do']);
    let i = 0, last = '', word = '';
    const blank = (start, end) => {
        for (let k = start; k < end; k++) if (text[k] !== '\n' && text[k] !== '\r') out[k] = ' ';
    };
    while (i < text.length) {
        const c = text[i], next = text[i + 1], top = stack[stack.length - 1];
        if (top.kind === 'template') {
            if (c === '\\') { blank(i, Math.min(i + 2, text.length)); i += 2; continue; }
            if (c === '`') { blank(i, i + 1); stack.pop(); i++; last = 'w'; word = ''; continue; }
            if (c === '$' && next === '{') {
                blank(i, i + 2); stack.push({kind: 'code', depth: 0}); i += 2; last = ''; word = ''; continue;
            }
            blank(i, i + 1); i++; continue;
        }
        if (c === '/' && (next === '/' || next === '*')) {
            const start = i;
            i += 2;
            if (next === '/') while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i++;
            else {
                while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
                i = Math.min(i + 2, text.length);
            }
            blank(start, i); continue;
        }
        if (c === "'" || c === '"') {
            const start = i++;
            while (i < text.length && text[i] !== c && text[i] !== '\n' && text[i] !== '\r') {
                if (text[i] === '\\') i++;
                i++;
            }
            if (text[i] === c) i++;
            blank(start, i); last = 'w'; word = ''; continue;
        }
        if (c === '`') { blank(i, i + 1); stack.push({kind: 'template'}); i++; continue; }
        if (c === '/' && (last === '' || '([=!:&|?,;{+-*%^~<>'.includes(last) || regexWords.has(word))) {
            let end = i + 1, inClass = false, closed = false;
            while (end < text.length && text[end] !== '\n' && text[end] !== '\r') {
                const d = text[end];
                if (d === '\\') { end += 2; continue; }
                if (d === '[') inClass = true;
                else if (d === ']') inClass = false;
                else if (d === '/' && !inClass) { end++; closed = true; break; }
                end++;
            }
            if (closed) {
                while (end < text.length && /[a-z]/i.test(text[end])) end++;
                blank(i, end); i = end; last = 'w'; word = ''; continue;
            }
        }
        if (c === '{' && stack.length > 1) top.depth++;
        if (c === '}' && stack.length > 1) {
            if (top.depth === 0) { blank(i, i + 1); stack.pop(); i++; continue; }
            top.depth--;
        }
        if (c === '(') parens.push(controlWords.has(word));
        if (c === ')') {
            last = parens.pop() ? ';' : ')';
            word = '';
            i++;
            continue;
        }
        if ((c === '+' || c === '-') && next === c) {
            // Postfix ++/-- завершает выражение, prefix оставляет возможность regex-операнда.
            last = last === 'w' || ')]}'.includes(last) ? 'w' : c;
            word = '';
            i += 2;
            continue;
        }
        const point = String.fromCodePoint(text.codePointAt(i));
        if (/[$_\p{ID_Start}]/u.test(point)) {
            const start = i;
            i += point.length;
            while (i < text.length) {
                const nextPoint = String.fromCodePoint(text.codePointAt(i));
                if (!/[$\u200C\u200D\p{ID_Continue}]/u.test(nextPoint)) break;
                i += nextPoint.length;
            }
            word = text.slice(start, i); last = 'w'; continue;
        }
        if (!/\s/.test(c)) { last = c; word = ''; }
        i++;
    }
    return out.join('');
}

/**
 * Проверяет инициализатор стрелочной функции, включая generic и тип результата.
 * @param {string} text Маска инициализатора.
 * @returns {boolean} Начинается ли текст со стрелочной функции.
 */
function isArrowExpression(text) {
    return /^(?:async\s+)?(?:<[^;\n]+>\s*)?(?:\([^;\n]*\)\s*(?::[^=;\n]+)?=>|[$_\p{ID_Start}][$\u200C\u200D\p{ID_Continue}]*\s*=>)/u.test(text.trim());
}

function params(text) {
    const start = text.indexOf('(');
    if (start === -1) return '';
    let depth = 0;
    for (let i = start; i < text.length; i++) {
        if (text[i] === '(') depth++;
        if (text[i] === ')' && --depth === 0) return text.slice(start + 1, i).replace(/\s+/g, ' ').trim().slice(0, 120);
    }
    return '';
}

function classify(text) {
    const t = text.trim();
    let m;
    if ((m = t.match(/^(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:abstract\s+)?class\s+([$_\p{ID_Start}][$\u200C\u200D\p{ID_Continue}]*)/u))) return {kind: 'class', name: m[1]};
    if ((m = t.match(/^(?:export\s+)?(?:declare\s+)?interface\s+([$_\p{ID_Start}][$\u200C\u200D\p{ID_Continue}]*)/u))) return {kind: 'interface', name: m[1]};
    if ((m = t.match(/^(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([$_\p{ID_Start}][$\u200C\u200D\p{ID_Continue}]*)/u))) return {kind: 'enum', name: m[1]};
    if ((m = t.match(/^(?:export\s+)?(?:declare\s+)?type\s+([$_\p{ID_Start}][$\u200C\u200D\p{ID_Continue}]*)\s*=/u))) return {kind: 'type', name: m[1]};
    if ((m = t.match(/^(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?function\s*\*?\s*([$_\p{ID_Start}][$\u200C\u200D\p{ID_Continue}]*)/u))) return {kind: 'function', name: m[1]};
    m = t.match(/^(?:export\s+)?(?:declare\s+)?(?:const|let|var)\s+([$_\p{ID_Start}][$\u200C\u200D\p{ID_Continue}]*)\s*=\s*([\s\S]*)/u);
    if (m && (isArrowExpression(m[2]) || /^(?:async\s+)?function\b/.test(m[2]))) return {kind: 'function', name: m[1] + '(' + params(m[2]) + ')'};
    if ((m = t.match(/^(?:module\.exports|exports)\.([$_\p{ID_Start}][$\u200C\u200D\p{ID_Continue}]*)\s*=/u))) return {kind: 'export', name: m[1]};
    m = t.match(/^(?:(?:public|private|protected|static|readonly|override|abstract|async|get|set)\s+|\*\s*)*(#?[$_\p{ID_Start}][$\u200C\u200D\p{ID_Continue}]*)\s*\([^;]*\)\s*(?:\{|=>|:)/u);
    if (m && !KEYWORDS.has(m[1])) return {kind: m[1].startsWith('#') ? 'private-method' : 'method', name: m[1] + '(' + params(t) + ')'};
    m = t.match(/^(?:(?:public|private|protected|static|readonly|override|declare)\s+)*(#?[$_\p{ID_Start}][$\u200C\u200D\p{ID_Continue}]*)[?!]?\s*[:=]/u);
    if (m && !KEYWORDS.has(m[1])) {
        const assignment = t.indexOf('=');
        const arrow = assignment >= 0 && isArrowExpression(t.slice(assignment + 1));
        const kind = arrow ? 'method' : 'property';
        return {kind: m[1].startsWith('#') ? 'private-' + kind : kind, name: arrow ? m[1] + '(' + params(t) + ')' : m[1]};
    }
    return null;
}

/**
 * Извлекает объявления TS/JS и экспорты CommonJS без внешнего парсера.
 * @param {string} text Исходный текст.
 * @param {boolean} jsx JSX-режим маски (для .tsx/.jsx).
 * @returns {{kind: string, name: string, line: number, offset: number, owner?: string, startLine?: number, endLine?: number, bodyStartLine?: number, bodyEndLine?: number}[]} Символы с номерами строк, смещениями и диапазонами.
 */
function parseSymbols(text, jsx) {
    const normalized = text.replace(/\r\n?/g, '\n');
    const lines = sourceCodeMask(normalized).split('\n');
    const symbols = [];
    const classes = [];
    let depth = 0;
    let exportDepth = null;
    // Диапазоны считаются по отдельной JSX-aware маске (same length), lineAt — бинарным поиском.
    const lineStarts = [0];
    for (let i = 0; i < normalized.length; i++) if (normalized[i] === '\n') lineStarts.push(i + 1);
    const lineAt = (off) => {
        let lo = 0, hi = lineStarts.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (lineStarts[mid] <= off) lo = mid;
            else hi = mid - 1;
        }
        return lo + 1;
    };
    let rmask = null;
    const rangesFor = (offset, kind) => {
        if (kind === 'export') return {};
        try {
            rmask = rmask || require('./mask').maskCode(normalized, jsx === true);
            return entityRanges(rmask, offset, kind, lineAt);
        } catch (e) {
            return {};
        }
    };
    lines.forEach((code, i) => {
        const t = code.trim();
        const c = t ? classify(code) : null;
        const owner = classes[classes.length - 1];
        if (c) {
            const offset = lineStarts[i] + (code.length - code.replace(/^\s+/, '').length);
            if (['class', 'interface', 'enum', 'type', 'function', 'export'].includes(c.kind)) {
                symbols.push({...c, line: i + 1, offset, ...rangesFor(offset, c.kind)});
            } else if (owner && depth === owner.depth && owner.kind === 'class') {
                symbols.push({...c, line: i + 1, offset, owner: owner.name, ...rangesFor(offset, c.kind)});
            }
        }
        const objectExport = code.match(/\bmodule\.exports\s*=\s*\{/);
        if (objectExport || (exportDepth !== null && depth === exportDepth)) {
            const entries = objectExport ? code.slice(objectExport.index + objectExport[0].length) : code;
            for (const entry of entries.split(',')) {
                const m = entry.trim().match(/^([$_\p{ID_Start}][$\u200C\u200D\p{ID_Continue}]*)\s*(?=[:,}(]|$)/u);
                if (m && !KEYWORDS.has(m[1])) symbols.push({kind: 'export', name: m[1], line: i + 1});
            }
        }
        const nextDepth = depth + (code.match(/\{/g) || []).length - (code.match(/\}/g) || []).length;
        if (c && (c.kind === 'class' || c.kind === 'interface') && nextDepth > depth) classes.push({name: c.name, kind: c.kind, depth: depth + 1});
        if (objectExport && nextDepth > depth) exportDepth = depth + 1;
        depth = nextDepth;
        while (classes.length && classes[classes.length - 1].depth > depth) classes.pop();
        if (exportDepth !== null && depth < exportDepth) exportDepth = null;
    });
    return symbols;
}

module.exports = {parseSymbols, sourceCodeMask, isArrowExpression};
