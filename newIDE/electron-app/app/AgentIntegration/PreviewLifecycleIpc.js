const { isLikelyPreviewWindow } = require('./PreviewInputTools');

const PREVIEW_LIFECYCLE_CHANNEL =
  'gdevelop-agent-integration:preview-lifecycle';

const serializeError = error => ({
  code: (error && error.code) || 'preview_lifecycle_failed',
  message:
    (error && typeof error.message === 'string' && error.message) ||
    'preview_lifecycle_failed',
});

const createPreviewLifecycleIpc = ({
  BrowserWindow,
  ipcMain,
  windowRegistry,
  isRegisteredPreviewWindow,
  getPreviewWindowParentId,
  previewInteractionService,
}) => {
  const isEditorWindow = windowId => windowRegistry.isRegistered(windowId);
  const isPreviewWindow = window =>
    isLikelyPreviewWindow(window, isEditorWindow, isRegisteredPreviewWindow);

  const getParentEditorWindowId = windowId =>
    typeof getPreviewWindowParentId === 'function'
      ? getPreviewWindowParentId(windowId)
      : null;

  const listPreviewWindows = parentEditorWindowId =>
    (BrowserWindow.getAllWindows ? BrowserWindow.getAllWindows() : [])
      .filter(isPreviewWindow)
      .filter(window => {
        if (!Number.isInteger(parentEditorWindowId)) return true;
        return getParentEditorWindowId(window.id) === parentEditorWindowId;
      })
      .map(window => {
        const parentWindowId = getParentEditorWindowId(window.id);
        return {
          windowId: window.id,
          ...(Number.isInteger(parentWindowId)
            ? {
                parentEditorWindowId: parentWindowId,
                projectPath: windowRegistry.getProjectPath(parentWindowId),
              }
            : {}),
          title: typeof window.getTitle === 'function' ? window.getTitle() : '',
          url:
            window.webContents &&
            typeof window.webContents.getURL === 'function'
              ? window.webContents.getURL()
              : '',
          visible:
            typeof window.isVisible === 'function' ? window.isVisible() : null,
          focused:
            typeof window.isFocused === 'function' ? window.isFocused() : null,
          destroyed:
            typeof window.isDestroyed === 'function'
              ? window.isDestroyed()
              : false,
          bounds:
            typeof window.getBounds === 'function' ? window.getBounds() : null,
          contentBounds:
            typeof window.getContentBounds === 'function'
              ? window.getContentBounds()
              : null,
          minimized:
            typeof window.isMinimized === 'function'
              ? window.isMinimized()
              : null,
          maximized:
            typeof window.isMaximized === 'function'
              ? window.isMaximized()
              : null,
          fullScreen:
            typeof window.isFullScreen === 'function'
              ? window.isFullScreen()
              : null,
        };
      });

  const getRequestingEditorWindowId = event => {
    if (
      !event ||
      !event.sender ||
      !BrowserWindow ||
      typeof BrowserWindow.fromWebContents !== 'function'
    ) {
      return null;
    }
    const window = BrowserWindow.fromWebContents(event.sender);
    return window && windowRegistry.isRegistered(window.id) ? window.id : null;
  };

  const handle = async event => {
    try {
      const parentEditorWindowId = getRequestingEditorWindowId(event);
      const windows = listPreviewWindows(parentEditorWindowId);
      const activated = [];
      for (const window of windows) {
        const parentMetadata = Number.isInteger(window.parentEditorWindowId)
          ? { parentEditorWindowId: window.parentEditorWindowId }
          : {};
        try {
          const status = await previewInteractionService.getRuntimeStatus({
            previewWindowId: window.windowId,
          });
          activated.push({
            windowId: window.windowId,
            ...parentMetadata,
            identity:
              status && status.identity
                ? status.identity
                : { announced: false, windowId: window.windowId },
          });
        } catch (error) {
          activated.push({
            windowId: window.windowId,
            ...parentMetadata,
            identity: {
              announced: false,
              windowId: window.windowId,
              reason:
                (error && error.code) ||
                (error && error.message) ||
                'preview_runtime_unavailable',
            },
          });
        }
      }
      return {
        ok: true,
        data: {
          ...(Number.isInteger(parentEditorWindowId)
            ? { parentEditorWindowId }
            : {}),
          windows,
          activated,
        },
      };
    } catch (error) {
      return { ok: false, error: serializeError(error) };
    }
  };

  ipcMain.handle(PREVIEW_LIFECYCLE_CHANNEL, handle);
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (typeof ipcMain.removeHandler === 'function') {
      ipcMain.removeHandler(PREVIEW_LIFECYCLE_CHANNEL);
    }
  };

  return {
    channel: PREVIEW_LIFECYCLE_CHANNEL,
    listPreviewWindows,
    dispose,
  };
};

module.exports = {
  PREVIEW_LIFECYCLE_CHANNEL,
  createPreviewLifecycleIpc,
};
