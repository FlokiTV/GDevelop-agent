const DEFAULT_MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
const DEFAULT_CAPTURE_ATTEMPTS = 4;
const DEFAULT_RETRY_DELAY_MS = 120;
const DEFAULT_READY_TIMEOUT_MS = 2500;
const READY_POLL_MS = 50;

const sleep = milliseconds =>
  new Promise(resolve => setTimeout(resolve, milliseconds));

const makeError = (code, details) => {
  const error = new Error(code);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
};

const getImageSize = image => {
  if (!image || typeof image.getSize !== 'function') return null;
  const size = image.getSize();
  if (!size || !Number.isFinite(size.width) || !Number.isFinite(size.height))
    return null;
  return { width: size.width, height: size.height };
};

const resizeNativeImage = (image, maxWidth, maxHeight) => {
  if (
    !image ||
    typeof image.getSize !== 'function' ||
    typeof image.resize !== 'function' ||
    (!maxWidth && !maxHeight)
  ) {
    return image;
  }
  const size = image.getSize();
  if (!size || !size.width || !size.height) return image;
  const widthScale = maxWidth ? maxWidth / size.width : 1;
  const heightScale = maxHeight ? maxHeight / size.height : 1;
  const scale = Math.min(1, widthScale, heightScale);
  if (scale >= 1) return image;
  return image.resize({
    width: Math.max(1, Math.floor(size.width * scale)),
    height: Math.max(1, Math.floor(size.height * scale)),
    quality: 'good',
  });
};

const readBoolean = (target, method, fallback = null) => {
  if (!target || typeof target[method] !== 'function') return fallback;
  try {
    return !!target[method]();
  } catch (_) {
    return fallback;
  }
};

const readValue = (target, method, fallback = null) => {
  if (!target || typeof target[method] !== 'function') return fallback;
  try {
    const value = target[method]();
    return value == null ? fallback : value;
  } catch (_) {
    return fallback;
  }
};

const getWindowState = targetWindow => {
  const webContents = targetWindow && targetWindow.webContents;
  const bounds = readValue(targetWindow, 'getBounds', null);
  const contentBounds = readValue(targetWindow, 'getContentBounds', null);
  const url =
    webContents && typeof webContents.getURL === 'function'
      ? readValue(webContents, 'getURL', '') || ''
      : null;
  const webContentsDestroyed = readBoolean(webContents, 'isDestroyed', false);
  const loading = webContentsDestroyed
    ? false
    : readBoolean(webContents, 'isLoading', false);
  const loadingMainFrame = webContentsDestroyed
    ? false
    : readBoolean(webContents, 'isLoadingMainFrame', false);
  const crashed = webContentsDestroyed
    ? false
    : readBoolean(webContents, 'isCrashed', false);

  return {
    windowId:
      targetWindow && Number.isInteger(targetWindow.id)
        ? targetWindow.id
        : null,
    title: readValue(targetWindow, 'getTitle', ''),
    url,
    bounds,
    contentBounds,
    visible: readBoolean(targetWindow, 'isVisible', null),
    focused: readBoolean(targetWindow, 'isFocused', null),
    minimized: readBoolean(targetWindow, 'isMinimized', null),
    maximized: readBoolean(targetWindow, 'isMaximized', null),
    fullScreen: readBoolean(targetWindow, 'isFullScreen', null),
    destroyed: readBoolean(targetWindow, 'isDestroyed', false),
    webContentsDestroyed,
    loading,
    loadingMainFrame,
    crashed,
  };
};

const classifyReadiness = state => {
  if (state.destroyed) return 'window_destroyed';
  if (state.webContentsDestroyed) return 'web_contents_destroyed';
  if (state.crashed) return 'web_contents_crashed';
  if (state.url !== null && (!state.url || state.url === 'about:blank'))
    return 'blank_url';
  if (state.loadingMainFrame || state.loading) return 'loading';
  return 'ready';
};

const waitForCaptureReadiness = async (
  targetWindow,
  { timeoutMs = DEFAULT_READY_TIMEOUT_MS, pollMs = READY_POLL_MS } = {}
) => {
  const startedAt = Date.now();
  let state = getWindowState(targetWindow);
  let reason = classifyReadiness(state);

  while (
    reason !== 'ready' &&
    ![
      'window_destroyed',
      'web_contents_destroyed',
      'web_contents_crashed',
    ].includes(reason) &&
    Date.now() - startedAt < timeoutMs
  ) {
    await sleep(pollMs);
    state = getWindowState(targetWindow);
    reason = classifyReadiness(state);
  }

  return {
    ready: reason === 'ready',
    reason,
    waitedMs: Date.now() - startedAt,
    state,
  };
};

