const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DESCRIPTORS,
  createDesktopCommandRegistry,
} = require('./DesktopCommandRegistry');

test('lists deterministic desktop command descriptors without protocol metadata', () => {
  const registry = createDesktopCommandRegistry({
    windowCaptureService: {},
    previewInteractionService: {},
    previewQaService: {},
    multiplayerPreviewService: {},
  });
  const descriptors = registry.listDescriptors();

  assert.deepEqual(
    descriptors.map(descriptor => descriptor.name),
    DESCRIPTORS.map(descriptor => descriptor.name)
  );
  assert.equal(
    descriptors.some(descriptor => JSON.stringify(descriptor).includes('mcp')),
    false
  );
  assert.equal(registry.has('desktop.window.capture'), true);
  assert.equal(registry.has('project.status'), false);
});

test('desktop.window.capture advertises bounded readiness and retry controls', () => {
  const descriptor = DESCRIPTORS.find(
    candidate => candidate.name === 'desktop.window.capture'
  );
  assert.ok(descriptor);
  assert.deepEqual(descriptor.inputSchema.properties.captureAttempts, {
    type: 'integer',
    minimum: 1,
    maximum: 8,
    description:
      'Bounded capture attempts before returning a persistent empty-capture diagnostic.',
  });
  assert.equal(descriptor.inputSchema.properties.retryDelayMs.maximum, 2000);
  assert.equal(descriptor.inputSchema.properties.readyTimeoutMs.maximum, 10000);
});

test('preview.viewport.set advertises exact bounded content sizing', () => {
  const descriptor = DESCRIPTORS.find(
    candidate => candidate.name === 'preview.viewport.set'
  );
  assert.ok(descriptor);
  assert.deepEqual(descriptor.inputSchema.required, [
    'previewWindowId',
    'width',
    'height',
  ]);
  assert.equal(descriptor.inputSchema.properties.width.maximum, 8192);
  assert.equal(descriptor.inputSchema.properties.timeoutMs.maximum, 10000);
  assert.equal(descriptor.metadata.idempotent, true);
});

test('preview input exposes canonical deterministic inspect/interact schemas', () => {
  const inspect = DESCRIPTORS.find(
    candidate => candidate.name === 'preview.input.inspect'
  );
  const interact = DESCRIPTORS.find(
    candidate => candidate.name === 'preview.input.interact'
  );
  assert.ok(inspect);
  assert.ok(interact);
  assert.equal(inspect.metadata.readOnly, true);
  assert.equal(interact.metadata.longRunning, true);
  assert.deepEqual(interact.inputSchema.properties.action.enum, [
    'move',
    'hover',
    'press',
    'release',
    'click',
    'double-click',
    'drag',
  ]);
  assert.equal(
    interact.inputSchema.properties.target.properties.instanceId.type,
    'integer'
  );
  assert.equal(
    interact.inputSchema.properties.waitFor.properties.timeoutMs.maximum,
    10000
  );
  assert.deepEqual(interact.inputSchema.properties.coordinateSpace.enum, [
    'viewport',
    'scene',
  ]);
});

