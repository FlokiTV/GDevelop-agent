const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  REQUIRED_TOOLS,
  VIEWPORT,
  buildCameraActionParameters,
  deriveEffectPropertyValue,
  isDisposableAcceptanceFixture,
} = require('./McpLayerVisualCleanRoomLiveScenario');

test('DX-32 live runner requires typed layer visual, camera, effect, runtime and QA surfaces', () => {
  const required = [
    'scene.layers.visual.capabilities',
    'scene.layers.visual.inspect',
    'scene.layers.camera.update',
    'scene.layers.effects.add',
    'scene.layers.effects.update',
    'scene.layers.effects.reorder',
    'scene.layers.effects.remove',
    'editor.types.effects.list',
    'editor.types.effects.describe',
    'events.instructions.search',
    'events.instructions.describe',
    'runtime.snapshot',
    'preview.viewport.set',
    'preview.visual.baseline.capture',
    'preview.visual.baseline.compare',
    'safety.transactions.rollback',
  ];
  for (const name of required) {
    assert.ok(REQUIRED_TOOLS.includes(name), 'missing:' + name);
  }
});

test('DX-32 live runner uses a deterministic content viewport', () => {
  assert.deepEqual(VIEWPORT, { width: 640, height: 360 });
});

test('DX-32 live runner tool contract is duplicate-free', () => {
  assert.equal(new Set(REQUIRED_TOOLS).size, REQUIRED_TOOLS.length);
});

test('DX-32 cleanup only recognizes its own temporary acceptance fixture', () => {
  const fixtureFile = path.join(
    os.tmpdir(),
    'gdevelop-dx32-layer-visual-residual',
    'project',
    'game.json'
  );
  assert.equal(
    isDisposableAcceptanceFixture({
      projectOpen: true,
      projectName: 'DX32 Layer Visual Acceptance',
      fileIdentifier: fixtureFile,
    }),
    true
  );
  assert.equal(
    isDisposableAcceptanceFixture({
      projectOpen: true,
      projectName: 'Another Project',
      fileIdentifier: fixtureFile,
    }),
    false
  );
  assert.equal(
    isDisposableAcceptanceFixture({
      projectOpen: true,
      projectName: 'DX32 Layer Visual Acceptance',
      fileIdentifier: path.join(process.cwd(), 'game.json'),
    }),
    false
  );
});

test('DX-32 effect values are derived from discovered property schema', () => {
  assert.equal(
    deriveEffectPropertyValue({
      name: 'opacity',
      type: 'Number',
      defaultValue: '1',
      choices: [],
    }),
    0.65
  );
  assert.equal(
    deriveEffectPropertyValue({
      name: 'enabled',
      type: 'Boolean',
      defaultValue: 'false',
      choices: [],
    }),
    true
  );
  assert.equal(
    deriveEffectPropertyValue({
      name: 'mode',
      type: 'String',
      defaultValue: 'normal',
      choices: [{ value: 'normal' }, { value: 'strong' }],
    }),
    'strong'
  );
});

test('DX-32 camera action parameters are derived from live metadata including code-only slots', () => {
  const setCenter = {
    id: 'SetCameraCenterX',
    parameters: [
      { index: 0, codeOnly: true, type: 'currentScene' },
      { index: 1, type: 'operator', name: 'operator' },
      {
        index: 2,
        type: 'expression',
        valueType: { number: true },
        description: 'Value',
      },
      { index: 3, type: 'layer', name: 'layer' },
      {
        index: 4,
        type: 'expression',
        valueType: { number: true },
        description: 'Camera number (default : 0)',
      },
    ],
  };
  assert.deepEqual(
    buildCameraActionParameters({
      instruction: setCenter,
      layerName: 'Gameplay',
      value: 123,
    }),
    ['', '=', '123', '"Gameplay"', '0']
  );

  const zoom = {
    id: 'ZoomCamera',
    parameters: [
      { index: 0, codeOnly: true, type: 'currentScene' },
      {
        index: 1,
        type: 'expression',
        valueType: { number: true },
        description: 'Value',
      },
      { index: 2, type: 'layer', name: 'layer' },
      {
        index: 3,
        type: 'expression',
        valueType: { number: true },
        description: 'Camera number (default : 0)',
      },
    ],
  };
  assert.deepEqual(
    buildCameraActionParameters({
      instruction: zoom,
      layerName: 'Gameplay',
      value: 1.5,
    }),
    ['', '1.5', '"Gameplay"', '0']
  );
});
