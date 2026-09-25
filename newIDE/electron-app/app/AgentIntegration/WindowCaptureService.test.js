const test = require('node:test');
const assert = require('node:assert/strict');
const {
  captureWindowPng,
  captureWindowPngDetailed,
  createWindowCaptureService,
} = require('./WindowCaptureService');

const pngImage = (buffer, size = { width: 800, height: 600 }) => ({
  getSize: () => size,
  resize: options =>
    pngImage(buffer, { width: options.width, height: options.height }),
  toPNG: () => buffer,
});

const makeWindow = ({
  id = 1,
  title = 'GDevelop',
  url = 'file:///preview/index.html',
  bounds = { x: 0, y: 0, width: 800, height: 600 },
  visible = true,
  focused = true,
  minimized = false,
  loading = false,
  capturePage,
} = {}) => ({
  id,
  isDestroyed: () => false,
  isVisible: () => visible,
  isFocused: () => focused,
  isMinimized: () => minimized,
  getTitle: () => title,
  getBounds: () => bounds,
  getContentBounds: () => bounds,
  getMediaSourceId: () => `window:${id}:0`,
  webContents: {
    getURL: () => url,
    isDestroyed: () => false,
    isLoading: () => loading,
    isLoadingMainFrame: () => loading,
    isCrashed: () => false,
    capturePage:
      capturePage || (async () => pngImage(Buffer.from('png'), bounds)),
  },
});

test('captureWindowPng uses desktopCapturer when capturePage is empty', async () => {
  const fallbackPng = Buffer.from('fallback-png');
  const targetWindow = makeWindow({
    id: 42,
    title: 'GDevelop',
    capturePage: async () => ({ toPNG: () => Buffer.alloc(0) }),
  });
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

test('captureWindowPng rejects oversized PNG responses immediately', async () => {
  const targetWindow = makeWindow({
    capturePage: async () => ({ toPNG: () => Buffer.alloc(32, 1) }),
  });
  await assert.rejects(
    captureWindowPng({
      targetWindow,
      desktopCapturer: null,
      maxCaptureBytes: 16,
    }),
    error =>
      error.code === 'window_capture_too_large' &&
      error.details.maxCaptureBytes === 16
  );
});

test('captureWindowPng forwards crop region and bounds output dimensions', async () => {
  const region = { x: 10, y: 20, width: 1000, height: 500 };
  const resizedPng = Buffer.from('resized-png');
  let receivedRegion = null;
  const targetWindow = makeWindow({
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
          return {
            getSize: () => ({ width: 400, height: 200 }),
            toPNG: () => resizedPng,
          };
        },
        toPNG: () => Buffer.from('full-size-png'),
      };
    },
  });

  const result = await captureWindowPngDetailed({
    targetWindow,
    desktopCapturer: null,
    region,
    maxWidth: 400,
    maxHeight: 400,
  });

  assert.deepEqual(receivedRegion, region);
  assert.equal(result.data, resizedPng);
  assert.deepEqual(result.sourceSize, { width: 1000, height: 500 });
  assert.deepEqual(result.outputSize, { width: 400, height: 200 });
  assert.equal(result.captureMethod, 'capturePage');
});

test('waits for loading content before the first capture attempt', async () => {
  let loading = true;
  let captures = 0;
  const targetWindow = makeWindow({
    capturePage: async () => {
      captures += 1;
      return pngImage(Buffer.from('ready-png'));
    },
  });
  targetWindow.webContents.isLoading = () => loading;
  targetWindow.webContents.isLoadingMainFrame = () => loading;
  setTimeout(() => {
    loading = false;
  }, 30);

  const result = await captureWindowPngDetailed({
    targetWindow,
    desktopCapturer: null,
    readyTimeoutMs: 250,
  });

  assert.equal(result.readiness.ready, true);
  assert.equal(result.readiness.reason, 'ready');
  assert.equal(captures, 1);
});

test('retries bounded empty captures and succeeds without hiding the attempts', async () => {
  let captureCount = 0;
  const targetWindow = makeWindow({
    capturePage: async () => {
      captureCount += 1;
      return captureCount === 1
        ? { toPNG: () => Buffer.alloc(0) }
        : pngImage(Buffer.from('second-attempt'));
    },
  });

  const result = await captureWindowPngDetailed({
    targetWindow,
    desktopCapturer: null,
    captureAttempts: 2,
    retryDelayMs: 0,
  });

  assert.equal(result.captureMethod, 'capturePage');
  assert.equal(result.attempts, 2);
  assert.equal(result.data.toString(), 'second-attempt');
});

test('persistent empty capture returns structured fallback diagnostics', async () => {
  const targetWindow = makeWindow({
    capturePage: async () => ({ toPNG: () => Buffer.alloc(0) }),
  });
  const desktopCapturer = {
    getSources: async () => [],
  };

  await assert.rejects(
    captureWindowPngDetailed({
      targetWindow,
      desktopCapturer,
      captureAttempts: 2,
      retryDelayMs: 0,
    }),
    error => {
      assert.equal(error.code, 'window_capture_empty');
      assert.equal(error.details.attempts, 2);
      assert.equal(error.details.reason, 'desktop_source_not_found');
      assert.equal(
        error.details.lastAttempt.fallback.reason,
        'desktop_source_not_found'
      );
      assert.equal(error.details.windowState.visible, true);
      return true;
    }
  );
});

test('minimized persistent capture reports minimized as the actionable reason', async () => {
  const targetWindow = makeWindow({
    minimized: true,
    capturePage: async () => ({ toPNG: () => Buffer.alloc(0) }),
  });

  await assert.rejects(
    captureWindowPngDetailed({
      targetWindow,
      desktopCapturer: null,
      captureAttempts: 1,
    }),
    error =>
      error.code === 'window_capture_empty' &&
      error.details.reason === 'window_minimized'
  );
});

test('capturePage remains authoritative for offscreen and multi-monitor bounds', async () => {
  const targetWindow = makeWindow({
    bounds: { x: -1600, y: 100, width: 1280, height: 720 },
    capturePage: async () =>
      pngImage(Buffer.from('offscreen-png'), { width: 1280, height: 720 }),
  });

  const result = await captureWindowPngDetailed({
    targetWindow,
    desktopCapturer: {
      getSources: async () => {
        throw new Error('fallback_should_not_run');
      },
    },
  });

  assert.equal(result.captureMethod, 'capturePage');
  assert.deepEqual(result.windowState.bounds, {
    x: -1600,
    y: 100,
    width: 1280,
    height: 720,
  });
  assert.deepEqual(result.outputSize, { width: 1280, height: 720 });
});

test('capture service lists semantic window metadata and captures by id', async () => {
  const png = Buffer.from('png');
  const editorWindow = makeWindow({
    id: 1,
    title: 'GDevelop',
    url: 'file:///editor/index.html',
    capturePage: async () => pngImage(png),
  });
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
      contentBounds: { x: 0, y: 0, width: 800, height: 600 },
      visible: true,
      focused: true,
      minimized: false,
      editorWindow: true,
      previewWindow: false,
      projectPath: 'C:/game.json',
    },
  ]);
  const captured = await service.capture({ windowId: 1 });
  assert.equal(captured.windowId, 1);
  assert.equal(captured.mimeType, 'image/png');
  assert.equal(captured.data, png);
  assert.equal(captured.captureMethod, 'capturePage');
  assert.equal(captured.attempts, 1);
  assert.deepEqual(captured.outputSize, { width: 800, height: 600 });
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
