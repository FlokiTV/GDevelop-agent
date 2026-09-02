const crypto = require('crypto');

const COMMAND_REQUEST_CHANNEL = 'gdevelop-agent-integration:command';
const COMMAND_RESPONSE_CHANNEL = 'gdevelop-agent-integration:command-response';
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = 10 * 60 * 1000;

const makeError = (code, message = code, details) => {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
};

const normalizeTimeoutMs = timeoutMs => {
  const numeric = Number(timeoutMs);
  if (!Number.isFinite(numeric) || numeric <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(1, Math.round(numeric)));
};

const createRendererBridge = ({
  BrowserWindow,
  ipcMain,
  windowRegistry,
  makeRequestId = () => crypto.randomUUID(),
}) => {
  const pendingRequests = new Map();
  let installed = false;

  const onCommandResponse = (event, payload = {}) => {
    const pending = pendingRequests.get(payload.requestId);
    if (!pending) return;
    const sourceWindow = BrowserWindow.fromWebContents(event.sender);
    if (!sourceWindow || sourceWindow.id !== pending.windowId) return;

    clearTimeout(pending.timeout);
    pendingRequests.delete(payload.requestId);
    if (payload.ok) {
      pending.resolve(payload.result);
      return;
    }

    if (payload.error && typeof payload.error === 'object') {
      const error = makeError(
        payload.error.code || 'renderer_request_failed',
        payload.error.message || 'renderer_request_failed',
        payload.error.details
      );
      error.retryable = !!payload.error.retryable;
      error.hint = payload.error.hint || null;
      error.currentRevision = payload.error.currentRevision;
      error.traceId = payload.error.traceId || null;
      pending.reject(error);
      return;
    }

    pending.reject(makeError('renderer_request_failed'));
  };

  const install = () => {
    if (installed) return;
    installed = true;
    ipcMain.on(COMMAND_RESPONSE_CHANNEL, onCommandResponse);
  };

  const rejectAll = code => {
    for (const pending of pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(makeError(code));
    }
    pendingRequests.clear();
  };

  const dispose = () => {
    if (installed) {
      ipcMain.removeListener(COMMAND_RESPONSE_CHANNEL, onCommandResponse);
      installed = false;
    }
    rejectAll('renderer_bridge_stopped');
  };

  const executeCommand = ({
    command,
    input,
    traceId,
    projectPath,
    windowId,
    timeoutMs,
  }) => {
    const targetWindow = windowRegistry.select({ projectPath, windowId });
    if (!targetWindow) {
      return Promise.reject(
        makeError(
          'target_window_not_found',
          projectPath
            ? 'project_not_open_in_agent_integration'
            : 'target_window_ambiguous_or_missing'
        )
      );
    }

    const requestId = makeRequestId();
    const requestTimeoutMs = normalizeTimeoutMs(timeoutMs);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingRequests.delete(requestId);
        reject(makeError('renderer_request_timeout'));
      }, requestTimeoutMs);
      pendingRequests.set(requestId, {
        resolve,
        reject,
        timeout,
        windowId: targetWindow.id,
      });
      targetWindow.webContents.send(COMMAND_REQUEST_CHANNEL, {
        requestId,
        command,
        input: input && typeof input === 'object' ? input : {},
        ...(typeof traceId === 'string' && traceId ? { traceId } : {}),
      });
    });
  };

  install();

  return {
    executeCommand,
    dispose,
    rejectAll,
    get pendingCount() {
      return pendingRequests.size;
    },
  };
};

module.exports = {
  COMMAND_REQUEST_CHANNEL,
  COMMAND_RESPONSE_CHANNEL,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  normalizeTimeoutMs,
  createRendererBridge,
};
