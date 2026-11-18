'use strict';

const descriptionLimit = 1024;
const descriptionWarn = 900;

function parseVersion(value) {
    if (typeof value !== 'string') return null;
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
    if (!match || match[0] !== value) return null;
    const [major, minor, patch] = match.slice(1).map(Number);
    if (![major, minor, patch].every(Number.isSafeInteger)) return null;
    return {major, minor, patch};
}

function unsupported(field, reason) {
    throw new Error(`${field}: неподдерживаемый YAML (${reason})`);
}

function frontmatterField(text, name) {
    const match = /^(\uFEFF?---[^\S\r\n]*\r?\n)([\s\S]*?)(^---[^\S\r\n]*(?:\r?\n|$))/m.exec(text);
    if (!match || match.index !== 0) return null;
    const header = match[2].replace(/\r\n/g, '\n');
    if (header.includes('\r')) unsupported(name, 'нужны LF или CRLF');
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u2028\u2029\ufffe\uffff]/.test(header)) {
        unsupported(name, 'неподдерживаемый символ или сырой Unicode line break');
    }
    const lines = header.split('\n');
    if (lines.at(-1) === '') lines.pop();
    let start = -1;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith(name + ':')) {
            if (start !== -1) unsupported(name, 'повторяющийся ключ');
            if (line.length > name.length + 1 && !/[ \t]/.test(line[name.length + 1])) {
                unsupported(name, 'после двоеточия нужен пробел');
            }
            start = i;
        } else if (new RegExp(`^(?:['"]${name}['"]|${name})[ \\t]*:`).test(line)) {
            unsupported(name, 'нужен некавыченный ключ верхнего уровня');
        } else if (new RegExp(`^\\?[ \\t]+(?:['"]${name}['"]|${name})(?:[ \\t]|$)`).test(line)) {
            unsupported(name, 'явные ключи не поддерживаются');
        }
    }
    if (start < 0) return null;
    const continuation = [];
    for (let i = start + 1; i < lines.length; i++) {
        if (lines[i] !== '' && !/^[ \t]/.test(lines[i])) break;
        continuation.push(lines[i]);
    }
    return {first: lines[start].slice(name.length + 1).replace(/^[ \t]+|[ \t]+$/g, ''), continuation};
}

