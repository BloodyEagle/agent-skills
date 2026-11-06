'use strict';

const MAX_BYTES = 8 * 1024;
const MAX_LINES = 200;

function clip(value, bytes = 180) {
    const text = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    return truncateUtf8(text, bytes);
}

function truncateUtf8(text, bytes, suffix = '...') {
    const buffer = Buffer.from(text);
    if (buffer.length <= bytes) return text;
    let end = Math.max(0, bytes - Buffer.byteLength(suffix));
    while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
    return buffer.subarray(0, end).toString('utf8') + suffix;
}

function truncateBody(text, body, bytes) {
    if (body.encoding === 'base64') return text.slice(0, Math.floor(bytes / 4) * 4);
    return truncateUtf8(text, bytes, '');
}

function formatBytes(value) {
    if (value === null || value === undefined) return '?';
    if (value === 0) return '0 B';
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    const power = Math.min(units.length - 1, Math.max(0, Math.floor(Math.log2(Math.abs(value)) / 10)));
    return `${Number((value / (1024 ** power)).toFixed(power ? 1 : 0))} ${units[power]}`;
}

function formatTime(value) {
    return value === null || value === undefined ? '?' : `${Number(value.toFixed(1))} мс`;
}

function fits(text) {
    return Buffer.byteLength(text) + 1 <= MAX_BYTES && text.split('\n').length <= MAX_LINES;
}

function histogram(values) {
    const entries = Object.entries(values);
    return entries.slice(0, 12).map(([name, count]) => `${clip(name, 35)}=${count}`).join(', ')
        + (entries.length > 12 ? `; ещё ${entries.length - 12} групп` : '');
}

function formatInfo(result) {
    const bytes = result.bytes;
    const time = result.time;
    return [
        `Запросов: ${result.requests}; страниц: ${result.pages}`,
        `Размеры тел: ${formatBytes(bytes.uncompressed)} несжатых; ${formatBytes(bytes.transfer)} передано; ${formatBytes(bytes.compression)} экономии`,
        `Неизвестные размеры: передано=${bytes.unknownTransfer}, несжатые=${bytes.unknownUncompressed}, экономия=${bytes.unknownCompression}; оценка по bodySize=${bytes.estimatedUncompressed}`,
        `Время: p50=${formatTime(time.p50)}, p95=${formatTime(time.p95)}, p99=${formatTime(time.p99)}, max=${formatTime(time.max)}`,
        `Сумма длительностей: ${formatTime(time.total)}; интервал записи: ${formatTime(time.span)}; неизвестно=${time.unknown}`,
        `Статусы: ${histogram(result.statuses) || '(нет)'}`,
        `Методы: ${histogram(result.methods) || '(нет)'}`,
        `Домены: ${result.domains.map(row => `${clip(row.domain, 50)} (${row.count})`).join(', ') || '(нет)'}`,
        `MIME: ${result.contentTypes.map(row => `${clip(row.type, 45)} ${aggregateBytes(row.uncompressed, row.unknownUncompressed)}`).join(', ') || '(нет)'}`,
        ...(result.omittedDomains || result.omittedContentTypes
            ? [`... ещё доменов ${result.omittedDomains}, MIME ${result.omittedContentTypes}; --limit N`] : [])
    ].join('\n');
}

function aggregateBytes(value, unknown) {
    return `${formatBytes(value)}${unknown ? ` + ?(${unknown})` : ''}`;
}

function entryRow(row) {
    return `#${row.index} ${clip(row.method, 12)} ${row.status ?? '?'} ${formatTime(row.time)} ${formatBytes(row.uncompressed)} ${clip(row.url, 180)}`;
}

