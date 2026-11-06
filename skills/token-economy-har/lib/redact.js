'use strict';

// Мутирует одну запись или метаданные; размеры HAR и тайминги не пересчитывает.
// Неподдерживаемые тела и чрезмерно глубокие данные удаляются, а не пропускаются.

const REDACTED = '[REDACTED]';

// Подписанный JWT: header.payload.signature в base64url.
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{5,}\b/g;
const PRIVATE_PEM_RE = /-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?)(?=-|\s|$)-{0,5}[\s\S]*?(?:-----END \1-----|$)/gi;
const PRIVATE_PEM_END_RE = /-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?(?=-|\s|$)/i;
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
    'sid', 'secret', 'apikey', 'signature', 'sig', 'hmac', 'csrf', 'xsrf', 'jwt', 'nonce', 'token', 'saml', 'assertion'
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

function createRedactionContext() {
    return { pageIds: new Map() };
}

function redactPageId(value, context) {
    if (!context.pageIds.has(value)) context.pageIds.set(value, `page-${context.pageIds.size + 1}`);
    return context.pageIds.get(value);
}

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
    if (SENSITIVE_SEGMENTS.has(norm)) return true;
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

function scrubParameters(query, depth) {
    if (depth >= MAX_DEPTH) return encodeURIComponent(REDACTED);
    return query.split('&').map(pair => {
        const eq = pair.indexOf('=');
        const name = eq === -1 ? pair : pair.slice(0, eq);
        if (isSensitiveParameter(safeDecode(name.replace(/\+/g, ' ')))) return `${name}=${encodeURIComponent(REDACTED)}`;
        if (eq === -1) return pair;
        const value = pair.slice(eq + 1);
        const decoded = safeDecode(value.replace(/\+/g, ' '));
        const cleaned = cleanParamValue(decoded, depth + 1);
        return cleaned === decoded ? pair : `${name}=${encodeURIComponent(cleaned)}`;
    }).join('&');
}

function structuralKey(key) {
    return typeof key === 'string' ? key.toLowerCase().replace(/^_+/, '') : '';
}

