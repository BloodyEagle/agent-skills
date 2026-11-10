const test = require('node:test');
const assert = require('node:assert/strict');
const {project, cli, json} = require('./helpers');
const fs = require('fs');
const path = require('path');

const paths = list => list.map(item => item.file.replace(/\\/g, '/'));
const deps = (root, file) => json(root, 'graph-tool', {op: 'deps', file, root: '.', why: true});

test('require связывает JS-файлы и показывает строку связи', () => project(root => {
    const result = deps(root, 'app.js');
    assert.ok(paths(result.imports).includes('lib/util.js'));
    assert.match(result.imports.find(item => item.file.replace(/\\/g, '/') === 'lib/util.js').via, /^L[1-9]\d*$/);
}));

test('динамический import резолвится к mjs', () => project(root => {
    assert.ok(paths(deps(root, 'app.js').imports).includes('lazy.mjs'));
}));

test('папка резолвится в index.js', () => project(root => {
    assert.ok(paths(deps(root, 'app.js').imports).includes('lib/index.js'));
}));

test('смешанный TS/JS-проект даёт единый граф', () => project(root => {
    assert.ok(paths(deps(root, 'app.js').imports).includes('typed.ts'));
    const result = json(root, 'graph-tool', {op: 'stats', root: '.'});
    assert.ok(result.files >= 8);
}));

test('локальный неразрешённый путь считается отдельно от external', () => project(root => {
    const result = deps(root, 'app.js');
    assert.equal(result.unresolved, 1);
    assert.ok(result.external.includes('express'));
    assert.equal(json(root, 'graph-tool', {op: 'stats', root: '.'}).unresolved, 1);
}));

test('CommonJS реэкспорт и rdeps видят legacy.cjs', () => project(root => {
    assert.ok(paths(deps(root, 'legacy.cjs').imports).includes('lib/util.js'));
    const result = json(root, 'graph-tool', {op: 'rdeps', file: 'lib/util.js', root: '.'});
    assert.ok(paths(result.importedBy).includes('legacy.cjs'));
}));

test('side-effect import и export from учитываются', () => project(root => {
    assert.ok(paths(deps(root, 'app.js').imports).includes('setup.js'));
    assert.ok(paths(deps(root, 'lib/index.js').imports).includes('lib/util.js'));
}));

test('symbol в JS находит стрелку и класс', () => project(root => {
    const load = json(root, 'graph-tool', {op: 'symbol', name: 'load', root: '.'});
    assert.ok(load.definedIn.some(item => item.file === 'app.js' && item.kind === 'function'));
    const counter = json(root, 'graph-tool', {op: 'symbol', name: 'Counter', root: '.'});
    assert.ok(counter.definedIn.some(item => item.kind === 'class'));
}));

test('graph исключает JS тесты, specs=true включает', () => project(root => {
    const without = json(root, 'graph-tool', {op: 'symbol', name: 'testOnly', root: '.'});
    assert.equal(without.definedIn.length, 0);
    const withTests = json(root, 'graph-tool', {op: 'symbol', name: 'testOnly', root: '.', specs: true});
    assert.equal(withTests.definedIn.length, 1);
}, {'special.test.js': 'function testOnly() {}'}));

test('комментарии и строки не создают ложные связи', () => project(root => {
    const result = deps(root, 'masked.js');
    assert.equal(result.unresolved, 0);
    assert.equal(result.imports.length, 0);
}, {'masked.js': '// require("./ghost")\nconst text = "require(\'./phantom\')";\n/* import "./absent"; */'}));

test('JS-first резолв не ломает TS-first для TS импортёров', () => project(root => {
    assert.deepEqual(paths(deps(root, 'js-entry.js').imports), ['shared.js']);
    assert.deepEqual(paths(deps(root, 'ts-entry.ts').imports), ['shared.ts']);
}, {'js-entry.js': 'import "./shared";', 'ts-entry.ts': 'import "./shared";', 'shared.js': 'export const value = 1;', 'shared.ts': 'export const value: number = 2;'}));

const isolated = (run, files) => project(run, files, {empty: true});

