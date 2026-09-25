// @flow
import { AgentError } from '../core/AgentError';
import { closeAllPreviewWindowsForAgent } from '../PreviewLifecycleTools';

type Options = {|
  project: ?gdProject,
  previewDebuggerServer: ?any,
  previewLifecycleTracker?: ?any,
  launchNewPreview: (options?: any) => Promise<void>,
  launchHotReloadPreview: () => Promise<void>,
  ipcRenderer: any,
|};

export const getPreviewStatus = (previewDebuggerServer: ?any) => {
  if (!previewDebuggerServer) {
    return {
      available: false,
      state: 'stopped',
      serverState: null,
      debuggerIds: [],
      previewDebuggerIds: [],
      previewWindowIds: [],
      targets: [],
      running: false,
      windowOpen: false,
      debuggerAttached: false,
      runtimeReady: false,
    };
  }
  const debuggerIds = previewDebuggerServer.getExistingDebuggerIds
    ? previewDebuggerServer.getExistingDebuggerIds()
    : [];
  const previewDebuggerIds = previewDebuggerServer.getExistingPreviewDebuggerIds
    ? previewDebuggerServer.getExistingPreviewDebuggerIds()
    : debuggerIds;
  return {
    available: true,
    state: previewDebuggerIds.length > 0 ? 'ready' : 'stopped',
    serverState: previewDebuggerServer.getServerState
      ? previewDebuggerServer.getServerState()
      : null,
    debuggerIds,
    previewDebuggerIds,
    previewWindowIds: [],
    targets: previewDebuggerIds.map(debuggerId => ({
      debuggerId,
      windowId: null,
      ready: true,
    })),
    running: previewDebuggerIds.length > 0,
    windowOpen: false,
    debuggerAttached: previewDebuggerIds.length > 0,
    runtimeReady: previewDebuggerIds.length > 0,
  };
};

export const createPreviewService = ({
  project,
  previewDebuggerServer,
  previewLifecycleTracker,
  launchNewPreview,
  launchHotReloadPreview,
  ipcRenderer,
}: Options) => {
  const getStatus = () =>
    previewLifecycleTracker
      ? previewLifecycleTracker.getStatus()
      : getPreviewStatus(previewDebuggerServer);

  const refreshStatus = async () =>
    previewLifecycleTracker
      ? previewLifecycleTracker.refreshWindows()
      : getPreviewStatus(previewDebuggerServer);

  return {
    getStatus,
    refreshStatus,

    start: async ({
      numberOfWindows,
      waitUntilReady = false,
      readyTimeoutMs,
    }: any = {}) => {
      if (!project) throw new AgentError({ code: 'no_project_open' });
      if (previewLifecycleTracker) previewLifecycleTracker.markStarting();
      try {
        await launchNewPreview({
          numberOfWindows:
            Number.isInteger(numberOfWindows) && numberOfWindows > 0
              ? numberOfWindows
              : 1,
        });
      } catch (error) {
        if (previewLifecycleTracker) previewLifecycleTracker.markFailed(error);
        throw error;
      }

      let lifecycle = null;
      try {
        lifecycle = await refreshStatus();
      } finally {
        if (previewLifecycleTracker) {
          previewLifecycleTracker.markLaunchCompleted();
        }
      }

      if (waitUntilReady && previewLifecycleTracker) {
        lifecycle = await previewLifecycleTracker.waitUntilReady({
          timeoutMs: readyTimeoutMs,
        });
      }

      if (!previewLifecycleTracker) return { started: true };
      return {
        started: true,
        ...(lifecycle || getStatus()),
      };
    },

    hotReload: async () => {
      if (!project) throw new AgentError({ code: 'no_project_open' });
      await launchHotReloadPreview();
      if (!previewLifecycleTracker) return { hotReloaded: true };
      return {
        hotReloaded: true,
        ...(await refreshStatus()),
      };
    },

    control: ({ action, debuggerId }: any) => {
      if (!previewDebuggerServer) {
        throw new AgentError({ code: 'preview_debugger_unavailable' });
      }
      if (!['play', 'pause', 'refresh'].includes(action)) {
        throw new AgentError({
          code: 'unsupported_preview_action',
          details: { action },
        });
      }
      const debuggerIds = previewDebuggerServer.getExistingDebuggerIds();
      const targetIds = debuggerId
        ? debuggerIds.filter(id => id === debuggerId)
        : debuggerIds;
      if (!targetIds.length) {
        const lifecycle = getStatus();
        throw new AgentError({
          code:
            lifecycle &&
            lifecycle.state !== 'stopped' &&
            lifecycle.state !== 'failed'
              ? 'preview_runtime_not_ready'
              : 'preview_not_running',
          details: lifecycle || undefined,
        });
      }
      targetIds.forEach(id =>
        previewDebuggerServer.sendMessage(id, { command: action })
      );
      if (!previewLifecycleTracker) {
        return { action, debuggerIds: targetIds };
      }
      return {
        action,
        debuggerIds: targetIds,
        lifecycle: getStatus(),
      };
    },

    closeAll: async () => {
      const result = await closeAllPreviewWindowsForAgent(ipcRenderer);
      if (!previewLifecycleTracker) return result;
      // Do not synchronously re-inspect windows that are in the process of
      // closing. The next preview.status call refreshes the lifecycle safely.
      return {
        ...result,
        lifecycle: getStatus(),
      };
    },
  };
};
