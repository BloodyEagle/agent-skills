'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const SKILL = path.join(ROOT, 'skills', 'token-economy-har', 'SKILL.md');

function read(relative) {
    return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

test('documentation routing keeps mandatory triggers and copied references', () => {
    const skill = read('skills/token-economy-har/SKILL.md');
    for (const [file, trigger] of [
        ['references/redact.md', /Перед `redact`, передачей HAR\/вывода либо оценкой анонимности обязательно прочитай `references\/redact\.md`/],
        ['references/testing.md', /Перед запуском или изменением тестов\/benchmark обязательно прочитай `references\/testing\.md` и получи разрешение пользователя/],
        ['references/compact-output.md', /Перед использованием или декодированием обязательно прочитай `references\/compact-output\.md`/]
    ]) {
        assert.match(skill, trigger);
        assert.ok(fs.statSync(path.join(path.dirname(SKILL), file)).isFile());
    }
});

test('moved rules remain reachable before their risky actions', () => {
    const skill = read('skills/token-economy-har/SKILL.md');
    const redact = read('skills/token-economy-har/references/redact.md');
    const testing = read('skills/token-economy-har/references/testing.md');
    const compact = read('skills/token-economy-har/references/compact-output.md');
    assert.match(skill, /--compact.*не очистка/);
    assert.match(redact, /не является гарантией анонимности/);
    assert.match(redact, /hard link/);
    assert.match(redact, /Файл назначения должен быть \*\*новым\*\*/);
    assert.match(testing, /получи разрешение пользователя/);
    assert.match(testing, /Не используй `--real` без отдельного разрешения/);
    assert.match(compact, /legacy JSON/);
    assert.match(compact, /каждый tagged-документ самодостаточен/);
    assert.match(compact, /truncated/);
});
