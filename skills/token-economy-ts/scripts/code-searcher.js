// code-searcher.js — поиск по подстроке в файлах проекта: имена файлов, номера строк, короткие сниппеты.
const fs = require('fs');
const path = require('path');

let args = {};
// Порядок разбора: argv-JSON (pwsh 7.3+/bash/cmd) → argv key=value → stdin → env.
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
        // невалидный stdin — остаёмся на argv/env
    }
}
if (!Object.keys(args).length) {
    args = {
        query: process.env.SEARCH_QUERY,
        ext: process.env.SEARCH_EXT
    };
}

const query = args.query;
const root = args.root || 'src';

if (!query) {
    console.log(JSON.stringify({error: "Не указан поисковый запрос (query)"}));
    process.exit(1);
}

// Несколько расширений за вызов: ext=.ts,.html
const exts = String(args.ext || '.ts').split(',').map(s => s.trim()).filter(Boolean)
    .map(s => s.startsWith('.') ? s : '.' + s);
// i=1 — без учёта регистра; regex=1 — query как регулярное выражение;
// limit — максимум показанных совпадений (по умолчанию 30); files=1 — только файлы со счётчиками.
const truthy = (v) => v === true || v === '1' || v === 'true';
const ignoreCase = truthy(args.i) || truthy(args.ignoreCase);
const filesOnly = truthy(args.files);
const limit = Math.max(1, Number(args.limit) || 30);
let rx = null;
if (truthy(args.regex)) {
    try {
        rx = new RegExp(query, ignoreCase ? 'i' : '');
    } catch (e) {
        console.log(JSON.stringify({error: "Некорректное регулярное выражение: " + e.message}));
        process.exit(1);
    }
}
const needle = ignoreCase ? query.toLowerCase() : null;
const match = (line) => rx
    ? rx.test(line)
    : needle ? line.toLowerCase().includes(needle) : line.includes(query);

// Правило 11 скилла: пути вне рабочей директории отклоняются.
// root="." допустим (relRoot === ''); точечная проверка ".." не задевает папки вида "..foo".
const rootAbs = path.resolve(process.cwd(), root);
const relRoot = path.relative(process.cwd(), rootAbs);
if (relRoot === '..' || relRoot.startsWith('..' + path.sep) || path.isAbsolute(relRoot)) {
    console.log(JSON.stringify({error: "root вне рабочей директории запрещён: " + root}));
    process.exit(1);
}

// Выровнен с graph-tool: те же исключаемые папки, точное совпадение имени
// (было — подстрока: папка "distributes" тоже попадала под исключение)
const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'dist', '.kilocode', '.angular', 'coverage', 'build']);

function searchInDir(dir, results = []) {
    if (!fs.existsSync(dir)) return results;
    fs.readdirSync(dir).forEach(file => {
        const filePath = path.join(dir, file);
        if (fs.statSync(filePath).isDirectory()) {
            if (!EXCLUDE_DIRS.has(file)) searchInDir(filePath, results);
        } else if (exts.some(e => file.endsWith(e))) {
            const lines = fs.readFileSync(filePath, 'utf8').replace(/\r\n?/g, '\n').split('\n');
            lines.forEach((line, index) => {
                if (match(line)) {
                    results.push({
                        file: path.relative(process.cwd(), filePath),
                        line: index + 1,
                        text: line.trim().replace(/\r/g, '').substring(0, 100)
                    });
                }
            });
        }
    });
    return results;
}

const matches = searchInDir(rootAbs);
if (filesOnly) {
    const byFile = new Map();
    for (const m of matches) byFile.set(m.file, (byFile.get(m.file) || 0) + 1);
    console.log(JSON.stringify({
        count: matches.length,
        filesTotal: byFile.size,
        files: [...byFile.entries()]
            .map(([file, count]) => ({file, count}))
            .sort((a, b) => b.count - a.count)
            .slice(0, limit)
    }));
} else {
    console.log(JSON.stringify({count: matches.length, matches: matches.slice(0, limit)}));
}
