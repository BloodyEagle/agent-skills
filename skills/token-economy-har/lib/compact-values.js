'use strict';

function bytes(value) {
    return Buffer.byteLength(JSON.stringify(value));
}

function object(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function rewrite(payload, replace) {
    const result = structuredClone(payload);
    const field = (parent, key, kind = 'string') => {
        if (typeof parent?.[key] === 'string') parent[key] = replace(parent[key], kind);
    };
    const strings = (values, kind = 'string') => {
        if (!Array.isArray(values)) return;
        for (let index = 0; index < values.length; index++) {
            if (typeof values[index] === 'string') values[index] = replace(values[index], kind);
        }
    };
    const rows = (value, fields, nested = {}) => {
        if (Array.isArray(value)) {
            for (const row of value) {
                if (!object(row)) continue;
                for (const [name, kind] of Object.entries(fields)) field(row, name, kind);
                for (const [name, kind] of Object.entries(nested)) strings(row[name], kind);
            }
            return;
        }
        if (!object(value) || !Array.isArray(value.columns) || !Array.isArray(value.rows)) return;
        const indexes = new Map(value.columns.map((name, index) => [name, index]));
        for (const row of value.rows) {
            if (!Array.isArray(row)) continue;
            for (const [name, kind] of Object.entries(fields)) {
                const index = indexes.get(name);
                if (index !== undefined && typeof row[index] === 'string') row[index] = replace(row[index], kind);
            }
            for (const [name, kind] of Object.entries(nested)) {
                const index = indexes.get(name);
                if (index !== undefined) strings(row[index], kind);
            }
        }
        if (object(value.defaults)) {
            for (const [name, kind] of Object.entries(fields)) field(value.defaults, name, kind);
            for (const [name, kind] of Object.entries(nested)) strings(value.defaults[name], kind);
        }
    };
    const data = result.data;
    if (!object(data)) return result;
    const summary = { method: 'string', domain: 'string', mimeType: 'string', url: 'url' };
    if (data.command === 'info') {
        rows(data.domains, { domain: 'string' });
        rows(data.contentTypes, { type: 'string' });
    }
    if (Object.hasOwn(data, 'items')) {
        const fields = { ...summary };
        const nested = {};
        if (data.command === 'content' && data.byMime) fields.type = 'string';
        if (data.command === 'errors') nested.reasons = 'string';
        if (data.command === 'dup' && data.strategy !== 'hash') {
            fields.key = 'url';
            nested.urls = 'url';
        }
        rows(data.items, fields, nested);
    }
    if (data.command === 'entry' && object(data.entry)) {
        const request = data.entry.request;
        const response = data.entry.response;
        field(request, 'method');
        field(request, 'url', 'url');
        field(response, 'redirectURL', 'url');
        field(response?.content, 'mimeType');
        const headers = value => {
            if (!Array.isArray(value)) return;
            const nameIndex = Array.isArray(result.headerColumns) ? result.headerColumns.indexOf('name') : -1;
            for (const pair of value) {
                if (object(pair)) field(pair, 'name');
                else if (Array.isArray(pair) && nameIndex >= 0 && typeof pair[nameIndex] === 'string') {
                    pair[nameIndex] = replace(pair[nameIndex], 'string');
                }
            }
        };
        headers(request?.headers);
        headers(response?.headers);
    }
    return result;
}

function occurrences(payload) {
    const values = new Map();
    rewrite(payload, (value, kind) => {
        const item = values.get(value) || { count: 0, kinds: new Set() };
        item.count++;
        item.kinds.add(kind);
        values.set(value, item);
        return value;
    });
    return values;
}

function dictionary(payload) {
    if (Object.hasOwn(payload, 'strings')) return payload;
    const values = [...occurrences(payload)]
        .filter(([, item]) => item.count > 1)
        .map(([value, item]) => ({ value, count: item.count, score: (item.count - 1) * JSON.stringify(value).length - item.count * 11 }))
        .sort((a, b) => b.score - a.score || b.value.length - a.value.length || a.value.localeCompare(b.value));
    const build = selected => {
        const indexes = new Map(selected.map(({ value }, index) => [value, index]));
        const candidate = rewrite(payload, value => indexes.has(value) ? { $ref: indexes.get(value) } : value);
        candidate.strings = selected.map(item => item.value);
        return candidate;
    };
    let selected = values;
    let candidate = selected.length ? build(selected) : payload;
    while (selected.length && bytes(candidate) >= bytes(payload)) {
        selected = selected.slice(0, -1);
        candidate = selected.length ? build(selected) : payload;
    }
    if (!selected.length) return payload;
    for (;;) {
        let improvement = candidate;
        let next = selected;
        for (let index = 0; index < selected.length; index++) {
            const subset = selected.slice(0, index).concat(selected.slice(index + 1));
            if (!subset.length) continue;
            const trial = build(subset);
            if (bytes(trial) < bytes(improvement)) {
                improvement = trial;
                next = subset;
            }
        }
        if (next === selected) return candidate;
        selected = next;
        candidate = improvement;
    }
}

function commonPrefix(left, right) {
    let index = 0;
    const length = Math.min(left.length, right.length);
    while (index < length && left[index] === right[index]) index++;
    const slash = left.lastIndexOf('/', index - 1);
    return slash < 11 ? '' : left.slice(0, slash + 1);
}

function prefixes(payload) {
    if (Object.hasOwn(payload, 'urlPrefixes')) return payload;
    const counts = new Map();
    rewrite(payload, (value, kind) => {
        if (kind === 'url' && value) counts.set(value, (counts.get(value) || 0) + 1);
        return value;
    });
    const urls = [...counts.keys()];
    const choices = new Set();
    for (let left = 0; left < urls.length; left++) for (let right = left + 1; right < urls.length; right++) {
        const prefix = commonPrefix(urls[left], urls[right]);
        if (prefix) choices.add(prefix);
    }
    const ranked = [...choices].map(prefix => {
        const matches = urls.filter(url => url.startsWith(prefix));
        const count = matches.reduce((sum, url) => sum + counts.get(url), 0);
        return { prefix, distinct: matches.length, score: count * prefix.length - JSON.stringify(prefix).length - count * 22 };
    }).filter(item => item.distinct > 1 && item.score > 0)
        .sort((a, b) => b.score - a.score || b.prefix.length - a.prefix.length || a.prefix.localeCompare(b.prefix));
    const build = selected => {
        const encode = prefixes => {
            const used = new Set();
            const candidate = rewrite(payload, (value, kind) => {
                if (kind !== 'url') return value;
                let found = -1;
                for (let index = 0; index < prefixes.length; index++) {
                    if (value.startsWith(prefixes[index]) && (found < 0 || prefixes[index].length > prefixes[found].length)) found = index;
                }
                if (found < 0) return value;
                used.add(found);
                return { $prefix: [found, value.slice(prefixes[found].length)] };
            });
            return { candidate, used };
        };
        let ordered = selected.map(item => item.prefix);
        let { candidate, used } = encode(ordered);
        if (used.size !== ordered.length) {
            ordered = ordered.filter((prefix, index) => used.has(index));
            ({ candidate } = encode(ordered));
        }
        candidate.urlPrefixes = ordered;
        return candidate;
    };
    let selected = [];
    let candidate = payload;
    for (const choice of ranked) {
        const trial = build(selected.concat(choice));
        if (bytes(trial) < bytes(candidate)) {
            selected = selected.concat(choice);
            candidate = trial;
        }
    }
    return candidate;
}

function encodeValues(payload, { dictionary: useDictionary = true, prefixes: usePrefixes = true } = {}) {
    const candidates = [payload];
    if (useDictionary) candidates.push(dictionary(payload));
    if (usePrefixes) candidates.push(prefixes(payload));
    if (useDictionary && usePrefixes) {
        candidates.push(prefixes(dictionary(payload)));
        candidates.push(dictionary(prefixes(payload)));
    }
    return candidates.reduce((best, candidate) => bytes(candidate) < bytes(best) ? candidate : best);
}

module.exports = { encodeValues };
