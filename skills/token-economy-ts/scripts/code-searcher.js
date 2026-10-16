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
const ext = args.ext || '.ts';
const root = args.root || 'src';

if (!query) {
    console.log(JSON.stringify({error: "Не указан поисковый запрос (query)"}));
    process.exit(1);
}

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
        } else if (file.endsWith(ext)) {
            const lines = fs.readFileSync(filePath, 'utf8').replace(/\r\n?/g, '\n').split('\n');
            lines.forEach((line, index) => {
                if (line.includes(query)) {
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
console.log(JSON.stringify({count: matches.length, matches: matches.slice(0, 30)}));
