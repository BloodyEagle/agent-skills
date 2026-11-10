const test = require('node:test');
const assert = require('node:assert/strict');
const {project, cli, json} = require('./helpers');
const {ANGULAR_ERROR} = require('../../skills/token-economy-ts/scripts/lib/files');

for (const script of ['graph-tool', 'scaffold-helper']) {
    test(script + ' отказывает без Angular с кодом 1', () => project(root => {
        const args = script === 'graph-tool' ? {op: 'selector', selector: 'app-root'} : {type: 'component', name: 'demo'};
        const result = cli(root, script, args);
        assert.equal(result.status, 1);
        assert.equal(result.stdout.trim(), ANGULAR_ERROR);
    }));
}

test('Angular selector сохраняет TS шаблоны, imports и symbols', () => project(root => {
    const result = json(root, 'graph-tool', {op: 'selector', selector: 'app-demo'});
    assert.ok(JSON.stringify(result).includes('demo.component.ts'));
    assert.ok(JSON.stringify(result).includes('app.html'));
    const symbol = json(root, 'graph-tool', {op: 'symbol', name: 'DemoComponent'});
    assert.ok(symbol.definedIn.some(item => item.file === 'src/demo.component.ts'));
    const deps = json(root, 'graph-tool', {op: 'deps', file: 'src/demo.component.ts'});
    assert.ok(deps.imports.some(item => item.file === 'src/util.ts'));
}, {
    'angular.json': '{}',
    'src/demo.component.ts': "import {Component} from '@angular/core';\nimport {value} from './util';\n@Component({selector: 'app-demo', template: '<span></span>'})\nexport class DemoComponent {}",
    'src/util.ts': 'export const value = 1;',
    'src/app.html': '<app-demo></app-demo>'
}));

test('@angular/core в package.json разрешает selector без angular.json', () => project(root => {
    assert.equal(cli(root, 'graph-tool', {op: 'selector', selector: 'absent', root: '.'}).status, 0);
}, {'package.json': JSON.stringify({dependencies: {'@angular/core': '20.0.0'}})}));

test('Angular generate сохраняет прежний отказ при отсутствии локального CLI', () => project(root => {
    const result = cli(root, 'scaffold-helper', {type: 'component', name: 'demo'});
    assert.equal(result.status, 1);
    assert.match(JSON.parse(result.stdout).error, /Локальный Angular CLI не найден/);
}, {'angular.json': '{}'}));

test('audit: Angular-декораторы в comments/templates не создают entities', () => project(root => {
    const result = json(root, 'graph-tool', {op: 'node', file: 'src/masked.ts'});
    assert.deepEqual(result.entities.map(item => item.name), ['Настоящий']);
    for (const selector of ['ghost-comment', 'ghost-template']) {
        assert.equal(json(root, 'graph-tool', {op: 'selector', selector}).file, null);
    }
}, {'angular.json': '{}', 'src/masked.ts': '/*\n@Component({selector: "ghost-comment"})\nexport class CommentGhost {}\n*/\n`\n@Component({selector: "ghost-template"})\nexport class TemplateGhost {}\n`;\n@Component({selector: "real"})\nexport class Настоящий {}\n'}, {empty: true}));

test('audit: дубликат selector возвращает предупреждение вместо тихого выбора', () => project(root => {
    const selector = json(root, 'graph-tool', {op: 'selector', selector: 'app-duplicate'});
    assert.ok(selector.warnings.some(warning => /app-duplicate/.test(warning) && /a\.ts/.test(warning) && /b\.ts/.test(warning)));
    const info = json(root, 'graph-tool', {op: 'info'});
    assert.ok(info.warnings.some(warning => /app-duplicate/.test(warning)));
    const deps = json(root, 'graph-tool', {op: 'deps', file: 'src/app.html'});
    assert.equal(deps.completeness.complete, false);
    assert.ok(deps.completeness.reasons.includes('duplicate-selectors'));
}, {'angular.json': '{}', 'src/a.ts': "@Component({selector: 'app-duplicate'})\nexport class A {}",
    'src/b.ts': "@Component({selector: 'app-duplicate'})\nexport class B {}", 'src/app.html': '<app-duplicate></app-duplicate>'}, {empty: true}));