test('I-03: явный внешний путь не подменяется локальным basename', () => isolated(root => {
    for (const op of ['node', 'deps', 'rdeps', 'path']) {
        const result = cli(root, 'graph-tool', op === 'path'
            ? {op, from: 'a.ts', to: 'C:/NOT-THIS-PROJECT/b.ts', root: '.'}
            : {op, file: 'C:/NOT-THIS-PROJECT/b.ts', root: '.'});
        assert.equal(result.status, 1, result.stdout);
        assert.match(JSON.parse(result.stdout).error, /C:\/NOT-THIS-PROJECT\/b\.ts/);
        assert.equal(result.stderr, '');
    }
}, {'a.ts': 'import "./b";', 'b.ts': 'export const b = 1;'}));

test('I-03: внутренние exact paths и непутевой поиск сохраняют идентичность', () => isolated(root => {
    for (const file of [path.join(root, 'left/b.ts'), 'left/b.ts', '.\\left\\b.ts']) {
        assert.equal(json(root, 'graph-tool', {op: 'node', file, root: '.'}).file, 'left/b.ts');
    }
    for (const file of ['../b.ts', 'missing/b.ts', 'Z:\\NOT-THIS-PROJECT\\b.ts']) {
        assert.equal(cli(root, 'graph-tool', {op: 'deps', file, root: '.'}).status, 1);
    }
    assert.equal(json(root, 'graph-tool', {op: 'node', file: 'unique', root: '.'}).file, 'unique.ts');
    assert.equal(json(root, 'graph-tool', {op: 'node', file: 'b.ts', root: '.'}).ambiguous, true);
    const wrongCase = cli(root, 'graph-tool', {op: 'node', file: 'LEFT/b.ts', root: '.'});
    assert.equal(wrongCase.status, process.platform === 'win32' ? 0 : 1);
    assert.equal(cli(root, 'graph-tool', {op: 'path', from: '../a.ts', to: 'unique.ts', root: '.'}).status, 1);
}, {'left/b.ts': 'export const b = 1;', 'right/b.ts': 'export const b = 2;', 'unique.ts': 'export const u = 1;'}));

test('I-02: TS ESM .js импорт находит исходный b.ts', () => isolated(root => {
    assert.deepEqual(paths(deps(root, 'a.ts').imports), ['b.ts']);
    assert.deepEqual(paths(json(root, 'graph-tool', {op: 'rdeps', file: 'b.ts', root: '.'}).importedBy), ['a.ts']);
}, {'a.ts': 'import {b} from "./b.js";', 'b.ts': 'export const b = 1;'}));

test('I-02: .js substitution сохраняет приоритет TS/JS, tsx, alias и reexport', () => isolated(root => {
    assert.deepEqual(paths(deps(root, 'ts-entry.ts').imports), ['shared.ts']);
    assert.deepEqual(paths(deps(root, 'js-entry.js').imports), ['shared.js']);
    assert.deepEqual(paths(deps(root, 'tsx-entry.ts').imports), ['view.tsx']);
    assert.deepEqual(paths(deps(root, 'real-entry.ts').imports), ['real.js']);
    assert.deepEqual(paths(deps(root, 'alias.ts').imports), ['shared.ts']);
    assert.deepEqual(json(root, 'graph-tool', {op: 'path', from: 'alias.ts', to: 'shared.ts', root: '.'}).chain, ['alias.ts', 'shared.ts']);
    assert.deepEqual(json(root, 'graph-tool', {op: 'symbol', name: 'esmControl', root: '.'}).definedIn.map(item => item.file), ['shared.ts']);
    assert.deepEqual(paths(deps(root, 'module-entry.ts').imports), ['native.cjs', 'native.mjs']);
    assert.deepEqual(deps(root, 'unsupported.ts').unresolvedPaths, ['./unsupported.mjs']);
}, {'ts-entry.ts': 'import "./shared.js";', 'js-entry.js': 'import "./shared.js";',
    'shared.ts': 'export const shared = 1;\nexport function esmControl() {}\n', 'shared.js': 'export const shared = 2;',
    'tsx-entry.ts': 'export {view} from "./view.js";', 'view.tsx': 'export const view = <div/>;',
    'real-entry.ts': 'import "./real.js";', 'real.js': 'export const real = 1;',
    'alias.ts': 'export * from "@lib/shared.js";',
    'tsconfig.json': '{"compilerOptions":{"paths":{"@lib/*":["*"]}}}',
    'module-entry.ts': 'import "./native.mjs"; import "./native.cjs";',
    'native.mjs': 'export const x = 1;', 'native.cjs': 'module.exports.x = 1;',
    'unsupported.ts': 'import "./unsupported.mjs";', 'unsupported.mts': 'export const x = 1;'}));

