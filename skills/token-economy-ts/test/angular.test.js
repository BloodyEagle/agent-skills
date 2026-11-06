const test = require('node:test');
const assert = require('node:assert/strict');
const {project, cli, json} = require('./helpers');
const {ANGULAR_ERROR} = require('../scripts/lib/files');

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
