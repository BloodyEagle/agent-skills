'use strict';

const assert = require('node:assert/strict');

function decodeCompact(document) {
    if (document.format !== 'har-compact-v1') return document;
    const data = structuredClone(document.data);
    const string = value => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
        if (Object.hasOwn(value, '$ref')) {
            assert.deepEqual(Object.keys(value), ['$ref']);
            assert.ok(Number.isInteger(value.$ref) && value.$ref >= 0 && value.$ref < document.strings.length);
            assert.equal(typeof document.strings[value.$ref], 'string');
            return document.strings[value.$ref];
        }
        if (Object.hasOwn(value, '$prefix')) {
            assert.deepEqual(Object.keys(value), ['$prefix']);
            const [index, suffix] = value.$prefix;
            assert.ok(Number.isInteger(index) && index >= 0 && index < document.urlPrefixes.length);
            assert.equal(typeof suffix, 'string');
            return document.urlPrefixes[index] + suffix;
        }
        return value;
    };
    function table(value) {
        if (Array.isArray(value) || !value || !value.columns) return value;
        assert.equal(new Set(value.columns).size, value.columns.length);
        assert.ok(!value.defaults || value.columns.every(column => !Object.hasOwn(value.defaults, column)));
        return value.rows.map(row => {
            assert.equal(row.length, value.columns.length);
            return { ...value.defaults, ...Object.fromEntries(value.columns.map((column, index) => [column, row[index]])) };
        });
    }
    function timings(row) {
        if (document.timingColumns && Array.isArray(row.timings)) {
            assert.equal(row.timings.length, document.timingColumns.length);
            row.timings = Object.fromEntries(document.timingColumns.map((key, index) => [key, row.timings[index]]));
        }
    }
    function fields(row, names) {
        for (const name of names) if (Object.hasOwn(row, name)) row[name] = string(row[name]);
    }
    if (Object.hasOwn(data, 'items')) data.items = table(data.items);
    if (data.command === 'info') {
        for (const field of ['domains', 'contentTypes']) {
            if (Object.hasOwn(data, field)) data[field] = table(data[field]);
            for (const row of data[field] || []) fields(row, [field === 'domains' ? 'domain' : 'type']);
        }
    }
    for (const row of data.items || []) {
        fields(row, ['method', 'domain', 'mimeType', 'url']);
        if (data.command === 'content' && data.byMime) fields(row, ['type']);
        if (data.command === 'slow') timings(row);
        if (data.command === 'errors' && Array.isArray(row.reasons)) row.reasons = row.reasons.map(string);
        if (data.command === 'dup') {
            if (data.strategy !== 'hash') fields(row, ['key']);
            if (Array.isArray(row.urls)) row.urls = row.urls.map(string);
        }
        if (data.command === 'diff' && document.endpointColumns) {
            for (const side of ['before', 'after']) if (Array.isArray(row[side])) {
                assert.equal(row[side].length, document.endpointColumns.length);
                row[side] = Object.fromEntries(document.endpointColumns.map((key, index) => [key, row[side][index]]));
            }
        }
    }
    if (data.command === 'entry' && data.entry) {
        timings(data.entry);
        for (const [side, names, pairFields] of [
            ['request', ['method', 'url'], ['headers', 'queryString']],
            ['response', ['redirectURL'], ['headers']]
        ]) {
            const details = data.entry[side];
            if (!details) continue;
            fields(details, names);
            for (const field of pairFields) {
                if (!Array.isArray(details[field])) continue;
                if (document.headerColumns) details[field] = details[field].map(pair => {
                    if (!Array.isArray(pair)) return pair;
                    assert.equal(pair.length, document.headerColumns.length);
                    return Object.fromEntries(document.headerColumns.map((key, index) => [key, pair[index]]));
                });
                if (field === 'headers') for (const pair of details[field]) fields(pair, ['name']);
            }
        }
        if (data.entry.response?.content) fields(data.entry.response.content, ['mimeType']);
    }
    return data;
}

module.exports = { decodeCompact };
