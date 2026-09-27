const assert = require('node:assert/strict');
const test = require('node:test');
const {
  DESCRIPTORS,
  createDesktopCommandRegistry,
} = require('./DesktopCommandRegistry');

const findDescriptor = name =>
  DESCRIPTORS.find(descriptor => descriptor.name === name);

test('publishes typed discoverable runtime layout commands', () => {
  const capabilities = findDescriptor('preview.layout.capabilities');
  const inspect = findDescriptor('preview.layout.inspect');
  const layoutAssert = findDescriptor('preview.layout.assert');
  const capture = findDescriptor('preview.capture.region');

  assert.ok(capabilities);
  assert.ok(inspect);
  assert.ok(layoutAssert);
  assert.ok(capture);

  assert.equal(capabilities.metadata.readOnly, true);
  assert.equal(inspect.metadata.idempotent, true);
  assert.deepEqual(inspect.inputSchema.required, [
    'previewWindowId',
    'targets',
  ]);
  assert.equal(
    inspect.inputSchema.properties.targets.items.properties.kind.enum.includes(
      'layer'
    ),
    true
  );
  assert.equal(
    layoutAssert.inputSchema.properties.assertions.items.properties.type.enum.includes(
      'text-fit'
    ),
    true
  );
  assert.equal(
    layoutAssert.inputSchema.properties.assertions.items.properties.type.enum.includes(
      'safe-area'
    ),
    true
  );
  assert.ok(capture.inputSchema.properties.target);
  assert.ok(capture.inputSchema.properties.region);
  assert.equal(capture.metadata.readOnly, true);
  assert.equal(capture.metadata.longRunning, true);
});

test('routes layout inspect/assert/capture through PreviewLayoutService with canonical desktop result shape', async () => {
  const calls = [];
  const previewLayoutService = {
    capabilities: () => ({ version: 1 }),
    inspect: input => {
      calls.push(['inspect', input]);
      return { previewWindowId: input.previewWindowId, targets: [] };
    },
    assert: input => {
      calls.push(['assert', input]);
      return { previewWindowId: input.previewWindowId, passed: true };
    },
    captureRegion: input => {
      calls.push(['capture', input]);
      return {
        previewWindowId: input.previewWindowId,
        actualRegion: { x: 1, y: 2, width: 3, height: 4 },
        imageBuffer: Buffer.from('png'),
      };
    },
  };
  const registry = createDesktopCommandRegistry({
    windowCaptureService: {},
    managedTempWorkspaceService: {},
    previewInteractionService: {},
    previewViewportService: {},
    previewQaService: {},
    previewLayoutService,
    multiplayerPreviewService: {},
    previewNetworkDiagnosticsService: {},
  });

  const capabilityResult = await registry.execute({
    command: 'preview.layout.capabilities',
    requestContext: { identity: { agentId: 'test-agent' } },
  });
  assert.equal(capabilityResult.data.version, 1);
  assert.equal(capabilityResult.meta.readOnly, true);
  assert.equal(capabilityResult.meta.identity.agentId, 'test-agent');

  const inspectResult = await registry.execute({
    command: 'preview.layout.inspect',
    input: {
      previewWindowId: 11,
      targets: [{ id: 'button', objectName: 'Button' }],
    },
  });
  assert.equal(inspectResult.command, 'preview.layout.inspect');
  assert.equal(inspectResult.data.previewWindowId, 11);

  const assertResult = await registry.execute({
    command: 'preview.layout.assert',
    input: {
      previewWindowId: 11,
      targets: [{ id: 'button', objectName: 'Button' }],
      assertions: [{ type: 'visible', targets: ['button'] }],
    },
  });
  assert.equal(assertResult.data.passed, true);

  const captureResult = await registry.execute({
    command: 'preview.capture.region',
    input: {
      previewWindowId: 11,
      target: { objectName: 'Button' },
    },
  });
  assert.deepEqual(captureResult.data.actualRegion, {
    x: 1,
    y: 2,
    width: 3,
    height: 4,
  });
  assert.ok(Buffer.isBuffer(captureResult.data.imageBuffer));
  assert.deepEqual(calls.map(([kind]) => kind), [
    'inspect',
    'assert',
    'capture',
  ]);
});
