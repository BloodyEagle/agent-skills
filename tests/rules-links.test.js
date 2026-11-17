const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Строки таблицы «Стек | Скилл | Правила стека» из rules/RULES.md:
// три колонки, в третьей перечислены .md-файлы правил (через «+»).
function stackRows() {
    const text = fs.readFileSync(path.join(ROOT, 'rules', 'RULES.md'), 'utf8');
    assert.match(text, /^\|\s*Стек\s*\|\s*Скилл\s*\|\s*Правила стека[^\n]*\|$/m, 'нет заголовка таблицы стека в RULES.md');
    const rows = [];
    for (const line of text.split('\n')) {
        if (!line.startsWith('|')) continue;
        const cells = line.split('|').slice(1, -1).map(cell => cell.trim());
        if (cells.length !== 3) continue;
        if (cells[0] === 'Стек' || /^:?-{2,}:?$/.test(cells[0])) continue;
        if (!cells[2].includes('.md')) continue;
        rows.push(cells);
    }
    return rows;
}

function ruleFiles(cells) {
    return cells[2].split('+').map(file => file.trim()).filter(Boolean);
}

test('RULES.md: файлы правил стека существуют в каталогах скиллов', () => {
    const rows = stackRows();
    assert.ok(rows.length >= 5, 'в таблице ожидалось не меньше пяти строк стека, найдено ' + rows.length);
    for (const [stack, skill, files] of rows) {
        assert.match(skill, /^[a-z0-9._-]+$/, 'имя скилла во второй колонке: ' + skill);
        for (const file of ruleFiles([stack, skill, files])) {
            const target = path.join(ROOT, 'skills', skill, ...file.split('/'));
            assert.ok(fs.existsSync(target), 'нет файла правил для стека «' + stack + '»: ' + path.join('skills', skill, file));
        }
    }
});

test('RULES.md: правила стека в таблице указаны путями references/, без голых имён', () => {
    for (const [stack, , files] of stackRows()) {
        for (const file of ruleFiles([stack, '', files])) {
            assert.ok(file.startsWith('references/'), 'голое имя ' + file + ' (стек «' + stack + '»): путь обязан начинаться с references/');
        }
    }
});

test('rules/ содержит только бутстрап, без правил стеков', () => {
    const actual = fs.readdirSync(path.join(ROOT, 'rules')).sort();
    assert.deepEqual(actual, ['RULES.md', 'hindsight.md', 'project-passport.md']);
});

test('SKILL.md каждого скилла указывает свой файл правил стека', () => {
    const expected = {
        'token-economy-ts': 'references/typescript.md',
        'token-economy-php': 'references/php.md',
        'token-economy-java': 'references/java.md',
        'token-economy-py': 'references/python.md',
        'token-economy-kt': 'references/kotlin.md'
    };
    for (const [skill, file] of Object.entries(expected)) {
        const doc = fs.readFileSync(path.join(ROOT, 'skills', skill, 'SKILL.md'), 'utf8');
        assert.ok(doc.includes(file), skill + ': SKILL.md не упоминает ' + file);
    }
});
