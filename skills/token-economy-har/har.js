#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const { openHar } = require('./lib/parse');
const stats = require('./lib/stats');
const { formatResult, MAX_BYTES, MAX_LINES } = require('./lib/format');
const { redactEntry, redactMetadata } = require('./lib/redact');

const COMMANDS = ['info', 'slow', 'errors', 'domains', 'content', 'dup', 'search', 'entry', 'waterfall', 'diff', 'redact'];
const HELP = [
    'HAR без чтения многомегабайтного JSON. Node.js >= 18, без npm-зависимостей.',
    'Использование: node har.js <команда> -f capture.har [флаги]',
    'Без -f HAR читается из stdin. Индексы записей начинаются с 0.',
    '',
    'info                         Сводка размеров, времени, статусов, доменов и MIME',
    'slow --top 10 --min 500       Медленные запросы и фазы времени, мс',
    'errors                       HTTP >= 400, обрывы, таймауты, _error, пустые ответы',
    'domains --sort size          Группы доменов; сортировка size, count или time',
    'content --by-mime            Размеры по категориям или MIME',
    'dup --strategy norm          Дубли: exact, norm или hash тела ответа',
    'search <regex> --limit 30    Поиск по URL, методу и статусу',
    'entry <n> --body 2k          Заголовки и фазы; тело только с --body',
    'waterfall --top 20           Старты и длительности запросов',
    'diff a.har b.har             Появившиеся, исчезнувшие, медленные и тяжёлые URL',
    'redact -o clean.har          Очистка секретов с сохранением исходных размеров',
    '',
    'Общие флаги: -f/--file, --json, --pretty, --limit N, --stream, -h/--help.',
    'Автоматический потоковый разбор файлов > 200 MiB; stdin всегда потоковый.',
    'Вывод <= 200 строк и 8 KiB; JSON остаётся валидным при обрезке.',
    'Коды: 0 данные есть; 1 совпадений нет; 2 ошибка аргументов, чтения или HAR.'
].join('\n');

function fail(message) {
    const error = new Error(message);
    error.exitCode = 2;
    throw error;
}

function positiveInteger(value, name) {
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) {
        fail(`${name}: требуется положительное целое число.`);
    }
    return Number(value);
}

function bodyLimit(value) {
    const match = /^(\d+(?:\.\d+)?)(b|k|kb|kib|m|mb|mib)?$/i.exec(value);
    if (!match) fail('--body: используйте число байтов или размер вида 2k, 1m.');
    const multiplier = /^k/i.test(match[2] || '') ? 1024 : /^m/i.test(match[2] || '') ? 1024 * 1024 : 1;
    const bytes = Math.floor(Number(match[1]) * multiplier);
    if (!Number.isSafeInteger(bytes) || bytes < 1) fail('--body: размер должен быть положительным.');
    return bytes;
}

