const fs = require('fs');
const path = require('path');
const {SOURCE_EXT} = require('./lib/files');
const {parseSymbols} = require('./lib/symbols');

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

const file = path.resolve(process.cwd(), args.file || '');
// Правило 11 скилла: пути вне рабочей директории отклоняются
const relFile = path.relative(process.cwd(), file);
if (relFile === '..' || relFile.startsWith('..' + path.sep) || path.isAbsolute(relFile)) {
    console.log(JSON.stringify({error: "Путь вне рабочей директории запрещён: " + (args.file || '')}));
    process.exit(1);
}
const sourceExt = process.platform === 'win32' ? path.extname(file).toLowerCase() : path.extname(file);
if (!args.file || !SOURCE_EXT.includes(sourceExt) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    console.log(JSON.stringify({error: "Исходный файл не найден: " + (args.file || '')}));
    process.exit(1);
}

const text = fs.readFileSync(file, 'utf8');
const symbols = parseSymbols(text);
const limit = Math.max(1, Number(args.limit) || 60);
const outline = symbols.slice(0, limit)
    .map(s => `  L${String(s.line).padStart(4)}  [${s.kind}] ${s.name}`)
    .join('\n');

// Массив symbols в вывод не включаем: он дублирует outline и удваивает расход токенов.
console.log(JSON.stringify({
    file: args.file,
    lines: text.replace(/\r\n?/g, '\n').split('\n').length,
    count: symbols.length,
    ...(symbols.length > limit ? {truncated: true} : {}),
    outline: outline || '(объявления не найдены)'
}));
