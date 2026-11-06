const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'new', 'else', 'do', 'try', 'finally', 'typeof', 'instanceof', 'in', 'of', 'case', 'throw', 'await']);

function mask(text) {
    return text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:\\[\s\S]|[^'\\])*'|"(?:\\[\s\S]|[^"\\])*"|`(?:\\[\s\S]|[^`\\])*`|\/(?![/*])(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\n\\])+\/[dgimsuvy]*/g,
        value => value.replace(/[^\n\r]/g, ' '));
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
    if ((m = t.match(/^(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/))) return {kind: 'class', name: m[1]};
    if ((m = t.match(/^(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/))) return {kind: 'interface', name: m[1]};
    if ((m = t.match(/^(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/))) return {kind: 'enum', name: m[1]};
    if ((m = t.match(/^(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/))) return {kind: 'type', name: m[1]};
    if ((m = t.match(/^(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/))) return {kind: 'function', name: m[1]};
    if ((m = t.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:\([^;]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>|function\b)/))) return {kind: 'function', name: m[1] + '(' + params(t) + ')'};
    if ((m = t.match(/^(?:module\.exports|exports)\.([A-Za-z_$][\w$]*)\s*=/))) return {kind: 'export', name: m[1]};
    m = t.match(/^(?:(?:public|private|protected|static|readonly|override|abstract|async|get|set)\s+|\*\s*)*(#?[A-Za-z_$][\w$]*)\s*\([^;]*\)\s*(?:\{|=>|:)/);
    if (m && !KEYWORDS.has(m[1])) return {kind: m[1].startsWith('#') ? 'private-method' : 'method', name: m[1] + '(' + params(t) + ')'};
    m = t.match(/^(?:(?:public|private|protected|static|readonly|override|declare)\s+)*(#?[A-Za-z_$][\w$]*)[?!]?\s*[:=]/);
    if (m && !KEYWORDS.has(m[1])) {
        const arrow = /=\s*(?:async\s*)?(?:\([^;]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/.test(t);
        const kind = arrow ? 'method' : 'property';
        return {kind: m[1].startsWith('#') ? 'private-' + kind : kind, name: arrow ? m[1] + '(' + params(t) + ')' : m[1]};
    }
    return null;
}

/**
 * Извлекает объявления TS/JS и экспорты CommonJS без внешнего парсера.
 * @param {string} text Исходный текст.
 * @returns {{kind: string, name: string, line: number, owner?: string}[]} Символы с номерами строк.
 */
function parseSymbols(text) {
    const normalized = text.replace(/\r\n?/g, '\n');
    const lines = mask(normalized).split('\n');
    const symbols = [];
    const classes = [];
    let depth = 0;
    let exportDepth = null;
    lines.forEach((code, i) => {
        const t = code.trim();
        const c = t ? classify(code) : null;
        const owner = classes[classes.length - 1];
        if (c) {
            if (['class', 'interface', 'enum', 'type', 'function', 'export'].includes(c.kind)) {
                symbols.push({...c, line: i + 1});
            } else if (owner && depth === owner.depth && owner.kind === 'class') {
                symbols.push({...c, line: i + 1, owner: owner.name});
            }
        }
        const objectExport = code.match(/\bmodule\.exports\s*=\s*\{/);
        if (objectExport || (exportDepth !== null && depth === exportDepth)) {
            const entries = objectExport ? code.slice(objectExport.index + objectExport[0].length) : code;
            for (const entry of entries.split(',')) {
                const m = entry.trim().match(/^([A-Za-z_$][\w$]*)\s*(?=[:,}(]|$)/);
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

module.exports = {parseSymbols};
