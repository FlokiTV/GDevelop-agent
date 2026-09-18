const { isLikelyPreviewWindow } = require('./PreviewInputTools');

const PREVIEW_RUNTIME_SNAPSHOT_CHANNEL =
  'gdevelop-agent-integration:preview-runtime-snapshot';

const makeError = (code, message = code, details) => {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
};

const serializeError = error => ({
  code: (error && error.code) || 'preview_runtime_snapshot_failed',
  message:
    (error && typeof error.message === 'string' && error.message) ||
    'preview_runtime_snapshot_failed',
  ...(error && error.details !== undefined ? { details: error.details } : {}),
});

const createPreviewRuntimeSnapshotIpc = ({
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
    (BrowserWindow.getAllWindows ? BrowserWindow.getAllWindows() : []).filter(
      isPreviewWindow
    );

  const selectPreviewWindowId = (request = {}) => {
    const explicitWindowId =
      request.previewWindowId != null
        ? request.previewWindowId
        : request.windowId;
    if (explicitWindowId != null && explicitWindowId !== '') {
      const numericWindowId = Number(explicitWindowId);
      if (!Number.isInteger(numericWindowId) || numericWindowId <= 0) {
        throw makeError('invalid_preview_window_id');
      }
      const window = BrowserWindow.fromId(numericWindowId);
      if (!isPreviewWindow(window)) {
        throw makeError('preview_window_not_found');
      }
      return numericWindowId;
    }

    const focusedWindow = BrowserWindow.getFocusedWindow
      ? BrowserWindow.getFocusedWindow()
      : null;
    if (isPreviewWindow(focusedWindow)) return focusedWindow.id;

    const previewWindows = listPreviewWindows();
    if (!previewWindows.length) throw makeError('preview_not_running');
    if (previewWindows.length > 1) {
      throw makeError('preview_window_ambiguous', 'preview_window_ambiguous', {
        previewWindowIds: previewWindows.map(window => window.id),
      });
    }
    return previewWindows[0].id;
  };

  const handleSnapshot = async (_event, request = {}) => {
    try {
      const previewWindowId = selectPreviewWindowId(request);
      const data = await previewInteractionService.getRuntimeSnapshot({
        ...request,
        previewWindowId,
      });
      return { ok: true, data };
    } catch (error) {
      return { ok: false, error: serializeError(error) };
    }
  };

  ipcMain.handle(PREVIEW_RUNTIME_SNAPSHOT_CHANNEL, handleSnapshot);
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (typeof ipcMain.removeHandler === 'function') {
      ipcMain.removeHandler(PREVIEW_RUNTIME_SNAPSHOT_CHANNEL);
    }
  };

  return {
    channel: PREVIEW_RUNTIME_SNAPSHOT_CHANNEL,
    selectPreviewWindowId,
    dispose,
  };
};

module.exports = {
  PREVIEW_RUNTIME_SNAPSHOT_CHANNEL,
  createPreviewRuntimeSnapshotIpc,
};
