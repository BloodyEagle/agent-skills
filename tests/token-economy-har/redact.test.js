'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { redactEntry, redactMetadata, REDACTED, isSensitiveName, scrubUrl } = require('../../skills/token-economy-har/lib/redact');

test('секреты в расширениях, OAuth query/fragment и URL внутри строк', () => {
    const metadata = {
        log: { version: '1.2', creator: { name: 'fixture', version: '1' }, pages: [], _token: 'extension_secret' },
        _clientSecret: 123456,
        _queryString: [{ name: 'token', value: 'extension_query_secret' }],
        _requestBody: 'opaque_extension_secret',
        description: 'follow https://user:pass@example.test/path?key=query_secret now'
    };
    assert.equal(redactMetadata(metadata), metadata);
    const raw = JSON.stringify(metadata);
    assert.doesNotMatch(raw, /extension_secret|123456|query_secret|user:pass/);
    assert.equal(metadata._queryString[0].value, REDACTED);
    assert.equal(metadata._requestBody, REDACTED);
    assert.equal(metadata.log.version, '1.2');
    assert.equal(metadata._clientSecret, REDACTED);
    const url = scrubUrl('https://user:pass@example.test/path?code=oauth_secret&state=state_secret&q=keep#access_token=fragment_secret');
    assert.doesNotMatch(url, /user:pass|oauth_secret|state_secret|fragment_secret/);
    assert.match(url, /q=keep/);
    assert.equal(new URL(url).username, '');
    assert.equal(isSensitiveName('monkey'), false);
    assert.equal(isSensitiveName('apiKey'), true);
});

test('JSON/base64/urlencoded тела очищаются, показатели HAR неизменны', () => {
    const entry = {
        time: 50, timings: { connect: 20, ssl: 10, wait: 30 },
        request: {
            url: 'https://example.test/?token=query_secret', bodySize: 999, headersSize: 100,
            headers: [{ name: 'authorization', value: 'auth_secret' }, { name: 'Accept', value: 'application/json' }],
            cookies: [{ value: 'cookie_secret' }], queryString: [{ name: 'token', value: 'query_secret' }],
            postData: {
                mimeType: 'application/x-www-form-urlencoded', text: 'password=form_secret&code=oauth_secret&monkey=keep',
                params: [{ name: 'client_secret', value: 'param_secret' }, { name: 'payload', value: '{"token":"nested_secret","ok":true}' }]
            }
        },
        response: {
            status: 200, bodySize: 50, headersSize: 80,
            headers: [{ name: 'Set-Cookie', value: 'set_cookie_secret' }, { name: 'Location', value: '/next?token=redirect_secret' }, { name: 'Refresh', value: '0;url=https://user:refresh_pass@example.test/?token=refresh_secret' }],
            cookies: [{ value: 'cookie_secret' }], redirectURL: '/next?token=redirect_secret',
            content: { size: 100, compression: 50, mimeType: 'application/json', encoding: 'base64', text: Buffer.from('{"token":"json_secret","monkey":"keep","url":"/next?token=url_secret"}').toString('base64') }
        }
    };
    assert.equal(redactEntry(entry), entry);
    assert.equal(entry.time, 50);
    assert.deepEqual(entry.timings, { connect: 20, ssl: 10, wait: 30 });
    assert.equal(entry.request.bodySize, 999);
    assert.equal(entry.request.headersSize, 100);
    assert.equal(entry.response.bodySize, 50);
    assert.equal(entry.response.headersSize, 80);
    assert.equal(entry.response.content.size, 100);
    assert.equal(entry.response.content.compression, 50);
    assert.equal(entry.request.headers.length, 1);
    assert.equal(entry.request.headers[0].name, 'Accept');
    assert.deepEqual(entry.request.cookies, []);
    assert.deepEqual(entry.response.cookies, []);
    const body = JSON.parse(Buffer.from(entry.response.content.text, 'base64').toString('utf8'));
    assert.equal(body.token, REDACTED);
    assert.equal(body.monkey, 'keep');
    assert.doesNotMatch(JSON.stringify(body), /json_secret|url_secret/);
    assert.doesNotMatch(JSON.stringify(entry), /query_secret|auth_secret|cookie_secret|form_secret|oauth_secret|param_secret|nested_secret|redirect_secret|refresh_secret|refresh_pass/);
    assert.match(entry.request.postData.text, /monkey=keep/);
});

test('JSON-примитивные строки тоже очищаются', () => {
    const entry = { response: { content: { size: 100, mimeType: 'application/json', text: '"https://example.test/?token=primitive_secret"' } } };
    redactEntry(entry);
    assert.doesNotMatch(entry.response.content.text, /primitive_secret/);
    assert.equal(entry.response.content.size, 100);
});

test('бинарные/HTML/битые тела удаляются вместе с encoding', () => {
    for (const mimeType of ['application/octet-stream', 'text/html', 'application/json']) {
        const entry = { response: { bodySize: 10, content: { size: 20, compression: 10, mimeType, encoding: 'base64', text: Buffer.from('<secret>opaque_secret</secret>').toString('base64') } } };
        redactEntry(entry);
        assert.equal(Object.hasOwn(entry.response.content, 'text'), false);
        assert.equal(Object.hasOwn(entry.response.content, 'encoding'), false);
        assert.equal(entry.response.bodySize, 10);
        assert.equal(entry.response.content.size, 20);
    }
});

test('слишком глубокие данные не сохраняются неочищенными', () => {
    const root = {};
    let node = root;
    for (let i = 0; i < 40; i++) node = node.next = {};
    node.token = 'deep_secret';
    const entry = { response: { content: { size: 999, mimeType: 'application/json', text: JSON.stringify(root) } }, _extra: structuredClone(root) };
    redactEntry(entry);
    assert.doesNotMatch(JSON.stringify(entry), /deep_secret/);
    assert.equal(entry.response.content.size, 999);
});
