const test = require('node:test');
const assert = require('node:assert/strict');
const {
  captureWindowPng,
  createWindowCaptureService,
} = require('./WindowCaptureService');

test('captureWindowPng uses desktopCapturer when capturePage is empty', async () => {
  const fallbackPng = Buffer.from('fallback-png');
  const targetWindow = {
    webContents: {
      capturePage: async () => ({ toPNG: () => Buffer.alloc(0) }),
    },
    getBounds: () => ({ width: 800, height: 600 }),
    getMediaSourceId: () => 'window:42:0',
    getTitle: () => 'GDevelop',
  };
  const desktopCapturer = {
    getSources: async options => {
      assert.deepEqual(options, {
        types: ['window'],
        thumbnailSize: { width: 800, height: 600 },
        fetchWindowIcons: false,
      });
      return [
        {
          id: 'window:42:0',
          name: 'GDevelop',
          thumbnail: { toPNG: () => fallbackPng },
        },
      ];
    },
  };
  assert.equal(
    await captureWindowPng({ targetWindow, desktopCapturer }),
    fallbackPng
  );
});

test('captureWindowPng rejects oversized PNG responses', async () => {
  const targetWindow = {
    webContents: {
      capturePage: async () => ({ toPNG: () => Buffer.alloc(32, 1) }),
    },
  };
  await assert.rejects(
    captureWindowPng({
      targetWindow,
      desktopCapturer: null,
      maxCaptureBytes: 16,
    }),
    error => error.code === 'window_capture_too_large'
  );
});

test('captureWindowPng forwards crop region and bounds output dimensions', async () => {
  const region = { x: 10, y: 20, width: 1000, height: 500 };
  const resizedPng = Buffer.from('resized-png');
  let receivedRegion = null;
  const targetWindow = {
    webContents: {
      capturePage: async requestedRegion => {
        receivedRegion = requestedRegion;
        return {
          getSize: () => ({ width: 1000, height: 500 }),
          resize: options => {
            assert.deepEqual(options, {
              width: 400,
              height: 200,
              quality: 'good',
            });
            return { toPNG: () => resizedPng };
          },
          toPNG: () => Buffer.from('full-size-png'),
        };
      },
    },
  };

  const result = await captureWindowPng({
    targetWindow,
    desktopCapturer: null,
    region,
    maxWidth: 400,
    maxHeight: 400,
  });

  assert.deepEqual(receivedRegion, region);
  assert.equal(result, resizedPng);
});

test('capture service lists semantic window metadata and captures by id', async () => {
  const png = Buffer.from('png');
  const editorWindow = {
    id: 1,
    isDestroyed: () => false,
    getTitle: () => 'GDevelop',
    getBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
    isVisible: () => true,
    isFocused: () => true,
    webContents: {
      getURL: () => 'file:///editor/index.html',
      capturePage: async () => ({ toPNG: () => png }),
    },
  };
  const BrowserWindow = {
    getAllWindows: () => [editorWindow],
    fromId: id => (Number(id) === 1 ? editorWindow : null),
    getFocusedWindow: () => editorWindow,
  };
  const windowRegistry = {
    prune: () => {},
    isRegistered: id => id === 1,
    getProjectPath: () => 'C:/game.json',
  };
  const service = createWindowCaptureService({
    BrowserWindow,
    desktopCapturer: null,
    windowRegistry,
    isRegisteredPreviewWindow: () => false,
  });
  assert.deepEqual(service.listWindows(), [
    {
      windowId: 1,
      title: 'GDevelop',
      url: 'file:///editor/index.html',
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      visible: true,
      focused: true,
      editorWindow: true,
      previewWindow: false,
      projectPath: 'C:/game.json',
    },
  ]);
  const captured = await service.capture({ windowId: 1 });
  assert.equal(captured.windowId, 1);
  assert.equal(captured.mimeType, 'image/png');
  assert.equal(captured.data, png);
});

test('capture service rejects missing windows', async () => {
  const service = createWindowCaptureService({
    BrowserWindow: {
      getAllWindows: () => [],
      fromId: () => null,
      getFocusedWindow: () => null,
    },
    desktopCapturer: null,
    windowRegistry: {
      prune: () => {},
      isRegistered: () => false,
      getProjectPath: () => null,
    },
    isRegisteredPreviewWindow: () => false,
  });
  await assert.rejects(
    service.capture({ windowId: 99 }),
    error => error.code === 'window_not_found'
  );
});
