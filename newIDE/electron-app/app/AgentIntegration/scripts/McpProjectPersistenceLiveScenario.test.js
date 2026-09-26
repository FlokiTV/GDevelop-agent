const assert = require('node:assert/strict');
const test = require('node:test');
const {
  addExternalProbe,
  parseArgs,
} = require('./McpProjectPersistenceLiveScenario');

test('DX41 persistence scenario argument parser is deterministic', () => {
  assert.deepEqual(parseArgs([]), {
    label: 'live',
    evidencePath: null,
  });
  assert.deepEqual(
    parseArgs(['--label', 'source', '--evidence', 'C:/temp/evidence.json']),
    {
      label: 'source',
      evidencePath: 'C:/temp/evidence.json',
    }
  );
  assert.throws(() => parseArgs(['--unknown']), /unknown_argument/);
});

test('DX41 external disk probe preserves valid JSON while changing semantic state', () => {
  const original = JSON.stringify({
    name: 'Game',
    layouts: [{ name: 'Scene' }],
  });
  const mutated = addExternalProbe(original);
  const parsed = JSON.parse(mutated);
  assert.equal(parsed.name, 'Game');
  assert.deepEqual(parsed.layouts, [{ name: 'Scene' }]);
  assert.equal(parsed.__dx41ExternalProbe, 'semantic-external-change');
  assert.notEqual(mutated, original);
});
