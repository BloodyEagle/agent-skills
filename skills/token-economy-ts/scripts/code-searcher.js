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
    if (a.startsWith('{')) continue; // argv-JSON уже разобран выше — не интерпретировать как ключ=значение
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
const truthy = (v) => v === true || v === '1' || v === 'true';
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ID_CONT = '[$\\u200C\\u200D\\p{ID_Continue}]';
const cwd = process.cwd();

/**
 * Один search-запрос: payload либо {error}. shared (walk/lines кэши) общий для batch:
 * одно дерево обходится один раз для всех запросов — это CPU-выгода, не токеновая.
 */
function runSearch(params, shared) {
    const query = params.query;
    if (!query) return {error: 'Не указан поисковый запрос (query)'};
    const root = params.root || (fs.existsSync(path.join(cwd, 'src')) ? 'src' : '.');

    // Несколько расширений за вызов: ext=.ts,.html
    const exts = String(params.ext || SOURCE_EXT.join(',')).split(',').map(s => s.trim()).filter(Boolean)
        .map(s => s.startsWith('.') ? s : '.' + s);
    // i=1 — без учёта регистра; regex=1 — query как регулярное выражение;
    // word=1 — совпадение по границам TS/JS-идентификатора (см. заголовок файла);
    // format=grouped|runs — обратимые компактные формы (opt-in); context=N — соседний код.
    const ignoreCase = truthy(params.i) || truthy(params.ignoreCase);
    const filesOnly = truthy(params.files);
    const format = params.format === undefined || params.format === null ? '' : String(params.format);
    if (format && format !== 'grouped' && format !== 'runs')
        return {error: 'format поддерживает только grouped или runs'};
    let context = 0;
    if (params.context !== undefined && params.context !== null && params.context !== '') {
        const n = Number(params.context);
        if (!Number.isInteger(n) || n < 0) return {error: 'context — целое число ≥ 0'};
        context = n;
    }
    if (context > 0 && filesOnly)
        return {error: 'context= неприменим к files=1: выдача файлов не превращается в код'};
    if (context > 0 && format)
        return {error: 'context= не сочетается с format=grouped|runs: блоки контекста уже передают строки целиком'};
    if (filesOnly && format)
        return {error: 'format=grouped|runs неприменим к files=1: список файлов уже передаёт путь один раз'};
    const limit = Math.max(1, Number(params.limit) || 30);
    let rx = null;
    if (truthy(params.regex) && truthy(params.word))
        return {error: 'word=1 несовместим с regex=1: word ищет literal query по границам идентификатора'};
    if (truthy(params.regex)) {
        try {
            rx = new RegExp(query, ignoreCase ? 'i' : '');
        } catch (e) {
            return {error: 'Некорректное регулярное выражение: ' + e.message};
        }
    }
    if (truthy(params.word)) {
        try {
            rx = new RegExp('(?<!' + ID_CONT + ')' + escapeRe(query) + '(?!' + ID_CONT + ')', ignoreCase ? 'iu' : 'u');
        } catch (e) {
            return {error: 'Некорректный запрос для word=1: ' + e.message};
        }
    }
    const needle = ignoreCase ? query.toLowerCase() : null;
    const match = (line) => rx
        ? rx.test(line)
        : needle ? line.toLowerCase().includes(needle) : line.includes(query);

    // Правило 11 скилла: пути вне рабочей директории отклоняются.
    // root="." допустим (relRoot === ''); точечная проверка ".." не задевает папки вида "..foo".
    const rootAbs = path.resolve(cwd, root);
    const relRoot = path.relative(cwd, rootAbs);
    if (relRoot === '..' || relRoot.startsWith('..' + path.sep) || path.isAbsolute(relRoot))
        return {error: 'root вне рабочей директории запрещён: ' + root};

    // Обход дерева кэшируется по (root, exts): повторные запросы batch не пересобирают дерево.
    const walkKey = JSON.stringify([rootAbs, exts]);
    let fileList = shared.walkCache.get(walkKey);
    if (!fileList) {
        fileList = walk(rootAbs, {ext: exts});
        shared.walkCache.set(walkKey, fileList);
    }
    const matches = [];
    for (const filePath of fileList) {
        let lines = shared.linesCache.get(filePath);
        if (!lines) {
            lines = fs.readFileSync(filePath, 'utf8').replace(/\r\n?/g, '\n').split('\n');
            shared.linesCache.set(filePath, lines);
        }
        lines.forEach((line, index) => {
            if (match(line)) {
                matches.push({
                    file: path.relative(cwd, filePath),
                    line: index + 1,
                    text: line.trim().replace(/\r/g, '').slice(0, 100).replace(/[\uD800-\uDBFF]$/, '')
                });
            }
        });
    }

    if (filesOnly) {
        const byFile = new Map();
        for (const m of matches) byFile.set(m.file, (byFile.get(m.file) || 0) + 1);
        return {
            count: matches.length,
            filesTotal: byFile.size,
            files: [...byFile.entries()]
                .map(([file, count]) => ({file, count}))
                .sort((a, b) => b.count - a.count)
                .slice(0, limit)
        };
    }
    if (context > 0) {
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
            const lines = shared.linesCache.get(path.resolve(cwd, file)) || [];
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
        return {count: matches.length, shownMatches: shown.length, files};
    }
    if (!format) {
        return {count: matches.length, matches: matches.slice(0, limit)};
    }
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
    return {
        count: matches.length,
        shownMatches: shown.length,
        ...(prefix ? {pathPrefix: prefix} : {}),
        groups: prefix ? groups.map((g) => ({...g, file: g.file.slice(prefix.length)})) : groups
    };
}

