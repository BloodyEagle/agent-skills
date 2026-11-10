'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHmac } = require('node:crypto');
const { redactEntry, redactMetadata, REDACTED, isSensitiveName, scrubUrl, scrubText } = require('../../skills/token-economy-har/lib/redact');

const REDACTION_MODULE = require.resolve('../../skills/token-economy-har/lib/redact');

function measureScrub(size, shape = 'blob') {
    const source = `
        const { scrubText } = require(process.argv[1]);
        const size = Number(process.argv[2]);
        const shape = process.argv[3];
        let input = 'x'.repeat(size);
        let expected = input;
        if (shape === 'userinfo-miss') {
            input = 'follow https://' + ':'.repeat(size) + 'host now';
            expected = input;
        } else if (shape === 'userinfo') {
            input = 'follow https://user:' + 's'.repeat(size) + '@example.test/path?token=fixture_secret now';
            expected = 'follow https://example.test/path?token=%5BREDACTED%5D now';
        } else if (shape === 'jose-miss') {
            input = 'eyJ' + 'AAAA-eyJ'.repeat(Math.ceil(size / 8));
            expected = input;
        } else if (shape === 'jose-long') {
            input = 'eyJhbGciOiJub25lIn0.' + 'A'.repeat(size) + '.';
            expected = '[REDACTED]';
        } else if (shape === 'jose-whitespace-miss') {
            input = 'C' + 'CCC-III-DDD'.repeat(Math.ceil(size / 11)) + '.invalid';
            expected = input;
        } else if (shape === 'jose-whitespace-long') {
            const header = Buffer.from(' '.repeat(size) + '{"alg":"none"}').toString('base64url');
            input = header + '.e30.';
            expected = '[REDACTED]';
        } else if (shape === 'url-path') {
            input = 'https://example.test/' + 'path//avatar@2x.png/'.repeat(Math.ceil(size / 19));
            expected = input;
        } else if (shape === 'pem-miss') {
            input = '-----BEGIN ' + 'A '.repeat(Math.ceil(size / 2)) + 'CERTIFICATE-----';
            expected = input;
        } else if (shape === 'pem-long') {
            input = '-----BEGIN RSA PRIVATE KEY-----' + 'A'.repeat(size) + '-----END RSA PRIVATE KEY-----';
            expected = '[REDACTED]';
        } else if (shape === 'query-long') {
            input = 'note access_token=' + 's'.repeat(size) + '&mode=kept after';
            expected = 'note access_token=[REDACTED]&mode=kept after';
        }
        scrubText('warmup');
        const started = performance.now();
        const result = scrubText(input);
        process.stdout.write(JSON.stringify({ durationMs: performance.now() - started, preserved: result === expected }));
    `;
    const child = spawnSync(process.execPath, ['-e', source, REDACTION_MODULE, String(size), shape], {
        encoding: 'utf8', timeout: 8000, maxBuffer: 4096, windowsHide: true
    });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout);
}

test('scrubText: scaling 16/32/64 KiB без секретов и без квадратичного перебора', t => {
    const measurements = [16, 32, 64].map(kib => ({ kib, ...measureScrub(kib * 1024) }));
    t.diagnostic(JSON.stringify(measurements));
    for (const result of measurements) {
        assert.equal(result.preserved, true, `blob ${result.kib} KiB не должен обрезаться`);
        assert.ok(result.durationMs < 1000, `scrubText ${result.kib} KiB: ${result.durationMs.toFixed(1)} мс, лимит 1000 мс`);
    }
});

test('scrubText: URL userinfo длиннее 4 KiB и неудачный поиск @ ограничены по времени', t => {
    for (const shape of ['userinfo-miss', 'userinfo']) {
        const measurement = measureScrub(32 * 1024, shape);
        t.diagnostic(JSON.stringify({ shape, ...measurement }));
        assert.equal(measurement.preserved, true, shape);
        assert.ok(measurement.durationMs < 1000, `${shape}: ${measurement.durationMs.toFixed(1)} мс`);
    }
});

