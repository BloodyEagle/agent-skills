'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SKILLS = path.join(ROOT, 'skills');
const skillNames = fs.readdirSync(SKILLS)
    .filter((n) => fs.statSync(path.join(SKILLS, n)).isDirectory())
    .sort();

// Триггеры, по которым модель выбирает скилл в индексе; таблица из плана T1.
const REQUIRED_DESCRIPTION = {
    'token-economy-ts': ['TypeScript', 'Angular', 'graph', 'search'],
    'token-economy-py': ['Python', 'te.py', 'graph'],
    'token-economy-java': ['Java', 'jv.js', 'Spring'],
    'token-economy-kt': ['Kotlin', 'kt.js', 'Android'],
    'token-economy-php': ['PHP', 'bx.js'],
    'token-economy-har': ['HAR', 'har.js'],
    automateskill: ['ZCode', 'CronCreate'],
};

// Файлы читаются как есть: .gitattributes держит LF, сравнение код-блоков — байтовое.
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

// Единственная кириллица, разрешённая в английских файлах, — строка-переключатель на русскую версию.
const SWITCHER_EN = '[Русская версия](README.ru.md)';

function fencedBlocks(text) {
    const blocks = [];
    let current = null;
    for (const line of text.split('\n')) {
        if (current === null) {
            if (line.startsWith('```')) current = [line];
        } else {
            current.push(line);
            if (line.startsWith('```')) {
                blocks.push(current.join('\n'));
                current = null;
            }
        }
    }
    assert.strictEqual(current, null, 'unclosed fenced code block');
    return blocks;
}

function stripCode(text) {
    return text
        .replace(/```[\s\S]*?```/g, '')
        .replace(/`[^`\n]*`/g, '');
}

test('bilingual: every skill has README.md and README.ru.md', () => {
    for (const name of skillNames) {
        assert.ok(fs.existsSync(path.join(SKILLS, name, 'README.md')), `${name}: README.md missing`);
        assert.ok(fs.existsSync(path.join(SKILLS, name, 'README.ru.md')), `${name}: README.ru.md missing`);
    }
});

test('bilingual: both skill READMEs start with the H1 of the directory name', () => {
    for (const name of skillNames) {
        for (const file of ['README.md', 'README.ru.md']) {
            const firstLine = read(path.join('skills', name, file)).split('\n')[0].trim();
            assert.strictEqual(firstLine, `# ${name}`, `${name}/${file}: H1 must be the directory name`);
        }
    }
});

test('bilingual: language switchers point at each other', () => {
    for (const name of skillNames) {
        const en = read(path.join('skills', name, 'README.md'));
        const ru = read(path.join('skills', name, 'README.ru.md'));
        assert.ok(en.includes('](README.ru.md)'), `${name}: README.md must link to README.ru.md`);
        assert.ok(ru.includes('](README.md)'), `${name}: README.ru.md must link to README.md`);
    }
    const rootEn = read('README.md');
    const rootRu = read('README.ru.md');
    assert.ok(rootEn.includes('](README.ru.md)'), 'root README.md must link to README.ru.md');
    assert.ok(rootRu.includes('](README.md)'), 'root README.ru.md must link to README.md');
});

test('bilingual: English files carry no Cyrillic outside code', () => {
    for (const name of skillNames) {
        const stripped = stripCode(read(path.join('skills', name, 'README.md'))).replace(SWITCHER_EN, '');
        assert.doesNotMatch(stripped, /[\u0400-\u04FF]/, `${name}: unexpected Cyrillic in the English README outside code`);
    }
    const stripped = stripCode(read('README.md')).replace(SWITCHER_EN, '');
    assert.doesNotMatch(stripped, /[\u0400-\u04FF]/, 'root README.md: unexpected Cyrillic outside code');
});

test('bilingual: fenced code blocks match byte for byte in every pair', () => {
    for (const name of skillNames) {
        const en = fencedBlocks(read(path.join('skills', name, 'README.md')));
        const ru = fencedBlocks(read(path.join('skills', name, 'README.ru.md')));
        assert.deepStrictEqual(ru, en, `${name}: fenced code blocks must match byte for byte`);
    }
    assert.deepStrictEqual(
        fencedBlocks(read('README.ru.md')),
        fencedBlocks(read('README.md')),
        'root: fenced code blocks must match byte for byte'
    );
});

test('bilingual: every skill description is a single-line human text with triggers', () => {
    assert.deepStrictEqual(
        skillNames,
        Object.keys(REQUIRED_DESCRIPTION).sort(),
        'the skills/ directory and the required-description table must list the same skills'
    );
    for (const name of skillNames) {
        const frontmatter = read(path.join('skills', name, 'SKILL.md')).match(/^---\n([\s\S]*?)\n---\n/);
        assert.ok(frontmatter, `${name}: SKILL.md must start with a frontmatter block`);
        const line = frontmatter[1].split('\n').find((l) => l.startsWith('description:'));
        assert.ok(line, `${name}: description: line missing`);
        const value = line.slice('description:'.length).trim();
        assert.ok(!/^[|>]/.test(value), `${name}: description must be a single line, not a block scalar`);
        let decoded = value;
        if (decoded.startsWith("'") && decoded.endsWith("'") && decoded.length >= 2) {
            decoded = decoded.slice(1, -1).replace(/''/g, "'");
        }
        assert.ok(decoded.length > 0, `${name}: description is empty`);
        assert.ok(!decoded.includes('\n'), `${name}: description must be a single line`);
        // Единица длины — Unicode code points, как в lib/metadata.js.
        const length = [...decoded].length;
        assert.ok(length <= 900, `${name}: description must be <= 900 code points, got ${length}`);
        for (const trigger of REQUIRED_DESCRIPTION[name]) {
            assert.ok(decoded.includes(trigger), `${name}: description must keep the trigger "${trigger}"`);
        }
    }
});