test('I-04: удаление tsconfig сбрасывает alias и совпадает с forced build', () => isolated(root => {
    assert.deepEqual(paths(deps(root, 'a.ts').imports), ['lib/b.ts']);
    fs.unlinkSync(path.join(root, 'tsconfig.json'));
    const cached = deps(root, 'a.ts');
    assert.deepEqual(cached.imports, []);
    json(root, 'graph-tool', {op: 'build', root: '.'});
    assert.deepEqual(deps(root, 'a.ts'), cached);
    assert.deepEqual(cached.external, ['@lib/b']);
}, {'a.ts': 'import "@lib/b";', 'lib/b.ts': 'export const b = 1;',
    'tsconfig.json': '{"compilerOptions":{"baseUrl":".","paths":{"@lib/*":["lib/*"]}}}'}));

test('I-04: config create/edit/delete с прежним mtime совпадает с forced graph', () => isolated(root => {
    const config = path.join(root, 'tsconfig.json');
    const equivalence = () => {
        const cached = deps(root, 'a.ts');
        json(root, 'graph-tool', {op: 'build', root: '.'});
        assert.deepEqual(deps(root, 'a.ts'), cached);
        return paths(cached.imports);
    };
    assert.deepEqual(equivalence(), []);
    fs.writeFileSync(config, '{"compilerOptions":{"paths":{"@lib/*":["one/*"]}}}');
    fs.utimesSync(config, 1, 1);
    assert.deepEqual(equivalence(), ['one/b.ts']);
    fs.writeFileSync(config, '{"compilerOptions":{"paths":{"@lib/*":["two/*"]}}}');
    fs.utimesSync(config, 1, 1);
    assert.deepEqual(equivalence(), ['two/b.ts']);
    fs.unlinkSync(config);
    assert.deepEqual(equivalence(), []);
}, {'a.ts': 'import "@lib/b";', 'one/b.ts': 'export const b = 1;', 'two/b.ts': 'export const b = 2;'}));

test('I-04: локальный extends отслеживается вместе с origin aliases', () => isolated(root => {
    const config = path.join(root, 'config/base.json');
    assert.deepEqual(paths(deps(root, 'a.ts').imports), ['one/b.ts']);
    fs.writeFileSync(config, '{"compilerOptions":{"baseUrl":"..","paths":{"@lib/*":["two/*"]}}}');
    fs.utimesSync(config, 1, 1);
    const cached = deps(root, 'a.ts');
    assert.deepEqual(paths(cached.imports), ['two/b.ts']);
    json(root, 'graph-tool', {op: 'build', root: '.'});
    assert.deepEqual(deps(root, 'a.ts'), cached);
    fs.unlinkSync(config);
    assert.deepEqual(deps(root, 'a.ts').imports, []);
}, {'a.ts': 'import "@lib/b";', 'one/b.ts': 'export const b = 1;', 'two/b.ts': 'export const b = 2;',
    'tsconfig.json': '{"extends":"./config/base.json"}',
    'config/base.json': '{"compilerOptions":{"baseUrl":"..","paths":{"@lib/*":["one/*"]}}}'}));

test('I-04: смена root, старый и повреждённый cache перестраиваются', () => isolated(root => {
    assert.deepEqual(paths(deps(root, 'one/a.ts').imports), ['one/b.ts']);
    json(root, 'graph-tool', {op: 'build', root: 'two'});
    assert.deepEqual(paths(deps(root, 'one/a.ts').imports), ['one/b.ts']);
    fs.writeFileSync(path.join(root, 'graph-deps.json'), '{"version":5,"root":".","files":[]}');
    fs.writeFileSync(path.join(root, '.graph-deps-cache.json'), '{broken');
    assert.deepEqual(paths(deps(root, 'one/a.ts').imports), ['one/b.ts']);
    fs.writeFileSync(path.join(root, 'graph-deps.json'), '{"version":6,"root":".","files":[null]}');
    assert.deepEqual(paths(deps(root, 'one/a.ts').imports), ['one/b.ts']);
}, {'one/a.ts': 'import "./b";', 'one/b.ts': 'export const b = 1;', 'two/a.ts': 'export const a = 2;'}));