test('executes windows, viewport, capture and preview input through injected services', async () => {
  const calls = [];
  const registry = createDesktopCommandRegistry({
    windowCaptureService: {
      listWindows: () => [{ windowId: 1, editorWindow: true }],
      capture: async input => {
        calls.push(['capture', input]);
        return {
          windowId: Number(input.windowId),
          mimeType: 'image/png',
          data: Buffer.from('png-data'),
        };
      },
    },
    previewViewportService: {
      status: input => {
        calls.push(['viewportStatus', input]);
        return {
          previewWindowId: input.previewWindowId,
          actualViewport: { width: 800, height: 600 },
        };
      },
      setViewport: async input => {
        calls.push(['viewportSet', input]);
        return {
          previewWindowId: input.previewWindowId,
          requestedViewport: { width: input.width, height: input.height },
          actualViewport: { width: input.width, height: input.height },
          exact: true,
        };
      },
    },
    previewInteractionService: {
      inspect: async input => {
        calls.push(['inspect', input]);
        return {
          previewWindowId: input.previewWindowId,
          point: { x: 100, y: 120 },
        };
      },
      interact: async input => {
        calls.push(['interact', input]);
        return {
          previewWindowId: input.previewWindowId,
          action: input.action,
          dispatched: [],
        };
      },
      sendInput: input => {
        calls.push(['sendInput', input]);
        return { sent: true };
      },
      sendSequence: async input => {
        calls.push(['sendSequence', input]);
        return { sent: true, steps: input.steps.length };
      },
      resetInput: input => {
        calls.push(['resetInput', input]);
        return { reset: true };
      },
      sendTouch: input => {
        calls.push(['sendTouch', input]);
        return { sent: true };
      },
      sendGamepad: input => {
        calls.push(['sendGamepad', input]);
        return { sent: true };
      },
      getRuntimeStatus: input => {
        calls.push(['getRuntimeStatus', input]);
        return { installed: true };
      },
      resetRuntime: input => {
        calls.push(['resetRuntime', input]);
        return { reset: true };
      },
    },
    multiplayerPreviewService: {
      capabilities: () => ({ multiPreview: { supported: true } }),
      listClients: () => [{ windowId: 2, alias: 'host' }],
      assignAliases: input => {
        calls.push(['assignClients', input]);
        return { clients: input.clients };
      },
      runBatch: async input => {
        calls.push(['multiplayerBatch', input]);
        return { results: [] };
      },
      runtimeStatus: async input => {
        calls.push(['multiplayerStatus', input]);
        return { clients: [] };
      },
    },
    previewQaService: {
      capabilities: () => ({
        deterministicGameplay: { inputReplay: { supported: true } },
      }),
      startRecording: input => {
        calls.push(['recordStart', input]);
        return { recordingId: 'walk' };
      },
      sendAndRecord: input => {
        calls.push(['recordSend', input]);
        return { sent: true };
      },
      stopRecording: input => {
        calls.push(['recordStop', input]);
        return { recordingId: 'walk', steps: [] };
      },
      replay: async input => {
        calls.push(['replay', input]);
        return { sent: true, steps: 1 };
      },
      captureBaseline: async input => {
        calls.push(['baselineCapture', input]);
        return { baselineId: input.baselineId, sha256: 'abc' };
      },
      compareBaseline: async input => {
        calls.push(['baselineCompare', input]);
        return { baselineId: input.baselineId, passed: true };
      },
    },
  });

  const windows = await registry.execute({
    command: 'desktop.windows.list',
    input: {},
  });
  assert.equal(windows.data[0].windowId, 1);
  assert.equal(windows.meta.readOnly, true);

  const capture = await registry.execute({
    command: 'desktop.window.capture',
    input: { windowId: 9 },
  });
  assert.equal(capture.data.windowId, 9);
  assert.equal(capture.data.mimeType, 'image/png');
  assert.deepEqual(capture.data.imageBuffer, Buffer.from('png-data'));

  const viewportStatus = await registry.execute({
    command: 'preview.viewport.status',
    input: { previewWindowId: 2 },
  });
  assert.deepEqual(viewportStatus.data.actualViewport, {
    width: 800,
    height: 600,
  });
  const viewportSet = await registry.execute({
    command: 'preview.viewport.set',
    input: { previewWindowId: 2, width: 1280, height: 720 },
  });
  assert.equal(viewportSet.data.exact, true);

  await registry.execute({
    command: 'preview.input.send',
    input: { previewWindowId: 2, event: { type: 'keyDown', keyCode: 'W' } },
  });
  await registry.execute({
    command: 'preview.input.sequence',
    input: {
      previewWindowId: 2,
      steps: [{ event: { type: 'keyDown', keyCode: 'W' } }],
    },
  });
  await registry.execute({
    command: 'preview.input.reset',
    input: { previewWindowId: 2 },
  });
  await registry.execute({
    command: 'preview.input.touch',
    input: { previewWindowId: 2, action: 'start', x: 10, y: 20 },
  });
  await registry.execute({
    command: 'preview.input.gamepad',
    input: { previewWindowId: 2, action: 'connect' },
  });
  await registry.execute({
    command: 'preview.input.runtime-status',
    input: { previewWindowId: 2 },
  });
  await registry.execute({
    command: 'preview.input.runtime-reset',
    input: { previewWindowId: 2 },
  });
  const capabilities = await registry.execute({
    command: 'preview.qa.capabilities',
    input: {},
  });
  assert.equal(
    capabilities.data.deterministicGameplay.inputReplay.supported,
    true
  );
  await registry.execute({
    command: 'preview.input.record.start',
    input: { previewWindowId: 2, recordingId: 'walk' },
  });
  await registry.execute({
    command: 'preview.input.record.send',
    input: { previewWindowId: 2, event: { type: 'keyDown', keyCode: 'W' } },
  });
  await registry.execute({
    command: 'preview.input.record.stop',
    input: { recordingId: 'walk' },
  });
  await registry.execute({
    command: 'preview.input.replay',
    input: { previewWindowId: 2, recordingId: 'walk' },
  });
  await registry.execute({
    command: 'preview.visual.baseline.capture',
    input: { previewWindowId: 2, baselineId: 'menu' },
  });
  await registry.execute({
    command: 'preview.visual.baseline.compare',
    input: { previewWindowId: 2, baselineId: 'menu' },
  });
  const multiplayerCapabilities = await registry.execute({
    command: 'preview.multiplayer.capabilities',
    input: {},
  });
  assert.equal(multiplayerCapabilities.data.multiPreview.supported, true);
  const clients = await registry.execute({
    command: 'preview.multiplayer.clients.list',
    input: {},
  });
  assert.equal(clients.data[0].alias, 'host');
  await registry.execute({
    command: 'preview.multiplayer.clients.assign',
    input: { clients: [{ alias: 'host', previewWindowId: 2 }] },
  });
  await registry.execute({
    command: 'preview.multiplayer.batch',
    input: { actions: [{ alias: 'host', operation: 'runtime-status' }] },
  });
  await registry.execute({
    command: 'preview.multiplayer.runtime-status',
    input: { aliases: ['host'] },
  });

  assert.deepEqual(calls.map(call => call[0]), [
    'capture',
    'viewportStatus',
    'viewportSet',
    'sendInput',
    'sendSequence',
    'resetInput',
    'sendTouch',
    'sendGamepad',
    'getRuntimeStatus',
    'resetRuntime',
    'recordStart',
    'recordSend',
    'recordStop',
    'replay',
    'baselineCapture',
    'baselineCompare',
    'assignClients',
    'multiplayerBatch',
    'multiplayerStatus',
  ]);
});

