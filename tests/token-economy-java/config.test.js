'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { project } = require('./helpers');

function output(r) {
  assert.equal(r.error, undefined);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return r.stdout;
}

const secret = 'FIXTURE_PRIVATE_VALUE';

test('search: application YAML masks sensitive values but preserves keys, line numbers and matches', (t) => {
  const p = project(t);
  p.write('src/main/resources/application-dev.yml', [
    'spring:', '  datasource:', '    password: ' + secret,
    '    username: public-user', 'app:', '  credentials:', '    nested:', '      value: ' + secret,
    '  private-key: |-', '    ' + secret, '    second-private-line',
    '  api-token: "first-' + secret, '    second-private-line"',
    '  tokens:', '    - ' + secret, '  env-password: ${DB_PASSWORD}', '  message: Привет', ''
  ].join('\n'));
  const all = output(p.run('op=search', 'query=.', 'regex=true', 'ext=.yml'));
  assert.ok(!all.includes(secret), 'secret values must be redacted');
  assert.ok(!all.includes('second-private-line'), 'multiline secrets must be redacted');
  assert.match(all, /3: password: \*\*\*/);
  assert.match(all, /4: username: public-user/);
  assert.match(all, /8: value: \*\*\*/);
  assert.match(all, /env-password: \$\{DB_PASSWORD\}/);
  assert.match(all, /message: Привет/);
  const byValue = output(p.run('op=search', 'query=' + secret, 'ext=.yml'));
  assert.ok(!byValue.includes(secret), 'matching by raw value must still redact its output');
  assert.match(byValue, /совпадений: 5, файлов: 1/);
  const config = output(p.run('op=config', 'query=app'));
  assert.ok(!config.includes(secret) && !config.includes('second-private-line'));
});

test('search: application properties continuations and escaped sensitive keys are masked', (t) => {
  const p = project(t);
  p.write('application.properties', [
    'db.password=' + secret + '\\', '  continued-private-value',
    'db.user=public-user', 'api\\u002etoken=' + secret,
    'password\\ key=' + secret, 'db.env-password=${DB_PASSWORD}', ''
  ].join('\r\n'));
  const all = output(p.run('op=search', 'query=.', 'regex=true', 'ext=.properties'));
  assert.ok(!all.includes(secret), 'properties values must be redacted');
  assert.ok(!all.includes('continued-private-value'), 'continuation must be redacted');
  assert.match(all, /db\.user=public-user/);
  assert.match(all, /db\.env-password=\$\{DB_PASSWORD\}/);
  const byValue = output(p.run('op=search', 'query=continued-private-value', 'ext=.properties'));
  assert.ok(!byValue.includes('continued-private-value'));
  assert.match(byValue, /2: \*\*\*/);
  assert.match(byValue, /совпадений: 1, файлов: 1/);
});

test('config/search: environment placeholders with secret defaults must not leak defaults', (t) => {
  const p = project(t);
  p.write('bootstrap.yml', 'app:\n  password: ${PASSWORD:' + secret + '}\n  token: ${TOKEN}\n');
  const config = output(p.run('op=config', 'query=app'));
  const search = output(p.run('op=search', 'query=.', 'regex=true', 'ext=.yml'));
  for (const text of [config, search]) {
    assert.ok(!text.includes(secret), 'fallback secret in placeholder must be redacted');
    assert.match(text, /\$\{TOKEN\}/);
    assert.match(text, /\*\*\*/);
  }
});

test('config/search: sensitive YAML keys, inline collections and escaped keys are masked', (t) => {
  const p = project(t);
  p.write('application-prod.yaml', [
    'app:', '  clients:', '    - name: public-client', '      credentials:', '        password: ' + secret,
    '        tokens:', '          - ' + secret,
    '  options: {password: ' + secret + ', label: visible}',
    '  "pass\\u0077ord": ' + secret,
    '  private-key: >2-', '    ' + secret,
    '  message: visible', ''
  ].join('\n'));
  const config = output(p.run('op=config', 'query=app'));
  const search = output(p.run('op=search', 'query=.', 'regex=true', 'ext=.yaml'));
  for (const text of [config, search]) assert.ok(!text.includes(secret), 'all sensitive YAML forms must be redacted');
  assert.match(search, /name: public-client/);
  assert.match(search, /message: visible/);
});

test('search/config: secret plain scalars below an empty YAML value are not exposed', (t) => {
  const p = project(t);
  p.write('application.yml', 'app:\n  password:\n    ' + secret + '\n    private-continuation\n  message: visible\n');
  const search = output(p.run('op=search', 'query=.', 'regex=true', 'ext=.yml'));
  assert.ok(!search.includes(secret) && !search.includes('private-continuation'), 'nested plain scalar must be redacted');
  assert.match(search, /message: visible/);
  const config = output(p.run('op=config', 'query=app.password'));
  assert.match(config, /app\.password = \*\*\*/);
});