test('AS-04: полный пустой rdeps отличается от unresolved graph', () => isolated(root => {
    const clean = json(root, 'graph-tool', {op: 'rdeps', file: 'b.ts', root: '.'});
    assert.deepEqual(clean.importedBy, []);
    assert.equal(clean.completeness.complete, true);
    assert.equal(clean.scope.root, root);
    fs.writeFileSync(path.join(root, 'a.ts'), 'import "./missing.js";');
    const partial = json(root, 'graph-tool', {op: 'rdeps', file: 'b.ts', root: '.'});
    assert.deepEqual(partial.importedBy, []);
    assert.equal(partial.completeness.complete, false);
    assert.ok(partial.completeness.reasons.includes('unresolved-imports'));
    assert.equal(json(root, 'graph-tool', {op: 'path', from: 'a.ts', to: 'b.ts', root: '.'}).completeness.complete, false);
    const outside = cli(root, 'graph-tool', {op: 'path', from: '../a.ts', to: 'b.ts', root: '.'});
    assert.equal(outside.status, 1);
    assert.equal(JSON.parse(outside.stdout).completeness.complete, false);
}, {'a.ts': 'export const a = 1;', 'b.ts': 'export const b = 1;'}));

test('AS-04: scope, unsupported config и ограниченные samples/truncation', () => isolated(root => {
    const result = deps(root, 'a.ts');
    assert.equal(result.scope.scanRoot, '.');
    assert.equal(result.completeness.complete, false);
    assert.ok(result.completeness.reasons.includes('unsupported-module-resolution-options'));
    assert.ok(result.completeness.samples.length <= 5);
    assert.ok(result.completeness.samplesTruncated > 0);
    assert.ok(result.unresolvedPaths.length <= 5);
    assert.equal(result.unresolvedPathsTruncated, 15);
}, {'a.ts': Array.from({length: 20}, (_, i) => `import "./missing${i}";`).join('\n'),
    'tsconfig.json': '{"compilerOptions":{"moduleSuffixes":[".native",""]}}'}));

test('AS-04: пропущенный source и недоступная запись cache не выглядят complete', () => isolated(root => {
    let result = deps(root, 'a.ts');
    assert.ok(result.completeness.reasons.includes('excluded-source-files'));
    fs.unlinkSync(path.join(root, 'graph-deps.json'));
    fs.mkdirSync(path.join(root, 'graph-deps.json'));
    result = deps(root, 'a.ts');
    assert.equal(result.completeness.complete, false);
    assert.ok(result.completeness.reasons.includes('cache-write-failed'));
    assert.deepEqual(paths(result.imports), ['b.ts']);
}, {'a.ts': 'import "./b";', 'b.ts': 'export const b = 1;', 'unsupported.mts': 'export const x = 1;'}));

test('AS-04: некорректная конфигурация и null parse-cache безопасно перестраиваются', () => isolated(root => {
    fs.writeFileSync(path.join(root, '.graph-deps-cache.json'), 'null');
    assert.equal(deps(root, 'a.ts').completeness.complete, true);
    fs.writeFileSync(path.join(root, 'tsconfig.json'), '{"compilerOptions":{"paths":{"@lib/*":[null]}}}');
    const result = deps(root, 'a.ts');
    assert.deepEqual(paths(result.imports), ['b.ts']);
    assert.equal(result.completeness.complete, false);
    assert.ok(result.completeness.reasons.includes('config-invalid-options'));
}, {'a.ts': 'import "./b";', 'b.ts': 'export const b = 1;'}));