test('rejects unknown desktop commands', async () => {
  const registry = createDesktopCommandRegistry({
    windowCaptureService: {},
    previewInteractionService: {},
    previewQaService: {},
    multiplayerPreviewService: {},
  });
  await assert.rejects(
    registry.execute({ command: 'desktop.missing', input: {} }),
    error => error && error.code === 'desktop_command_not_found'
  );
});

test('routes managed temp workspace commands with caller identity metadata', async () => {
  const calls = [];
  const identity = {
    clientId: 'client-a',
    agentId: 'agent-a',
    sessionId: 'session-a',
    taskId: 'task-a',
    ownerKey: 'agent-a::session-a',
  };
  const managedTempWorkspaceService = {
    capabilities: () => ({ supported: true, ownerBoundToCallerIdentity: true }),
    create: (input, requestContext) => {
      calls.push(['create', input, requestContext]);
      return {
        created: true,
        namespace: {
          namespaceId: 'ns-a',
          ownerKey: requestContext.identity.ownerKey,
        },
      };
    },
    status: (input, requestContext) => {
      calls.push(['status', input, requestContext]);
      return { namespaces: [] };
    },
    heartbeat: (input, requestContext) => {
      calls.push(['heartbeat', input, requestContext]);
      return { namespace: { namespaceId: input.namespaceId } };
    },
    write: (input, requestContext) => {
      calls.push(['write', input, requestContext]);
      return { written: true, relativePath: input.relativePath };
    },
    read: (input, requestContext) => {
      calls.push(['read', input, requestContext]);
      return { content: 'a', relativePath: input.relativePath };
    },
    list: (input, requestContext) => {
      calls.push(['list', input, requestContext]);
      return { entries: [] };
    },
    release: (input, requestContext) => {
      calls.push(['release', input, requestContext]);
      return { released: true, namespaceId: input.namespaceId };
    },
  };
  const registry = createDesktopCommandRegistry({
    windowCaptureService: {},
    managedTempWorkspaceService,
    previewInteractionService: {},
    previewViewportService: {},
    previewQaService: {},
    multiplayerPreviewService: {},
    previewNetworkDiagnosticsService: {},
  });

  const createDescriptor = DESCRIPTORS.find(
    descriptor => descriptor.name === 'agent.workspace.temp.create'
  );
  assert.ok(createDescriptor);
  assert.equal(registry.has('agent.workspace.temp.write'), true);
  assert.equal(
    DESCRIPTORS.find(
      descriptor => descriptor.name === 'agent.workspace.temp.write'
    ).inputSchema.properties.overwrite.type,
    'boolean'
  );

  const requestContext = { identity, traceId: 'trace-temp' };
  const created = await registry.execute({
    command: 'agent.workspace.temp.create',
    input: { purpose: 'helper' },
    requestContext,
  });
  assert.equal(created.data.namespace.ownerKey, identity.ownerKey);
  assert.deepEqual(created.meta.identity, identity);

  await registry.execute({
    command: 'agent.workspace.temp.write',
    input: {
      namespaceId: 'ns-a',
      relativePath: 'scripts/helper.js',
      content: 'a',
    },
    requestContext,
  });
  await registry.execute({
    command: 'agent.workspace.temp.read',
    input: { namespaceId: 'ns-a', relativePath: 'scripts/helper.js' },
    requestContext,
  });
  await registry.execute({
    command: 'agent.workspace.temp.release',
    input: { namespaceId: 'ns-a' },
    requestContext,
  });

  assert.deepEqual(calls.map(call => call[0]), [
    'create',
    'write',
    'read',
    'release',
  ]);
  calls.forEach(call => assert.deepEqual(call[2].identity, identity));
});
