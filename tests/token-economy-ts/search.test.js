// search.test.js — приёмка задач 2/4/5/13/14 плана экономии: word-границы, grouped/runs,
// pathPrefix, context, batch search; декодеры восстанавливают legacy-ответ побайтно.
const test = require('node:test');
const assert = require('node:assert/strict');
const {project, json, cli} = require('./helpers');

const legacyMatches = (root, args) => json(root, 'code-searcher', args);

/** Декодер format=grouped: группы + pathPrefix → legacy matches. */
const decodeGrouped = (r) => (r.groups || []).flatMap(g => {
    const file = r.pathPrefix !== undefined ? r.pathPrefix + g.file : g.file;
    return g.hits.map(h => ({file, line: h.line, text: h.text}));
});

/** Декодер format=runs: {startLine, texts[]} → legacy matches. */
const decodeRuns = (r) => (r.groups || []).flatMap(g => {
    const file = r.pathPrefix !== undefined ? r.pathPrefix + g.file : g.file;
    return g.runs.flatMap(run => run.texts.map((text, i) => ({file, line: run.startLine + i, text})));
});

test('word=1 совпадает по границам идентификатора: saved/$save/combining исключены, my-save найден', () => project(root => {
    const r = json(root, 'code-searcher', {query: 'save', word: '1', ext: '.js'});
    const lines = r.matches.map(m => m.line).sort((a, b) => a - b);
    assert.deepEqual(lines, [3, 4, 6, 8, 9]);
}, {'s.js': 'const saved = 1;\nconst $save = 2;\nconst my_save = save + 3;\nconst cafe\u0301 = 4; // save\nconst mid = 5;\nconst a\u203Fb = save;\nconst zw\u200Csp = 6;\nconst x = my-save;\nconsole.log(save);\n'}, {empty: true}));

test('word=1 исключает save перед U+0301/ZWNJ/ZWJ/U+00B7/U+203F и не работает с regex', () => project(root => {
    assert.equal(json(root, 'code-searcher', {query: 'save', word: '1', ext: '.js'}).count, 0);
    const bad = cli(root, 'code-searcher', {query: 'save', word: '1', regex: '1'});
    assert.equal(bad.status, 1);
    assert.ok(JSON.parse(bad.stdout).error);
}, {'t.js': 'const save\u0301x = 1;\nconst save\u200Cx = 2;\nconst save\u00B7x = 3;\nconst save\u203Fx = 4;\nconst save\u200Dx = 5;\n'}, {empty: true}));

test('grouped восстанавливает legacy matches: разные сниппеты соседних строк, порядок и count', () => project(root => {
    const legacy = legacyMatches(root, {query: 'alpha', ext: '.ts'});
    const grouped = json(root, 'code-searcher', {query: 'alpha', ext: '.ts', format: 'grouped'});
    assert.equal(grouped.count, legacy.count);
    assert.equal(grouped.shownMatches, legacy.matches.length);
    assert.deepEqual(decodeGrouped(grouped), legacy.matches);
}, {'src/a1.ts': 'const alpha = 1;\nconst beta = alpha;\nconst gamma = alpha;\n', 'src/a2.ts': 'const alpha = 5;\n'}, {empty: true}));

test('runs кодирует подряд идущие строки и восстанавливает пропуски и пустые тексты', () => project(root => {
    const legacy = legacyMatches(root, {query: 'needle', ext: '.js', regex: '1'});
    const runs = json(root, 'code-searcher', {query: 'needle', ext: '.js', regex: '1', format: 'runs'});
    assert.deepEqual(decodeRuns(runs), legacy.matches);
}, {'r.js': 'const needleA = 1;\nconst needleB = 2;\nconst other = 3;\nconst needleC = 4;\nconst needleD = 5;\n'}, {empty: true}));

test('limit внутри run и в grouped отсекает хвост, shownMatches это отражает', () => project(root => {
    const legacy = legacyMatches(root, {query: 'n', ext: '.js', limit: '3'});
    const runs = json(root, 'code-searcher', {query: 'n', ext: '.js', format: 'runs', limit: '3'});
    assert.equal(runs.shownMatches, 3);
    assert.equal(runs.count, legacy.count);
    assert.deepEqual(decodeRuns(runs), legacy.matches);
}, {'r.js': 'const n1 = 1;\nconst n2 = 2;\nconst n3 = 3;\nconst n4 = 4;\n'}, {empty: true}));

test('pathPrefix: полный путь восстанавливается точной конкатенацией', () => project(root => {
    const grouped = json(root, 'code-searcher', {query: 'alpha', format: 'grouped'});
    assert.ok(grouped.pathPrefix);
    const legacy = legacyMatches(root, {query: 'alpha'});
    assert.deepEqual(decodeGrouped(grouped), legacy.matches);
}, {'deep/nested/comp/a1.ts': 'const alpha = 1;\n', 'deep/nested/comp/a2.ts': 'const alpha = 5;\n'}, {empty: true}));

test('один хит в grouped не обязан быть короче legacy, но остаётся обратимым', () => project(root => {
    const legacy = legacyMatches(root, {query: 'only'});
    const grouped = json(root, 'code-searcher', {query: 'only', format: 'grouped'});
    assert.deepEqual(decodeGrouped(grouped), legacy.matches);
}, {'single.ts': 'const only = 1;\n'}, {empty: true}));