function noContinuation(field, name) {
    if (field.continuation.some((line) => !/^[ \t]*(?:#.*)?$/.test(line))) {
        unsupported(name, 'многострочные plain/quoted значения не поддерживаются');
    }
}

function plainValue(value, name) {
    const comment = value.search(/(?:^|[ \t])#/);
    const result = (comment < 0 ? value : value.slice(0, comment)).replace(/[ \t]+$/g, '');
    if (/^[\[\]{},&*!|>%@`]/.test(result) || /^[?:-](?:[ \t]|$)/.test(result) || /:(?:[ \t]|$)/.test(result)) {
        unsupported(name, 'коллекции, теги, anchors/aliases и mapping-синтаксис не поддерживаются');
    }
    // YAML 1.2 core: description должен быть строкой, не неявным null/bool/number.
    if (/^(?:~|null|true|false|[-+]?(?:[0-9]+|0o[0-7]+|0x[0-9a-f]+|(?:[0-9]+\.[0-9]*|\.[0-9]+)(?:e[-+]?[0-9]+)?|[0-9]+e[-+]?[0-9]+|\.inf)|\.nan)$/i.test(result)) {
        unsupported(name, 'нестроковый plain scalar; используйте кавычки');
    }
    return result;
}

function quotedValue(value) {
    const quote = value[0];
    const escapes = {'0': '\0', a: '\x07', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r',
        e: '\x1b', ' ': ' ', '"': '"', '/': '/', '\\': '\\', N: '\u0085', _: '\u00a0', L: '\u2028', P: '\u2029'};
    let result = '';
    for (let i = 1; i < value.length; i++) {
        const char = value[i];
        if (char === quote) {
            if (quote === "'" && value[i + 1] === "'") {
                result += "'";
                i++;
                continue;
            }
            const suffix = value.slice(i + 1);
            if (!/^(?:[ \t]*|[ \t]+#.*)$/.test(suffix)) unsupported('description', 'текст после закрывающей кавычки');
            return result;
        }
        if (quote === '"' && char === '\\') {
            const escape = value[++i];
            if (Object.hasOwn(escapes, escape)) {
                result += escapes[escape];
                continue;
            }
            const width = {x: 2, u: 4, U: 8}[escape];
            if (!width) unsupported('description', 'неизвестный escape');
            const hex = value.slice(i + 1, i + 1 + width);
            if (hex.length !== width || !/^[0-9a-f]+$/i.test(hex)) unsupported('description', 'некорректный hex escape');
            const point = Number.parseInt(hex, 16);
            if (point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) {
                unsupported('description', 'escape не является Unicode scalar value');
            }
            result += String.fromCodePoint(point);
            i += width;
        } else {
            result += char;
        }
    }
    unsupported('description', 'незакрытая кавычка или многострочное quoted значение');
}

function blockValue(field) {
    const match = /^([|>])([-+]?)(?:[ \t]+#.*)?$/.exec(field.first);
    if (!match) unsupported('description', 'нужны | или > с необязательным +/-, без explicit indent');
    const source = field.continuation;
    const firstText = source.findIndex((line) => !/^ *$/.test(line));
    const indent = firstText < 0 ? 0 : /^ */.exec(source[firstText])[0].length;
    const rows = source.map((line) => {
        const spaces = /^ */.exec(line)[0].length;
        if (line[spaces] === '\t') unsupported('description', 'табуляция в отступе');
        if (/^ *$/.test(line)) {
            if (firstText >= 0 && spaces > indent) unsupported('description', 'избыточный отступ пустой строки');
            return '';
        }
        if (!indent || spaces !== indent) unsupported('description', 'неодинаковый/more-indented отступ блока');
        return line.slice(indent);
    });
    let end = rows.length;
    while (end > 0 && rows[end - 1] === '') end--;
    if (end === 0) return match[2] === '+' ? '\n'.repeat(rows.length) : '';
    let result = '';
    for (let i = 0; i < end; i++) {
        if (i > 0) result += match[1] === '|' ? '\n' : rows[i - 1] === '' ? '\n' : rows[i] === '' ? '' : ' ';
        result += rows[i];
    }
    if (match[2] !== '-') result += '\n';
    if (match[2] === '+') result += '\n'.repeat(rows.length - end);
    return result;
}

function validUnicode(value) {
    for (const char of value) {
        const point = char.codePointAt(0);
        if (point >= 0xd800 && point <= 0xdfff) unsupported('description', 'одиночный Unicode surrogate');
    }
    return value;
}

function parseDescription(text) {
    const field = frontmatterField(text, 'description');
    if (!field) return null;
    let value;
    if (/^[|>]/.test(field.first)) value = blockValue(field);
    else {
        noContinuation(field, 'description');
        value = /^["']/.test(field.first) ? quotedValue(field.first) : plainValue(field.first, 'description');
    }
    return validUnicode(value);
}

function parseFrontmatterVersion(text) {
    const field = frontmatterField(text, 'version');
    if (!field) return null;
    noContinuation(field, 'version');
    const value = plainValue(field.first, 'version');
    if (!parseVersion(value)) throw new Error('version: нужна каноническая числовая тройка X.Y.Z без ведущих нулей, с safe-integer компонентами');
    return value;
}

function descriptionIssue(value) {
    if (value === null) return 'в SKILL.md нет description: в frontmatter';
    if (value.trim() === '') return 'description пустое';
    const length = [...value].length;
    if (length > descriptionLimit) return `description ${length} Unicode code points > ${descriptionLimit} — превышен локальный лимит CLI`;
    return null;
}

module.exports = {parseVersion, parseDescription, parseFrontmatterVersion, descriptionIssue, descriptionLimit, descriptionWarn};