test('review F1: baseUrl-only ESM сохраняет локальный import и полный rdeps', () => isolated(root => {
    const result = deps(root, 'a.ts');
    assert.deepEqual(paths(result.imports), ['lib/b.ts']);
    assert.equal(result.completeness.complete, true);
    assert.deepEqual(result.external, ['external-package']);
    const reverse = json(root, 'graph-tool', {op: 'rdeps', file: 'lib/b.ts', root: '.'});
    assert.deepEqual(paths(reverse.importedBy), ['a.ts']);
    assert.equal(reverse.completeness.complete, true);
    assert.deepEqual(json(root, 'graph-tool', {op: 'path', from: 'a.ts', to: 'lib/b.ts', root: '.'}).chain, ['a.ts', 'lib/b.ts']);
}, {'a.ts': 'import "lib/b.js";\nimport "external-package";', 'lib/b.ts': 'export const b = 1;',
    'tsconfig.json': '{"compilerOptions":{"baseUrl":"."}}'}));

test('review F1: inherited baseUrl и config removal совпадают с forced graph', () => isolated(root => {
    assert.deepEqual(paths(deps(root, 'a.ts').imports), ['lib/b.ts']);
    fs.unlinkSync(path.join(root, 'tsconfig.json'));
    const ordinary = deps(root, 'a.ts');
    assert.deepEqual(ordinary.imports, []);
    assert.deepEqual(ordinary.external, ['lib']);
    json(root, 'graph-tool', {op: 'build', root: '.'});
    assert.deepEqual(deps(root, 'a.ts'), ordinary);
}, {'a.ts': 'import "lib/b.js";', 'lib/b.ts': 'export const b = 1;',
    'tsconfig.json': '{"extends":"./config/base.json"}', 'config/base.json': '{"compilerOptions":{"baseUrl":".."}}'}));

test('review F2: damaged parse-cache восстанавливает import из source', () => isolated(root => {
    assert.deepEqual(paths(deps(root, 'a.ts').imports), ['b.ts']);
    const cacheFile = path.join(root, '.graph-deps-cache.json');
    const damage = () => {
        const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        cache['a.ts'].data = {entities: [], exports: []};
        fs.writeFileSync(cacheFile, JSON.stringify(cache));
    };
    damage();
    fs.unlinkSync(path.join(root, 'graph-deps.json'));
    assert.deepEqual(paths(deps(root, 'a.ts').imports), ['b.ts']);
    damage();
    const build = json(root, 'graph-tool', {op: 'build', root: '.'});
    assert.equal(build.reparsed, 1);
    const reverse = json(root, 'graph-tool', {op: 'rdeps', file: 'b.ts', root: '.'});
    assert.deepEqual(paths(reverse.importedBy), ['a.ts']);
    assert.equal(reverse.completeness.complete, true);
}, {'a.ts': 'import "./b.js";', 'b.ts': 'export const b = 1;'}));

test('review F2: malformed style/JS specifiers и HTML fileRefs перепарсиваются', () => isolated(root => {
    for (const [file, expected] of [['a.js', 'b.ts'], ['a.scss', '_b.scss'], ['a.html', 'b.css']]) {
        assert.deepEqual(paths(deps(root, file).imports), [expected]);
        const cacheFile = path.join(root, '.graph-deps-cache.json');
        const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        if (file === 'a.html') delete cache[file].data.fileRefs;
        else cache[file].data.specifiers = [null];
        fs.writeFileSync(cacheFile, JSON.stringify(cache));
        const result = json(root, 'graph-tool', {op: 'build', root: '.'});
        assert.equal(result.reparsed, 1);
        assert.deepEqual(paths(deps(root, file).imports), [expected]);
    }
}, {'a.js': 'import "./b.js";', 'b.ts': 'export const b = 1;',
    'a.scss': '@use "./b";', '_b.scss': '$b: 1;', 'a.html': '<link rel="stylesheet" href="./b.css">', 'b.css': 'body {}'}));

test('AS-04: усечённый deps не удостоверяет полноту', () => isolated(root => {
    const result = deps(root, 'a.ts');
    assert.equal(result.importsTotal, 65);
    assert.equal(result.imports.length, 60);
    assert.equal(result.completeness.complete, false);
    assert.equal(result.completeness.truncated, 5);
}, Object.fromEntries([
    ['a.ts', Array.from({length: 65}, (_, i) => `import "./b${i}";`).join('\n')],
    ...Array.from({length: 65}, (_, i) => [`b${i}.ts`, 'export const b = 1;'])
])));