test('context=1: окна объединяются, hits — точные номера, полная строка содержит сниппет', () => project(root => {
    const legacy = legacyMatches(root, {query: 'three', ext: '.ts'});
    const ctx = json(root, 'code-searcher', {query: 'three', ext: '.ts', context: '1'});
    assert.equal(ctx.count, legacy.count);
    assert.equal(ctx.shownMatches, 1);
    const file = ctx.files[0];
    assert.equal(file.file, 'ctx.ts');
    const block = file.blocks[0];
    assert.deepEqual(block.hits, [3]);
    assert.equal(block.startLine, 2);
    assert.equal(block.lines.length, 3);
    assert.equal(block.lines[1].trim(), legacy.matches[0].text);
    // два близких хита — одно окно
    const two = json(root, 'code-searcher', {query: 'three|five', ext: '.ts', regex: '1', context: '1'});
    assert.equal(two.files[0].blocks.length, 1);
    assert.deepEqual(two.files[0].blocks[0].hits, [3, 5]);
}, {'ctx.ts': 'const one = 1;\nconst two = 2;\nconst three = 3;\nconst four = 4;\nconst five = 5;\n'}, {empty: true}));

test('context: limit ограничивает хиты, а не блоки; CRLF нормализованы', () => project(root => {
    const ctx = json(root, 'code-searcher', {query: 'needle', ext: '.js', context: '1', limit: '1'});
    assert.equal(ctx.shownMatches, 1);
    assert.equal(ctx.files[0].blocks[0].hits.length, 1);
    assert.ok(ctx.files[0].blocks[0].lines.every(l => !l.includes('\r')));
}, {'c.js': 'const needle = 1;\r\nconst after = 2;\r\n'}, {empty: true}));

test('context+files и context+format — явные ошибки, files=1 не превращается в код', () => project(root => {
    for (const args of [{query: 'one', context: '1', files: '1'}, {query: 'one', context: '1', format: 'grouped'}]) {
        const r = cli(root, 'code-searcher', args);
        assert.equal(r.status, 1, JSON.stringify(args));
        assert.ok(JSON.parse(r.stdout).error);
    }
}, {'one.ts': 'const one = 1;\n'}, {empty: true}));

test('argv-JSON со знаком = в значении: один JSON-аргумент разбирается как параметры', () => project(root => {
    // cli() передаёт пары ключ=значение; JSON-аргумент передаём напрямую одним argv
    const {spawnSync} = require('child_process');
    const path = require('path');
    const {scripts} = require('./helpers');
    const result = spawnSync(process.execPath, [path.join(scripts, 'code-searcher.js'), JSON.stringify({query: 'a=b', ext: '.ts'})],
        {cwd: root, encoding: 'utf8', windowsHide: true, env: {...process.env, NODE_OPTIONS: ''}});
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.count, 1);
    assert.equal(parsed.matches[0].file, 'eq.ts');
}, {'eq.ts': 'const a=b = 1;\n'}, {empty: true}));

test('batch search: независимые query/format/context, no-match одного не влияет на другой', () => project(root => {
    const r = json(root, 'code-searcher', {requests: JSON.stringify([
        {query: 'alpha'},
        {query: 'alpha', format: 'grouped'},
        {query: 'three', context: 1},
        {query: 'absent-everywhere'}
    ])});
    assert.equal(r.batch, true);
    assert.equal(r.total, 4);
    assert.equal(r.failed, 0);
    const norm = (m) => ({file: m.file.replace(/\\/g, '/'), line: m.line, text: m.text});
    assert.deepEqual(decodeGrouped(r.results[1]).map(norm), r.results[0].matches.filter(m => m.file.replace(/\\/g, '/') === 'src/a1.ts').map(norm));
    assert.equal(r.results[3].count, 0);
}, {'src/a1.ts': 'const alpha = 1;\nconst beta = alpha;\n', 'src/ctx.ts': 'const three = 3;\nconst near = 4;\n'}, {empty: true}));

test('batch search: ошибка одного запроса — элемент с error, остальные выполнены', () => project(root => {
    const r = json(root, 'code-searcher', {requests: JSON.stringify([
        {query: 'alpha'},
        {query: 'x', regex: '1', word: '1'}
    ])});
    assert.equal(r.failed, 1);
    assert.equal(r.results[0].count, 1);
    assert.ok(r.results[1].error);
}, {'src/a1.ts': 'const alpha = 1;\n'}, {empty: true}));

test('batch search: requests_file читается из проекта', () => project(root => {
    const fs = require('fs');
    fs.writeFileSync(require('path').join(root, 'reqs.json'), JSON.stringify([{query: 'alpha'}, {query: 'alpha', format: 'runs'}]));
    const r = json(root, 'code-searcher', {requests_file: 'reqs.json'});
    assert.equal(r.total, 2);
    assert.deepEqual(decodeRuns(r.results[1]), r.results[0].matches);
}, {'src/a1.ts': 'const alpha = 1;\n'}, {empty: true}));
