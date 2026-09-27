const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getLinkTargets,
  parseArgs,
} = require('./McpProjectStructureLiveScenario');

test('DX33 project structure live scenario argument parser is deterministic', () => {
  assert.deepEqual(parseArgs([]), { label: 'live', evidencePath: null });
  assert.deepEqual(
    parseArgs(['--label', 'package', '--evidence', 'C:/tmp/dx33.json']),
    { label: 'package', evidencePath: 'C:/tmp/dx33.json' }
  );
  assert.throws(() => parseArgs(['--unknown']), /unknown_argument/);
});

test('DX33 link target collector follows nested event trees', () => {
  assert.deepEqual(
    getLinkTargets([
      { type: 'BuiltinCommonInstructions::Link', target: 'A' },
      {
        type: 'BuiltinCommonInstructions::Standard',
        events: [{ type: 'BuiltinCommonInstructions::Link', target: 'B' }],
      },
    ]),
    ['A', 'B']
  );
});
