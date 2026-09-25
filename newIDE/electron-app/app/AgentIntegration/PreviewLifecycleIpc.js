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
  previewInteractionService,
}) => {
  const isEditorWindow = windowId => windowRegistry.isRegistered(windowId);
  const isPreviewWindow = window =>
    isLikelyPreviewWindow(window, isEditorWindow, isRegisteredPreviewWindow);

  const listPreviewWindows = () =>
    (BrowserWindow.getAllWindows ? BrowserWindow.getAllWindows() : [])
      .filter(isPreviewWindow)
      .map(window => ({
        windowId: window.id,
        title: typeof window.getTitle === 'function' ? window.getTitle() : '',
        url:
          window.webContents && typeof window.webContents.getURL === 'function'
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
      }));

  const handle = async () => {
    try {
      const windows = listPreviewWindows();
      const activated = [];
      for (const window of windows) {
        try {
          const status = await previewInteractionService.getRuntimeStatus({
            previewWindowId: window.windowId,
          });
          activated.push({
            windowId: window.windowId,
            identity:
              status && status.identity
                ? status.identity
                : { announced: false, windowId: window.windowId },
          });
        } catch (error) {
          activated.push({
            windowId: window.windowId,
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
      return { ok: true, data: { windows, activated } };
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
