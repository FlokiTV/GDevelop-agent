const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PREVIEW_LIFECYCLE_CHANNEL,
  createPreviewLifecycleIpc,
} = require('./PreviewLifecycleIpc');

const makeWindow = ({
  id,
  title,
  url,
  visible = true,
  focused = false,
  bounds = { x: 20, y: 30, width: 816, height: 639 },
  contentBounds = { x: 28, y: 61, width: 800, height: 600 },
  minimized = false,
  maximized = false,
  fullScreen = false,
}) => ({
  id,
  isDestroyed: () => false,
  isVisible: () => visible,
  isFocused: () => focused,
  isMinimized: () => minimized,
  isMaximized: () => maximized,
  isFullScreen: () => fullScreen,
  getBounds: () => ({ ...bounds }),
  getContentBounds: () => ({ ...contentBounds }),
  getTitle: () => title,
  webContents: { getURL: () => url },
});

test('lists preview windows and activates runtime identity without editor windows', async () => {
  const editorWindow = makeWindow({
    id: 1,
    title: 'GDevelop',
    url: 'file:///editor/index.html',
  });
  const previewWindow = makeWindow({
    id: 12,
    title: 'Preview of Lifecycle',
    url: 'file:///tmp/preview/index.html',
    focused: true,
  });
  const BrowserWindow = {
    getAllWindows: () => [editorWindow, previewWindow],
  };
  const handlers = new Map();
  const ipcMain = {
    handle: (channel, handler) => handlers.set(channel, handler),
    removeHandler: channel => handlers.delete(channel),
  };
  const calls = [];
  const bridge = createPreviewLifecycleIpc({
    BrowserWindow,
    ipcMain,
    windowRegistry: { isRegistered: id => Number(id) === 1 },
    isRegisteredPreviewWindow: id => Number(id) === 12,
    previewInteractionService: {
      getRuntimeStatus: async input => {
        calls.push(input);
        return {
          windowId: input.previewWindowId,
          installed: true,
          identity: {
            announced: true,
            windowId: input.previewWindowId,
          },
        };
      },
    },
  });

  const handler = handlers.get(PREVIEW_LIFECYCLE_CHANNEL);
  const response = await handler();
  assert.equal(response.ok, true);
  assert.deepEqual(response.data.windows.map(window => window.windowId), [12]);
  assert.deepEqual(response.data.windows[0], {
    windowId: 12,
    title: 'Preview of Lifecycle',
    url: 'file:///tmp/preview/index.html',
    visible: true,
    focused: true,
    destroyed: false,
    bounds: { x: 20, y: 30, width: 816, height: 639 },
    contentBounds: { x: 28, y: 61, width: 800, height: 600 },
    minimized: false,
    maximized: false,
    fullScreen: false,
  });
  assert.deepEqual(calls, [{ previewWindowId: 12 }]);
  assert.deepEqual(response.data.activated, [
    {
      windowId: 12,
      identity: { announced: true, windowId: 12 },
    },
  ]);

  bridge.dispose();
  assert.equal(handlers.has(PREVIEW_LIFECYCLE_CHANNEL), false);
});

test('keeps window visibility even when runtime identity is not ready', async () => {
  const previewWindow = makeWindow({
    id: 22,
    title: 'Preview attaching',
    url: 'file:///tmp/preview-22/index.html',
  });
  const handlers = new Map();
  const bridge = createPreviewLifecycleIpc({
    BrowserWindow: { getAllWindows: () => [previewWindow] },
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler),
      removeHandler: channel => handlers.delete(channel),
    },
    windowRegistry: { isRegistered: () => false },
    isRegisteredPreviewWindow: id => Number(id) === 22,
    previewInteractionService: {
      getRuntimeStatus: async () => {
        const error = new Error('preview runtime unavailable');
        error.code = 'preview_runtime_unavailable';
        throw error;
      },
    },
  });

  const response = await handlers.get(PREVIEW_LIFECYCLE_CHANNEL)();
  assert.equal(response.ok, true);
  assert.deepEqual(response.data.windows.map(window => window.windowId), [22]);
  assert.deepEqual(response.data.activated, [
    {
      windowId: 22,
      identity: {
        announced: false,
        windowId: 22,
        reason: 'preview_runtime_unavailable',
      },
    },
  ]);

  bridge.dispose();
});

test('filters preview lifecycle by requesting editor parent and exposes project association', async () => {
  const editorA = makeWindow({
    id: 1,
    title: 'Project A',
    url: 'file:///editor-a/index.html',
  });
  const editorB = makeWindow({
    id: 2,
    title: 'Project B',
    url: 'file:///editor-b/index.html',
  });
  const previewA = makeWindow({
    id: 12,
    title: 'Preview A',
    url: 'file:///preview-a/index.html',
  });
  const previewB = makeWindow({
    id: 22,
    title: 'Preview B',
    url: 'file:///preview-b/index.html',
  });
  const senderA = { id: 'sender-a' };
  const handlers = new Map();
  const bridge = createPreviewLifecycleIpc({
    BrowserWindow: {
      getAllWindows: () => [editorA, editorB, previewA, previewB],
      fromWebContents: sender => (sender === senderA ? editorA : null),
    },
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler),
      removeHandler: channel => handlers.delete(channel),
    },
    windowRegistry: {
      isRegistered: id => [1, 2].includes(Number(id)),
      getProjectPath: id =>
        Number(id) === 1 ? 'C:/games/a/game.json' : 'C:/games/b/game.json',
    },
    isRegisteredPreviewWindow: id => [12, 22].includes(Number(id)),
    getPreviewWindowParentId: id => (Number(id) === 12 ? 1 : 2),
    previewInteractionService: {
      getRuntimeStatus: async input => ({
        identity: { announced: true, windowId: input.previewWindowId },
      }),
    },
  });

  const response = await handlers.get(PREVIEW_LIFECYCLE_CHANNEL)({
    sender: senderA,
  });
  assert.equal(response.ok, true);
  assert.equal(response.data.parentEditorWindowId, 1);
  assert.equal(response.data.windows.length, 1);
  assert.deepEqual(response.data.windows[0], {
    windowId: 12,
    parentEditorWindowId: 1,
    projectPath: 'C:/games/a/game.json',
    title: 'Preview A',
    url: 'file:///preview-a/index.html',
    visible: true,
    focused: false,
    destroyed: false,
    bounds: { x: 20, y: 30, width: 816, height: 639 },
    contentBounds: { x: 28, y: 61, width: 800, height: 600 },
    minimized: false,
    maximized: false,
    fullScreen: false,
  });
  assert.deepEqual(response.data.activated, [
    {
      windowId: 12,
      parentEditorWindowId: 1,
      identity: { announced: true, windowId: 12 },
    },
  ]);

  bridge.dispose();
});
