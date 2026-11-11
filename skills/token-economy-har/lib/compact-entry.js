'use strict';

const TIMING_COLUMNS = ['blocked', 'dns', 'connect', 'ssl', 'send', 'wait', 'receive'];
const HEADER_COLUMNS = ['name', 'value'];

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function packTimings(value) {
    if (!isObject(value) || Object.keys(value).length !== TIMING_COLUMNS.length
        || !TIMING_COLUMNS.every(column => Object.hasOwn(value, column)
            && (value[column] === null || (typeof value[column] === 'number' && Number.isFinite(value[column]))))) {
        return value;
    }
    return TIMING_COLUMNS.map(column => value[column]);
}

function packPairs(value) {
    if (!Array.isArray(value) || value.length === 0
        || !value.every(pair => isObject(pair) && Object.keys(pair).length === HEADER_COLUMNS.length
            && HEADER_COLUMNS.every(column => Object.hasOwn(pair, column) && typeof pair[column] === 'string'))) {
        return value;
    }
    return value.map(pair => HEADER_COLUMNS.map(column => pair[column]));
}

function encodeEntry(payload) {
    const result = { ...payload };
    const data = payload.data;
    if (data.command === 'entry' && isObject(data.entry)) {
        const timings = packTimings(data.entry.timings);
        if (timings !== data.entry.timings) {
            result.data = { ...data, entry: { ...data.entry, timings } };
            result.timingColumns = TIMING_COLUMNS.slice();
        }
    }
    if (data.command === 'slow' && Array.isArray(data.items)) {
        let changed = false;
        const items = data.items.map(row => {
            if (!isObject(row)) return row;
            const timings = packTimings(row.timings);
            if (timings === row.timings) return row;
            changed = true;
            return { ...row, timings };
        });
        if (changed) {
            result.data = { ...data, items };
            result.timingColumns = TIMING_COLUMNS.slice();
        }
    }
    if (data.command === 'slow' && isObject(data.items)
        && Array.isArray(data.items.columns) && Array.isArray(data.items.rows)) {
        const column = data.items.columns.indexOf('timings');
        if (column !== -1) {
            let changed = false;
            const rows = data.items.rows.map(row => {
                if (!Array.isArray(row)) return row;
                const timings = packTimings(row[column]);
                if (timings === row[column]) return row;
                changed = true;
                const packed = row.slice();
                packed[column] = timings;
                return packed;
            });
            if (changed) {
                result.data = { ...data, items: { ...data.items, rows } };
                result.timingColumns = TIMING_COLUMNS.slice();
            }
        }
    }
    if (data.command === 'entry' && isObject(data.entry)) {
        let entry = result.data.entry;
        for (const [side, fields] of [['request', ['headers', 'queryString']], ['response', ['headers']]]) {
            if (!isObject(entry[side])) continue;
            let details = entry[side];
            for (const field of fields) {
                const pairs = packPairs(details[field]);
                if (pairs === details[field]) continue;
                details = { ...details, [field]: pairs };
                result.headerColumns = HEADER_COLUMNS.slice();
            }
            if (details !== entry[side]) entry = { ...entry, [side]: details };
        }
        if (entry !== result.data.entry) result.data = { ...result.data, entry };
    }
    return result;
}

module.exports = { encodeEntry };