function parseArgs(argv) {
    const options = { positions: [], flags: new Set() };
    const aliases = { '-f': 'file', '-o': 'output', '-h': 'help' };
    const booleans = new Set(['json', 'pretty', 'stream', 'by-mime', 'help']);
    const values = new Set(['file', 'output', 'limit', 'top', 'min', 'sort', 'strategy', 'body']);
    let positional = false;
    for (let i = 0; i < argv.length; i++) {
        const argument = argv[i];
        if (!positional && argument === '--') {
            positional = true;
            continue;
        }
        if (!positional && argument.startsWith('-') && argument !== '-') {
            const equals = argument.indexOf('=');
            const flag = equals < 0 ? argument : argument.slice(0, equals);
            const name = aliases[flag] || (flag.startsWith('--') ? flag.slice(2) : '');
            if (!booleans.has(name) && !values.has(name)) fail(`Неизвестный флаг: ${flag}.`);
            options.flags.add(name);
            if (booleans.has(name)) {
                if (equals >= 0) fail(`${flag}: флаг не принимает значение.`);
                options[name] = true;
                continue;
            }
            let value;
            if (equals >= 0) value = argument.slice(equals + 1);
            else if (name === 'body' && (!argv[i + 1] || argv[i + 1].startsWith('-'))) value = '2k';
            else value = argv[++i];
            if (value === undefined || value === '' || (equals < 0 && value.startsWith('-') && value !== '-')) {
                fail(`${flag}: не указано значение.`);
            }
            options[name] = value;
        } else if (!options.command) options.command = argument;
        else options.positions.push(argument);
    }
    if (options.help || !options.command || options.command === 'help') {
        options.command = 'help';
        return options;
    }
    if (!COMMANDS.includes(options.command)) fail(`Неизвестная команда: ${options.command}. Используйте --help.`);
    const allowed = {
        top: ['slow', 'domains', 'waterfall'], min: ['slow'], sort: ['domains'], strategy: ['dup'],
        'by-mime': ['content'], body: ['entry'], output: ['redact']
    };
    for (const [flag, commands] of Object.entries(allowed)) {
        if (options.flags.has(flag) && !commands.includes(options.command)) fail(`--${flag} не поддерживается командой ${options.command}.`);
    }
    for (const name of ['limit', 'top']) {
        if (options[name] !== undefined) options[name] = positiveInteger(options[name], `--${name}`);
    }
    if (options.min !== undefined) {
        if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(options.min) || !Number.isFinite(Number(options.min))) {
            fail('--min: требуется неотрицательное время в миллисекундах.');
        }
        options.min = Number(options.min);
    }
    if (options.body !== undefined) options.body = bodyLimit(options.body);
    if (options.sort && !['size', 'count', 'time'].includes(options.sort)) fail('--sort: допустимы size, count, time.');
    if (options.strategy && !['exact', 'norm', 'hash'].includes(options.strategy)) fail('--strategy: допустимы exact, norm, hash.');
    const expected = options.command === 'diff' ? 2 : ['search', 'entry'].includes(options.command) ? 1 : 0;
    if (options.positions.length !== expected) fail(`${options.command}: требуется позиционных аргументов ${expected}.`);
    if (options.command === 'entry' && (!/^\d+$/.test(options.positions[0]) || !Number.isSafeInteger(Number(options.positions[0])))) {
        fail('entry: индекс должен быть целым числом от 0.');
    }
    if (options.command === 'redact' && !options.output) fail('redact: укажите -o clean.har.');
    if (options.command === 'diff' && options.file) fail('diff: передайте два пути без --file.');
    if (options.command === 'diff' && options.positions.every(file => file === '-')) fail('diff: stdin можно прочитать только один раз.');
    return options;
}

function rowLimit(options) {
    const defaults = { slow: 10, domains: 10, waterfall: 20, info: 5 };
    const limit = options.limit ?? options.top ?? defaults[options.command] ?? 30;
    return options.top === undefined ? limit : Math.min(limit, options.top);
}

function listResult(command, total, items, limit, extras = {}) {
    return { command, total, shown: items.length, omitted: total - items.length, limit, truncated: total > items.length, ...extras, items };
}

function keepBest(items, row, capacity, compare) {
    if (items.length === capacity && compare(row, items[items.length - 1]) >= 0) return;
    let low = 0;
    let high = items.length;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (compare(row, items[middle]) < 0) high = middle;
        else low = middle + 1;
    }
    items.splice(low, 0, row);
    if (items.length > capacity) items.pop();
}

function headers(value) {
    return Array.isArray(value) ? value.slice(0, MAX_LINES).map(header => ({
        name: typeof header?.name === 'string' ? header.name : '',
        value: typeof header?.value === 'string' ? header.value : ''
    })) : [];
}

