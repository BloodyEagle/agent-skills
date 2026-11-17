// F3 плана git-hotspots: четыре JS-копии git-signals.js обязаны совпадать байт в байт —
// это проверяется sha256, а не договорённостью. Python-порт проверяется выводом
// (tests/token-economy-py/hotspots.test.js), не хешем.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SKILLS = ['token-economy-ts', 'token-economy-kt', 'token-economy-java', 'token-economy-php'];

test('hotspots: четыре JS-копии git-signals.js совпадают байт в байт (sha256)', () => {
    const digests = SKILLS.map((skill) => {
        const file = path.resolve(__dirname, '..', 'skills', skill, 'scripts', 'git-signals.js');
        const buf = fs.readFileSync(file);
        assert.ok(buf.length > 5000, 'модуль неожиданно мал: ' + skill);
        assert.ok(!buf.includes('\r\n'), 'переводы строк должны быть LF: ' + skill);
        return crypto.createHash('sha256').update(buf).digest('hex');
    });
    assert.equal(new Set(digests).size, 1, 'все копии одинаковы, получены: ' + digests.join(' '));
});
