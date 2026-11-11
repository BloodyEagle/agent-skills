'use strict';

const { encodeLists } = require('./compact-list');
const { encodeEntry } = require('./compact-entry');
const { encodeValues } = require('./compact-values');
const { MAX_BYTES, MAX_LINES } = require('./format');

function render(payload) {
    return JSON.stringify({ format: 'har-compact-v1', ...payload });
}

function fits(text) {
    return Buffer.byteLength(text) + 1 <= MAX_BYTES && text.split('\n').length <= MAX_LINES;
}

function encode(baseline, options) {
    let payload = options.tables ? encodeLists(baseline, { defaults: options.defaults }) : { data: structuredClone(baseline) };
    if (options.entry) payload = encodeEntry(payload);
    payload = encodeValues(payload, { dictionary: options.dictionary, prefixes: options.prefixes });
    return payload;
}

function compactCandidates(baseline) {
    const variants = [];
    for (const tables of [false, true]) {
        for (const entry of [false, true]) {
            for (const defaults of [false, true]) {
                for (const dictionary of [false, true]) {
                    for (const prefixes of [false, true]) {
                        variants.push(encode(baseline, { tables, entry, defaults, dictionary, prefixes }));
                    }
                }
            }
        }
    }
    const unique = new Map();
    for (const payload of variants) {
        const text = render(payload);
        if (!unique.has(text)) unique.set(text, payload);
    }
    return [...unique.values()];
}

function compactResult(baseline, baselineText = JSON.stringify(baseline)) {
    let best = baselineText;
    for (const payload of compactCandidates(baseline)) {
        const transformed = Object.keys(payload).some(key => key !== 'data') || payload.data.items?.columns
            || payload.data.domains?.columns || payload.data.contentTypes?.columns;
        if (!transformed) continue;
        const text = render(payload);
        if (fits(text) && Buffer.byteLength(text) < Buffer.byteLength(best)) best = text;
    }
    return best;
}

module.exports = { compactCandidates, compactResult };