function joseSegment(value) {
    return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

test('JWT alg=none и JWE маскируются целиком в тексте и JSON-строках', async t => {
    const unsigned = `${joseSegment({ alg: 'none' })}.${joseSegment({ sub: 'fixture-user' })}`;
    const encrypted = joseSegment({ alg: 'RSA-OAEP', enc: 'A256GCM' });
    const direct = joseSegment({ alg: 'dir', enc: 'A256GCM' });
    const cases = [
        ['JWT без подписи, два сегмента', unsigned],
        ['JWT без подписи, пустой третий сегмент', `${unsigned}.`],
        ['JWE с encrypted key', `${encrypted}.ZW5jcnlwdGVka2V5.aW5pdGlhbGl6YXRpb24.Y2lwaGVydGV4dA.YXV0aGVudGljYXRpb24`],
        ['JWE с пустым encrypted key', `${direct}..aW5pdGlhbGl6YXRpb24.Y2lwaGVydGV4dA.YXV0aGVudGljYXRpb24`],
        ['JWE с пустыми encrypted key и ciphertext', `${direct}..aW5pdGlhbGl6YXRpb24..YXV0aGVudGljYXRpb24`]
    ];
    for (const [label, token] of cases) {
        await t.test(label, () => {
            assert.ok(scrubText(`before ${token} after`) === `before ${REDACTED} after`, 'весь токен должен быть удалён');
            const entry = { response: { content: { mimeType: 'application/json', text: JSON.stringify({ label: token }) } } };
            redactEntry(entry);
            assert.ok(JSON.parse(entry.response.content.text).label === REDACTED, 'JSON-тело не должно сохранять сегменты токена');
        });
    }
});

test('JOSE header: допустимые JSON whitespace не скрывают JWT/JWE', async t => {
    const whitespace = [
        ['LF', '\n'], ['space', ' '], ['tab', '\t'], ['CRLF', '\r\n'],
        ['long', ' \t\r\n'.repeat(2048)]
    ];
    for (const [label, prefix] of whitespace) {
        await t.test(label, () => {
            const header = Buffer.from(prefix + '{"alg":"HS256"}' + prefix).toString('base64url');
            const signingInput = `${header}.${joseSegment({ sub: 'synthetic-user' })}`;
            const signature = createHmac('sha256', 'synthetic-only-key').update(signingInput).digest('base64url');
            const signed = `${signingInput}.${signature}`;
            const unsigned = `${Buffer.from(prefix + '{"alg":"none"}').toString('base64url')}.e30`;
            const encrypted = Buffer.from(prefix + '{"alg":"dir","enc":"A256GCM"}').toString('base64url');
            for (const token of [signed, unsigned, `${unsigned}.`, `${encrypted}..a.b.c`]) {
                assert.ok(scrubText(`before ${token} after`) === `before ${REDACTED} after`, 'JOSE должен маскироваться независимо от JSON whitespace');
                for (const encoding of ['', 'base64']) {
                    const text = JSON.stringify({ label: token });
                    const entry = { response: { content: { mimeType: 'application/json', text: encoding ? Buffer.from(text).toString('base64') : text, ...(encoding ? { encoding } : {}) } } };
                    redactEntry(entry);
                    const body = entry.response.content.text;
                    assert.ok(JSON.parse(encoding ? Buffer.from(body, 'base64').toString('utf8') : body).label === REDACTED, 'JSON/base64-тело не должно сохранять JOSE');
                }
            }
        });
    }
});

test('JWS: дополнительное поле enc не отменяет очистку трёх сегментов', () => {
    const header = joseSegment({ alg: 'HS256', enc: 'custom' });
    const signingInput = `${header}.e30`;
    const signature = createHmac('sha256', 'synthetic-only-key').update(signingInput).digest('base64url');
    const token = `${signingInput}.${signature}`;
    assert.ok(scrubText(`before ${token} after`) === `before ${REDACTED} after`, 'enc — допустимое дополнительное поле JWS');
    const entry = { response: { content: { mimeType: 'application/json', text: JSON.stringify({ label: token }) } } };
    redactEntry(entry);
    assert.ok(JSON.parse(entry.response.content.text).label === REDACTED);
});

test('query-подобные секреты в свободном тексте без ложных code/state/key', () => {
    const cases = [
        ['audit token=fixture_secret status=ok', `audit token=${REDACTED} status=ok`],
        ['title: access_token=fixture_secret&mode=read', `title: access_token=${REDACTED}&mode=read`],
        ['(client_secret="fixture secret with spaces")', `(client_secret="${REDACTED}")`],
        ["note password='fixture secret' done", `note password='${REDACTED}' done`],
        ['token=fixture_secret\r\nnext=kept', `token=${REDACTED}\r\nnext=kept`],
        ['note %74oken=fixture%20secret end', `note %74oken=${REDACTED} end`]
    ];
    for (const [input, expected] of cases) {
        assert.ok(scrubText(input) === expected, 'значение чувствительной пары должно маскироваться целиком');
        const metadata = { log: { pages: [{ id: 'p', title: input }], comment: input } };
        redactMetadata(metadata);
        assert.ok(metadata.log.pages[0].title === expected, 'page title');
        assert.ok(metadata.log.comment === expected, 'comment');
    }
    const ordinary = 'code=200 state=ready key=Enter monkey=banana author=writer size=42 tokenization is useful';
    assert.equal(scrubText(ordinary), ordinary);
});

test('длинные JOSE/PEM/query и malformed-кандидаты не обрезаются и не зависают', t => {
    for (const shape of ['jose-miss', 'jose-long', 'pem-miss', 'pem-long', 'query-long']) {
        const measurement = measureScrub(64 * 1024, shape);
        t.diagnostic(JSON.stringify({ shape, ...measurement }));
        assert.equal(measurement.preserved, true, shape);
        assert.ok(measurement.durationMs < 1000, `${shape}: ${measurement.durationMs.toFixed(1)} мс`);
    }
});

test('review scaling: whitespace JOSE и URL path 16/32/64 KiB', t => {
    for (const shape of ['jose-whitespace-miss', 'jose-whitespace-long', 'url-path']) {
        const measurements = [16, 32, 64].map(kib => ({ kib, ...measureScrub(kib * 1024, shape) }));
        t.diagnostic(JSON.stringify({ shape, measurements }));
        for (const result of measurements) {
            assert.equal(result.preserved, true, shape);
            assert.ok(result.durationMs < 1000, `${shape} ${result.kib} KiB: ${result.durationMs.toFixed(1)} мс`);
        }
    }
});

test('JWT/JWE: короткие сегменты, дефисы, переводы строк и malformed-формы', () => {
    const signed = `${joseSegment({ alg: 'HS256' })}.e30.ab-_`;
    const unsigned = `${joseSegment({ alg: 'none' })}.e30.`;
    const jwe = `${joseSegment({ alg: 'dir', enc: 'A256GCM' })}..a.b.c`;
    const input = `first ${signed}\r\n${unsigned}\n(${jwe}) last`;
    assert.ok(scrubText(input) === `first ${REDACTED}\r\n${REDACTED}\n(${REDACTED}) last`);
    for (const token of [signed, unsigned, jwe]) {
        const result = scrubText(`note ${token}. after`);
        assert.ok(result === `note ${REDACTED} after` || result === `note ${REDACTED}. after`, 'знак конца предложения не должен оставлять токен');
    }
    // Прежняя эвристика подписанных JWT сохраняется даже с битым JSON header.
    assert.equal(scrubText('eyJinvalidHeader.AAAAAAAA.signature_tail-'), REDACTED);
    assert.ok(!scrubText('eyJbad.prefix.eyJinvalidHeader.AAAAAAAA.signature_tail-').includes('signature_tail'), 'malformed-префикс не должен скрывать подписанный JWT');
    for (const value of [
        'eyJdocumentation.example', 'not-a-jwt.AAAAAAAA.BBBBBBBB',
        `${joseSegment({ alg: 'HS256' })}.e30`, `${joseSegment({ typ: 'JWT' })}.e30.`,
        `${joseSegment({ alg: 'dir', enc: 'A256GCM' })}..a.b`,
        'eyJ.aaaaa.bbbbb', 'plain.header.payload.signature.tail'
    ]) assert.equal(scrubText(value), value);
});

test('PEM: полный, незавершённый и осиротевший private key; public key сохраняется', () => {
    for (const label of ['PRIVATE KEY', 'RSA PRIVATE KEY', 'ENCRYPTED PRIVATE KEY', 'PGP PRIVATE KEY BLOCK']) {
        const block = `-----BEGIN ${label}-----\r\nfixture_material\r\n-----END ${label}-----`;
        assert.equal(scrubText(`before ${block} after`), `before ${REDACTED} after`);
        assert.equal(scrubText(`before -----BEGIN ${label}-----\nfixture_material`), `before ${REDACTED}`);
        assert.equal(scrubText(`fixture_material\n-----END ${label}-----`), REDACTED);
    }
    const publicKey = '-----BEGIN PUBLIC KEY-----\npublic_material\n-----END PUBLIC KEY-----';
    assert.equal(scrubText(publicKey), publicKey);
});

test('URL userinfo: protocol-relative, несколько @, длинная схема и границы строк', () => {
    const cases = [
        ['//user:pass@example.test/path', '//example.test/path'],
        ['custom+scheme://user:p@ss@example.test/path', 'custom+scheme://example.test/path'],
        ['go https://user:pass@example.test/x\nnext //other:pass@example.test/y done', 'go https://example.test/x\nnext //example.test/y done'],
        [`${'s'.repeat(8192)}://user:pass@example.test/x`, `${'s'.repeat(8192)}://example.test/x`],
        ['https://user:pa\r\nss@example.test/x', 'https://example.test/x']
    ];
    for (const [input, expected] of cases) assert.ok(scrubText(input) === expected, 'userinfo удалён целиком');
    for (const value of ['person@example.test', 'https://example.test/path@kept', 'https://example.test/path', '//////']) {
        assert.equal(scrubText(value), value);
    }
});

test('URL // внутри path/query не является authority и не теряет @-данные', () => {
    const urls = [
        'https://cdn.example.test/icons//avatar@2x.png',
        'https://example.test/?q=part//alice@example.test',
        '/icons//avatar@2x.png',
        'https://example.test/path//user:label@segment?q=keep',
        'https://example.test/icons/=//avatar@2x.png'
    ];
    for (const url of urls) {
        assert.equal(scrubUrl(url), url);
        assert.equal(scrubText(url), url);
        assert.equal(scrubText(`before ${url} after`), `before ${url} after`);
        const entry = { request: { url }, response: { content: { mimeType: 'application/json', text: JSON.stringify({ link: url }) } } };
        redactEntry(entry);
        assert.equal(entry.request.url, url);
        assert.equal(JSON.parse(entry.response.content.text).link, url);
    }
    assert.equal(scrubText('go //user:pass@example.test/icons//avatar@2x.png end'), 'go //example.test/icons//avatar@2x.png end');
});

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
