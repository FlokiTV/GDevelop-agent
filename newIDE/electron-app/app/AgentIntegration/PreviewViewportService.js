const { isLikelyPreviewWindow } = require('./PreviewInputTools');

const MIN_VIEWPORT_SIZE = 64;
const MAX_VIEWPORT_SIZE = 8192;
const DEFAULT_APPLY_TIMEOUT_MS = 3000;
const APPLY_POLL_MS = 40;
const COMMON_QA_SIZES = Object.freeze([
  Object.freeze({ width: 1280, height: 720 }),
  Object.freeze({ width: 1366, height: 768 }),
  Object.freeze({ width: 1440, height: 900 }),
  Object.freeze({ width: 1600, height: 900 }),
  Object.freeze({ width: 1920, height: 1080 }),
]);

const sleep = milliseconds =>
  new Promise(resolve => setTimeout(resolve, milliseconds));

const makeError = (code, details) => {
  const error = new Error(code);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
};

const readBoolean = (target, method, fallback = null) => {
  if (!target || typeof target[method] !== 'function') return fallback;
  try {
    return !!target[method]();
  } catch (_) {
    return fallback;
  }
};

const readBounds = (target, method) => {
  if (!target || typeof target[method] !== 'function') return null;
  try {
    const bounds = target[method]();
    if (
      !bounds ||
      !Number.isFinite(bounds.x) ||
      !Number.isFinite(bounds.y) ||
      !Number.isFinite(bounds.width) ||
      !Number.isFinite(bounds.height)
    ) {
      return null;
    }
    return {
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
    };
  } catch (_) {
    return null;
  }
};

const normalizeDimension = (value, field) => {
  const number = Math.round(Number(value));
  if (
    !Number.isFinite(number) ||
    number < MIN_VIEWPORT_SIZE ||
    number > MAX_VIEWPORT_SIZE
  ) {
    throw makeError('invalid_preview_viewport_size', {
      field,
      value,
      minimum: MIN_VIEWPORT_SIZE,
      maximum: MAX_VIEWPORT_SIZE,
    });
  }
  return number;
};

const readRendererViewport = async targetWindow => {
  const webContents = targetWindow && targetWindow.webContents;
  if (!webContents || typeof webContents.executeJavaScript !== 'function') {
    return null;
  }
  try {
    const result = await webContents.executeJavaScript(
      '({ width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio })'
    );
    if (
      !result ||
      !Number.isFinite(result.width) ||
      !Number.isFinite(result.height)
    ) {
      return null;
    }
    return {
      width: Math.round(result.width),
      height: Math.round(result.height),
      devicePixelRatio: Number.isFinite(result.devicePixelRatio)
        ? result.devicePixelRatio
        : null,
    };
  } catch (_) {
    return null;
  }
};

const normalizeTimeout = value => {
  if (value == null) return DEFAULT_APPLY_TIMEOUT_MS;
  const number = Math.round(Number(value));
  if (!Number.isFinite(number) || number < 0 || number > 10000) {
    throw makeError('invalid_preview_viewport_timeout', {
      value,
      minimum: 0,
      maximum: 10000,
    });
  }
  return number;
};