test('search/config: quoted scalars containing a colon after an empty key keep the owner and full range', (t) => {
  const p = project(t);
  for (const value of ['"' + secret + ': suffix"', "'" + secret + ": suffix'", '"' + secret + ': suffix\n    private-quoted-continuation"']) {
    p.write('application.yml', 'app:\n  password:\n    ' + value + '\n  message: visible\n');
    const search = output(p.run('op=search', 'query=.', 'regex=true', 'ext=.yml'));
    const config = output(p.run('op=config', 'query=app.password'));
    for (const text of [search, config]) {
      assert.ok(!text.includes(secret), 'quoted scalar secret must not become part of a key');
      assert.ok(!text.includes('private-quoted-continuation'), 'entire quoted scalar range must be redacted');
    }
    assert.match(search, /2: password:\s*\*\*\*/);
    assert.match(search, /3: \*\*\*/);
    assert.match(search, /message: visible/);
    assert.match(config, /^app\.password = \*\*\*\s+\[default\]\s+application\.yml:2/m);
    assert.doesNotMatch(config, /app\.password\./);
  }
});

test('search/config: flow collections below an empty key mask sensitive fields under the owner', (t) => {
  const p = project(t);
  for (const value of ['{user: public, password: ' + secret + '}', '{user: public,\n     password: ' + secret + '\n    }', '[{user: public, token: ' + secret + '}]']) {
    p.write('application.yml', 'app:\n  options:\n    ' + value + '\n  message: visible\n');
    const search = output(p.run('op=search', 'query=.', 'regex=true', 'ext=.yml'));
    const config = output(p.run('op=config', 'query=app.options'));
    for (const text of [search, config]) assert.ok(!text.includes(secret), 'sensitive flow values must be redacted');
    assert.match(search, /2: options:\s*\*\*\*/);
    assert.match(search, /3: \*\*\*/);
    assert.match(search, /message: visible/);
    assert.match(config, /^app\.options = \*\*\*\s+\[default\]\s+application\.yml:2/m);
    assert.doesNotMatch(config, /app\.options\./);
  }
});

test('search/config: escaped sensitive keys inside flow mappings are masked', (t) => {
  const p = project(t);
  for (const value of ['{"pass\\u0077ord": ' + secret + '}', '{"tok\\x65n": ' + secret + '}', '[{"pass\\U00000077ord": ' + secret + '}]']) {
    for (const separator of [' ', '\n    ']) {
      p.write('application.yml', 'app:\n  options:' + separator + value + '\n  message: visible\n');
      const search = output(p.run('op=search', 'query=.', 'regex=true', 'ext=.yml'));
      const config = output(p.run('op=config', 'query=app.options'));
      for (const text of [search, config]) assert.ok(!text.includes(secret), 'escaped flow key must trigger redaction');
      assert.match(config, /^app\.options = \*\*\*\s+\[default\]\s+application\.yml:2/m);
      assert.match(search, /message: visible/);
    }
  }
});

test('search/config: quoted block keys and non-sensitive nested values still keep their structure', (t) => {
  const p = project(t);
  p.write('application.yml', 'app:\n  settings:\n    "label: text": visible\n    "password": ' + secret + '\n  note:\n    "public: suffix"\n  options:\n    {user: public}\n');
  const search = output(p.run('op=search', 'query=.', 'regex=true', 'ext=.yml'));
  const config = output(p.run('op=config', 'query=app'));
  for (const text of [search, config]) assert.ok(!text.includes(secret), 'quoted block mapping must still redact its value');
  assert.match(config, /app\.settings\.label: text = visible/);
  assert.match(config, /app\.settings\.password = \*\*\*/);
  assert.match(config, /app\.note = public: suffix/);
  assert.match(config, /app\.options = \{user: public\}/);
});

test('search: plain source files, no-match and limits keep their original contract', (t) => {
  const p = project(t);
  p.write('Foo.java', 'class Foo {\n  String password = "public-fixture";\n}\n');
  p.write('application.properties', 'password=private-one\npassword=private-two\n');
  assert.match(output(p.run('op=search', 'query=password')), /password = "public-fixture"/);
  assert.match(output(p.run('op=search', 'query=missing-fixture')), /совпадений нет/);
  const limited = output(p.run('op=search', 'query=password', 'ext=.properties', 'limit=1'));
  assert.ok(!limited.includes('private-one') && !limited.includes('private-two'));
  assert.match(limited, /совпадений: 2, файлов: 1, показано 1/);
});
