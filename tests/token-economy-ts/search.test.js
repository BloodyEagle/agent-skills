// search.test.js — приёмка задач 2/4/5/13/14 плана экономии: word-границы, grouped/runs,
// pathPrefix, context, batch search; декодеры восстанавливают legacy-ответ побайтно.
const test = require('node:test');
const assert = require('node:assert/strict');
const {project, json, cli, scripts} = require('./helpers');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');

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

const requestClis = [
    {script: 'code-searcher', good: {query: 'alpha'}, bad: {}},
    {script: 'symbol-index', good: {file: 'src/a.ts'}, bad: {file: 'src/missing.ts'}},
    {script: 'sig-reader', good: {name: './types.d.ts#Alpha'}, bad: {name: 'missing-pkg#X'}},
    {script: 'graph-tool', good: {op: 'symbol', name: 'alpha'}, bad: {op: 'deps', file: 'src/missing.ts'}}
];
const requestFiles = {
    'src/a.ts': 'export const alpha = 1;\n',
    'types.d.ts': 'export declare class Alpha {}\n'
};

// helpers.cli намеренно отвергает fixture-ссылки; для confinement-кейсов нужен сырой
// subprocess, а неизменность JSON/source проверяется отдельно, без обхода ссылок.
function requestCli(root, script, file) {
    const result = spawnSync(process.execPath, [path.join(scripts, script + '.js'), 'requests_file=' + file], {
        cwd: root, encoding: 'utf8', timeout: 8000, windowsHide: true,
        env: {...process.env, NODE_OPTIONS: '', HOME: root, USERPROFILE: root}
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    return {...result, payload: JSON.parse(result.stdout)};
}

function requestLink(t, target, link, directory = false) {
    try {
        fs.symlinkSync(target, link, directory && process.platform === 'win32' ? 'junction' : directory ? 'dir' : 'file');
        return true;
    } catch (e) {
        if (!['EPERM', 'EACCES', 'ENOSYS'].includes(e.code)) throw e;
        t.skip('Создание ссылки недоступно: ' + e.code);
        return false;
    }
}

test('requests_file reader: ошибка доступа сохраняется и JSON не читается', t => project(root => {
    const {readRequestsFile} = require('../../skills/token-economy-ts/scripts/lib/requests-file');
    const denied = Object.assign(new Error('Access denied'), {code: 'EACCES'});
    fs.writeFileSync(path.join(root, 'reqs.json'), JSON.stringify([{query: 'alpha'}]));
    const open = t.mock.method(fs, 'openSync', () => { throw denied; });
    try {
        assert.throws(() => readRequestsFile('reqs.json', root), error => error === denied);
        assert.equal(open.mock.callCount(), 1);
    } finally {
        open.mock.restore();
    }
}, requestFiles, {empty: true}));

for (const {script, good, bad} of requestClis) {
    test(script + ': requests_file regular JSON сохраняет partial/all-failed exit и index', () => project(root => {
        fs.writeFileSync(path.join(root, 'reqs.json'), JSON.stringify([good, bad]));
        for (const file of ['reqs.json', path.join(root, 'reqs.json')]) {
            const result = requestCli(root, script, file);
            assert.equal(result.status, 0);
            assert.equal(result.payload.failed, 1);
            assert.deepEqual(result.payload.results.map(r => r.index), [0, 1]);
            assert.ok(result.payload.results[1].error);
        }
        fs.writeFileSync(path.join(root, 'reqs.json'), JSON.stringify([bad]));
        const all = requestCli(root, script, 'reqs.json');
        assert.equal(all.status, 1);
        assert.equal(all.payload.failed, 1);
    }, requestFiles, {empty: true}));

    test(script + ': requests_file directory/missing/traversal отклоняются до batch', () => project(root => {
        fs.mkdirSync(path.join(root, 'reqdir'));
        for (const file of ['reqdir', 'missing.json', '../outside.json', root + '-outside/reqs.json']) {
            const result = requestCli(root, script, file);
            assert.equal(result.status, 1, file);
            assert.ok(result.payload.error, file);
            assert.equal(result.payload.batch, undefined);
        }
        assert.match(requestCli(root, script, 'reqdir').payload.error, /обычным файлом/);
        fs.writeFileSync(path.join(root, 'invalid.json'), '{invalid');
        assert.match(requestCli(root, script, 'invalid.json').payload.error, /requests_file/);
    }, requestFiles, {empty: true}));

    test(script + ': requests_file internal directory alias допустим', t => project(root => {
        fs.mkdirSync(path.join(root, 'data'));
        const bytes = JSON.stringify([good]);
        fs.writeFileSync(path.join(root, 'data/reqs.json'), bytes);
        if (!requestLink(t, path.join(root, 'data'), path.join(root, 'alias'), true)) return;
        const result = requestCli(root, script, 'alias/reqs.json');
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.equal(result.payload.failed, 0);
        assert.equal(fs.readFileSync(path.join(root, 'data/reqs.json'), 'utf8'), bytes);
    }, requestFiles, {empty: true}));

    test(script + ': requests_file internal file alias допустим', t => project(root => {
        fs.writeFileSync(path.join(root, 'reqs.json'), JSON.stringify([good]));
        if (!requestLink(t, path.join(root, 'reqs.json'), path.join(root, 'alias.json'))) return;
        const result = requestCli(root, script, 'alias.json');
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.equal(result.payload.failed, 0);
    }, requestFiles, {empty: true}));

    test(script + ': requests_file root-junction сохраняет реальную cwd границу', t => project(root => {
        const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'te-request-root-'));
        try {
            fs.writeFileSync(path.join(root, 'reqs.json'), JSON.stringify([good]));
            fs.mkdirSync(path.join(root, 'data'));
            fs.writeFileSync(path.join(root, 'data/reqs.json'), JSON.stringify([good]));
            const alias = path.join(sandbox, 'root-alias');
            if (!requestLink(t, root, alias, true)) return;
            if (!requestLink(t, path.join(root, 'data'), path.join(root, 'internal-alias'), true)) return;
            for (const file of ['reqs.json', 'internal-alias/reqs.json']) {
                const result = requestCli(alias, script, file);
                assert.equal(result.status, 0, result.stdout + result.stderr);
                assert.equal(result.payload.failed, 0);
            }
        } finally {
            fs.rmSync(sandbox, {recursive: true, force: true});
        }
    }, requestFiles, {empty: true}));

    for (const directory of [true, false]) {
        test(script + ': requests_file external ' + (directory ? 'junction' : 'file-symlink') + ' не читается', t => project(root => {
            const outside = fs.mkdtempSync(root + '-outside-');
            const bytes = JSON.stringify([good]);
            try {
                fs.writeFileSync(path.join(outside, 'reqs.json'), bytes);
                for (const file of [path.join(outside, 'reqs.json'), path.relative(root, path.join(outside, 'reqs.json'))]) {
                    const direct = requestCli(root, script, file);
                    assert.equal(direct.status, 1);
                    assert.match(direct.payload.error, /requests_file вне рабочей директории/);
                    assert.equal(direct.payload.batch, undefined);
                }
                const link = path.join(root, directory ? 'external' : 'external.json');
                if (!requestLink(t, directory ? outside : path.join(outside, 'reqs.json'), link, directory)) return;
                const result = requestCli(root, script, directory ? 'external/reqs.json' : 'external.json');
                assert.equal(result.status, 1);
                assert.match(result.payload.error, /realpath вне рабочей директории/);
                assert.equal(result.payload.batch, undefined);
                assert.equal(fs.readFileSync(path.join(outside, 'reqs.json'), 'utf8'), bytes);
                assert.equal(fs.readFileSync(path.join(root, 'src/a.ts'), 'utf8'), requestFiles['src/a.ts']);
            } finally {
                fs.rmSync(outside, {recursive: true, force: true});
            }
        }, requestFiles, {empty: true}));
    }

    test(script + ': requests_file dangling link даёт явную ошибку', t => project(root => {
        if (!requestLink(t, path.join(root, 'missing.json'), path.join(root, 'dangling.json'))) return;
        const result = requestCli(root, script, 'dangling.json');
        assert.equal(result.status, 1);
        assert.match(result.payload.error, /Не удалось прочитать requests_file/);
        assert.equal(result.payload.batch, undefined);
    }, requestFiles, {empty: true}));
}
