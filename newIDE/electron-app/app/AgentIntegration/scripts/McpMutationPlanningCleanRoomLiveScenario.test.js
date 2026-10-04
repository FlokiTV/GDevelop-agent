const assert = require('node:assert/strict');
const test = require('node:test');
const {
  REQUIRED_TOOLS,
} = require('./McpMutationPlanningCleanRoomLiveScenario');

test('DX-38 live runner requires planning, refactor, resource and safety surfaces', () => {
  const required = [
    'mutations.capabilities',
    'mutations.plan',
    'mutations.commit',
    'objects.definitions.rename',
    'objects.groups.members.add',
    'scene.instances.create',
    'events.insert',
    'resources.visual.import',
    'resources.visual.inspect',
    'objects.sprite.animations.create',
    'objects.sprite.frames.add',
    'validation.run',
    'safety.transactions.begin',
    'safety.transactions.rollback',
  ];
  for (const name of required) {
    assert.ok(REQUIRED_TOOLS.includes(name), 'missing:' + name);
  }
});

test('DX-38 live runner tool contract is deterministic and duplicate-free', () => {
  assert.equal(new Set(REQUIRED_TOOLS).size, REQUIRED_TOOLS.length);
});
