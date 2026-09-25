// @flow
import { listPreviewWindowsForAgent } from '../PreviewLifecycleTools';

const DEFAULT_READY_TIMEOUT_MS = 10000;
const MIN_POLL_MS = 50;
const MAX_READY_TIMEOUT_MS = 30000;

const sleep = (milliseconds: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, milliseconds));

const clampTimeout = (value: any): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_READY_TIMEOUT_MS;
  return Math.max(100, Math.min(MAX_READY_TIMEOUT_MS, Math.round(parsed)));
};

const makeError = (code: string, details?: any): Error => {
  const error: any = new Error(code);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
};

export const createPreviewLifecycleTracker = ({
  previewDebuggerServer,
  ipcRenderer,
}: {|
  previewDebuggerServer: any,
  ipcRenderer: any,
|}): any => {
  const debuggerStatuses: Map<string, any> = new Map();
  const debuggerWindowIds: Map<string, number> = new Map();
  let windows: Array<any> = [];
  let launching = false;
  let launchedAt = null;
  let lastFailure = null;
  let disposed = false;

  const getDebuggerIds = (): Array<string> => {
    if (!previewDebuggerServer) return [];
    const ids = previewDebuggerServer.getExistingPreviewDebuggerIds
      ? previewDebuggerServer.getExistingPreviewDebuggerIds()
      : previewDebuggerServer.getExistingDebuggerIds
      ? previewDebuggerServer.getExistingDebuggerIds()
      : [];
    return Array.isArray(ids) ? ids : [];
  };

  const getServerState = (): ?string =>
    previewDebuggerServer && previewDebuggerServer.getServerState
      ? previewDebuggerServer.getServerState()
      : null;

  const reconcileUnambiguousMapping = () => {
    const debuggerIds = getDebuggerIds();
    if (windows.length !== 1 || debuggerIds.length !== 1) return;
    const debuggerId = debuggerIds[0];
    if (!debuggerStatuses.has(debuggerId)) return;
    const windowId = windows[0] && windows[0].windowId;
    if (!Number.isInteger(windowId) || windowId <= 0) return;
    const mappedWindowId = debuggerWindowIds.get(debuggerId);
    if (mappedWindowId == null) debuggerWindowIds.set(debuggerId, windowId);
  };

  const isDebuggerReady = (debuggerId: string): boolean => {
    if (!debuggerStatuses.has(debuggerId)) return false;
    if (!windows.length) return true;
    const windowId = debuggerWindowIds.get(debuggerId);
    return (
      Number.isInteger(windowId) &&
      windows.some(window => window && window.windowId === windowId)
    );
  };

  const getState = (): string => {
    const debuggerIds = getDebuggerIds();
    const readyIds = debuggerIds.filter(isDebuggerReady);
    if (lastFailure && readyIds.length === 0) return 'failed';
    if (launching) return 'starting';
    if (windows.length > 0) {
      const readyWindowIds = new Set(
        readyIds
          .map(id => debuggerWindowIds.get(id))
          .filter(windowId => Number.isInteger(windowId))
      );
      if (
        readyIds.length > 0 &&
        windows.every(window => readyWindowIds.has(window.windowId))
      ) {
        return 'ready';
      }
      if (debuggerIds.length > 0 || getServerState() === 'started') {
        return 'debugger-attaching';
      }
      return 'window-open';
    }
    if (debuggerIds.length > 0) {
      return readyIds.length > 0 ? 'ready' : 'debugger-attaching';
    }
    return 'stopped';
  };

  const getStatus = (): any => {
    const debuggerIds = getDebuggerIds();
    const previewWindowIds = windows.map(window => window.windowId);
    const state = getState();
    const targets = debuggerIds.map(debuggerId => {
      const status = debuggerStatuses.get(debuggerId) || null;
      const windowId = debuggerWindowIds.get(debuggerId) || null;
      return {
        debuggerId,
        windowId,
        ready: isDebuggerReady(debuggerId),
        ...(status || {}),
      };
    });
    const mappedWindowIds = new Set(
      targets.map(target => target.windowId).filter(Boolean)
    );
    previewWindowIds.forEach(windowId => {
      if (mappedWindowIds.has(windowId)) return;
      targets.push({
        debuggerId: null,
        windowId,
        ready: false,
      });
    });
    return {
      available: !!previewDebuggerServer,
      state,
      serverState: getServerState(),
      debuggerIds,
      previewDebuggerIds: debuggerIds,
      previewWindowIds,
      targets,
      running: state !== 'stopped' && state !== 'failed',
      windowOpen: previewWindowIds.length > 0,
      debuggerAttached: debuggerIds.length > 0,
      runtimeReady: state === 'ready',
      launchedAt,
      failure: lastFailure,
    };
  };

  const refreshWindows = async (): Promise<any> => {
    if (disposed) throw makeError('preview_lifecycle_disposed');
    if (!ipcRenderer || typeof ipcRenderer.invoke !== 'function') {
      return getStatus();
    }
    try {
      const result = await listPreviewWindowsForAgent(ipcRenderer);
      windows = Array.isArray(result.windows) ? result.windows : [];
      reconcileUnambiguousMapping();
      if (!windows.length && getDebuggerIds().length === 0 && !launching) {
        launchedAt = null;
        lastFailure = null;
      }
    } catch (error) {
      const code = String(
        (error && error.code) ||
          (error && error.message) ||
          'preview_lifecycle_unavailable'
      );
      // Browser/non-desktop previews can still be authoritative from debugger
      // state even when desktop window enumeration is unavailable.
      if (code !== 'preview_lifecycle_unavailable') throw error;
    }
    return getStatus();
  };

  const markStarting = () => {
    launching = true;
    launchedAt = Date.now();
    lastFailure = null;
    windows = [];
    debuggerStatuses.clear();
    debuggerWindowIds.clear();
  };

  const markLaunchCompleted = () => {
    launching = false;
  };

  const markFailed = (error: any) => {
    launching = false;
    lastFailure = {
      code: String(
        (error && error.code) ||
          (error && error.message) ||
          'preview_start_failed'
      ),
      message: String(
        (error && error.message) ||
          (error && error.code) ||
          'preview_start_failed'
      ),
    };
  };

  const waitUntilReady = async (options: any = {}): Promise<any> => {
    const timeoutMs = clampTimeout(options.timeoutMs);
    const started = Date.now();
    while (Date.now() - started <= timeoutMs) {
      await refreshWindows();
      const status = getStatus();
      if (status.runtimeReady) {
        return {
          ...status,
          readyWait: {
            elapsedMs: Date.now() - started,
            timedOut: false,
          },
        };
      }
      if (status.state === 'failed') {
        throw makeError('preview_failed', status.failure);
      }
      await sleep(MIN_POLL_MS);
    }
    const status = getStatus();
    throw makeError('preview_ready_timeout', {
      timeoutMs,
      state: status.state,
      serverState: status.serverState,
      previewWindowIds: status.previewWindowIds,
      debuggerIds: status.debuggerIds,
      targets: status.targets,
    });
  };

  const unregisterCallbacks =
    previewDebuggerServer && previewDebuggerServer.registerCallbacks
      ? previewDebuggerServer.registerCallbacks({
          onErrorReceived: error => {
            if (!launching && windows.length === 0) return;
            lastFailure = {
              code: 'preview_debugger_server_error',
              message: String(
                (error && error.message) || error || 'Debugger server error'
              ),
            };
          },
          onConnectionClosed: ({ id }) => {
            debuggerStatuses.delete(id);
            debuggerWindowIds.delete(id);
          },
          onConnectionOpened: ({ id }) => {
            if (previewDebuggerServer && previewDebuggerServer.sendMessage) {
              previewDebuggerServer.sendMessage(id, { command: 'getStatus' });
            }
          },
          onConnectionErrored: ({ id, errorMessage }) => {
            debuggerStatuses.delete(id);
            debuggerWindowIds.delete(id);
            if (windows.length > 0 || launching) {
              lastFailure = {
                code: 'preview_debugger_connection_error',
                message: String(
                  errorMessage || `Debugger connection ${id} errored.`
                ),
              };
            }
          },
          onServerStateChanged: () => {},
          onHandleParsedMessage: ({ id, parsedMessage }) => {
            if (!parsedMessage) return;
            if (parsedMessage.command === 'agent.preview.identity') {
              const windowId = Number(
                parsedMessage.payload && parsedMessage.payload.windowId
              );
              if (Number.isInteger(windowId) && windowId > 0) {
                debuggerWindowIds.set(id, windowId);
              }
              return;
            }
            if (parsedMessage.command === 'status') {
              debuggerStatuses.set(id, {
                isPaused: !!(
                  parsedMessage.payload && parsedMessage.payload.isPaused
                ),
                isInGameEdition: !!(
                  parsedMessage.payload && parsedMessage.payload.isInGameEdition
                ),
                sceneName:
                  parsedMessage.payload &&
                  typeof parsedMessage.payload.sceneName === 'string'
                    ? parsedMessage.payload.sceneName
                    : null,
              });
              reconcileUnambiguousMapping();
              lastFailure = null;
            }
          },
        })
      : null;

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (unregisterCallbacks) unregisterCallbacks();
    debuggerStatuses.clear();
    debuggerWindowIds.clear();
    windows = [];
  };

  return {
    getDebuggerIds,
    getServerState,
    getStatus,
    refreshWindows,
    markStarting,
    markLaunchCompleted,
    markFailed,
    waitUntilReady,
    dispose,
  };
};