function looksLikeUrl(value) {
    return typeof value === 'string' && (URL_START_RE.test(value) || /^(?:\/|\.{1,2}\/|[?#])/.test(value)
        || /^[^\s?#]+[?#][^\s]*$/.test(value));
}

function scrubSecrets(value) {
    const cleaned = value.replace(PRIVATE_PEM_RE, REDACTED);
    // Без завершающего маркера удаляем остаток блока; без начального — всю строку.
    return PRIVATE_PEM_END_RE.test(cleaned) ? REDACTED : cleaned.replace(JWT_RE, REDACTED);
}

// Известные секреты и scheme://user:pass@ в произвольном тексте.
function scrubText(value, depth = 0) {
    if (typeof value !== 'string' || !value) return value;
    let text = scrubSecrets(value);
    if (looksLikeUrl(text)) text = scrubUrl(text, depth + 1);
    text = text.replace(TEXT_USERINFO_RE, (match, scheme) => scheme);
    text = text.replace(/(?:[a-z][a-z0-9+.\-]*:\/\/|\/\/)[^\s<>"']+/gi, link => scrubUrl(link, depth + 1));
    return scrubSecrets(text);
}

// Убирает user:pass@, чувствительные query-параметры и JWT из ссылки.
// Работает и с относительными ссылками (/path?token=...).
function scrubUrl(raw, depth = 0) {
    if (typeof raw !== 'string' || !raw) return raw;
    if (depth >= MAX_DEPTH) return REDACTED;
    let url = raw.replace(USERINFO_RE, (match, scheme) => `${scheme || ''}//`);
    const queryAt = url.indexOf('?');
    const hashAt = url.indexOf('#');
    if (queryAt !== -1 && (hashAt === -1 || queryAt < hashAt)) {
        const head = url.slice(0, queryAt + 1);
        const queryEnd = hashAt === -1 ? url.length : hashAt;
        const query = url.slice(queryAt + 1, queryEnd);
        const tail = url.slice(queryEnd);
        const cleaned = scrubParameters(query, depth + 1);
        url = head + cleaned + tail;
    }
    const fragmentAt = url.indexOf('#');
    if (fragmentAt !== -1 && URL_START_RE.test(url.slice(fragmentAt + 1))) {
        url = url.slice(0, fragmentAt + 1) + scrubUrl(url.slice(fragmentAt + 1), depth + 1);
    } else if (fragmentAt !== -1 && url.slice(fragmentAt + 1).includes('=')) {
        const fragment = url.slice(fragmentAt + 1);
        const questionAt = fragment.indexOf('?');
        const routeQueryAt = questionAt !== -1 && (fragment.startsWith('/') || questionAt < fragment.indexOf('=')) ? questionAt : -1;
        const head = routeQueryAt === -1 ? '' : fragment.slice(0, routeQueryAt + 1);
        const parameters = routeQueryAt === -1 ? fragment : fragment.slice(routeQueryAt + 1);
        url = url.slice(0, fragmentAt + 1) + head + scrubParameters(parameters, depth + 1);
    }
    return scrubSecrets(url.replace(TEXT_USERINFO_RE, (match, scheme) => scheme));
}

function cleanLooseText(value, depth) {
    const cleaned = scrubText(value, depth);
    return cleaned.length > MAX_TEXT_LENGTH ? REDACTED : cleaned;
}

// Чувствительные заголовки удаляются целиком; Location/Referer/Refresh —
// только чистятся как URL (redirect может нести токен в query).
function sanitizeHeaders(headers, context, depth) {
    if (depth >= MAX_DEPTH) return REDACTED;
    const kept = headers.filter(header =>
        !(header && typeof header === 'object' && isSensitiveName(header.name)));
    headers.length = 0;
    for (const header of kept) {
        headers.push(header);
        if (!header || typeof header !== 'object' || depth + 1 >= MAX_DEPTH) {
            cleanNode(headers, headers.length - 1, depth + 1, context);
            continue;
        }
        if (typeof header?.value === 'string') {
            const url = URL_VALUE_HEADERS.has(structuralKey(header.name)) || looksLikeUrl(header.value);
            header.value = scrubText(url ? scrubUrl(header.value, depth + 2) : header.value, depth + 2);
        }
        for (const key of Object.keys(header)) {
            if (key !== 'value' || typeof header.value !== 'string') cleanNode(header, key, depth + 2, context);
        }
    }
    return headers;
}

// Списки вида [{name, value}]: queryString; чувствительные имена -> '[REDACTED]'.
function sanitizeNameValues(items, context, depth, jsonValues = false) {
    if (depth >= MAX_DEPTH) return REDACTED;
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (!item || typeof item !== 'object' || depth + 1 >= MAX_DEPTH) {
            cleanNode(items, i, depth + 1, context);
            continue;
        }
        if (typeof item.name === 'string' && isSensitiveParameter(safeDecode(item.name.replace(/\+/g, ' ')))) {
            item.value = REDACTED;
        } else if (typeof item.value === 'string' && item.value) {
            item.value = cleanParamValue(item.value, depth + 2, jsonValues);
        }
        for (const key of Object.keys(item)) {
            if (key !== 'value' || typeof item.value !== 'string') cleanNode(item, key, depth + 2, context);
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
    if (depth >= MAX_DEPTH) {
        parent[key] = REDACTED;
        return;
    }
    if (isSensitiveName(key)) {
        parent[key] = REDACTED;
        return;
    }
    const value = parent[key];
    if (typeof value === 'string') {
        parent[key] = looksLikeUrl(value) && !/\s/.test(value) ? scrubUrl(value, depth) : scrubText(value, depth);
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
function sanitizeJsonBody(text, depth) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        return null;
    }
    const root = { value: parsed };
    cleanJsonNode(root, 'value', depth);
    return JSON.stringify(root.value);
}

// form-urlencoded: чувствительные ключи -> '[REDACTED]', в значениях чистятся
// JWT и URL с учётками. Нетронутые пары остаются байт в байт.
function sanitizeFormBody(text, depth) {
    return scrubParameters(text, depth);
}

// Тело с известным форматом (JSON или urlencoded), возможно в base64.
// Возвращает новый текст или null — тогда тело удаляется целиком.
function sanitizeTextBody(text, mime, isBase64, depth) {
    if (depth >= MAX_DEPTH) return null;
    const body = isBase64 ? decodeBody(text) : text;
    if (typeof body !== 'string') return null;
    const cleaned = /urlencoded/i.test(mime) ? sanitizeFormBody(body, depth + 1) : sanitizeJsonBody(body, depth + 1);
    if (cleaned === null) return null;
    return isBase64 ? Buffer.from(cleaned, 'utf8').toString('base64') : cleaned;
}

// Общий обход для метаданных, расширений и нестандартных полей:
// мутирует на месте, числа (размеры, времена, статусы) сохраняет.
function cleanNode(parent, key, depth, context) {
    const value = parent[key];
    if (value === null || value === undefined) return;
    if (typeof value === 'object' && depth >= MAX_DEPTH) {
        parent[key] = REDACTED;
        return;
    }
    const structural = structuralKey(key);
    if (Array.isArray(value)) {
        if (structural === 'headers') {
            parent[key] = sanitizeHeaders(value, context, depth);
            return;
        }
        if (structural === 'cookies' || structural === 'cookie') {
            value.length = 0;
            return;
        }
        if (structural === 'querystring' || structural === 'params') {
            parent[key] = sanitizeNameValues(value, context, depth, structural === 'params');
            return;
        }
        if (structural === 'entries') {
            for (let i = 0; i < value.length; i++) value[i] = redactEntry(value[i], context, depth + 1);
            return;
        }
        if (structural === 'pages') {
            for (let i = 0; i < value.length; i++) {
                const page = value[i];
                if (!page || typeof page !== 'object' || Array.isArray(page) || depth + 1 >= MAX_DEPTH) {
                    cleanNode(value, i, depth + 1, context);
                    continue;
                }
                if (typeof page.id === 'string') page.id = redactPageId(page.id, context);
                for (const child of Object.keys(page)) {
                    if (child !== 'id' || typeof page.id !== 'string') cleanNode(page, child, depth + 2, context);
                }
            }
            return;
        }
        if (isSensitiveName(key)) {
            parent[key] = REDACTED;
            return;
        }
        for (let i = 0; i < value.length; i++) cleanNode(value, i, depth + 1, context);
        return;
    }
    if (isSensitiveName(key)) {
        parent[key] = REDACTED;
        return;
    }
    if (typeof value === 'string') {
        if (structural === 'pageref') {
            parent[key] = redactPageId(value, context);
            return;
        }
        if (BODY_KEYS.has(structural)) {
            parent[key] = REDACTED;
            return;
        }
        parent[key] = looksLikeUrl(value)
            ? /\s/.test(value) ? scrubText(value, depth) : scrubUrl(value, depth)
            : cleanLooseText(value, depth);
        return;
    }
    if (typeof value !== 'object') return;
    if (structural === 'cookies' || structural === 'cookie') {
        parent[key] = REDACTED;
        return;
    }
    if (structural === 'postdata') {
        parent[key] = sanitizePostData(value, context, depth);
        return;
    }
    if (structural === 'content') {
        parent[key] = sanitizeContent(value, context, depth);
        return;
    }
    for (const child of Object.keys(value)) cleanNode(value, child, depth + 1, context);
}

// URL/form/query используют одну очистку; JSON разбирается только у postData.params.
function cleanParamValue(value, depth, jsonValues = false) {
    if (depth >= MAX_DEPTH) return REDACTED;
    if (jsonValues && /^\s*[[{]/.test(value) && /[\]}]\s*$/.test(value)) {
        const cleaned = sanitizeJsonBody(value, depth + 1);
        if (cleaned !== null) return cleaned;
    }
    const url = looksLikeUrl(value);
    const cleaned = url && !/\s/.test(value) ? scrubUrl(value, depth + 1) : scrubText(value, depth + 1);
    if (cleaned !== value || url) return cleaned;
    const decoded = safeDecode(value);
    if (decoded === value) return value;
    if (jsonValues && /^\s*[[{]/.test(decoded) && /[\]}]\s*$/.test(decoded)) {
        const json = sanitizeJsonBody(decoded, depth + 1);
        if (json !== null) return json;
    }
    const scrubbed = looksLikeUrl(decoded) && !/\s/.test(decoded) ? scrubUrl(decoded, depth + 1) : scrubText(decoded, depth + 1);
    return scrubbed === decoded ? value : scrubbed;
}

function removeUnsupportedBody(holder) {
    delete holder.text;
    delete holder.encoding;
}

function sanitizeText(holder, mime, depth) {
    if (/json|urlencoded/i.test(mime)) {
        const cleaned = sanitizeTextBody(holder.text, mime, holder.encoding === 'base64', depth);
        if (cleaned !== null) {
            holder.text = cleaned;
            return;
        }
    }
    removeUnsupportedBody(holder);
}

function sanitizeContent(content, context, depth) {
    if (!content || typeof content !== 'object') return content;
    if (depth >= MAX_DEPTH) return REDACTED;
    const mime = typeof content.mimeType === 'string' ? content.mimeType : '';
    if (Object.hasOwn(content, 'text')) {
        if (typeof content.text === 'string') sanitizeText(content, mime, depth + 1);
        else removeUnsupportedBody(content);
    }
    for (const key of Object.keys(content)) {
        if (!CONTENT_KEYS.has(key.toLowerCase())) cleanNode(content, key, depth + 1, context);
    }
    return content;
}

function sanitizePostData(postData, context, depth) {
    if (!postData || typeof postData !== 'object') return postData;
    if (depth >= MAX_DEPTH) return REDACTED;
    const mime = typeof postData.mimeType === 'string' ? postData.mimeType : '';
    if (Array.isArray(postData.params)) {
        postData.params = sanitizeNameValues(postData.params, context, depth + 1, true);
    } else if (Object.hasOwn(postData, 'params')) {
        cleanNode(postData, 'params', depth + 1, context);
    }
    if (Object.hasOwn(postData, 'text')) {
        if (typeof postData.text === 'string') sanitizeText(postData, mime, depth + 1);
        else removeUnsupportedBody(postData);
    }
    for (const key of Object.keys(postData)) {
        if (!POSTDATA_KEYS.has(key.toLowerCase())) cleanNode(postData, key, depth + 1, context);
    }
    return postData;
}

// Очищает одну запись HAR. МУТИРУЕТ entry и возвращает её же.
// request/response могут отсутствовать (обрыв) — тогда чистится только прочее.
function redactEntry(entry, context = createRedactionContext(), depth = 3) {
    if (!entry || typeof entry !== 'object') return typeof entry === 'string' ? cleanLooseText(entry, depth) : entry;
    if (depth >= MAX_DEPTH) return REDACTED;
    if (Array.isArray(entry)) {
        const root = { value: entry };
        cleanNode(root, 'value', depth, context);
        return root.value;
    }
    const request = entry.request;
    if (request && typeof request === 'object') {
        if (depth + 1 >= MAX_DEPTH) entry.request = REDACTED;
        else {
            if (typeof request.url === 'string') request.url = scrubUrl(request.url, depth + 2);
            cleanNode(request, 'headers', depth + 2, context);
            cleanNode(request, 'queryString', depth + 2, context);
            if (Object.hasOwn(request, 'cookies')) request.cookies = [];
            cleanNode(request, 'postData', depth + 2, context);
            for (const key of Object.keys(request)) {
                if (!REQUEST_KEYS.has(key.toLowerCase())) cleanNode(request, key, depth + 2, context);
            }
        }
    }
    const response = entry.response;
    if (response && typeof response === 'object') {
        if (depth + 1 >= MAX_DEPTH) entry.response = REDACTED;
        else {
            if (typeof response.redirectURL === 'string') response.redirectURL = scrubUrl(response.redirectURL, depth + 2);
            if (typeof response.url === 'string') response.url = scrubUrl(response.url, depth + 2);
            cleanNode(response, 'headers', depth + 2, context);
            if (Object.hasOwn(response, 'cookies')) response.cookies = [];
            cleanNode(response, 'content', depth + 2, context);
            for (const key of Object.keys(response)) {
                if (!RESPONSE_KEYS.has(key.toLowerCase())) cleanNode(response, key, depth + 2, context);
            }
        }
    }
    cleanNode(entry, 'pageref', depth + 1, context);
    cleanNode(entry, 'cache', depth + 1, context);
    cleanNode(entry, 'timings', depth + 1, context);
    for (const key of Object.keys(entry)) {
        const lower = key.toLowerCase();
        if (ENTRY_KEYS.has(lower)) continue;
        cleanNode(entry, key, depth + 1, context);
    }
    return entry;
}

// Очищает корневой HAR без entries ({log: {...}}); страницы, creator, browser
// и все нестандартные поля чистятся рекурсивно. Если entries присутствуют
// (полный HAR), каждая запись проходит через redactEntry. МУТИРУЕТ metadata.
function redactMetadata(metadata, context = createRedactionContext()) {
    if (!metadata || typeof metadata !== 'object') return metadata;
    for (const key of Object.keys(metadata)) cleanNode(metadata, key, 1, context);
    return metadata;
}

module.exports = { createRedactionContext, redactEntry, redactMetadata, REDACTED, isSensitiveName, scrubUrl, scrubText };