function listRow(command, row, result) {
    if (command === 'slow') {
        const phases = Object.entries(row.timings).map(([phase, time]) => `${phase}=${time === null ? '?' : Number(time.toFixed(1))}`).join(' ');
        return `${entryRow(row)} | ${phases}`;
    }
    if (command === 'errors') return `${entryRow(row)} | ${row.reasons.join(', ')}`;
    if (command === 'domains' || command === 'content') {
        return `${clip(row.domain ?? row.type, 65)} | ${row.count} | ${aggregateBytes(row.transfer, row.unknownTransfer)} / ${aggregateBytes(row.uncompressed, row.unknownUncompressed)} | ${formatTime(row.time)}${row.unknownTime ? ` + ?(${row.unknownTime})` : ''}`;
    }
    if (command === 'dup') {
        return `${row.count}x ${clip(row.key, 180)} | индексы: ${row.indices.join(',')}${row.omittedIndices ? `; ещё ${row.omittedIndices}` : ''}`;
    }
    if (command === 'waterfall') {
        const width = 36;
        const span = Math.max(1, result.span || 1);
        const offset = row.offset === null ? null : Math.min(width - 1, Math.floor(row.offset / span * width));
        const length = offset === null ? 0 : Math.max(1, Math.min(width - offset, Math.ceil((row.time || 0) / span * width)));
        const bar = offset === null ? '?'.padEnd(width) : (' '.repeat(offset) + '='.repeat(length)).padEnd(width);
        return `#${row.index} [${bar}] +${formatTime(row.offset)} ${formatTime(row.time)} ${clip(row.url, 125)}`;
    }
    if (command === 'diff') {
        const names = { added: 'появился', removed: 'исчез', slower: 'медленнее', heavier: 'тяжелее', count: 'число запросов' };
        const before = row.before;
        const after = row.after;
        const metric = row.change === 'heavier' ? `${formatBytes(before?.size)} -> ${formatBytes(after?.size)}`
            : row.change === 'slower' ? `${formatTime(before?.time)} -> ${formatTime(after?.time)}`
                : `${before?.count || 0} -> ${after?.count || 0}`;
        return `${names[row.change]} | ${metric} | ${clip(row.method, 10)} ${clip(row.url, 170)}`;
    }
    return entryRow(row);
}

function formatList(result) {
    const header = result.command === 'domains' || result.command === 'content'
        ? 'Группа | запросы | передано / несжатое | сумма времени' : '';
    const lines = [`Совпадений: ${result.total}; показано: ${result.items.length}`];
    if (header) lines.push(header);
    if (result.span !== undefined) lines.push(`Интервал: ${formatTime(result.span)}; '=' обозначает длительность, не фазы ожидания`);
    lines.push(...result.items.map(row => listRow(result.command, row, result)));
    if (!result.total) lines.push('Нет подходящих записей.');
    if (result.omitted) {
        const next = Math.max(result.limit + 1, result.total);
        const top = ['slow', 'domains', 'waterfall'].includes(result.command) ? ` --top ${next}` : '';
        lines.push(`... ещё ${result.omitted}, --limit ${next}${top} (предел вывода 8 KiB)`);
    }
    return lines.join('\n');
}

function formatEntry(result) {
    const entry = result.entry;
    const lines = [
        `Запись #${result.index}: ${clip(entry.request.method, 15)} ${clip(entry.request.url, 500)}`,
        `HTTP ${entry.response.status ?? '?'} ${clip(entry.response.statusText, 100)}; время ${formatTime(entry.time)}`,
        `Начало: ${entry.startedDateTime || '?'}; передано ${formatBytes(entry.sizes.transfer)}, несжатое ${formatBytes(entry.sizes.uncompressed)}`,
        `Фазы: ${Object.entries(entry.timings).map(([phase, time]) => `${phase}=${formatTime(time)}`).join(', ')}`,
        'Заголовки запроса:',
        ...entry.request.headers.map(header => `  ${clip(header.name, 70)}: ${clip(header.value, 300)}`),
        'Заголовки ответа:',
        ...entry.response.headers.map(header => `  ${clip(header.name, 70)}: ${clip(header.value, 300)}`),
        `Контент: ${clip(entry.response.content.mimeType, 100)}; размер ${formatBytes(entry.response.content.size)}`
    ];
    for (const [key, label] of [['requestBody', 'Тело запроса'], ['body', 'Тело ответа']]) {
        const body = result[key];
        if (!body) continue;
        lines.push(`${label} (${body.encoding}, ${body.shownBytes}/${body.bytes} B${body.truncated ? ', обрезано' : ''}):`);
        lines.push(body.text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '?'));
    }
    if (!result.body && !result.requestBody) lines.push(result.message || 'Тела не выводятся; для просмотра --body 2k.');
    if (result.truncated) lines.push('... поля обрезаны до безопасного объёма вывода.');
    return lines.join('\n');
}

function renderText(result) {
    if (result.command === 'info') return formatInfo(result);
    if (result.items) return formatList(result);
    if (result.entry) return formatEntry(result);
    if (result.command === 'redact') return `Очищено запросов: ${result.requests}; HAR записан в ${clip(result.output, 400)}. Исходные размеры сохранены.`;
    if (result.message) return result.message;
    return JSON.stringify(result);
}