for (const ext of ['ts', 'tsx']) {
    test('audit: объявления в comments/templates не создают entities .' + ext, () => isolated(root => {
        const result = json(root, 'graph-tool', {op: 'node', file: 'masked.' + ext, root: '.'});
        assert.deepEqual(result.entities.map(({name, line}) => ({name, line})), [{name: 'Real', line: 7}]);
        for (const name of ['CommentGhost', 'TemplateGhost']) {
            assert.deepEqual(json(root, 'graph-tool', {op: 'symbol', name, root: '.'}).definedIn, []);
        }
    }, {['masked.' + ext]: '/*\nexport class CommentGhost {}\n*/\n`\nexport class TemplateGhost {}\n`;\nexport class Real {}\n'}));
}

test('audit: старый parse-cache не сохраняет фантомы после обновления парсера', () => isolated(root => {
    json(root, 'graph-tool', {op: 'build', root: '.'});
    const graphFile = path.join(root, 'graph-deps.json');
    const cacheFile = path.join(root, '.graph-deps-cache.json');
    const graph = JSON.parse(fs.readFileSync(graphFile, 'utf8'));
    const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    graph.version = cache.__v = 7;
    const ghost = {name: 'StaleGhost', kind: 'class', line: 1};
    graph.files[0].entities = [ghost];
    graph.symbols = {StaleGhost: [1]};
    cache['a.ts'].data.entities = [ghost];
    cache['a.ts'].data.exports = ['StaleGhost'];
    fs.writeFileSync(graphFile, JSON.stringify(graph));
    fs.writeFileSync(cacheFile, JSON.stringify(cache));
    assert.deepEqual(json(root, 'graph-tool', {op: 'symbol', name: 'StaleGhost', root: '.'}).definedIn, []);
    assert.equal(json(root, 'graph-tool', {op: 'symbol', name: 'Real', root: '.'}).definedIn.length, 1);
}, {'a.ts': 'export class Real {}'}));

function chainFiles(length, cycle = false) {
    const file = i => 'chain/f' + String(i).padStart(5, '0') + '.ts';
    return Object.fromEntries(Array.from({length}, (_, i) => [file(i), i + 1 < length || cycle
        ? 'import "./' + path.basename(file((i + 1) % length)) + '";\n'
        : 'export const end = 1;\n']));
}

for (const cycle of [false, true]) {
    test('audit: Тарьян обрабатывает 6200 файлов, ' + (cycle ? 'цикл' : 'цепочка'), {timeout: 60000}, () => isolated(root => {
        const first = 'chain/f00000.ts';
        assert.deepEqual(paths(json(root, 'graph-tool', {op: 'node', file: first, root: '.'}).imports), ['chain/f00001.ts']);
        assert.deepEqual(paths(deps(root, first).imports), ['chain/f00001.ts']);
        const result = json(root, 'graph-tool', {op: 'cycles', root: '.'});
        assert.equal(result.count, cycle ? 1 : 0);
        if (cycle) {
            assert.equal(result.cycles[0].size, 6200);
            assert.equal(result.cycles[0].sample.length, 15);
        }
    }, chainFiles(6200, cycle)));
}

test('audit: Тарьян не сливает SCC по перекрёстным рёбрам', () => isolated(root => {
    const result = json(root, 'graph-tool', {op: 'cycles', root: '.'});
    assert.deepEqual(result.cycles.map(group => group.slice().sort()).sort(), [['a.ts', 'b.ts'], ['d.ts', 'e.ts', 'f.ts']]);
}, {'a.ts': 'import "./b"; import "./c";', 'b.ts': 'import "./a"; import "./d";',
    'c.ts': 'import "./d";', 'd.ts': 'import "./e";', 'e.ts': 'import "./f";', 'f.ts': 'import "./d";',
    'g.ts': 'import "./c"; import "./e";', 'h.ts': 'export const h = 1;'}));

