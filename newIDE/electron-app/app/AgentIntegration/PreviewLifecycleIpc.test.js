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
