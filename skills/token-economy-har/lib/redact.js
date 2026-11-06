'use strict';

// Мутирует одну запись или метаданные; размеры HAR и тайминги не пересчитывает.
// Неподдерживаемые тела и чрезмерно глубокие данные удаляются, а не пропускаются.

const REDACTED = '[REDACTED]';

// Подписанный JWT: header.payload.signature в base64url.
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{5,}\b/g;
// user:pass@ сразу после scheme:// или в начале protocol-relative ссылки.
const USERINFO_RE = /^([a-z][a-z0-9+.\-]*:)?\/\/[^/?#]*@/i;
// user:pass@ внутри произвольного текста (схема обязательна).
const TEXT_USERINFO_RE = /([a-z][a-z0-9+.\-]*:\/\/)[^\s/?#@]+(?::[^/\s?#@]*)?@/gi;
const URL_START_RE = /^(?:[a-z][a-z0-9+.\-]*:)?\/\//i;

// Подстроки в нормализованном имени (нижний регистр, без разделителей).
const SENSITIVE_SUBSTRINGS = [
    'token', 'secret', 'apikey', 'password', 'passwd', 'csrf', 'xsrf', 'jwt',
    'signature', 'cookie', 'session', 'sessid', 'credential', 'nonce',
    'authorization', 'authenticat', 'privatekey', 'accesskey'
];
// Отдельные сегменты camelCase/разделителей: auth, oauth, sid и т.д.
// ('author' и 'authority' сюда не попадают — это не 'auth').
const SENSITIVE_SEGMENTS = new Set([
    'auth', 'oauth', 'pass', 'pwd', 'passwd', 'password', 'passphrase',
    'sid', 'secret', 'apikey', 'signature', 'csrf', 'xsrf', 'jwt', 'nonce', 'token', 'saml', 'assertion'
]);
// Ключи расширений, строковое значение которых считается потенциальным телом.
const BODY_KEYS = new Set([
    'text', 'body', 'content', 'data', 'message', 'payload', 'html', 'xml', 'json',
    'requestbody', 'responsebody', 'requesttext', 'responsetext', 'postdata'
]);
// Заголовки, значения которых чистятся как URL, но сами не удаляются.
const URL_VALUE_HEADERS = new Set(['location', 'referer', 'referrer', 'refresh', 'content-location']);

// Известные ключи HAR; остальные (включая _*) идут через общий обход.
const ENTRY_KEYS = new Set([
    'pageref', 'starteddatetime', 'time', 'request', 'response', 'cache',
    'timings', 'serveripaddress', 'connection'
]);
const REQUEST_KEYS = new Set([
    'method', 'url', 'httpversion', 'headers', 'querystring', 'cookies',
    'postdata', 'headerssize', 'bodysize'
]);
const RESPONSE_KEYS = new Set([
    'status', 'statustext', 'httpversion', 'headers', 'cookies', 'content',
    'redirecturl', 'headerssize', 'bodysize'
]);
const CONTENT_KEYS = new Set(['size', 'compression', 'mimetype', 'text', 'encoding']);
const POSTDATA_KEYS = new Set(['mimetype', 'params', 'text', 'encoding']);

const MAX_TEXT_LENGTH = 512;
const MAX_DEPTH = 24;

function safeDecode(value) {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

function segments(name) {
    return String(name)
        .split(/[^A-Za-z0-9]+/)
        .flatMap(part => part.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/))
        .map(part => part.toLowerCase())
        .filter(Boolean);
}

// Консервативно, но без неспецифичных совпадений: 'monkey' не секрет,
// 'size'/'status'/'time' не матчатся, 'author' не считается 'auth'.
function isSensitiveName(name) {
    if (typeof name !== 'string' || !name) return false;
    const norm = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!norm) return false;
    if (SENSITIVE_SUBSTRINGS.some(part => norm.includes(part))) return true;
    const parts = segments(name);
    if (parts.some(part => SENSITIVE_SEGMENTS.has(part))) return true;
    if (parts.includes('api') && parts.includes('key')) return true;
    if (parts.includes('access') && parts.includes('key')) return true;
    if (parts.includes('private') && parts.includes('key')) return true;
    return false;
}

function isSensitiveParameter(name) {
    return isSensitiveName(name) || /^(?:key|code|state|samlresponse|samlrequest|assertion)$/i.test(String(name));
}

function scrubParameters(query) {
    return query.split('&').map(pair => {
        const eq = pair.indexOf('=');
        const name = eq === -1 ? pair : pair.slice(0, eq);
        return isSensitiveParameter(safeDecode(name.replace(/\+/g, ' '))) ? `${name}=${REDACTED}` : pair;
    }).join('&');
}

function structuralKey(key) {
    return typeof key === 'string' ? key.toLowerCase().replace(/^_+/, '') : '';
}

function looksLikeUrl(value) {
    return typeof value === 'string' && (URL_START_RE.test(value) || /^(?:\/|\.{1,2}\/|[?#])/.test(value));
}

// JWT-подобные строки и scheme://user:pass@ в произвольном тексте.
function scrubText(value) {
    if (typeof value !== 'string' || !value) return value;
    let text = value.replace(TEXT_USERINFO_RE, (match, scheme) => scheme);
    text = text.replace(/(?:[a-z][a-z0-9+.\-]*:\/\/|\/\/)[^\s<>"']+/gi, link => scrubUrl(link));
    text = text.replace(JWT_RE, REDACTED);
    return text;
}

// Убирает user:pass@, чувствительные query-параметры и JWT из ссылки.
// Работает и с относительными ссылками (/path?token=...).
function scrubUrl(raw) {
    if (typeof raw !== 'string' || !raw) return raw;
    let url = raw.replace(USERINFO_RE, (match, scheme) => `${scheme || ''}//`);
    const queryAt = url.indexOf('?');
    const hashAt = url.indexOf('#');
    if (queryAt !== -1 && (hashAt === -1 || queryAt < hashAt)) {
        const head = url.slice(0, queryAt + 1);
        const queryEnd = hashAt === -1 ? url.length : hashAt;
        const query = url.slice(queryAt + 1, queryEnd);
        const tail = url.slice(queryEnd);
        const cleaned = scrubParameters(query);
        url = head + cleaned + tail;
    }
    const fragmentAt = url.indexOf('#');
    if (fragmentAt !== -1 && url.slice(fragmentAt + 1).includes('=')) {
        url = url.slice(0, fragmentAt + 1) + scrubParameters(url.slice(fragmentAt + 1));
    }
    return url.replace(JWT_RE, REDACTED);
}

function cleanLooseText(value) {
    const cleaned = scrubText(value);
    return cleaned.length > MAX_TEXT_LENGTH ? REDACTED : cleaned;
}

// Чувствительные заголовки удаляются целиком; Location/Referer/Refresh —
// только чистятся как URL (redirect может нести токен в query).
function sanitizeHeaders(headers) {
    const kept = headers.filter(header =>
        !(header && typeof header === 'object' && isSensitiveName(header.name)));
    headers.length = 0;
    for (const header of kept) {
        if (typeof header?.value === 'string') {
            const url = URL_VALUE_HEADERS.has(structuralKey(header.name)) || looksLikeUrl(header.value);
            header.value = scrubText(url ? scrubUrl(header.value) : header.value);
        }
        headers.push(header);
    }
    return headers;
}

// Списки вида [{name, value}]: queryString; чувствительные имена -> '[REDACTED]'.
function sanitizeNameValues(items) {
    for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        if (typeof item.name === 'string' && isSensitiveParameter(item.name)) {
            item.value = REDACTED;
        } else if (typeof item.value === 'string' && item.value) {
            item.value = scrubText(item.value);
        }
    }
    return items;
}

// Декодирование base64: бинарное/некорректное utf8 -> null (тело удаляется).
function decodeBody(text) {
    const decoded = Buffer.from(text, 'base64').toString('utf8');
    return decoded.includes('\u0000') || decoded.includes('\uFFFD') ? null : decoded;
}

// Рекурсивная чистка разобранного JSON по чувствительным ключам, URL и JWT.
// Числа, булевы и null не трогаются; вложенность ограничена MAX_DEPTH.
function cleanJsonNode(parent, key, depth) {
    if (depth > MAX_DEPTH) {
        parent[key] = REDACTED;
        return;
    }
    if (isSensitiveName(key)) {
        parent[key] = REDACTED;
        return;
    }
    const value = parent[key];
    if (typeof value === 'string') {
        parent[key] = looksLikeUrl(value) ? scrubUrl(value) : scrubText(value);
        return;
    }
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) cleanJsonNode(value, i, depth + 1);
        return;
    }
    for (const child of Object.keys(value)) cleanJsonNode(value, child, depth + 1);
}

// Разбирает JSON-текст и возвращает очищенную строку; null — не разобрать.
function sanitizeJsonBody(text) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        return null;
    }
    const root = { value: parsed };
    cleanJsonNode(root, 'value', 0);
    return JSON.stringify(root.value);
}

// form-urlencoded: чувствительные ключи -> '[REDACTED]', в значениях чистятся
// JWT и URL с учётками. Нетронутые пары остаются байт в байт.
function sanitizeFormBody(text) {
    return text.split('&').map(pair => {
        const eq = pair.indexOf('=');
        const name = eq === -1 ? pair : pair.slice(0, eq);
        if (isSensitiveParameter(safeDecode(name.replace(/\+/g, ' ')))) return `${name}=${REDACTED}`;
        if (eq === -1) return pair;
        const value = pair.slice(eq + 1);
        const decoded = safeDecode(value);
        const cleaned = looksLikeUrl(decoded) ? scrubUrl(decoded) : scrubText(decoded);
        return cleaned === decoded ? pair : `${name}=${encodeURIComponent(cleaned)}`;
    }).join('&');
}

// Тело с известным форматом (JSON или urlencoded), возможно в base64.
// Возвращает новый текст или null — тогда тело удаляется целиком.
function sanitizeTextBody(text, mime, isBase64) {
    const body = isBase64 ? decodeBody(text) : text;
    if (typeof body !== 'string') return null;
    const cleaned = /urlencoded/i.test(mime) ? sanitizeFormBody(body) : sanitizeJsonBody(body);
    if (cleaned === null) return null;
    return isBase64 ? Buffer.from(cleaned, 'utf8').toString('base64') : cleaned;
}

// Общий обход для метаданных, расширений и нестандартных полей:
// мутирует на месте, числа (размеры, времена, статусы) сохраняет.
function cleanNode(parent, key, depth) {
    const value = parent[key];
    if (value === null || value === undefined) return;
    const structural = structuralKey(key);
    if (Array.isArray(value)) {
        if (structural === 'headers') return sanitizeHeaders(value);
        if (structural === 'cookies' || structural === 'cookie') {
            value.length = 0;
            return;
        }
        if (structural === 'querystring' || structural === 'params') return sanitizeNameValues(value);
        if (structural === 'entries') {
            for (let i = 0; i < value.length; i++) redactEntry(value[i]);
            return;
        }
        if (isSensitiveName(key)) {
            parent[key] = REDACTED;
            return;
        }
        if (depth >= MAX_DEPTH) {
            parent[key] = REDACTED;
            return;
        }
        for (let i = 0; i < value.length; i++) cleanNode(value, i, depth + 1);
        return;
    }
    if (isSensitiveName(key)) {
        parent[key] = REDACTED;
        return;
    }
    if (typeof value === 'string') {
        if (BODY_KEYS.has(structural)) {
            parent[key] = REDACTED;
            return;
        }
        parent[key] = looksLikeUrl(value) ? scrubUrl(value) : cleanLooseText(value);
        return;
    }
    if (typeof value !== 'object') return;
    if (structural === 'cookies' || structural === 'cookie' || isSensitiveName(key)) {
        parent[key] = REDACTED;
        return;
    }
    if (depth >= MAX_DEPTH) {
        parent[key] = REDACTED;
        return;
    }
    for (const child of Object.keys(value)) cleanNode(value, child, depth + 1);
}

// Значение postData.params: вложенный JSON чистится целиком, иначе URL/JWT.
function cleanParamValue(value) {
    if (/^\s*[[{]/.test(value) && /[\]}]\s*$/.test(value)) {
        const cleaned = sanitizeJsonBody(value);
        if (cleaned !== null) return cleaned;
    }
    return looksLikeUrl(value) ? scrubUrl(value) : scrubText(value);
}

function removeUnsupportedBody(holder) {
    delete holder.text;
    delete holder.encoding;
}

function sanitizeText(holder, mime) {
    if (/json|urlencoded/i.test(mime)) {
        const cleaned = sanitizeTextBody(holder.text, mime, holder.encoding === 'base64');
        if (cleaned !== null) {
            holder.text = cleaned;
            return;
        }
    }
    removeUnsupportedBody(holder);
}

function sanitizeContent(content) {
    if (!content || typeof content !== 'object') return;
    const mime = typeof content.mimeType === 'string' ? content.mimeType : '';
    if (Object.hasOwn(content, 'text')) {
        if (typeof content.text === 'string') sanitizeText(content, mime);
        else removeUnsupportedBody(content);
    }
    for (const key of Object.keys(content)) {
        if (!CONTENT_KEYS.has(key.toLowerCase())) cleanNode(content, key, 0);
    }
}

function sanitizePostData(postData) {
    if (!postData || typeof postData !== 'object') return;
    const mime = typeof postData.mimeType === 'string' ? postData.mimeType : '';
    if (Array.isArray(postData.params)) {
        for (const param of postData.params) {
            if (!param || typeof param !== 'object') continue;
            if (typeof param.name === 'string' && isSensitiveParameter(param.name)) {
                param.value = REDACTED;
            } else if (typeof param.value === 'string' && param.value) {
                param.value = cleanParamValue(param.value);
            }
        }
    }
    if (Object.hasOwn(postData, 'text')) {
        if (typeof postData.text === 'string') sanitizeText(postData, mime);
        else removeUnsupportedBody(postData);
    }
    for (const key of Object.keys(postData)) {
        if (!POSTDATA_KEYS.has(key.toLowerCase())) cleanNode(postData, key, 0);
    }
}

// Очищает одну запись HAR. МУТИРУЕТ entry и возвращает её же.
// request/response могут отсутствовать (обрыв) — тогда чистится только прочее.
function redactEntry(entry) {
    if (!entry || typeof entry !== 'object') return entry;
    const request = entry.request;
    if (request && typeof request === 'object') {
        if (typeof request.url === 'string') request.url = scrubUrl(request.url);
        if (Array.isArray(request.headers)) sanitizeHeaders(request.headers);
        if (Array.isArray(request.queryString)) sanitizeNameValues(request.queryString);
        if (Object.hasOwn(request, 'cookies')) request.cookies = [];
        sanitizePostData(request.postData);
        for (const key of Object.keys(request)) {
            if (!REQUEST_KEYS.has(key.toLowerCase())) cleanNode(request, key, 0);
        }
    }
    const response = entry.response;
    if (response && typeof response === 'object') {
        if (typeof response.redirectURL === 'string') response.redirectURL = scrubUrl(response.redirectURL);
        if (typeof response.url === 'string') response.url = scrubUrl(response.url);
        if (Array.isArray(response.headers)) sanitizeHeaders(response.headers);
        if (Object.hasOwn(response, 'cookies')) response.cookies = [];
        sanitizeContent(response.content);
        for (const key of Object.keys(response)) {
            if (!RESPONSE_KEYS.has(key.toLowerCase())) cleanNode(response, key, 0);
        }
    }
    if (entry.cache && typeof entry.cache === 'object') {
        for (const key of Object.keys(entry.cache)) cleanNode(entry.cache, key, 0);
    }
    for (const key of Object.keys(entry)) {
        const lower = key.toLowerCase();
        if (ENTRY_KEYS.has(lower) || lower === 'timings') continue;
        cleanNode(entry, key, 0);
    }
    return entry;
}

// Очищает корневой HAR без entries ({log: {...}}); страницы, creator, browser
// и все нестандартные поля чистятся рекурсивно. Если entries присутствуют
// (полный HAR), каждая запись проходит через redactEntry. МУТИРУЕТ metadata.
function redactMetadata(metadata) {
    if (!metadata || typeof metadata !== 'object') return metadata;
    for (const key of Object.keys(metadata)) cleanNode(metadata, key, 0);
    return metadata;
}

module.exports = { redactEntry, redactMetadata, REDACTED, isSensitiveName, scrubUrl, scrubText };
