'use strict';

const crypto = require('node:crypto');

const PHASES = ['blocked', 'dns', 'connect', 'ssl', 'send', 'wait', 'receive'];

function knownSize(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function getSizes(entry) {
    const response = entry.response || {};
    const content = response.content || {};
    const size = knownSize(content.size);
    const body = knownSize(response.bodySize);
    const compression = typeof content.compression === 'number' && Number.isFinite(content.compression)
        ? content.compression : null;
    const derived = size !== null && compression !== null ? knownSize(size - compression) : null;
    const transfer = body !== null ? body : derived;
    const uncompressed = size !== null ? size : body;
    return {
        transfer,
        uncompressed,
        compression: transfer !== null && size !== null ? size - transfer : null,
        uncompressedEstimated: size === null && body !== null
    };
}

function getTimings(entry) {
    const timings = Object.fromEntries(PHASES.map(phase => [phase, knownSize(entry.timings?.[phase])]));
    // HAR включает SSL в connect. В разбивке эти две фазы не должны считаться дважды.
    if (timings.connect !== null && timings.ssl !== null) {
        timings.connect = Math.max(0, timings.connect - timings.ssl);
    }
    return timings;
}

function getTime(entry) {
    return knownSize(entry.time);
}

function getDomain(url) {
    try {
        return new URL(url).hostname || '(без домена)';
    } catch {
        return '(без домена)';
    }
}

function getMime(entry) {
    const mime = entry.response?.content?.mimeType;
    return typeof mime === 'string' && mime.trim() ? mime.split(';', 1)[0].trim().toLowerCase() : '(неизвестно)';
}

function getCategory(mime) {
    if (mime === '(неизвестно)') return 'unknown';
    if (mime.includes('javascript') || mime.includes('ecmascript')) return 'javascript';
    if (mime === 'text/css') return 'css';
    if (mime === 'text/html' || mime === 'application/xhtml+xml') return 'html';
    if (mime.endsWith('/json') || mime.endsWith('+json')) return 'json';
    if (mime.startsWith('image/')) return 'images';
    if (mime.startsWith('font/') || /font|woff|opentype/.test(mime)) return 'fonts';
    if (mime.startsWith('audio/') || mime.startsWith('video/')) return 'media';
    if (mime.startsWith('text/') || mime.endsWith('/xml') || mime.endsWith('+xml')) return 'text';
    return 'other';
}

function normalizeUrl(raw) {
    const value = typeof raw === 'string' ? raw : '';
    try {
        const url = new URL(value);
        for (const key of [...url.searchParams.keys()]) {
            if (/^(?:_|timestamp|cachebust|cache_bust|_timestamp|_ts|_dc)$/i.test(key)) {
                url.searchParams.delete(key);
            }
        }
        url.searchParams.sort();
        url.pathname = url.pathname.replace(/([.-])[a-f0-9]{6,}(?=\.[^/]+$)/gi, '$1*');
        url.hash = '';
        return url.toString();
    } catch {
        return value;
    }
}

function bodyHash(entry) {
    const content = entry.response?.content;
    if (typeof content?.text !== 'string') return null;
    const body = content.encoding === 'base64' ? Buffer.from(content.text, 'base64') : content.text;
    return crypto.createHash('sha256').update(body).digest('hex');
}

function errorReasons(entry) {
    const response = entry.response;
    const status = knownSize(response?.status);
    const reasons = [];
    if (status !== null && status >= 400) reasons.push(`HTTP ${status}`);
    if (!response || status === null || status === 0) reasons.push('обрыв или нет ответа');
    const errors = [entry._error, entry._failureText, entry._blockedReason, response?._error, entry.request?._error]
        .filter(value => value !== undefined && value !== null && value !== false && value !== '');
    if (errors.length) reasons.push('_error');
    const details = errors.filter(value => typeof value === 'string').join(' ').slice(0, 500);
    if (/timeout|timed\s*out|time\s*out|таймаут/i.test(`${response?.statusText || ''} ${details}`)) {
        reasons.push('таймаут');
    }
    const mayBeEmpty = String(entry.request?.method || '').toUpperCase() === 'HEAD' || (status >= 100 && status < 200)
        || status === 204 || status === 205 || (status >= 300 && status < 400);
    const sizes = getSizes(entry);
    const empty = sizes.uncompressed === 0 || (sizes.uncompressed === null && response?.content?.text === '');
    if (response && !mayBeEmpty && status !== 0 && empty) reasons.push('пустой ответ');
    return reasons;
}

function summarizeEntry(index, entry) {
    const url = typeof entry.request?.url === 'string' ? entry.request.url : '';
    const start = Date.parse(entry.startedDateTime);
    return {
        index,
        method: typeof entry.request?.method === 'string' ? entry.request.method : '?',
        status: knownSize(entry.response?.status),
        url,
        domain: getDomain(url),
        mimeType: getMime(entry),
        time: getTime(entry),
        startedDateTime: Number.isFinite(start) ? entry.startedDateTime : null,
        start: Number.isFinite(start) ? start : null,
        ...getSizes(entry)
    };
}

function newAggregate() {
    return { count: 0, transfer: 0, uncompressed: 0, unknownTransfer: 0, unknownUncompressed: 0, time: 0, unknownTime: 0 };
}

function addAggregate(aggregate, sizes, time) {
    aggregate.count++;
    for (const key of ['transfer', 'uncompressed']) {
        if (sizes[key] === null) aggregate[key === 'transfer' ? 'unknownTransfer' : 'unknownUncompressed']++;
        else aggregate[key] += sizes[key];
    }
    if (time === null) aggregate.unknownTime++;
    else aggregate.time += time;
}

function addGroup(groups, name, sizes, time) {
    if (!groups.has(name)) groups.set(name, newAggregate());
    addAggregate(groups.get(name), sizes, time);
}

function createStats(group = null) {
    if (group === 'domains' || group === 'mimeTypes' || group === 'categories') {
        return { requests: 0, group, [group]: new Map() };
    }
    return {
        requests: 0,
        bytes: { transferred_known: 0, transferred_unknown_count: 0, transferred_is_lower_bound: false,
            uncompressed: 0, compression: 0, unknownUncompressed: 0, unknownCompression: 0,
            estimatedUncompressed: 0 },
        durations: [],
        unknownTime: 0,
        firstStart: Infinity,
        lastEnd: -Infinity,
        spanIncomplete: false,
        statuses: new Map(),
        methods: new Map(),
        domains: new Map(),
        mimeTypes: new Map(),
        categories: new Map()
    };
}

function addEntry(stats, entry) {
    stats.requests++;
    const sizes = getSizes(entry);
    const time = getTime(entry);
    if (stats.group) {
        let name;
        if (stats.group === 'domains') name = getDomain(entry.request?.url);
        else {
            const mime = getMime(entry);
            name = stats.group === 'mimeTypes' ? mime : getCategory(mime);
        }
        addGroup(stats[stats.group], name, sizes, time);
        return;
    }
    const size = knownSize(entry.response?.content?.size);
    const body = knownSize(entry.response?.bodySize);
    if (body === null) {
        stats.bytes.transferred_unknown_count++;
        stats.bytes.transferred_is_lower_bound = true;
    } else {
        stats.bytes.transferred_known += body;
    }
    if (sizes.uncompressed === null) stats.bytes.unknownUncompressed++;
    else stats.bytes.uncompressed += sizes.uncompressed;
    if (size !== null && body !== null) stats.bytes.compression += size - body;
    else stats.bytes.unknownCompression++;
    if (sizes.uncompressedEstimated) stats.bytes.estimatedUncompressed++;
    if (time === null) stats.unknownTime++;
    else stats.durations.push(time);
    const start = Date.parse(entry.startedDateTime);
    if (time === null || !Number.isFinite(start)) stats.spanIncomplete = true;
    if (Number.isFinite(start)) {
        stats.firstStart = Math.min(stats.firstStart, start);
        stats.lastEnd = Math.max(stats.lastEnd, start + (time || 0));
    }
    const status = knownSize(entry.response?.status);
    const statusKey = status === null ? 'unknown' : String(status);
    const method = typeof entry.request?.method === 'string' ? entry.request.method.slice(0, 32) : '?';
    stats.statuses.set(statusKey, (stats.statuses.get(statusKey) || 0) + 1);
    stats.methods.set(method, (stats.methods.get(method) || 0) + 1);
    const mime = getMime(entry);
    addGroup(stats.domains, getDomain(entry.request?.url), sizes, time);
    addGroup(stats.mimeTypes, mime, sizes, time);
    addGroup(stats.categories, getCategory(mime), sizes, time);
}

function groupRows(groups, key, sort = 'size') {
    const metric = sort === 'size' ? 'uncompressed' : sort;
    return [...groups].map(([name, values]) => ({ [key]: name, ...values }))
        .sort((a, b) => b[metric] - a[metric] || String(a[key]).localeCompare(String(b[key])));
}

function finishStats(stats, metadata = {}, limit = 5) {
    const sorted = stats.durations.sort((a, b) => a - b);
    const percentile = fraction => sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] : null;
    const domains = groupRows(stats.domains, 'domain', 'count');
    const types = groupRows(stats.mimeTypes, 'type');
    return {
        command: 'info',
        requests: stats.requests,
        pages: Array.isArray(metadata.log?.pages) ? metadata.log.pages.length : 0,
        bytes: stats.bytes,
        time: {
            total: sorted.reduce((total, value) => total + value, 0),
            p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99),
            max: sorted.length ? sorted[sorted.length - 1] : null,
            unknown: stats.unknownTime,
            span: Number.isFinite(stats.firstStart) ? stats.lastEnd - stats.firstStart : null,
            spanIncomplete: stats.spanIncomplete
        },
        statuses: Object.fromEntries([...stats.statuses].sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }))),
        methods: Object.fromEntries([...stats.methods].sort(([a], [b]) => a.localeCompare(b))),
        domains: domains.slice(0, limit),
        contentTypes: types.slice(0, limit),
        omittedDomains: Math.max(0, domains.length - limit),
        omittedContentTypes: Math.max(0, types.length - limit),
        truncated: domains.length > limit || types.length > limit
    };
}

module.exports = {
    PHASES, knownSize, getSizes, getTimings, getTime, getDomain, getMime, getCategory,
    normalizeUrl, bodyHash, errorReasons, summarizeEntry, newAggregate, addAggregate,
    createStats, addEntry, groupRows, finishStats
};
