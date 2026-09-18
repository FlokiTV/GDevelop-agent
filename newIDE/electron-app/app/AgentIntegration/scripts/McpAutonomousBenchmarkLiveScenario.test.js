const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  REQUIRED_TOOLS,
  assertRequiredTools,
  buildStructuredMutation,
  findZeroParameterSceneCondition,
  parseArgs,
  selectAdditionalBuildTarget,
} = require('./McpAutonomousBenchmarkLiveScenario');

test('parseArgs requires explicit mutation/build opt-in without weakening CAP-25 defaults', () => {
  assert.deepEqual(
    parseArgs([
      '--allow-mutate',
      '--allow-remote-build',
      '--output',
      'artifacts/cap25',
      '--object-query',
      'animated 2d character',
      '--keep-project',
    ]),
    {
      cleanupProject: false,
      allowRemoteBuild: true,
      requireAdditionalBuild: true,
      objectQuery: 'animated 2d character',
      allowMutate: true,
      outputDir: path.resolve('artifacts/cap25'),
    }
  );
  assert.equal(parseArgs([]).requireAdditionalBuild, true);
  assert.equal(
    parseArgs(['--allow-no-additional-build']).requireAdditionalBuild,
    false
  );
  assert.throws(() => parseArgs(['--publish']), /unknown_argument/);
});

test('assertRequiredTools rejects incomplete or incorrectly annotated public MCP surfaces', () => {
  const tools = REQUIRED_TOOLS.map(name => ({
    name,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
  }));
  assert.doesNotThrow(() => assertRequiredTools(tools));

  const missing = tools.filter(tool => tool.name !== 'docs.search');
  assert.throws(
    () => assertRequiredTools(missing),
    /cap25_tools_missing:docs.search/
  );

  const bad = tools.map(tool =>
    tool.name === 'runtime.snapshot'
      ? { ...tool, annotations: { ...tool.annotations, readOnlyHint: false } }
      : tool
  );
  assert.throws(
    () => assertRequiredTools(bad),
    /cap25_readonly_annotation_invalid:runtime.snapshot/
  );
});

test('selectAdditionalBuildTarget is capability-driven and prefers web-online when available', () => {
  const targets = [
    {
      id: 'windows-exe',
      deliveryKind: 'remote-build',
      availability: { state: 'available' },
    },
    {
      id: 'web-online',
      deliveryKind: 'remote-build',
      availability: { state: 'available' },
    },
    {
      id: 'html5-local',
      deliveryKind: 'local-export',
      availability: { state: 'available' },
    },
  ];
  assert.equal(selectAdditionalBuildTarget(targets).id, 'web-online');
  assert.equal(
    selectAdditionalBuildTarget([
      {
        id: 'windows-exe',
        deliveryKind: 'remote-build',
        availability: { state: 'available' },
      },
    ]).id,
    'windows-exe'
  );
  assert.equal(
    selectAdditionalBuildTarget([
      {
        id: 'html5-local',
        availability: { state: 'available' },
      },
      {
        id: 'windows-exe',
        availability: { state: 'unavailable' },
      },
    ]),
    null
  );
});

test('findZeroParameterSceneCondition selects a discovered scene condition without hard-coded ids', async () => {
  const calls = [];
  const call = async (name, args) => {
    calls.push({ name, args });
    if (name === 'events.instructions.search') {
      return {
        data: {
          items: [
            { id: 'CandidateWithParameter' },
            { id: 'InstalledZeroParameterCondition' },
          ],
        },
      };
    }
    if (args.id === 'CandidateWithParameter') {
      return {
        data: {
          item: {
            id: args.id,
            kind: 'condition',
            eventContexts: { scene: true },
            scope: { kind: 'scene' },
            parameters: [{ name: 'Value', codeOnly: false }],
          },
        },
      };
    }
    return {
      data: {
        item: {
          id: args.id,
          kind: 'condition',
          eventContexts: { scene: true },
          scope: { kind: 'scene' },
          parameters: [],
        },
      },
    };
  };

  const result = await findZeroParameterSceneCondition(call);
  assert.equal(result.described.id, 'InstalledZeroParameterCondition');
  assert.equal(calls[0].name, 'events.instructions.search');
  assert.equal(
    calls.some(item => item.name === 'events.instructions.describe'),
    true
  );
});

test('buildStructuredMutation derives a sprite payload from discovered/inspected structure metadata', () => {
  const structure = buildStructuredMutation({
    inspectedStructure: {
      kind: 'sprite',
      objectType: 'DynamicallyDiscoveredType',
      adaptCollisionMaskAutomatically: true,
      updateIfNotVisible: false,
      preScale: 2,
      animations: [],
    },
    resourceName: 'discovered-image.png',
  });
  assert.equal(structure.kind, 'sprite');
  assert.equal(structure.objectType, 'DynamicallyDiscoveredType');
  assert.equal(structure.preScale, 2);
  assert.equal(
    structure.animations[0].directions[0].frames[0].image,
    'discovered-image.png'
  );
  assert.equal(
    structure.animations[0].directions[0].frames[0].points[0].name,
    'BenchmarkPoint'
  );
});

test('CAP-25 scenario avoids hard-coded GDevelop model identifiers for discovered content', () => {
  const source = fs.readFileSync(
    path.join(__dirname, 'McpAutonomousBenchmarkLiveScenario.js'),
    'utf8'
  );
  for (const forbidden of [
    "object_type: 'Sprite'",
    "objectType: 'Sprite'",
    'TextObject::Text',
    'BuiltinCommonInstructions::Once',
    "type: { value: 'Create' }",
    'BuiltinExternalLayouts::CreateObjectsFromExternalLayout',
    "call('project.save', {\n      expectedRevision:",
  ]) {
    assert.equal(
      source.includes(forbidden),
      false,
      `benchmark should not hard-code ${forbidden}`
    );
  }
});