function boundedCopy(value, state, key = '', parent = null) {
    if (typeof value === 'string') {
        const bodyText = key === 'text' && parent && Object.hasOwn(parent, 'shownBytes');
        const max = bodyText ? MAX_BYTES - 512 : key === 'url' || key === 'key' ? 600 : 400;
        const safe = bodyText ? value : value.replace(/[\u0000-\u001f\u007f]/g, ' ');
        const shortened = bodyText ? truncateBody(safe, parent, max) : truncateUtf8(safe, max);
        if (shortened !== value) state.truncated = true;
        return shortened;
    }
    if (Array.isArray(value)) return value.map(item => boundedCopy(item, state));
    if (value && typeof value === 'object') {
        const result = {};
        for (const [name, item] of Object.entries(value)) {
            Object.defineProperty(result, name, { value: boundedCopy(item, state, name, value), enumerable: true, writable: true, configurable: true });
        }
        if (Object.hasOwn(result, 'shownBytes') && typeof result.text === 'string') {
            const size = Buffer.byteLength(result.text, result.encoding === 'base64' ? 'base64' : 'utf8');
            if (size < result.shownBytes) {
                result.shownBytes = size;
                result.truncated = true;
            }
        }
        return result;
    }
    return value;
}

function candidates(value, arrays = [], strings = []) {
    if (!value || typeof value !== 'object') return { arrays, strings };
    for (const [key, item] of Object.entries(value)) {
        if (Array.isArray(item) && item.length) arrays.push({ parent: value, key, value: item });
        else if (typeof item === 'string' && item.length > 16) strings.push({ parent: value, key, value: item });
        if (item && typeof item === 'object') candidates(item, arrays, strings);
    }
    return { arrays, strings };
}

function formatResult(original, options = {}) {
    const state = { truncated: false };
    const result = boundedCopy(original, state);
    if (state.truncated) result.truncated = true;
    const render = () => options.json ? JSON.stringify(result, null, options.pretty ? 2 : undefined) : renderText(result);
    let text = render();
    while (!fits(text)) {
        result.truncated = true;
        const fields = candidates(result);
        const rows = fields.arrays.find(field => field.parent === result && field.key === 'items');
        const array = rows || fields.arrays.sort((a, b) => JSON.stringify(b.value).length - JSON.stringify(a.value).length)[0];
        if (array) {
            array.value.pop();
            if (array.parent === result && array.key === 'items') {
                result.shown = result.items.length;
                result.omitted = result.total - result.shown;
            } else if (array.parent === result && array.key === 'domains') result.omittedDomains++;
            else if (array.parent === result && array.key === 'contentTypes') result.omittedContentTypes++;
            else if (array.key === 'indices' && Object.hasOwn(array.parent, 'count')) array.parent.omittedIndices = array.parent.count - array.value.length;
            else result.omittedValues = (result.omittedValues || 0) + 1;
        } else {
            const mapKey = ['statuses', 'methods'].filter(key => result[key] && Object.keys(result[key]).length)
                .sort((a, b) => JSON.stringify(result[b]).length - JSON.stringify(result[a]).length)[0];
            if (mapKey) {
                const keys = Object.keys(result[mapKey]);
                delete result[mapKey][keys[keys.length - 1]];
                const omitted = mapKey === 'statuses' ? 'omittedStatuses' : 'omittedMethods';
                result[omitted] = (result[omitted] || 0) + 1;
                text = render();
                continue;
            }
            const field = fields.strings.sort((a, b) => b.value.length - a.value.length)[0];
            if (!field) break;
            const body = field.key === 'text' && Object.hasOwn(field.parent, 'shownBytes');
            const bytes = Math.max(16, Math.floor(Buffer.byteLength(field.value) / 2));
            field.parent[field.key] = body ? truncateBody(field.value, field.parent, bytes) : truncateUtf8(field.value, bytes);
            if (body) {
                field.parent.shownBytes = Buffer.byteLength(field.parent.text, field.parent.encoding === 'base64' ? 'base64' : 'utf8');
                field.parent.truncated = true;
            }
        }
        text = render();
    }
    if (!fits(text)) {
        return options.json ? JSON.stringify({ command: result.command, truncated: true, message: 'Сводка превышает предел вывода; уменьшите --limit или --body.' })
            : 'Сводка превышает предел вывода; уменьшите --limit или --body.';
    }
    return text;
}

module.exports = { MAX_BYTES, MAX_LINES, clip, truncateUtf8, formatBytes, formatTime, formatResult };