test('audit: неизвестный op не создаёт и не обновляет граф', () => isolated(root => {
    const result = cli(root, 'graph-tool', {op: 'typo', root: '.'});
    assert.equal(result.status, 1);
    assert.match(JSON.parse(result.stdout).error, /Неизвестный op/);
    for (const file of ['graph-deps.json', '.graph-deps-cache.json']) assert.equal(fs.existsSync(path.join(root, file)), false, file);
    json(root, 'graph-tool', {op: 'build', root: '.'});
    const before = ['graph-deps.json', '.graph-deps-cache.json'].map(file => fs.statSync(path.join(root, file)).mtimeMs);
    fs.writeFileSync(path.join(root, 'a.ts'), 'export class Changed {}');
    assert.equal(cli(root, 'graph-tool', {op: 'typo', root: '.'}).status, 1);
    assert.deepEqual(['graph-deps.json', '.graph-deps-cache.json'].map(file => fs.statSync(path.join(root, file)).mtimeMs), before);
}, {'a.ts': 'export class Original {}'}));

test('audit: существующий JSON import не делает статический граф неполным', () => isolated(root => {
    const result = deps(root, 'a.ts');
    assert.deepEqual(paths(result.imports), ['b.ts']);
    assert.equal(result.unresolved, 0);
    assert.equal(result.completeness.complete, true);
    assert.deepEqual(deps(root, 'c.js').imports, []);
    assert.equal(deps(root, 'c.js').unresolved, 0);
    fs.unlinkSync(path.join(root, 'data.json'));
    const missing = deps(root, 'a.ts');
    assert.equal(missing.unresolved, 1);
    assert.deepEqual(missing.unresolvedPaths, ['./data.json']);
    assert.equal(missing.completeness.complete, false);
    fs.writeFileSync(path.join(root, 'data.json'), '{}');
    assert.equal(deps(root, 'a.ts').completeness.complete, true);
}, {'a.ts': 'import data from "./data.json"; import "./b";', 'b.ts': 'export const b = 1;',
    'c.js': 'const data = require("./data.json");', 'data.json': '{}'}));

test('audit: JSON resources через alias, baseUrl и query остаются вне source nodes', () => isolated(root => {
    const result = deps(root, 'a.ts');
    assert.deepEqual(result.imports, []);
    assert.equal(result.unresolved, 0);
    assert.equal(result.completeness.complete, true);
    assert.equal(json(root, 'graph-tool', {op: 'stats', root: '.'}).files, 1);
}, {'a.ts': 'import "@data/config.json"; import "data/config.json"; import "./data/config.json?raw";',
    'data/config.json': '{}', 'tsconfig.json': '{"compilerOptions":{"baseUrl":".","paths":{"@data/*":["data/*"]}}}'}));

test('audit: деление не маскирует require, настоящий regex маскируется', () => isolated(root => {
    const result = deps(root, 'division.js');
    assert.deepEqual(paths(result.imports), ['divisor.js']);
    assert.equal(result.unresolved, 0);
}, {'division.js': 'const ratio = total / require("./divisor") / scale;\nconst pattern = /require("ghost")/g;\n',
    'divisor.js': 'module.exports = 2;'}));

test('audit: graph arrow-свойства класса имеют kind method', () => isolated(root => {
    for (const name of ['onClick', 'identity']) {
        const result = json(root, 'graph-tool', {op: 'symbol', name, in: 'Service', root: '.'});
        assert.deepEqual(result.definedIn.map(item => [item.kind, item.owner]), [['method', 'Service']]);
    }
}, {'arrows.ts': 'export class Service {\n  onClick = (event: Event): void => {};\n  identity = <T>(value: T) => value;\n}\n'}));

test('audit: graph находит Unicode объявления и члены', () => isolated(root => {
    for (const [name, kind] of [['Сервис', 'class'], ['привет', 'function'], ['cafe\u0301', 'const'], ['𐐀run', 'function']]) {
        const result = json(root, 'graph-tool', {op: 'symbol', name, root: '.'});
        assert.deepEqual(result.definedIn.map(item => item.kind), [kind], name);
    }
    const member = json(root, 'graph-tool', {op: 'symbol', name: 'сохранить', in: 'Сервис', root: '.'});
    assert.deepEqual(member.definedIn.map(item => [item.kind, item.owner]), [['method', 'Сервис']]);
}, {'unicode.ts': 'export class Сервис {\n  сохранить(): void {}\n}\nexport function привет() {}\nexport const cafe\u0301 = 1;\nexport function 𐐀run() {}\n'}));
