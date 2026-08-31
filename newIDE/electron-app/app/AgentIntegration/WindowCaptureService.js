const makeError = code => {
  const error = new Error(code);
  error.code = code;
  return error;
};

const captureWindowPng = async ({ targetWindow, desktopCapturer }) => {
  const image = await targetWindow.webContents.capturePage();
  const directBuffer = image && image.toPNG ? image.toPNG() : Buffer.alloc(0);
  if (directBuffer.length > 0) return directBuffer;

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

  const fallbackBuffer =
    source && source.thumbnail && source.thumbnail.toPNG
      ? source.thumbnail.toPNG()
      : Buffer.alloc(0);
  if (fallbackBuffer.length > 0) return fallbackBuffer;
  throw makeError('window_capture_empty');
};

const createWindowCaptureService = ({
  BrowserWindow,
  desktopCapturer,
  windowRegistry,
  isRegisteredPreviewWindow,
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

  const capture = async ({ windowId } = {}) => {
    const targetWindow = resolveWindow(windowId);
    return {
      windowId: targetWindow.id,
      mimeType: 'image/png',
      data: await captureWindowPng({ targetWindow, desktopCapturer }),
    };
  };

  return { listWindows, resolveWindow, capture };
};

module.exports = {
  captureWindowPng,
  createWindowCaptureService,
};
