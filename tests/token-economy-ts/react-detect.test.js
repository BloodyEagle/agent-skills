const test = require('node:test');
const assert = require('node:assert/strict');
const {project, json} = require('./helpers');

const pkgFile = (pkg, extra = {}) => ({
    ...extra,
    'package.json': JSON.stringify({name: 'react-app', ...pkg}),
    'src/index.ts': 'export const index = 1;'
});
const info = (root) => json(root, 'graph-tool', {op: 'info'});
const hasReactWarning = (result) => (result.warnings || []).some(warning => /react/i.test(warning));

for (const [major, spec] of [[16, '^16.0.0'], [17, '17.0.2'], [18, '18.3.1'], [19, '~19.0.0']]) {
    test('react ' + major + ' в dependencies → projectType=react', () => project(root => {
        const result = info(root);
        assert.equal(result.projectType, 'react');
        assert.equal(result.keyDeps.react, spec);
        assert.ok(!hasReactWarning(result));
    }, pkgFile({dependencies: {react: spec}}), {empty: true}));
}

test('react в devDependencies и peerDependencies → projectType=react', () => {
    project(root => assert.equal(info(root).projectType, 'react'),
        pkgFile({devDependencies: {react: '18.3.1'}}), {empty: true});
    project(root => assert.equal(info(root).projectType, 'react'),
        pkgFile({peerDependencies: {react: '^17.0.0'}}), {empty: true});
});

test('react 15 не делает проект react и даёт warning', () => project(root => {
    const result = info(root);
    assert.equal(result.projectType, 'ts');
    assert.ok(result.warnings.some(warning => warning.includes('react >= 16')), JSON.stringify(result.warnings));
    assert.ok(result.warnings.some(warning => warning.includes('react 15.6')), JSON.stringify(result.warnings));
}, pkgFile({dependencies: {react: '15.6'}}), {empty: true}));

test('нераспознанная версия latest → projectType=react + warning', () => project(root => {
    const result = info(root);
    assert.equal(result.projectType, 'react');
    assert.ok(result.warnings.some(warning => warning.includes('latest') && warning.includes('не распознана')),
        JSON.stringify(result.warnings));
}, pkgFile({dependencies: {react: 'latest'}}), {empty: true}));

test('react-dom без react не делает проект react', () => project(root => {
    const result = info(root);
    assert.equal(result.projectType, 'ts');
    assert.equal(result.keyDeps['react-dom'], '^18.0.0');
    assert.ok(!hasReactWarning(result), JSON.stringify(result.warnings));
}, pkgFile({dependencies: {'react-dom': '^18.0.0'}}), {empty: true}));

test('next без react не делает проект react', () => project(root => {
    const result = info(root);
    assert.equal(result.projectType, 'ts');
    assert.equal(result.keyDeps.next, '^14.0.0');
    assert.ok(!hasReactWarning(result), JSON.stringify(result.warnings));
}, pkgFile({dependencies: {next: '^14.0.0'}}), {empty: true}));

test('angular.json имеет приоритет над react', () => project(root => {
    const result = info(root);
    assert.equal(result.projectType, 'angular');
    assert.equal(result.angularJson, true);
    assert.ok(!hasReactWarning(result), JSON.stringify(result.warnings));
}, pkgFile({dependencies: {react: '^18.0.0'}}, {'angular.json': '{}'}), {empty: true}));

test('react с express → projectType=react, а не node', () => project(root => {
    assert.equal(info(root).projectType, 'react');
}, pkgFile({dependencies: {react: '^18.0.0', express: '^4.19.0'}}), {empty: true}));

test('существующие типы проектов не изменились', () => {
    project(root => {
        const result = info(root);
        assert.equal(result.projectType, 'node');
        assert.equal(result.server, 'express');
    }, pkgFile({dependencies: {express: '^4.19.0'}}), {empty: true});
    project(root => assert.equal(info(root).projectType, 'nest'),
        pkgFile({dependencies: {'@nestjs/core': '^10.0.0'}}), {empty: true});
    project(root => assert.equal(info(root).projectType, 'ts'),
        pkgFile({dependencies: {'fake-lib': '^1.0.0'}}), {empty: true});
});
