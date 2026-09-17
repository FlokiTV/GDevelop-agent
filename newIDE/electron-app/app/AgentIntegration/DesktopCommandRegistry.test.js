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

test('executes windows, capture and preview input through injected services', async () => {
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
    previewInteractionService: {
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
