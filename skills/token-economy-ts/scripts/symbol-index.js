const fs = require('fs');
const path = require('path');

let args = {};
try {
    args = JSON.parse(fs.readFileSync(0, 'utf-8').trim() || '{}');
} catch (e) {
    args = {};
}

const file = path.resolve(process.cwd(), args.file || '');
// Правило 11 скилла: пути вне рабочей директории отклоняются
const relFile = path.relative(process.cwd(), file);
if (relFile === '..' || relFile.startsWith('..' + path.sep) || path.isAbsolute(relFile)) {
    console.log(JSON.stringify({error: "Путь вне рабочей директории запрещён: " + (args.file || '')}));
    process.exit(1);
}
if (!args.file || !fs.existsSync(file)) {
    console.log(JSON.stringify({error: "Файл не найден: " + (args.file || '')}));
    process.exit(1);
}

const lines = fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n').split('\n');

const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'new', 'else', 'do', 'try', 'finally', 'typeof', 'instanceof', 'in', 'of', 'case', 'throw', 'await']);

/**
 * Определяет тип объявления в строке TypeScript-кода.
 * @param {string} line - исходная строка кода.
 * @returns {{kind: string, name: string}|null} Тип и имя символа либо null.
 */
function classify(line) {
    const t = line.trim();
    if (!t || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return null;

    let m;
    if ((m = t.match(/^(export\s+)?(abstract\s+)?class\s+([A-Za-z_$][\w$]*)/))) return {kind: 'class', name: m[3]};
    if ((m = t.match(/^(export\s+)?interface\s+([A-Za-z_$][\w$]*)/))) return {kind: 'interface', name: m[2]};
    if ((m = t.match(/^(export\s+)?(const\s+)?enum\s+([A-Za-z_$][\w$]*)/))) return {kind: 'enum', name: m[3]};
    if ((m = t.match(/^(export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/))) return {kind: 'type', name: m[2]};
    if ((m = t.match(/^(export\s+)?(async\s+)?function\s+([A-Za-z_$][\w$]*)/))) return {kind: 'function', name: m[3]};
    if ((m = t.match(/^(export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(async\s*)?\(/))) return {
        kind: 'function',
        name: m[2] + '(' + params(t) + ')'
    };

    // Метод: name(...) с модификаторами, исключая ключевые слова
    m = t.match(/^\s*(?:public|private|protected|static|readonly|override|abstract|async|get|set|\*|\s)*?([A-Za-z_$][\w$]*)\s*\([^;]*\)\s*(\{|=>|:)/);
    if (m && !KEYWORDS.has(m[1]) && m[1] !== 'constructor') return {kind: 'method', name: m[1] + '(' + params(t) + ')'};
    if (m && m[1] === 'constructor') return {kind: 'method', name: 'constructor(' + params(t) + ')'};

    // Свойство: name: Type или name = value (без скобок)
    if (!/^(const|let|var|import|export\s+default)\b/.test(t)) {
        m = t.match(/^\s*(?:public|private|protected|static|readonly|override|\s)*([A-Za-z_$][\w$]*)(\?|!)?\s*[:=]/);
        if (m && !KEYWORDS.has(m[1])) {
            const arrow = /=\s*(async\s*)?\(/.test(t);
            return {kind: arrow ? 'method' : 'property', name: arrow ? m[1] + '(' + params(t) + ')' : m[1]};
        }
    }
    return null;
}

/**
 * Возвращает усечённые параметры из строки (текст внутри первых скобок).
 * @param {string} t - строка кода.
 * @returns {string} Строка параметров без обрамляющих скобок.
 */
function params(t) {
    const start = t.indexOf('(');
    if (start === -1) return '';
    let depth = 0;
    for (let i = start; i < t.length; i++) {
        if (t[i] === '(') depth++;
        if (t[i] === ')') {
            depth--;
            if (depth === 0) return t.slice(start + 1, i).replace(/\s+/g, ' ').trim();
        }
    }
    return '';
}

const symbols = [];
let depth = 0;
const classDepths = [];    // глубины, на которых открыты классы
const ifaceDepths = [];    // глубины, на которых открыты интерфейсы

lines.forEach((line, i) => {
    const c = classify(line);

    const inClass = classDepths.length > 0 && depth === classDepths[classDepths.length - 1];
    const inIface = ifaceDepths.length > 0 && depth === ifaceDepths[ifaceDepths.length - 1];

    if (c) {
        c.line = i + 1;
        if (['class', 'interface', 'enum', 'type', 'function'].includes(c.kind)) {
            symbols.push(c);
        } else if (inClass && !inIface && (c.kind === 'method' || c.kind === 'property')) {
            symbols.push(c);
        }
    }

    // Обновление глубины фигурных скобок
    const open = (line.match(/{/g) || []).length;
    const close = (line.match(/}/g) || []).length;
    const newDepth = depth + open - close;

    if (c && c.kind === 'class') classDepths.push(newDepth);
    if (c && c.kind === 'interface') ifaceDepths.push(newDepth);

    depth = newDepth;
    while (classDepths.length && classDepths[classDepths.length - 1] > depth) classDepths.pop();
    while (ifaceDepths.length && ifaceDepths[ifaceDepths.length - 1] > depth) ifaceDepths.pop();
});

const outline = symbols
    .map(s => `  L${String(s.line).padStart(4)}  [${s.kind}] ${s.name}`)
    .join('\n');

// Массив symbols в вывод не включаем: он дублирует outline и удваивает расход токенов.
console.log(JSON.stringify({
    file: args.file,
    lines: lines.length,
    count: symbols.length,
    outline: outline || '(объявления не найдены)'
}));
