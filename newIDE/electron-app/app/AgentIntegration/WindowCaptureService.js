const DEFAULT_MAX_CAPTURE_BYTES = 16 * 1024 * 1024;

const makeError = code => {
  const error = new Error(code);
  error.code = code;
  return error;
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

const captureWindowPng = async ({
  targetWindow,
  desktopCapturer,
  region,
  maxWidth,
  maxHeight,
  maxCaptureBytes = DEFAULT_MAX_CAPTURE_BYTES,
}) => {
  const ensureCaptureSize = buffer => {
    if (buffer.length > maxCaptureBytes) {
      throw makeError('window_capture_too_large');
    }
    return buffer;
  };

  const image = await targetWindow.webContents.capturePage(region);
  const resizedImage = resizeNativeImage(image, maxWidth, maxHeight);
  const directBuffer =
    resizedImage && resizedImage.toPNG ? resizedImage.toPNG() : Buffer.alloc(0);
  if (directBuffer.length > 0) return ensureCaptureSize(directBuffer);

  if (!desktopCapturer || typeof desktopCapturer.getSources !== 'function') {
    throw makeError('window_capture_empty');
  }

  const bounds = targetWindow.getBounds();
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: {
      width: Math.max(1, bounds.width),
      height: Math.max(1, bounds.height),
    },
    fetchWindowIcons: false,
  });
  const mediaSourceId =
    typeof targetWindow.getMediaSourceId === 'function'
      ? targetWindow.getMediaSourceId()
      : null;
  let source = mediaSourceId
    ? sources.find(candidate => candidate.id === mediaSourceId)
    : null;
  if (!source && typeof targetWindow.getTitle === 'function') {
    const title = targetWindow.getTitle();
    source = sources.find(candidate => candidate.name === title);
  }

  let fallbackImage = source && source.thumbnail ? source.thumbnail : null;
  if (fallbackImage && region && typeof fallbackImage.crop === 'function') {
    fallbackImage = fallbackImage.crop(region);
  }
  fallbackImage = resizeNativeImage(fallbackImage, maxWidth, maxHeight);
  const fallbackBuffer =
    fallbackImage && fallbackImage.toPNG
      ? fallbackImage.toPNG()
      : Buffer.alloc(0);
  if (fallbackBuffer.length > 0) return ensureCaptureSize(fallbackBuffer);
  throw makeError('window_capture_empty');
};

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
      visible: window.isVisible(),
      focused: window.isFocused(),
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

  const capture = async ({ windowId, region, maxWidth, maxHeight } = {}) => {
    const targetWindow = resolveWindow(windowId);
    return {
      windowId: targetWindow.id,
      mimeType: 'image/png',
      region: region || null,
      maxWidth: maxWidth || null,
      maxHeight: maxHeight || null,
      data: await captureWindowPng({
        targetWindow,
        desktopCapturer,
        region,
        maxWidth,
        maxHeight,
        maxCaptureBytes,
      }),
    };
  };

  return { listWindows, resolveWindow, capture };
};

module.exports = {
  captureWindowPng,
  createWindowCaptureService,
};