function previewBody(text, encoding, mimeType, requestedBytes) {
    if (typeof text !== 'string') return null;
    mimeType = typeof mimeType === 'string' ? mimeType : '';
    const buffer = Buffer.from(text, encoding === 'base64' ? 'base64' : 'utf8');
    const textual = encoding !== 'base64' || /^(?:text\/)|json|javascript|xml|svg|x-www-form-urlencoded/i.test(mimeType || '');
    let end = Math.min(requestedBytes, MAX_BYTES - 1536, buffer.length);
    if (textual && end < buffer.length) {
        while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
    }
    return {
        mimeType: mimeType || '(неизвестно)',
        encoding: textual ? 'utf8' : 'base64',
        bytes: buffer.length,
        shownBytes: end,
        text: buffer.subarray(0, end).toString(textual ? 'utf8' : 'base64'),
        truncated: end < buffer.length
    };
}

function detailEntry(index, entry, bodyBytes) {
    const request = entry.request || {};
    const response = entry.response || {};
    const content = response.content || {};
    const result = {
        command: 'entry', index, truncated: false,
        entry: {
            startedDateTime: typeof entry.startedDateTime === 'string' ? entry.startedDateTime : null,
            pageref: typeof entry.pageref === 'string' ? entry.pageref : null,
            serverIPAddress: typeof entry.serverIPAddress === 'string' ? entry.serverIPAddress : null,
            time: stats.getTime(entry), timings: stats.getTimings(entry), sizes: stats.getSizes(entry),
            request: {
                method: typeof request.method === 'string' ? request.method : '?',
                url: typeof request.url === 'string' ? request.url : '',
                httpVersion: typeof request.httpVersion === 'string' ? request.httpVersion : '', headers: headers(request.headers),
                queryString: headers(request.queryString)
            },
            response: {
                status: stats.knownSize(response.status), statusText: typeof response.statusText === 'string' ? response.statusText : '',
                httpVersion: typeof response.httpVersion === 'string' ? response.httpVersion : '', headers: headers(response.headers),
                redirectURL: typeof response.redirectURL === 'string' ? response.redirectURL : '',
                content: { size: stats.knownSize(content.size), compression: typeof content.compression === 'number' && Number.isFinite(content.compression) ? content.compression : null, mimeType: stats.getMime(entry) }
            }
        }
    };
    result.truncated = [request.headers, response.headers, request.queryString].some(value => Array.isArray(value) && value.length > MAX_LINES);
    if (bodyBytes !== undefined) {
        const body = previewBody(content.text, content.encoding, content.mimeType, bodyBytes);
        const requestBody = previewBody(request.postData?.text, request.postData?.encoding, request.postData?.mimeType, bodyBytes);
        if (body) result.body = body;
        if (requestBody) result.requestBody = requestBody;
        result.truncated ||= Boolean(body?.truncated || requestBody?.truncated);
        if (!body && !requestBody) result.message = 'В HAR нет захваченных тел для этой записи.';
    }
    return result;
}

async function inputHar(file, options) {
    if ((!file || file === '-') && process.stdin.isTTY) fail('Укажите -f capture.har или передайте HAR через stdin.');
    return openHar(file, { stream: Boolean(options.stream) });
}

async function snapshot(file, options) {
    const har = await inputHar(file, options);
    const groups = new Map();
    for await (const { entry } of har.entries) {
        const method = typeof entry.request?.method === 'string' ? entry.request.method : '?';
        const url = stats.normalizeUrl(entry.request?.url);
        const key = `${method}\u0000${url}`;
        if (!groups.has(key)) groups.set(key, { method, url, ...stats.newAggregate() });
        stats.addAggregate(groups.get(key), stats.getSizes(entry), stats.getTime(entry));
    }
    return groups;
}

function endpoint(group) {
    if (!group) return null;
    return {
        count: group.count,
        time: group.unknownTime === group.count ? null : group.time / (group.count - group.unknownTime),
        size: group.unknownUncompressed === group.count ? null : group.uncompressed / (group.count - group.unknownUncompressed),
        unknownTime: group.unknownTime, unknownSize: group.unknownUncompressed
    };
}

