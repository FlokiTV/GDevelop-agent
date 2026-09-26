const test = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs } = require('./McpMultiProjectTargetIsolationLiveScenario');

test('DX40 multi-project target isolation live scenario argument parser is deterministic', () => {
  assert.deepEqual(parseArgs([]), {
    discoveryPath: null,
    evidencePath: null,
    label: 'live',
  });
  assert.deepEqual(
    parseArgs([
      '--discovery',
      'C:/tmp/discovery.json',
      '--evidence',
      'C:/tmp/evidence.json',
      '--label',
      'package',
    ]),
    {
      discoveryPath: 'C:/tmp/discovery.json',
      evidencePath: 'C:/tmp/evidence.json',
      label: 'package',
    }
  );
  assert.throws(() => parseArgs(['--bad']), /unknown_argument/);
});
