'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs } = require('../../skills/token-economy-har/har');

test('--compact: только --json без --pretty, включая help', () => {
    assert.equal(parseArgs(['--compact', '--json', 'info']).compact, true);
    assert.equal(parseArgs(['info', '--json', '--compact']).compact, true);
    assert.equal(parseArgs(['help', '--json', '--compact']).command, 'help');
    for (const args of [
        ['info', '--compact'], ['help', '--compact'],
        ['info', '--compact', '--json', '--pretty'], ['help', '--json', '--compact', '--pretty'],
        ['info', '--compact=true', '--json']
    ]) {
        assert.throws(() => parseArgs(args), error => error.exitCode === 2 && /--compact/.test(error.message));
    }
});
