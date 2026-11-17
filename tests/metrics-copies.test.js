const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {requiresOf} = require('../lib/hash');

const root = path.resolve(__dirname, '..');
const skills = ['ts', 'kt', 'java', 'php'];
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('four metrics kernels have identical SHA256 bytes', () => {
    const hashes = skills.map(skill => digest(path.join(root, 'skills', 'token-economy-' + skill, 'scripts', 'lib', 'metrics.js')));
    for (let i = 1; i < hashes.length; i++) assert.equal(hashes[i], hashes[0], skills[i] + ' metrics kernel drift');
});

test('Python has no unused JS kernel or Node runtime requirement', () => {
    const dir = path.join(root, 'skills', 'token-economy-py');
    assert.equal(fs.existsSync(path.join(dir, 'scripts', 'lib', 'metrics.js')), false);
    assert.deepEqual(requiresOf(dir), ['python>=3']);
});

test('four skills keep the same formula tests verbatim', () => {
    const sections = skills.map(skill => {
        const text = fs.readFileSync(path.join(root, 'tests', 'token-economy-' + skill, 'metrics.test.js'), 'utf8');
        const start = text.indexOf("test('chain: local dependents");
        const end = text.indexOf('\n});', text.indexOf("test('percentile uses midrank", start)) + 4;
        assert.ok(start >= 0 && end > start, skill + ' formula tests missing');
        return text.slice(start, end);
    });
    for (let i = 1; i < sections.length; i++) assert.equal(sections[i], sections[0], skills[i] + ' formula test drift');
});
