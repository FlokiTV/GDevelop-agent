const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createMultiplayerPreviewService,
} = require('./MultiplayerPreviewService');

const makeWindow = id => ({
  id,
  isDestroyed: () => false,
  getTitle: () => `Preview ${id}`,
  isFocused: () => id === 2,
  isVisible: () => true,
  webContents: { getURL: () => `file:///preview-${id}/index.html` },
});

const makeService = () => {
  const windows = [makeWindow(2), makeWindow(3), makeWindow(9)];
  const calls = [];
  const service = createMultiplayerPreviewService({
    BrowserWindow: { getAllWindows: () => windows },
    isRegisteredPreviewWindow: id => id === 2 || id === 3,
    previewInteractionService: {
      sendInput: input => {
        calls.push(['input', input]);
        return { sent: true };
      },
      sendSequence: input => {
        calls.push(['sequence', input]);
        return { sent: true, steps: input.steps.length };
      },
      getRuntimeStatus: input => {
        calls.push(['status', input]);
        return { installed: true, windowId: input.previewWindowId };
      },
      resetRuntime: input => {
        calls.push(['reset', input]);
        return { reset: true };
      },
    },
  });
  return { service, calls };
};

test('discovers live previews and exposes truthful capabilities', () => {
  const { service } = makeService();
  assert.deepEqual(service.listClients().map(client => client.windowId), [
    2,
    3,
  ]);
  const capabilities = service.capabilities();
  assert.equal(capabilities.multiPreview.supported, true);
  assert.equal(capabilities.networkObservability.supported, true);
  assert.equal(capabilities.networkShaping.supported, false);
});

test('assigns stable aliases and rejects duplicate clients', () => {
  const { service } = makeService();
  const assigned = service.assignAliases({
    clients: [
      { alias: 'host', previewWindowId: 2 },
      { alias: 'guest', previewWindowId: 3 },
    ],
  });
  assert.deepEqual(
    assigned.clients.map(client => [client.alias, client.windowId]),
    [['host', 2], ['guest', 3]]
  );
  assert.deepEqual(service.resolveAlias('guest'), {
    alias: 'guest',
    previewWindowId: 3,
  });
  assert.throws(
    () =>
      service.assignAliases({
        clients: [
          { alias: 'same', previewWindowId: 2 },
          { alias: 'same', previewWindowId: 3 },
        ],
      }),
    /duplicate_preview_client/
  );
});

test('coordinates input and runtime assertions by alias', async () => {
  const { service, calls } = makeService();
  service.assignAliases({
    clients: [
      { alias: 'host', previewWindowId: 2 },
      { alias: 'guest', previewWindowId: 3 },
    ],
  });
  const batch = await service.runBatch({
    actions: [
      {
        alias: 'host',
        operation: 'input',
        event: { type: 'keyDown', keyCode: 'A' },
      },
      { alias: 'guest', operation: 'runtime-status' },
    ],
  });
  assert.equal(batch.results.length, 2);
  assert.deepEqual(calls.map(call => call[0]), ['input', 'status']);

  const status = await service.runtimeStatus({ aliases: ['host', 'guest'] });
  assert.deepEqual(
    status.clients.map(client => [client.alias, client.runtime.windowId]),
    [['host', 2], ['guest', 3]]
  );
});
