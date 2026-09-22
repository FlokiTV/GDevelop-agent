const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isSimpleBehaviorCondition,
  parseArgs,
} = require('./McpMetadataDiscoveryLiveScenario');

test('isSimpleBehaviorCondition accepts only scene behavior conditions with object+behavior parameters', () => {
  const valid = {
    kind: 'condition',
    scope: { kind: 'behavior', behaviorType: 'Example::Behavior' },
    eventContexts: { scene: true },
    parameters: [
      { codeOnly: true, valueType: {} },
      { codeOnly: false, valueType: { object: true } },
      { codeOnly: false, valueType: { behavior: true } },
    ],
  };
  assert.equal(isSimpleBehaviorCondition(valid), true);
  assert.equal(
    isSimpleBehaviorCondition({
      ...valid,
      parameters: [
        { codeOnly: false, valueType: { object: true } },
        { codeOnly: false, valueType: { behavior: true } },
        { codeOnly: false, valueType: { number: true } },
      ],
    }),
    false
  );
  assert.equal(
    isSimpleBehaviorCondition({
      ...valid,
      eventContexts: { scene: false },
    }),
    false
  );
});

test('parseArgs keeps natural search terms separate from canonical ids', () => {
  assert.deepEqual(
    parseArgs([
      '--allow-mutate',
      '--object-query',
      '2d sprite',
      '--behavior-query',
      'movement',
      '--window-id',
      '17',
    ]),
    {
      rollback: true,
      eventNodesOnly: false,
      objectQuery: '2d sprite',
      behaviorQuery: 'movement',
      allowMutate: true,
      windowId: '17',
    }
  );
});

test('parseArgs supports read-only event node acceptance without mutation opt-in', () => {
  assert.deepEqual(
    parseArgs(['--event-nodes-only', '--project-path', 'game.json']),
    {
      rollback: true,
      eventNodesOnly: true,
      objectQuery: 'sprite',
      behaviorQuery: 'movement',
      projectPath: 'game.json',
    }
  );
});
