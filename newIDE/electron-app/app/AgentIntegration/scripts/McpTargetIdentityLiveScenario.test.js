const test = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs } = require('./McpTargetIdentityLiveScenario');

test('DX40 target identity live scenario argument parser is deterministic', () => {
  assert.deepEqual(parseArgs([]), { label: 'live', evidencePath: null });
  assert.deepEqual(
    parseArgs(['--label', 'package', '--evidence', 'C:/tmp/dx40.json']),
    {
      label: 'package',
      evidencePath: 'C:/tmp/dx40.json',
    }
  );
  assert.throws(() => parseArgs(['--unknown']), /unknown_argument/);
});
