const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TYPED_TOOLS,
  assertRequiredTools,
  parseArgs,
} = require('./McpTypedEditorFunctionsLiveScenario');

test('parseArgs defaults to rollback and accepts targeting/output options', () => {
  assert.deepEqual(
    parseArgs([
      '--allow-mutate',
      '--output',
      'artifacts/typed-editor-functions',
      '--window-id',
      '11',
      '--project-path',
      'C:/game.json',
      '--open-project-path',
      'C:/opened-game.json',
    ]),
    {
      rollback: true,
      allowMutate: true,
      outputDir: 'artifacts/typed-editor-functions',
      windowId: '11',
      projectPath: 'C:/game.json',
      openProjectPath: 'C:/opened-game.json',
    }
  );
});

test('assertRequiredTools rejects missing or malformed typed EditorFunction surface', () => {
  assert.ok(TYPED_TOOLS.includes('editor.functions.create-scene'));
  assert.ok(TYPED_TOOLS.includes('editor.functions.put-2d-instances'));
  assert.throws(
    () => assertRequiredTools([{ name: 'project.status' }]),
    /typed_tool_missing:/
  );

  const complete = [
    ...TYPED_TOOLS.map(name => ({
      name,
      inputSchema: {
        type: 'object',
        properties: {},
      },
      annotations: { readOnlyHint: true },
    })),
    { name: 'editor.functions.call' },
    { name: 'editor.types.objects.list' },
  ];
  const createScene = complete.find(
    tool => tool.name === 'editor.functions.create-scene'
  );
  createScene.inputSchema = {
    type: 'object',
    required: ['scene_name'],
    properties: { scene_name: { type: 'string' } },
  };
  createScene.annotations = { readOnlyHint: false };

  assert.doesNotThrow(() => assertRequiredTools(complete));

  createScene.inputSchema.properties.arguments = { type: 'object' };
  assert.throws(
    () => assertRequiredTools(complete),
    /typed_create_scene_schema_invalid/
  );
});
