const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PREVIEW_RUNTIME_SNAPSHOT_CHANNEL,
  createPreviewRuntimeSnapshotIpc,
} = require('./PreviewRuntimeSnapshotIpc');

const makeWindow = ({ id, title, url, focused = false }) => ({
  id,
  isDestroyed: () => false,
  isFocused: () => focused,
  getTitle: () => title,
  webContents: { getURL: () => url },
});

test('selects the unique preview and proxies a bounded snapshot', async () => {
  const editorWindow = makeWindow({
    id: 1,
    title: 'GDevelop',
    url: 'file:///editor/index.html',
  });
  const previewWindow = makeWindow({
    id: 2,
    title: 'Preview of Test',
    url: 'file:///tmp/preview/index.html',
  });
  const windows = new Map([[1, editorWindow], [2, previewWindow]]);
  const BrowserWindow = {
    fromId: id => windows.get(Number(id)) || null,
    getFocusedWindow: () => editorWindow,
    getAllWindows: () => Array.from(windows.values()),
  };
  const handlers = new Map();
  const ipcMain = {
    handle: (channel, handler) => handlers.set(channel, handler),
    removeHandler: channel => handlers.delete(channel),
  };
  const calls = [];
  const bridge = createPreviewRuntimeSnapshotIpc({
    BrowserWindow,
    ipcMain,
    windowRegistry: { isRegistered: id => Number(id) === 1 },
    isRegisteredPreviewWindow: id => Number(id) === 2,
    previewInteractionService: {
      getRuntimeSnapshot: async input => {
        calls.push(input);
        return {
          previewWindowId: input.previewWindowId,
          snapshotSource: 'bounded-preview-runtime',
          scene: { name: 'Scene' },
        };
      },
    },
  });

  const handler = handlers.get(PREVIEW_RUNTIME_SNAPSHOT_CHANNEL);
  const response = await handler({}, { maxInstances: 12 });
  assert.equal(response.ok, true);
  assert.equal(response.data.previewWindowId, 2);
  assert.deepEqual(calls, [{ maxInstances: 12, previewWindowId: 2 }]);

  bridge.dispose();
  assert.equal(handlers.has(PREVIEW_RUNTIME_SNAPSHOT_CHANNEL), false);
});

test('requires explicit targeting when multiple previews are available', async () => {
  const previews = [2, 3].map(id =>
    makeWindow({
      id,
      title: `Preview of Test ${id}`,
      url: `file:///tmp/preview-${id}/index.html`,
    })
  );
  const BrowserWindow = {
    fromId: id => previews.find(window => window.id === Number(id)) || null,
    getFocusedWindow: () => null,
    getAllWindows: () => previews,
  };
  const handlers = new Map();
  const ipcMain = {
    handle: (channel, handler) => handlers.set(channel, handler),
    removeHandler: channel => handlers.delete(channel),
  };
  const bridge = createPreviewRuntimeSnapshotIpc({
    BrowserWindow,
    ipcMain,
    windowRegistry: { isRegistered: () => false },
    isRegisteredPreviewWindow: id => [2, 3].includes(Number(id)),
    previewInteractionService: {
      getRuntimeSnapshot: async input => ({
        previewWindowId: input.previewWindowId,
      }),
    },
  });

  const handler = handlers.get(PREVIEW_RUNTIME_SNAPSHOT_CHANNEL);
  const ambiguous = await handler({}, {});
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.error.code, 'preview_window_ambiguous');
  assert.deepEqual(ambiguous.error.details.previewWindowIds, [2, 3]);

  const explicit = await handler({}, { previewWindowId: 3, maxInstances: 1 });
  assert.equal(explicit.ok, true);
  assert.equal(explicit.data.previewWindowId, 3);
  bridge.dispose();
});