const createPreviewViewportService = ({
  BrowserWindow,
  windowRegistry,
  isRegisteredPreviewWindow,
}) => {
  const requestedByWindow = new Map();
  const isEditorWindow = windowId => windowRegistry.isRegistered(windowId);
  const isPreviewWindow = window =>
    isLikelyPreviewWindow(window, isEditorWindow, isRegisteredPreviewWindow);

  const resolveWindow = previewWindowId => {
    const numericWindowId = Number(previewWindowId);
    if (!Number.isInteger(numericWindowId) || numericWindowId <= 0) {
      throw makeError('invalid_preview_window_id');
    }
    const targetWindow = BrowserWindow.fromId(numericWindowId);
    if (!isPreviewWindow(targetWindow)) {
      throw makeError('preview_window_not_found', {
        previewWindowId: numericWindowId,
      });
    }
    return targetWindow;
  };

  const getState = targetWindow => {
    const contentBounds = readBounds(targetWindow, 'getContentBounds');
    const outerBounds = readBounds(targetWindow, 'getBounds');
    return {
      previewWindowId: targetWindow.id,
      units: 'device-independent-pixels',
      requestedViewport: requestedByWindow.get(targetWindow.id) || null,
      actualViewport: contentBounds
        ? { width: contentBounds.width, height: contentBounds.height }
        : null,
      contentBounds,
      outerBounds,
      visible: readBoolean(targetWindow, 'isVisible', null),
      focused: readBoolean(targetWindow, 'isFocused', null),
      minimized: readBoolean(targetWindow, 'isMinimized', null),
      maximized: readBoolean(targetWindow, 'isMaximized', null),
      fullScreen: readBoolean(targetWindow, 'isFullScreen', null),
      callerCompensationRequired: false,
    };
  };

  const status = input => {
    const targetWindow = resolveWindow(input && input.previewWindowId);
    return getState(targetWindow);
  };

  const restoreBlockingState = (targetWindow, restoreWindowState) => {
    const before = getState(targetWindow);
    const blocked =
      before.minimized === true ||
      before.maximized === true ||
      before.fullScreen === true;
    if (blocked && restoreWindowState === false) {
      throw makeError('preview_viewport_blocked_window_state', {
        previewWindowId: targetWindow.id,
        minimized: before.minimized,
        maximized: before.maximized,
        fullScreen: before.fullScreen,
        hint: 'Retry with restoreWindowState=true.',
      });
    }

    const restoredFrom = {
      minimized: before.minimized === true,
      maximized: before.maximized === true,
      fullScreen: before.fullScreen === true,
      hidden: before.visible === false,
    };

    if (restoreWindowState !== false) {
      if (restoredFrom.fullScreen) {
        if (typeof targetWindow.setFullScreen !== 'function') {
          throw makeError('preview_viewport_fullscreen_restore_unsupported');
        }
        targetWindow.setFullScreen(false);
      }
      if (restoredFrom.maximized) {
        if (typeof targetWindow.unmaximize !== 'function') {
          throw makeError('preview_viewport_maximized_restore_unsupported');
        }
        targetWindow.unmaximize();
      }
      if (restoredFrom.minimized) {
        if (typeof targetWindow.restore !== 'function') {
          throw makeError('preview_viewport_minimized_restore_unsupported');
        }
        targetWindow.restore();
      }
      if (restoredFrom.hidden) {
        if (typeof targetWindow.showInactive === 'function') {
          targetWindow.showInactive();
        } else if (typeof targetWindow.show === 'function') {
          targetWindow.show();
        } else {
          throw makeError('preview_viewport_hidden_restore_unsupported');
        }
      }
    }

    return restoredFrom;
  };

  const setViewport = async input => {
    const targetWindow = resolveWindow(input && input.previewWindowId);
    if (
      typeof targetWindow.setContentSize !== 'function' ||
      typeof targetWindow.getContentBounds !== 'function'
    ) {
      throw makeError('preview_viewport_resize_unsupported', {
        previewWindowId: targetWindow.id,
      });
    }

    const width = normalizeDimension(input && input.width, 'width');
    const height = normalizeDimension(input && input.height, 'height');
    const timeoutMs = normalizeTimeout(input && input.timeoutMs);
    const waitUntilApplied =
      !input || input.waitUntilApplied === undefined
        ? true
        : input.waitUntilApplied === true;
    const restoreWindowState =
      !input || input.restoreWindowState === undefined
        ? true
        : input.restoreWindowState === true;
    const focus = !!(input && input.focus);
    const restoredFrom = restoreBlockingState(
      targetWindow,
      restoreWindowState
    );

    requestedByWindow.set(targetWindow.id, { width, height });
    targetWindow.setContentSize(width, height, false);
    if (focus && typeof targetWindow.focus === 'function') targetWindow.focus();

    const startedAt = Date.now();
    let state = getState(targetWindow);
    let rendererViewport = await readRendererViewport(targetWindow);
    const isExact = () =>
      !!state.actualViewport &&
      state.actualViewport.width === width &&
      state.actualViewport.height === height &&
      (!rendererViewport ||
        (rendererViewport.width === width &&
          rendererViewport.height === height));
    let exact = isExact();

    while (
      waitUntilApplied &&
      !exact &&
      Date.now() - startedAt < timeoutMs
    ) {
      await sleep(APPLY_POLL_MS);
      state = getState(targetWindow);
      rendererViewport = await readRendererViewport(targetWindow);
      exact = isExact();
    }

    const result = {
      ...state,
      requestedViewport: { width, height },
      rendererViewport,
      exact,
      applied: exact,
      waitUntilApplied,
      waitedMs: Date.now() - startedAt,
      restoredFrom,
      focusRequested: focus,
    };
    if (waitUntilApplied && !exact) {
      throw makeError('preview_viewport_apply_timeout', result);
    }
    return result;
  };

  const capabilities = () => ({
    supported: true,
    source: 'electron-browser-window-content-size',
    units: 'device-independent-pixels',
    minimum: {
      width: MIN_VIEWPORT_SIZE,
      height: MIN_VIEWPORT_SIZE,
    },
    maximum: {
      width: MAX_VIEWPORT_SIZE,
      height: MAX_VIEWPORT_SIZE,
    },
    commonQaSizes: COMMON_QA_SIZES,
    exactContentViewport: true,
    callerChromeCompensationRequired: false,
    waitUntilApplied: true,
    restoreWindowState: true,
    optionalFocus: true,
    offscreenPositionIndependent: true,
  });

  return {
    capabilities,
    status,
    setViewport,
  };
};

module.exports = {
  COMMON_QA_SIZES,
  MAX_VIEWPORT_SIZE,
  MIN_VIEWPORT_SIZE,
  createPreviewViewportService,
};
