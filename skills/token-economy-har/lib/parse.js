'use strict';

const fs = require('node:fs');
const { once } = require('node:events');

const STREAM_THRESHOLD = 200 * 1024 * 1024;

function harError(message) {
    const error = new Error(message);
    error.exitCode = 2;
    return error;
}

function parseJson(text, message) {
    try {
        return JSON.parse(text);
    } catch {
        throw harError(message);
    }
}

function validateHar(document) {
    if (!document || typeof document !== 'object' || Array.isArray(document)
        || !document.log || typeof document.log !== 'object' || Array.isArray(document.log)
        || !Array.isArray(document.log.entries)) {
        throw harError('Неверный HAR: требуется объект log с массивом entries.');
    }
    for (let index = 0; index < document.log.entries.length; index++) {
        const entry = document.log.entries[index];
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            throw harError(`Неверный HAR: запись #${index} должна быть объектом.`);
        }
    }
}

function metadataOf(document) {
    const { entries, ...log } = document.log;
    return { ...document, log };
}

function whitespace(character) {
    return character === ' ' || character === '\n' || character === '\r' || character === '\t';
}

function scanner(validateOnly = false) {
    const frames = [];
    const envelope = [];
    const special = /["\\\u0000-\u001f]/g;
    let rootState = 'value';
    let mode = 'outer';
    let inString = false;
    let escaped = false;
    let keyString = false;
    let keyParts = [];
    let primitive = '';
    let entryParts = [];
    let entryBrackets = [];
    let entriesState = 'valueOrEnd';
    let foundEntries = false;
    let index = 0;

    const invalid = () => { throw harError('Битый HAR: неверная структура JSON или незавершённый документ.'); };
    const saveEnvelope = text => { if (!validateOnly && text) envelope.push(text); };
    const frame = () => frames[frames.length - 1];
    const consumeValue = () => {
        const parent = frame();
        if (!parent) {
            if (rootState !== 'value') invalid();
            rootState = 'done';
        } else {
            if (parent.kind === 'object' ? parent.state !== 'value' : !['value', 'valueOrEnd'].includes(parent.state)) invalid();
            parent.state = 'commaOrEnd';
        }
    };
    const finishPrimitive = () => {
        if (!primitive) return;
        parseJson(primitive, 'Битый HAR: некорректное значение JSON.');
        primitive = '';
        consumeValue();
    };

    function* scan(chunk) {
        let position = 0;
        let segment = 0;
        let keyStart = 0;
        while (position < chunk.length) {
            if (inString) {
                if (escaped) {
                    escaped = false;
                    position++;
                    continue;
                }
                // Большие тела почти целиком состоят из строк; пропускаем их кусками, не посимвольно.
                special.lastIndex = position;
                const match = special.exec(chunk);
                if (!match) {
                    position = chunk.length;
                    break;
                }
                position = match.index;
                const character = chunk[position];
                if (character === '\\') {
                    escaped = true;
                    position++;
                    continue;
                }
                if (character !== '"') invalid();
                inString = false;
                if (mode === 'outer') {
                    if (keyString) {
                        keyParts.push(chunk.slice(keyStart, position + 1));
                        const key = parseJson(keyParts.join(''), 'Битый HAR: некорректное имя поля JSON.');
                        const parent = frame();
                        if (parent.root && key === 'log' && parent.logSeen) throw harError('Неоднозначный HAR: поле log повторяется.');
                        if (parent.root && key === 'log') parent.logSeen = true;
                        if (parent.log && key === 'entries' && parent.entriesSeen) throw harError('Неоднозначный HAR: поле log.entries повторяется.');
                        if (parent.log && key === 'entries') parent.entriesSeen = true;
                        parent.key = key;
                        parent.state = 'colon';
                        keyParts = [];
                    } else consumeValue();
                }
                keyString = false;
                position++;
                continue;
            }

            const character = chunk[position];
            if (mode === 'entry') {
                if (character === '"') {
                    inString = true;
                    position++;
                    continue;
                }
                if (character === '{' || character === '[') entryBrackets.push(character === '{' ? '}' : ']');
                else if (character === '}' || character === ']') {
                    if (entryBrackets.pop() !== character) invalid();
                    if (!entryBrackets.length) {
                        let entry;
                        if (!validateOnly) {
                            entryParts.push(chunk.slice(segment, position + 1));
                            entry = parseJson(entryParts.join(''), `Битый JSON в записи HAR #${index}.`);
                        }
                        entryParts = [];
                        mode = 'entries';
                        entriesState = 'commaOrEnd';
                        segment = position + 1;
                        const current = index++;
                        position++;
                        if (!validateOnly) yield { index: current, entry };
                        continue;
                    }
                }
                position++;
                continue;
            }

            if (mode === 'entries') {
                if (whitespace(character)) {
                    position++;
                    continue;
                }
                if (character === ']' && ['valueOrEnd', 'commaOrEnd'].includes(entriesState)) {
                    saveEnvelope(']');
                    mode = 'outer';
                    segment = position + 1;
                    position++;
                    continue;
                }
                if (character === ',' && entriesState === 'commaOrEnd') {
                    entriesState = 'value';
                    position++;
                    continue;
                }
                if (character !== '{' || !['value', 'valueOrEnd'].includes(entriesState)) {
                    throw harError(`Битый HAR: ожидался объект записи #${index} или корректный разделитель entries.`);
                }
                mode = 'entry';
                entryBrackets = ['}'];
                segment = position;
                position++;
                continue;
            }

            if (primitive) {
                if (whitespace(character) || ',]}'.includes(character)) {
                    finishPrimitive();
                    continue;
                }
                primitive += character;
                position++;
                continue;
            }
            if (whitespace(character)) {
                position++;
                continue;
            }
            const parent = frame();
            if (character === '"') {
                keyString = Boolean(parent?.kind === 'object' && ['key', 'keyOrEnd'].includes(parent.state));
                if (!keyString) {
                    if (parent?.kind === 'object' ? parent.state !== 'value' : parent ? !['value', 'valueOrEnd'].includes(parent.state) : rootState !== 'value') invalid();
                }
                keyParts = [];
                keyStart = position;
                inString = true;
                position++;
                continue;
            }
            if (character === '{' || character === '[') {
                const log = character === '{' && Boolean(parent?.root && parent.key === 'log');
                const entries = character === '[' && Boolean(parent?.log && parent.key === 'entries');
                consumeValue();
                if (entries) {
                    if (foundEntries) throw harError('Неоднозначный HAR: массив log.entries повторяется.');
                    foundEntries = true;
                    saveEnvelope(chunk.slice(segment, position + 1));
                    segment = position + 1;
                    mode = 'entries';
                    entriesState = 'valueOrEnd';
                } else frames.push({ kind: character === '{' ? 'object' : 'array', state: character === '{' ? 'keyOrEnd' : 'valueOrEnd', root: !parent, log, key: null });
                position++;
                continue;
            }
            if (character === '}' || character === ']') {
                const kind = character === '}' ? 'object' : 'array';
                const emptyState = kind === 'object' ? 'keyOrEnd' : 'valueOrEnd';
                if (!parent || parent.kind !== kind || !['commaOrEnd', emptyState].includes(parent.state)) invalid();
                frames.pop();
            } else if (character === ',') {
                if (!parent || parent.state !== 'commaOrEnd') invalid();
                parent.state = parent.kind === 'object' ? 'key' : 'value';
            } else if (character === ':') {
                if (!parent || parent.kind !== 'object' || parent.state !== 'colon') invalid();
                parent.state = 'value';
            } else {
                if (!/[-0-9tfn]/.test(character)) invalid();
                if (parent?.kind === 'object' ? parent.state !== 'value' : parent ? !['value', 'valueOrEnd'].includes(parent.state) : rootState !== 'value') invalid();
                primitive = character;
            }
            position++;
        }
        if (mode === 'outer') {
            saveEnvelope(chunk.slice(segment));
            if (inString && keyString) keyParts.push(chunk.slice(keyStart));
        } else if (mode === 'entry' && !validateOnly) entryParts.push(chunk.slice(segment));
    }

    function finish() {
        finishPrimitive();
        if (mode !== 'outer' || inString || frames.length || rootState !== 'done') invalid();
        if (!foundEntries) throw harError('Неверный HAR: не найден массив log.entries.');
        if (validateOnly) return;
        const document = parseJson(envelope.join(''), 'Битый JSON в метаданных HAR.');
        validateHar(document);
        return metadataOf(document);
    }

    return { scan, finish };
}

async function openHar(file, options = {}) {
    const stdin = !file || file === '-';
    let streaming = Boolean(options.stream) || stdin;
    if (!stdin) {
        try {
            const details = await fs.promises.stat(file);
            if (!details.isFile()) throw harError('Путь HAR должен указывать на обычный файл.');
            streaming ||= details.size > STREAM_THRESHOLD;
        } catch (error) {
            if (error.exitCode === 2) throw error;
            throw harError(`Не удалось открыть HAR (${error.code || 'ошибка чтения'}).`);
        }
    }
    if (!streaming) {
        let text;
        try {
            text = await fs.promises.readFile(file, 'utf8');
        } catch (error) {
            throw harError(`Не удалось прочитать HAR (${error.code || 'ошибка чтения'}).`);
        }
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
        const document = parseJson(text, 'Битый JSON в HAR.');
        validateHar(document);
        // Одинаковая политика для неоднозначных повторов log/entries в обоих режимах.
        const keys = scanner(true);
        for (const ignored of keys.scan(text)) void ignored;
        keys.finish();
        return {
            metadata: metadataOf(document), streaming: false,
            entries: (async function* () {
                for (let index = 0; index < document.log.entries.length; index++) yield { index, entry: document.log.entries[index] };
            })()
        };
    }
    const metadata = {};
    const entries = (async function* () {
        let source;
        try {
            source = stdin ? options.input || process.stdin : fs.createReadStream(file, {
                encoding: 'utf8', highWaterMark: options.highWaterMark || 64 * 1024
            });
            if (source.isTTY) throw harError('HAR в stdin не передан; укажите --file.');
            if (typeof source.setEncoding === 'function') source.setEncoding('utf8');
            const parser = scanner();
            let first = true;
            for await (const chunk of source) {
                let text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
                if (first) {
                    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
                    first = false;
                }
                yield* parser.scan(text);
            }
            Object.assign(metadata, parser.finish());
        } catch (error) {
            if (error.exitCode === 2) throw error;
            throw harError(`Не удалось прочитать HAR (${error.code || 'ошибка чтения'}).`);
        } finally {
            if (!stdin && source) {
                source.destroy();
                // Закрытие дескриптора завершается до возврата генератора: на Windows открытый файл блокирует удаление каталога.
                if (!source.closed) await once(source, 'close').catch(() => {});
            }
        }
    })();
    return { entries, metadata, streaming: true };
}

module.exports = { openHar, STREAM_THRESHOLD };
