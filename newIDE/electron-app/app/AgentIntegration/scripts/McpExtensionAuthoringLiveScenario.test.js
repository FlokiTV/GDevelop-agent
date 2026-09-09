const test = require('node:test');
const assert = require('node:assert/strict');
const {
  REQUIRED_TOOLS,
  assertRequiredTools,
  findCustomType,
  parseArgs,
} = require('./McpExtensionAuthoringLiveScenario');

test('parseArgs defaults to rollback and accepts targeting/output options', () => {
  assert.deepEqual(
    parseArgs([
      '--allow-mutate',
      '--output',
      'artifacts/custom',
      '--window-id',
      '42',
      '--project-path',
      'C:/game/game.json',
    ]),
    {
      rollback: true,
      allowMutate: true,
      outputDir: 'artifacts/custom',
      windowId: '42',
      projectPath: 'C:/game/game.json',
    }
  );
  assert.deepEqual(parseArgs(['--allow-mutate', '--persist']), {
    rollback: false,
    allowMutate: true,
  });
});

test('assertRequiredTools rejects incomplete MCP extension-authoring surface', () => {
  assert.equal(
    assertRequiredTools(REQUIRED_TOOLS.map(name => ({ name }))),
    true
  );
  assert.throws(
    () => assertRequiredTools([{ name: 'project.status' }]),
    /extension_authoring_tools_missing:/
  );
});

test('findCustomType accepts canonical suffix and exact extension ownership', () => {
  const items = [
    {
      type: 'Other::Widget',
      name: 'Widget',
      extension: { name: 'Other' },
    },
    {
      type: 'McpExtension::Widget',
      name: 'Widget',
      extension: { name: 'McpExtension', namespace: 'McpExtension' },
    },
  ];
  assert.deepEqual(findCustomType(items, 'McpExtension', 'Widget'), items[1]);
  assert.equal(findCustomType(items, 'Missing', 'Widget'), null);
});