// Кэши одного запуска: дерево обхода и строки файлов (для context) переиспользуются
// всеми запросами batch; у каждого запроса свои match-состояние, лимиты и хиты.
const shared = {walkCache: new Map(), linesCache: new Map()};
const emit = (obj) => console.log(JSON.stringify(obj));
const fail = (msg) => {
    emit({error: msg});
    process.exit(1);
};

/**
 * Batch search: requests=[{"query": ...}] либо requests_file (UTF-8 JSON внутри проекта).
 * У каждого запроса собственные query/i/regex/word/count/limit/ошибки; no-match одного
 * запроса не влияет на другой. Exit 0 при хотя бы одном выполненном запросе, 1 — при полном
 * провале. Разные запросы НЕ заменяются объединением A|B: оно теряет идентичность запросов.
 */
function runSearchBatch() {
    let requests = args.requests;
    if (typeof requests === 'string') {
        try {
            requests = JSON.parse(requests);
        } catch (e) {
            fail('Некорректный JSON в requests: ' + e.message);
        }
    }
    if (args.requests_file !== undefined && args.requests_file !== null && args.requests_file !== '') {
        const rf = String(args.requests_file);
        const rfAbs = path.resolve(cwd, rf);
        const rfRel = path.relative(cwd, rfAbs);
        if (rfRel === '..' || rfRel.startsWith('..' + path.sep) || path.isAbsolute(rfRel))
            fail('requests_file вне рабочей директории запрещён: ' + rf);
        try {
            requests = JSON.parse(fs.readFileSync(fs.realpathSync(rfAbs), 'utf8'));
        } catch (e) {
            fail('Не удалось прочитать requests_file: ' + e.message);
        }
    }
    if (!Array.isArray(requests) || !requests.length)
        fail('requests должен быть непустым JSON-массивом запросов {"query": ...}');
    for (let i = 0; i < requests.length; i++) {
        const r = requests[i];
        if (!r || typeof r !== 'object' || Array.isArray(r)) fail('requests[' + i + ']: элемент должен быть объектом');
    }
    const results = new Array(requests.length);
    let failed = 0;
    requests.forEach((r, i) => {
        const payload = runSearch(r, shared);
        if (payload.error) {
            results[i] = {index: i, error: payload.error};
            failed++;
        } else {
            results[i] = {index: i, ...payload};
        }
    });
    emit({batch: true, total: requests.length, failed, results});
    process.exit(failed === requests.length ? 1 : 0);
}

if (args.requests !== undefined && args.requests !== null || args.requests_file !== undefined && args.requests_file !== null && args.requests_file !== '') {
    runSearchBatch();
} else {
    const payload = runSearch(args, shared);
    if (payload.error) fail(payload.error);
    emit(payload);
}
