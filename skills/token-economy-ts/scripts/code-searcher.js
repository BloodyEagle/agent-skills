// code-searcher.js — поиск по подстроке в файлах проекта: имена файлов, номера строк, короткие сниппеты.
const fs = require('fs');
const path = require('path');
const {SOURCE_EXT, walk} = require('./lib/files');

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
const root = args.root || (fs.existsSync(path.join(process.cwd(), 'src')) ? 'src' : '.');

if (!query) {
    console.log(JSON.stringify({error: "Не указан поисковый запрос (query)"}));
    process.exit(1);
}

// Несколько расширений за вызов: ext=.ts,.html
const exts = String(args.ext || SOURCE_EXT.join(',')).split(',').map(s => s.trim()).filter(Boolean)
    .map(s => s.startsWith('.') ? s : '.' + s);
// i=1 — без учёта регистра; regex=1 — query как регулярное выражение;
// word=1 — совпадение по границам TS/JS-идентификатора: класс продолжения
// [$\u200C\u200D\p{ID_Continue}] (дефис в идентификатор не входит, поэтому my-save совпадает
// с save, а saved и $save — нет). Это поиск raw text, а не разрешение ссылок: escaped
// идентификаторы (\u0073ave) и вхождения в строках/комментариях находятся наравне с кодом.
// word=1 и regex=1 вместе — ошибка, комбинировать их не предполагается.
// format=grouped|runs — обратимые компактные формы (opt-in): путь один раз на файл.
// limit — максимум показанных совпадений (по умолчанию 30); files=1 — только файлы со счётчиками.
const truthy = (v) => v === true || v === '1' || v === 'true';
const ignoreCase = truthy(args.i) || truthy(args.ignoreCase);
const filesOnly = truthy(args.files);
const format = args.format === undefined || args.format === null ? '' : String(args.format);
if (format && format !== 'grouped' && format !== 'runs') {
    console.log(JSON.stringify({error: "format поддерживает только grouped или runs"}));
    process.exit(1);
}
// context=N — соседний код вокруг совпадений (opt-in, по умолчанию 0).
// Не добавляется автоматически: N строк не гарантируют полный контекст.
let context = 0;
if (args.context !== undefined && args.context !== null && args.context !== '') {
    const n = Number(args.context);
    if (!Number.isInteger(n) || n < 0) {
        console.log(JSON.stringify({error: "context — целое число ≥ 0"}));
        process.exit(1);
    }
    context = n;
}
if (context > 0 && filesOnly) {
    console.log(JSON.stringify({error: "context= неприменим к files=1: выдача файлов не превращается в код"}));
    process.exit(1);
}
if (context > 0 && format) {
    console.log(JSON.stringify({error: "context= не сочетается с format=grouped|runs: блоки контекста уже передают строки целиком"}));
    process.exit(1);
}
const limit = Math.max(1, Number(args.limit) || 30);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ID_CONT = '[$\\u200C\\u200D\\p{ID_Continue}]';
let rx = null;
if (truthy(args.regex) && truthy(args.word)) {
    console.log(JSON.stringify({error: "word=1 несовместим с regex=1: word ищет literal query по границам идентификатора"}));
    process.exit(1);
}
if (truthy(args.regex)) {
    try {
        rx = new RegExp(query, ignoreCase ? 'i' : '');
    } catch (e) {
        console.log(JSON.stringify({error: "Некорректное регулярное выражение: " + e.message}));
        process.exit(1);
    }
}
if (truthy(args.word)) {
    try {
        rx = new RegExp('(?<!' + ID_CONT + ')' + escapeRe(query) + '(?!' + ID_CONT + ')', ignoreCase ? 'iu' : 'u');
    } catch (e) {
        console.log(JSON.stringify({error: "Некорректный запрос для word=1: " + e.message}));
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

const linesCache = new Map(); // строки файлов с совпадениями — для context-блоков без повторного чтения
function searchInDir(dir, results = []) {
    for (const filePath of walk(dir, {ext: exts})) {
        const lines = fs.readFileSync(filePath, 'utf8').replace(/\r\n?/g, '\n').split('\n');
        let any = false;
        lines.forEach((line, index) => {
            if (match(line)) {
                any = true;
                results.push({
                    file: path.relative(process.cwd(), filePath),
                    line: index + 1,
                    text: line.trim().replace(/\r/g, '').slice(0, 100).replace(/[\uD800-\uDBFF]$/, '')
                });
            }
        });
        if (any) linesCache.set(filePath, lines);
    }
    return results;
}

const matches = searchInDir(rootAbs);
if (filesOnly) {
    if (format) {
        console.log(JSON.stringify({error: "format=grouped|runs неприменим к files=1: список файлов уже передаёт путь один раз"}));
        process.exit(1);
    }
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
} else if (context > 0) {
    // context=N (opt-in): код соседних строк блоками на файл. Перекрывающиеся и вплотную
    // соседние окна объединяются; повторяющиеся строки передаются один раз. Текст строк
    // полный (без trim/лимита 100): строка может быть длинной — это осознанный компромисс.
    // limit ограничивает число совпавших строк, а не блоков; context-строки в count не входят.
    const shown = matches.slice(0, limit);
    const byFile = new Map();
    for (const m of shown) {
        if (!byFile.has(m.file)) byFile.set(m.file, []);
        byFile.get(m.file).push(m);
    }
    const files = [];
    for (const [file, list] of byFile) {
        const lines = linesCache.get(path.resolve(process.cwd(), file)) || [];
        const blocks = [];
        for (const m of list) {
            const a = Math.max(1, m.line - context), b = Math.min(lines.length, m.line + context);
            const last = blocks[blocks.length - 1];
            if (last && a <= last.end + 1) {
                last.end = Math.max(last.end, b);
            } else {
                blocks.push({start: a, end: b, hits: []});
            }
        }
        for (const m of list) {
            const blk = blocks.find((b) => m.line >= b.start && m.line <= b.end);
            blk.hits.push(m.line);
        }
        files.push({file, blocks: blocks.map((b) => ({startLine: b.start, lines: lines.slice(b.start - 1, b.end), hits: b.hits}))});
    }
    console.log(JSON.stringify({count: matches.length, shownMatches: shown.length, files}));
} else if (!format) {
    console.log(JSON.stringify({count: matches.length, matches: matches.slice(0, limit)}));
} else {
    // Обратимые компактные формы: путь один раз на группу, все сниппеты сохраняются,
    // порядок совпадений не меняется. Декодер восстанавливает matches побайтно.
    const shown = matches.slice(0, limit);
    const groups = [];
    let group = null, run = null;
    for (const m of shown) {
        if (!group || group.file !== m.file) {
            group = format === 'runs' ? {file: m.file, runs: []} : {file: m.file, hits: []};
            run = null;
            groups.push(group);
        }
        if (format === 'runs') {
            if (run && m.line === run.startLine + run.texts.length) run.texts.push(m.text);
            else {
                run = {startLine: m.line, texts: [m.text]};
                group.runs.push(run);
            }
        } else {
            group.hits.push({line: m.line, text: m.text});
        }
    }
    // Общий префикс путей (задача 14): передаётся один раз, полный путь = конкатенация.
    let prefix = null;
    const files = groups.map((g) => g.file);
    if (files.length > 1) {
        let common = files[0];
        for (const f of files) {
            let i = 0;
            while (i < common.length && i < f.length && common[i] === f[i]) i++;
            common = common.slice(0, i);
            if (!common) break;
        }
        const cut = Math.max(common.lastIndexOf('/'), common.lastIndexOf('\\'));
        if (cut > 0 && cut + 1 >= 4) prefix = common.slice(0, cut + 1);
    }
    console.log(JSON.stringify({
        count: matches.length,
        shownMatches: shown.length,
        ...(prefix ? {pathPrefix: prefix} : {}),
        groups: prefix ? groups.map((g) => ({...g, file: g.file.slice(prefix.length)})) : groups
    }));
}
