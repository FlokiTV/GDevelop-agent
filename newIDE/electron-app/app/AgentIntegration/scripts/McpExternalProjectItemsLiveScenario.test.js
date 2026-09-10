const test = require('node:test');
const assert = require('node:assert/strict');
const {
  REQUIRED_TOOLS,
  assertRequiredTools,
  parseArgs,
} = require('./McpExternalProjectItemsLiveScenario');

test('parseArgs defaults to rollback and accepts targeting/output options', () => {
  assert.deepEqual(
    parseArgs([
      '--allow-mutate',
      '--output',
      'artifacts/external-items',
      '--window-id',
      '7',
      '--project-path',
      'C:/game.json',
    ]),
    {
      rollback: true,
      allowMutate: true,
      outputDir: 'artifacts/external-items',
      windowId: '7',
      projectPath: 'C:/game.json',
    }
  );
});

test('assertRequiredTools rejects incomplete External Events/Layout surface', () => {
  assert.ok(REQUIRED_TOOLS.includes('external-events.create'));
  assert.ok(REQUIRED_TOOLS.includes('external-layouts.instances.create'));
  assert.throws(
    () => assertRequiredTools([{ name: 'project.status' }]),
    /external_project_items_tools_missing:/
  );
  assert.equal(
    assertRequiredTools(REQUIRED_TOOLS.map(name => ({ name }))),
    true
  );
});
