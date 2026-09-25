const test = require('node:test');
const assert = require('node:assert/strict');
const {
  COMMON_QA_SIZES,
  createPreviewViewportService,
} = require('./PreviewViewportService');

const makeHarness = ({
  id = 7,
  width = 800,
  height = 600,
  minimized = false,
  maximized = false,
  fullScreen = false,
  visible = true,
  applyImmediately = true,
} = {}) => {
  let contentBounds = { x: 10, y: 20, width, height };
  let outerBounds = { x: 2, y: 3, width: width + 16, height: height + 39 };
  let state = { minimized, maximized, fullScreen, visible, focused: false };
  const calls = [];
  const targetWindow = {
    id,
    isDestroyed: () => false,
    getTitle: () => 'Preview of Test',
    webContents: { getURL: () => 'file:///preview/index.html' },
    getContentBounds: () => ({ ...contentBounds }),
    getBounds: () => ({ ...outerBounds }),
    isVisible: () => state.visible,
    isFocused: () => state.focused,
    isMinimized: () => state.minimized,
    isMaximized: () => state.maximized,
    isFullScreen: () => state.fullScreen,
    restore: () => {
      calls.push('restore');
      state.minimized = false;
    },
    unmaximize: () => {
      calls.push('unmaximize');
      state.maximized = false;
    },
    setFullScreen: value => {
      calls.push(['setFullScreen', value]);
      state.fullScreen = !!value;
    },
    showInactive: () => {
      calls.push('showInactive');
      state.visible = true;
    },
    focus: () => {
      calls.push('focus');
      state.focused = true;
    },
    setContentSize: (nextWidth, nextHeight, animate) => {
      calls.push(['setContentSize', nextWidth, nextHeight, animate]);
      if (applyImmediately) {
        contentBounds = {
          ...contentBounds,
          width: nextWidth,
          height: nextHeight,
        };
        outerBounds = {
          ...outerBounds,
          width: nextWidth + 16,
          height: nextHeight + 39,
        };
      }
    },
  };
  const BrowserWindow = {
    fromId: windowId => (Number(windowId) === id ? targetWindow : null),
  };
  const service = createPreviewViewportService({
    BrowserWindow,
    windowRegistry: { isRegistered: () => false },
    isRegisteredPreviewWindow: windowId => Number(windowId) === id,
  });
  return {
    service,
    calls,
    getState: () => ({ ...state, contentBounds: { ...contentBounds } }),
  };
};

test('advertises exact DIP viewport sizing and required QA presets', () => {
  const { service } = makeHarness();
  const capabilities = service.capabilities();
  assert.equal(capabilities.supported, true);
  assert.equal(capabilities.units, 'device-independent-pixels');
  assert.equal(capabilities.exactContentViewport, true);
  assert.equal(capabilities.callerChromeCompensationRequired, false);
  assert.deepEqual(COMMON_QA_SIZES, [
    { width: 1280, height: 720 },
    { width: 1366, height: 768 },
    { width: 1440, height: 900 },
    { width: 1600, height: 900 },
    { width: 1920, height: 1080 },
  ]);
});

test('sets the content viewport exactly without caller outer-window compensation', async () => {
  const { service, calls } = makeHarness({ width: 800, height: 600 });
  const result = await service.setViewport({
    previewWindowId: 7,
    width: 1366,
    height: 768,
  });
  assert.equal(result.exact, true);
  assert.deepEqual(result.requestedViewport, { width: 1366, height: 768 });
  assert.deepEqual(result.actualViewport, { width: 1366, height: 768 });
  assert.deepEqual(result.contentBounds, {
    x: 10,
    y: 20,
    width: 1366,
    height: 768,
  });
  assert.deepEqual(result.outerBounds, {
    x: 2,
    y: 3,
    width: 1382,
    height: 807,
  });
  assert.equal(result.callerCompensationRequired, false);
  assert.deepEqual(calls[0], ['setContentSize', 1366, 768, false]);
});

test('restores minimized/maximized/fullscreen/hidden previews before sizing', async () => {
  const { service, calls } = makeHarness({
    minimized: true,
    maximized: true,
    fullScreen: true,
    visible: false,
  });
  const result = await service.setViewport({
    previewWindowId: 7,
    width: 1280,
    height: 720,
    focus: true,
  });
  assert.equal(result.exact, true);
  assert.deepEqual(result.restoredFrom, {
    minimized: true,
    maximized: true,
    fullScreen: true,
    hidden: true,
  });
  assert.deepEqual(calls.slice(0, 4), [
    ['setFullScreen', false],
    'unmaximize',
    'restore',
    'showInactive',
  ]);
  assert.equal(calls.some(call => call === 'focus'), true);
});

test('returns structured blocked-state and apply-timeout diagnostics', async () => {
  const blocked = makeHarness({ minimized: true });
  await assert.rejects(
    blocked.service.setViewport({
      previewWindowId: 7,
      width: 1280,
      height: 720,
      restoreWindowState: false,
    }),
    error =>
      error &&
      error.code === 'preview_viewport_blocked_window_state' &&
      error.details.minimized === true
  );

  const stalled = makeHarness({ applyImmediately: false });
  await assert.rejects(
    stalled.service.setViewport({
      previewWindowId: 7,
      width: 1280,
      height: 720,
      timeoutMs: 0,
    }),
    error =>
      error &&
      error.code === 'preview_viewport_apply_timeout' &&
      error.details.requestedViewport.width === 1280 &&
      error.details.actualViewport.width === 800
  );
});

test('status preserves requested viewport separately from actual content bounds', async () => {
  const { service } = makeHarness();
  await service.setViewport({
    previewWindowId: 7,
    width: 1600,
    height: 900,
  });
  const status = service.status({ previewWindowId: 7 });
  assert.deepEqual(status.requestedViewport, { width: 1600, height: 900 });
  assert.deepEqual(status.actualViewport, { width: 1600, height: 900 });
  assert.equal(status.units, 'device-independent-pixels');
});