const nativeImageToPng = ({
  image,
  maxWidth,
  maxHeight,
  maxCaptureBytes,
}) => {
  const sourceSize = getImageSize(image);
  const resizedImage = resizeNativeImage(image, maxWidth, maxHeight);
  const outputSize = getImageSize(resizedImage);
  const data =
    resizedImage && typeof resizedImage.toPNG === 'function'
      ? resizedImage.toPNG()
      : Buffer.alloc(0);
  if (data.length > maxCaptureBytes) {
    throw makeError('window_capture_too_large', {
      bytes: data.length,
      maxCaptureBytes,
      sourceSize,
      outputSize,
    });
  }
  return { data, sourceSize, outputSize };
};

const captureDesktopFallback = async ({
  targetWindow,
  desktopCapturer,
  region,
  maxWidth,
  maxHeight,
  maxCaptureBytes,
}) => {
  if (!desktopCapturer || typeof desktopCapturer.getSources !== 'function') {
    return {
      data: Buffer.alloc(0),
      available: false,
      reason: 'desktop_capturer_unavailable',
      sourcesCount: 0,
      matchedBy: null,
      sourceSize: null,
      outputSize: null,
    };
  }

  const bounds = readValue(targetWindow, 'getBounds', null) || {
    width: 1,
    height: 1,
  };
  let sources;
  try {
    sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: {
        width: Math.max(1, bounds.width || 1),
        height: Math.max(1, bounds.height || 1),
      },
      fetchWindowIcons: false,
    });
  } catch (error) {
    return {
      data: Buffer.alloc(0),
      available: true,
      reason: 'desktop_capturer_failed',
      error: String((error && error.message) || error),
      sourcesCount: 0,
      matchedBy: null,
      sourceSize: null,
      outputSize: null,
    };
  }

  const mediaSourceId =
    typeof targetWindow.getMediaSourceId === 'function'
      ? targetWindow.getMediaSourceId()
      : null;
  let source = mediaSourceId
    ? sources.find(candidate => candidate.id === mediaSourceId)
    : null;
  let matchedBy = source ? 'mediaSourceId' : null;
  if (!source && typeof targetWindow.getTitle === 'function') {
    const title = targetWindow.getTitle();
    source = sources.find(candidate => candidate.name === title);
    if (source) matchedBy = 'title';
  }

  if (!source || !source.thumbnail) {
    return {
      data: Buffer.alloc(0),
      available: true,
      reason: source ? 'desktop_thumbnail_missing' : 'desktop_source_not_found',
      sourcesCount: sources.length,
      matchedBy,
      sourceSize: null,
      outputSize: null,
    };
  }

  let fallbackImage = source.thumbnail;
  if (region && typeof fallbackImage.crop === 'function') {
    fallbackImage = fallbackImage.crop(region);
  }
  const converted = nativeImageToPng({
    image: fallbackImage,
    maxWidth,
    maxHeight,
    maxCaptureBytes,
  });
  return {
    ...converted,
    available: true,
    reason: converted.data.length
      ? 'captured'
      : 'desktop_thumbnail_empty',
    sourcesCount: sources.length,
    matchedBy,
  };
};

