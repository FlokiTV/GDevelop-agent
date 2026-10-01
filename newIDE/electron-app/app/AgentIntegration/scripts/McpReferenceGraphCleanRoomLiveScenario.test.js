const assert = require('node:assert/strict');
const test = require('node:test');
const { REQUIRED_TOOLS } = require('./McpReferenceGraphCleanRoomLiveScenario');

test('DX-37 live runner requires graph, authoring, refactor and safety surfaces', () => {
  const required = [
    'references.graph.capabilities',
    'references.graph.query',
    'references.graph.usages',
    'references.graph.impact',
    'objects.definitions.rename',
    'objects.groups.members.add',
    'scene.instances.create',
    'events.insert',
    'validation.run',
    'safety.transactions.begin',
    'safety.transactions.rollback',
  ];
  for (const name of required) {
    assert.ok(REQUIRED_TOOLS.includes(name), 'missing:' + name);
  }
});

test('DX-37 live runner tool contract is deterministic and duplicate-free', () => {
  assert.equal(new Set(REQUIRED_TOOLS).size, REQUIRED_TOOLS.length);
});
