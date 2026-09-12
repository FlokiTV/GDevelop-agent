const test = require('node:test');
const assert = require('node:assert/strict');
const {
  REQUIRED_TOOLS,
  assertRequiredTools,
  chooseInstallableExtension,
  parseArgs,
} = require('./McpObjectStructureExtensionsLiveScenario');

test('parseArgs defaults to rollback and accepts CAP-09/10 targeting options', () => {
  assert.deepEqual(
    parseArgs([
      '--allow-mutate',
      '--output',
      'artifacts/cap09-10',
      '--window-id',
      '11',
      '--project-path',
      'C:/game.json',
      '--open-project-path',
      'C:/opened-game.json',
      '--skip-extension-install',
    ]),
    {
      rollback: true,
      allowMutate: true,
      outputDir: 'artifacts/cap09-10',
      windowId: '11',
      projectPath: 'C:/game.json',
      openProjectPath: 'C:/opened-game.json',
      skipExtensionInstall: true,
    }
  );
});

test('assertRequiredTools requires structural and extension lifecycle surface with annotations', () => {
  assert.ok(REQUIRED_TOOLS.includes('objects.structure.apply'));
  assert.ok(REQUIRED_TOOLS.includes('extensions.install'));
  assert.throws(
    () => assertRequiredTools([{ name: 'project.status' }]),
    /object_structure_extension_tools_missing:/
  );

  const tools = REQUIRED_TOOLS.map(name => ({
    name,
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  }));
  const apply = tools.find(tool => tool.name === 'objects.structure.apply');
  apply.inputSchema.properties.structure = { type: 'object' };
  apply.annotations.readOnlyHint = false;
  assert.doesNotThrow(() => assertRequiredTools(tools));

  apply.annotations.readOnlyHint = true;
  assert.throws(
    () => assertRequiredTools(tools),
    /object_structure_apply_schema_or_annotations_invalid/
  );
});

test('chooseInstallableExtension prefers reviewed non-installed bounded dependency candidates', () => {
  const selected = chooseInstallableExtension([
    {
      name: 'ExperimentalOne',
      installed: false,
      tier: 'experimental',
      requiredExtensions: [],
    },
    {
      name: 'ReviewedTooManyDeps',
      installed: false,
      tier: 'reviewed',
      requiredExtensions: [{}, {}, {}, {}, {}],
    },
    {
      name: 'ReviewedGood',
      installed: false,
      tier: 'reviewed',
      requiredExtensions: [{}],
    },
  ]);
  assert.equal(selected.name, 'ReviewedGood');
});
