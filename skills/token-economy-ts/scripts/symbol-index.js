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
    if (a.startsWith('{')) continue; // argv-JSON уже разобран выше — не интерпретировать как ключ=значение
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

const cwd = process.cwd();

/**
 * Один outline-запрос: payload либо {error}. Явный batch выполняет несколько файлов
 * одним вызовом без повторной обвязки tool-call.
 */
function runOutline(params) {
    const fileArg = String(params.file || '');
    const file = path.resolve(cwd, fileArg);
    // Правило 11 скилла: пути вне рабочей директории отклоняются
    const relFile = path.relative(cwd, file);
    if (relFile === '..' || relFile.startsWith('..' + path.sep) || path.isAbsolute(relFile))
        return {error: 'Путь вне рабочей директории запрещён: ' + fileArg};
    const sourceExt = process.platform === 'win32' ? path.extname(file).toLowerCase() : path.extname(file);
    if (!fileArg || !SOURCE_EXT.includes(sourceExt) || !fs.existsSync(file) || !fs.statSync(file).isFile())
        return {error: 'Исходный файл не найден: ' + fileArg};

    const text = fs.readFileSync(file, 'utf8');
    const symbols = parseSymbols(text);
    const limit = Math.max(1, Number(params.limit) || 60);
    // compact=1 (opt-in): без декоративного выравнивания; для объявлений с известным концом
    // диапазон L<start>-<end> — полный span объявления (как endLine в graph), поэтому
    // точечное чтение считается как limit = end - start + 1. Legacy-формат не изменён:
    // те же номера, kind, name и порядок.
    const compact = params.compact === true || params.compact === '1' || params.compact === 'true';
    const outline = symbols.slice(0, limit)
        .map(s => compact
            ? (s.endLine != null ? `L${s.line}-${s.endLine}` : `L${s.line}`) + ` [${s.kind}] ${s.name}`
            : `  L${String(s.line).padStart(4)}  [${s.kind}] ${s.name}`)
        .join('\n');

    // Массив symbols в вывод не включаем: он дублирует outline и удваивает расход токенов.
    return {
        file: fileArg,
        lines: text.replace(/\r\n?/g, '\n').split('\n').length,
        count: symbols.length,
        ...(symbols.length > limit ? {truncated: true} : {}),
        outline: outline || '(объявления не найдены)'
    };
}

/**
 * Batch outline: requests=[{"file": ...}] либо requests_file (UTF-8 JSON внутри проекта).
 * Каждый элемент получает свой ответ либо {index, error}. Exit 0 при хотя бы одном
 * выполненном запросе, 1 — при полном провале.
 */
function runOutlineBatch() {
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
        fail('requests должен быть непустым JSON-массивом запросов {"file": "src/a.ts"}');
    for (let i = 0; i < requests.length; i++) {
        const r = requests[i];
        if (!r || typeof r !== 'object' || Array.isArray(r)) fail('requests[' + i + ']: элемент должен быть объектом');
    }
    const results = new Array(requests.length);
    let failed = 0;
    requests.forEach((r, i) => {
        const payload = runOutline(r);
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

const emit = (obj) => console.log(JSON.stringify(obj));
const fail = (msg) => {
    emit({error: msg});
    process.exit(1);
};

if (args.requests !== undefined && args.requests !== null || args.requests_file !== undefined && args.requests_file !== null && args.requests_file !== '') {
    runOutlineBatch();
} else {
    const payload = runOutline(args);
    if (payload.error) fail(payload.error);
    emit(payload);
}
