'use strict';

const SUMMARY_COLUMNS = ['index', 'method', 'status', 'url', 'domain', 'mimeType', 'time', 'startedDateTime', 'start', 'transfer', 'uncompressed', 'compression', 'uncompressedEstimated'];
const GROUP_COLUMNS = ['count', 'transfer', 'uncompressed', 'unknownTransfer', 'unknownUncompressed', 'time', 'unknownTime'];
const COMMAND_COLUMNS = {
    search: SUMMARY_COLUMNS,
    slow: SUMMARY_COLUMNS.concat('timings'),
    errors: SUMMARY_COLUMNS.concat('reasons'),
    waterfall: SUMMARY_COLUMNS.concat('offset'),
    domains: ['domain', ...GROUP_COLUMNS],
    content: ['type', ...GROUP_COLUMNS],
    dup: ['key', 'count', 'indices', 'urls', 'omittedIndices'],
    diff: ['change', 'method', 'url', 'before', 'after']
};
const INFO_COLUMNS = { domains: ['domain', ...GROUP_COLUMNS], contentTypes: ['type', ...GROUP_COLUMNS] };
const ENDPOINT_COLUMNS = ['count', 'time', 'size', 'unknownTime', 'unknownSize'];

function object(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function table(items, schema, defaults) {
    if (!Array.isArray(items) || !items.length || !items.every(object)) return items;
    const columns = schema.filter(key => Object.hasOwn(items[0], key));
    if (!items.every(row => Object.keys(row).length === columns.length && columns.every(key => Object.hasOwn(row, key)))) return items;
    const plain = { columns, rows: items.map(row => columns.map(key => row[key])) };
    if (!defaults || items.length < 2) return plain;
    const common = {};
    for (const key of columns) {
        const value = items[0][key];
        if ((value === null || ['string', 'number', 'boolean'].includes(typeof value))
            && items.every(row => row[key] === value)) common[key] = value;
    }
    if (!Object.keys(common).length) return plain;
    const variable = columns.filter(key => !Object.hasOwn(common, key));
    const candidate = { columns: variable, rows: items.map(row => variable.map(key => row[key])), defaults: common };
    return Buffer.byteLength(JSON.stringify(candidate)) < Buffer.byteLength(JSON.stringify(plain)) ? candidate : plain;
}

function encodeLists(baseline, { defaults = false } = {}) {
    const data = { ...baseline };
    const result = { data };
    const schema = COMMAND_COLUMNS[data.command];
    if (schema) {
        let items = data.items;
        if (data.command === 'diff' && Array.isArray(items)) {
            let changed = false;
            items = items.map(row => {
                if (!object(row)) return row;
                const copy = { ...row };
                for (const side of ['before', 'after']) {
                    const value = row[side];
                    if (object(value) && Object.keys(value).length === ENDPOINT_COLUMNS.length
                        && ENDPOINT_COLUMNS.every(key => Object.hasOwn(value, key))) {
                        copy[side] = ENDPOINT_COLUMNS.map(key => value[key]);
                        changed = true;
                    }
                }
                return copy;
            });
            if (changed) result.endpointColumns = ENDPOINT_COLUMNS.slice();
        }
        if (Object.hasOwn(data, 'items')) data.items = table(items, schema, defaults);
    }
    if (data.command === 'info') {
        for (const key of ['domains', 'contentTypes']) {
            if (Object.hasOwn(data, key)) data[key] = table(data[key], INFO_COLUMNS[key], defaults);
        }
    }
    return result;
}

module.exports = { encodeLists };