const captureWindowPngDetailed = async ({
  targetWindow,
  desktopCapturer,
  region,
  maxWidth,
  maxHeight,
  maxCaptureBytes = DEFAULT_MAX_CAPTURE_BYTES,
  captureAttempts = DEFAULT_CAPTURE_ATTEMPTS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
}) => {
  const readiness = await waitForCaptureReadiness(targetWindow, {
    timeoutMs: readyTimeoutMs,
  });
  const attempts = Math.max(1, Math.min(8, Math.round(captureAttempts) || 1));
  let lastAttempt = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const state = getWindowState(targetWindow);
    let direct = {
      data: Buffer.alloc(0),
      error: null,
      sourceSize: null,
      outputSize: null,
    };

    if (!state.webContentsDestroyed && !state.destroyed && !state.crashed) {
      try {
        const image = await targetWindow.webContents.capturePage(region);
        direct = {
          ...nativeImageToPng({
            image,
            maxWidth,
            maxHeight,
            maxCaptureBytes,
          }),
          error: null,
        };
      } catch (error) {
        if (error && error.code === 'window_capture_too_large') throw error;
        direct.error = String((error && error.message) || error);
      }
    }

    if (direct.data.length > 0) {
      return {
        data: direct.data,
        captureMethod: 'capturePage',
        attempts: attempt,
        readiness,
        windowState: state,
        sourceSize: direct.sourceSize,
        outputSize: direct.outputSize,
        fallback: null,
      };
    }

    const fallback = await captureDesktopFallback({
      targetWindow,
      desktopCapturer,
      region,
      maxWidth,
      maxHeight,
      maxCaptureBytes,
    });
    if (fallback.data.length > 0) {
      return {
        data: fallback.data,
        captureMethod: 'desktopCapturer',
        attempts: attempt,
        readiness,
        windowState: state,
        sourceSize: fallback.sourceSize,
        outputSize: fallback.outputSize,
        fallback: {
          available: fallback.available,
          reason: fallback.reason,
          sourcesCount: fallback.sourcesCount,
          matchedBy: fallback.matchedBy,
        },
      };
    }

    lastAttempt = {
      attempt,
      direct: {
        empty: direct.data.length === 0,
        error: direct.error,
        sourceSize: direct.sourceSize,
      },
      fallback: {
        available: fallback.available,
        reason: fallback.reason,
        error: fallback.error || null,
        sourcesCount: fallback.sourcesCount,
        matchedBy: fallback.matchedBy,
      },
      windowState: state,
    };

    if (attempt < attempts) await sleep(retryDelayMs);
  }

  const finalState = getWindowState(targetWindow);
  const reason =
    finalState.minimized === true
      ? 'window_minimized'
      : finalState.visible === false
      ? 'window_hidden'
      : readiness.reason !== 'ready'
      ? readiness.reason
      : lastAttempt &&
        lastAttempt.fallback &&
        lastAttempt.fallback.reason !== 'desktop_capturer_unavailable'
      ? lastAttempt.fallback.reason
      : 'persistent_empty_capture';

  throw makeError('window_capture_empty', {
    reason,
    attempts,
    retryDelayMs,
    readiness,
    windowState: finalState,
    lastAttempt,
  });
};

const captureWindowPng = async options =>
  (await captureWindowPngDetailed(options)).data;

const createWindowCaptureService = ({
  BrowserWindow,
  desktopCapturer,
  windowRegistry,
  isRegisteredPreviewWindow,
  maxCaptureBytes = DEFAULT_MAX_CAPTURE_BYTES,
}) => {
  const listWindows = () => {
    windowRegistry.prune();
    return BrowserWindow.getAllWindows().map(window => ({
      windowId: window.id,
      title: window.getTitle(),
      url: window.webContents.getURL(),
      bounds: window.getBounds(),
      contentBounds:
        typeof window.getContentBounds === 'function'
          ? window.getContentBounds()
          : null,
      visible: window.isVisible(),
      focused: window.isFocused(),
      minimized:
        typeof window.isMinimized === 'function' ? window.isMinimized() : null,
      editorWindow: windowRegistry.isRegistered(window.id),
      previewWindow: !!isRegisteredPreviewWindow(window.id),
      projectPath: windowRegistry.isRegistered(window.id)
        ? windowRegistry.getProjectPath(window.id)
        : null,
    }));
  };

  const resolveWindow = windowId => {
    const targetWindow =
      windowId != null && windowId !== ''
        ? BrowserWindow.fromId(Number(windowId))
        : BrowserWindow.getFocusedWindow();
    if (!targetWindow || targetWindow.isDestroyed()) {
      throw makeError('window_not_found');
    }
    return targetWindow;
  };

  const capture = async ({
    windowId,
    region,
    maxWidth,
    maxHeight,
    captureAttempts,
    retryDelayMs,
    readyTimeoutMs,
  } = {}) => {
    const targetWindow = resolveWindow(windowId);
    const captured = await captureWindowPngDetailed({
      targetWindow,
      desktopCapturer,
      region,
      maxWidth,
      maxHeight,
      maxCaptureBytes,
      captureAttempts,
      retryDelayMs,
      readyTimeoutMs,
    });
    return {
      windowId: targetWindow.id,
      mimeType: 'image/png',
      region: region || null,
      maxWidth: maxWidth || null,
      maxHeight: maxHeight || null,
      captureMethod: captured.captureMethod,
      attempts: captured.attempts,
      readiness: captured.readiness,
      windowState: captured.windowState,
      sourceSize: captured.sourceSize,
      outputSize: captured.outputSize,
      fallback: captured.fallback,
      data: captured.data,
    };
  };

  return { listWindows, resolveWindow, capture };
};

module.exports = {
  captureWindowPng,
  captureWindowPngDetailed,
  createWindowCaptureService,
  getWindowState,
  waitForCaptureReadiness,
};