async function diffHar(options) {
    const before = await snapshot(options.positions[0], options);
    const after = await snapshot(options.positions[1], options);
    const limit = rowLimit(options);
    const capacity = Math.min(limit, MAX_LINES - 5);
    const items = [];
    let total = 0;
    const add = (change, old, current) => {
        total++;
        if (items.length < capacity) items.push({ change, method: (current || old).method, url: (current || old).url, before: endpoint(old), after: endpoint(current) });
    };
    for (const [key, old] of before) {
        const current = after.get(key);
        if (!current) {
            add('removed', old, null);
            continue;
        }
        const a = endpoint(old);
        const b = endpoint(current);
        if (a.count !== b.count) add('count', old, current);
        if (!a.unknownTime && !b.unknownTime && b.time > a.time) add('slower', old, current);
        if (!a.unknownSize && !b.unknownSize && b.size > a.size) add('heavier', old, current);
    }
    for (const [key, current] of after) {
        if (!before.has(key)) add('added', null, current);
    }
    return listResult('diff', total, items, limit);
}

async function redactHar(options) {
    if (fs.existsSync(options.output)) fail('Файл назначения уже существует; исходные файлы не перезаписываются.');
    const har = await inputHar(options.file, options);
    const temporary = `${options.output}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    let fd;
    let requests = 0;
    try {
        fd = fs.openSync(temporary, 'wx', 0o600);
        fs.writeFileSync(fd, '{"log":{"entries":[');
        for await (const { entry } of har.entries) {
            fs.writeFileSync(fd, `${requests ? ',' : ''}${JSON.stringify(redactEntry(entry))}`);
            requests++;
        }
        const metadata = redactMetadata(har.metadata);
        fs.writeFileSync(fd, ']');
        for (const [key, value] of Object.entries(metadata.log || {})) {
            if (key !== 'entries') fs.writeFileSync(fd, `,${JSON.stringify(key)}:${JSON.stringify(value)}`);
        }
        fs.writeFileSync(fd, '}');
        for (const [key, value] of Object.entries(metadata)) {
            if (key !== 'log') fs.writeFileSync(fd, `,${JSON.stringify(key)}:${JSON.stringify(value)}`);
        }
        fs.writeFileSync(fd, '}\n');
        fs.closeSync(fd);
        fd = undefined;
        // link создаёт назначение атомарно и, в отличие от rename, не перезаписывает чужой файл.
        fs.linkSync(temporary, options.output);
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
    return { command: 'redact', requests, output: options.output, redacted: true };
}

async function run(options) {
    if (options.command === 'help') return { result: { command: 'help', message: HELP, commands: COMMANDS }, exitCode: 0 };
    if (options.command === 'diff') {
        const result = await diffHar(options);
        return { result, exitCode: result.total ? 0 : 1 };
    }
    if (options.command === 'redact') {
        const result = await redactHar(options);
        return { result, exitCode: result.requests ? 0 : 1 };
    }
    let regex;
    if (options.command === 'search') {
        try {
            regex = new RegExp(options.positions[0]);
        } catch {
            fail('Некорректное регулярное выражение для search.');
        }
    }
    const har = await inputHar(options.file, options);
    const aggregate = ['info', 'domains', 'content'].includes(options.command) ? stats.createStats() : null;
    const limit = rowLimit(options);
    const capacity = Math.min(limit, MAX_LINES - 5);
    const items = [];
    const duplicates = new Map();
    let total = 0;
    let selected = null;
    let firstStart = Infinity;
    let lastEnd = -Infinity;
    for await (const { index, entry } of har.entries) {
        if (aggregate) {
            stats.addEntry(aggregate, entry);
            continue;
        }
        if (options.command === 'entry') {
            if (index === Number(options.positions[0])) selected = detailEntry(index, entry, options.body);
            continue;
        }
        if (options.command === 'dup') {
            const strategy = options.strategy || 'exact';
            const url = typeof entry.request?.url === 'string' ? entry.request.url : '';
            const key = strategy === 'hash' ? stats.bodyHash(entry) : strategy === 'norm' ? stats.normalizeUrl(url) : url;
            if (key === null || key === '') continue;
            if (!duplicates.has(key)) duplicates.set(key, { key, count: 0, indices: [], urls: [], omittedIndices: 0 });
            const group = duplicates.get(key);
            group.count++;
            if (group.indices.length < Math.min(capacity, 30)) group.indices.push(index);
            else group.omittedIndices++;
            if (group.urls.length < 3 && !group.urls.includes(url)) group.urls.push(url);
            continue;
        }
        if (options.command === 'errors') {
            const reasons = stats.errorReasons(entry);
            if (!reasons.length) continue;
            total++;
            if (items.length < capacity) items.push({ ...stats.summarizeEntry(index, entry), reasons });
            continue;
        }
        if (options.command === 'search') {
            if (!regex.test(`${entry.request?.method || '?'} ${entry.response?.status ?? '?'} ${entry.request?.url || ''}`)) continue;
            total++;
            if (items.length < capacity) items.push(stats.summarizeEntry(index, entry));
            continue;
        }
        const row = stats.summarizeEntry(index, entry);
        if (options.command === 'slow') {
            if (row.time === null || row.time < (options.min ?? 0)) continue;
            total++;
            keepBest(items, { ...row, timings: stats.getTimings(entry) }, capacity, (a, b) => b.time - a.time || a.index - b.index);
        } else if (options.command === 'waterfall') {
            total++;
            if (row.start !== null) {
                firstStart = Math.min(firstStart, row.start);
                lastEnd = Math.max(lastEnd, row.start + (row.time || 0));
            }
            keepBest(items, row, capacity, (a, b) => (a.start ?? Infinity) - (b.start ?? Infinity) || a.index - b.index);
        }
    }
    let result;
    if (options.command === 'info') result = stats.finishStats(aggregate, har.metadata, capacity);
    else if (options.command === 'domains' || options.command === 'content') {
        const groups = options.command === 'domains' ? aggregate.domains : options['by-mime'] ? aggregate.mimeTypes : aggregate.categories;
        const rows = stats.groupRows(groups, options.command === 'domains' ? 'domain' : 'type', options.sort || 'size');
        result = listResult(options.command, rows.length, rows.slice(0, capacity), limit, options.command === 'content' ? { byMime: Boolean(options['by-mime']) } : {});
    } else if (options.command === 'entry') {
        result = selected || { command: 'entry', message: `Запись #${options.positions[0]} не найдена.`, found: false };
    } else if (options.command === 'dup') {
        const groups = [...duplicates.values()].filter(group => group.count > 1).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
        result = listResult('dup', groups.length, groups.slice(0, capacity), limit, { strategy: options.strategy || 'exact' });
    } else if (options.command === 'waterfall') {
        const span = Number.isFinite(firstStart) ? lastEnd - firstStart : null;
        for (const row of items) row.offset = row.start === null ? null : row.start - firstStart;
        result = listResult('waterfall', total, items, limit, { span });
    } else result = listResult(options.command, total, items, limit);
    const count = result.requests ?? result.total ?? (selected ? 1 : 0);
    return { result, exitCode: count ? 0 : 1 };
}

async function main() {
    let options;
    try {
        options = parseArgs(process.argv.slice(2));
        const { result, exitCode } = await run(options);
        if (options.command === 'help' && !options.json) process.stdout.write(`${HELP}\n`);
        else process.stdout.write(`${formatResult(result, options)}\n`);
        process.exitCode = exitCode;
    } catch (error) {
        const message = error.exitCode === 2 ? error.message : `Не удалось обработать HAR: ${error.message}`;
        const json = options?.json || process.argv.includes('--json');
        process.stderr.write(`${formatResult(json ? { error: message, exitCode: 2 } : { message: `Ошибка: ${message}` }, { json })}\n`);
        process.exitCode = 2;
    }
}

if (require.main === module) main();

module.exports = { parseArgs, rowLimit, previewBody, detailEntry, run };
