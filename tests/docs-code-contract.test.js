const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('docs: TypeScript routes selectors separately from pipe/style symbols', () => {
    const reference = read('skills/token-economy-ts/references/typescript.md');
    assert.match(reference, /селектор[^\n]*op: `selector`/i);
    assert.match(reference, /пайп[^\n]*op: `symbol`/i);
    const overview = read('README.md');
    assert.match(overview, /`graph symbol`[^\n]*пайп[^\n]*`graph selector`[^\n]*Angular-селектор/);
});

test('docs: generic TS rules precede info and framework rules are conditional', () => {
    const rules = read('rules/RULES.md');
    assert.match(rules, /TypeScript-reference[^\n]*до первой команды TS/);
    assert.match(rules, /Angular\/React-reference[^\n]*после определения[^\n]*до профильной операции/);
    const skill = read('skills/token-economy-ts/SKILL.md');
    assert.match(skill, /references\/typescript\.md/);
    assert.match(skill, /references\/react\.md/);
    assert.match(skill, /references\/angular\.md/);
});

test('docs: snippet limits count content separately from markers', () => {
    for (const skill of ['token-economy-php', 'token-economy-py']) {
        const text = read('skills/' + skill + '/SKILL.md');
        assert.match(text, /120 символов содержимого[^\n]*маркеры/);
        assert.match(text, /номера строки[^\n]*лимит не входит/);
    }
});

test('docs: automateskill requires main compatibility and an agreed one-shot date', () => {
    const skill = read('skills/automateskill/SKILL.md');
    assert.match(skill, /поддерживают только подтверждённую `main`/);
    assert.match(skill, /согласованную календарную дату/);
    assert.match(skill, /delayMinutes/);
    assert.match(skill, /intervalUnit/);
    assert.match(read('skills/automateskill/references/plan-template.md'), /остановка до создания\/публикации плана/);
    const prompt = read('skills/automateskill/references/automation-prompt.md');
    assert.match(prompt, /до его pull\/clone\/запуска исполнителя/);
    assert.match(prompt, /относительная задержка — только `delayMinutes`/);
});
