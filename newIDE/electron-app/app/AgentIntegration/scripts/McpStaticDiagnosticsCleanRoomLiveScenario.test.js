const assert = require('node:assert/strict');
const test = require('node:test');
const {
  REQUIRED_TOOLS,
} = require('./McpStaticDiagnosticsCleanRoomLiveScenario');

test('DX-39 live runner requires static diagnostics, event authoring, aggregate validation and safety surfaces', () => {
  const required = [
    'diagnostics.capabilities',
    'diagnostics.query',
    'events.instructions.search',
    'events.read',
    'events.insert',
    'validation.run',
    'safety.transactions.begin',
    'safety.transactions.rollback',
  ];
  for (const name of required) {
    assert.ok(REQUIRED_TOOLS.includes(name), 'missing:' + name);
  }
});

test('DX-39 live runner keeps runtime diagnostics out of its required contract', () => {
  for (const name of REQUIRED_TOOLS) {
    assert.equal(
      /^runtime\./.test(name),
      false,
      'unexpected-runtime-surface:' + name
    );
  }
});

test('DX-39 live runner tool contract is deterministic and duplicate-free', () => {
  assert.equal(new Set(REQUIRED_TOOLS).size, REQUIRED_TOOLS.length);
});
