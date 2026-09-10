const test = require('node:test');
const assert = require('node:assert/strict');
const {
  REQUIRED_TOOLS,
  assertRequiredTools,
  parseArgs,
} = require('./McpDocsStoreLiveScenario');

test('parseArgs defaults to rollback and accepts targeting/output options', () => {
  assert.deepEqual(
    parseArgs([
      '--allow-mutate',
      '--output',
      'artifacts/docs-store',
      '--window-id',
      '9',
      '--project-path',
      'C:/game.json',
      '--open-project-path',
      'C:/opened-game.json',
    ]),
    {
      rollback: true,
      allowMutate: true,
      outputDir: 'artifacts/docs-store',
      windowId: '9',
      projectPath: 'C:/game.json',
      openProjectPath: 'C:/opened-game.json',
    }
  );
});

test('assertRequiredTools rejects incomplete docs/store surface', () => {
  assert.ok(REQUIRED_TOOLS.includes('docs.search'));
  assert.ok(REQUIRED_TOOLS.includes('store.objects.import'));
  assert.ok(REQUIRED_TOOLS.includes('store.resources.import'));
  assert.throws(
    () => assertRequiredTools([{ name: 'project.status' }]),
    /docs_store_tools_missing:/
  );
  assert.equal(
    assertRequiredTools(REQUIRED_TOOLS.map(name => ({ name }))),
    true
  );
});
