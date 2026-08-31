// @flow
import { AgentError } from '../core/AgentError';
import { closeAllPreviewWindowsForAgent } from '../../AgentApi/PreviewLifecycleTools';

type Options = {|
  project: ?gdProject,
  previewDebuggerServer: ?any,
  launchNewPreview: (options?: any) => Promise<void>,
  launchHotReloadPreview: () => Promise<void>,
  ipcRenderer: any,
|};

export const getPreviewStatus = (previewDebuggerServer: ?any) => {
  if (!previewDebuggerServer) {
    return {
      available: false,
      serverState: null,
      debuggerIds: [],
      previewDebuggerIds: [],
      running: false,
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
    serverState: previewDebuggerServer.getServerState
      ? previewDebuggerServer.getServerState()
      : null,
    debuggerIds,
    previewDebuggerIds,
    running: previewDebuggerIds.length > 0,
  };
};

export const createPreviewService = ({
  project,
  previewDebuggerServer,
  launchNewPreview,
  launchHotReloadPreview,
  ipcRenderer,
}: Options) => ({
  getStatus: () => getPreviewStatus(previewDebuggerServer),

  start: async ({ numberOfWindows }: any = {}) => {
    if (!project) throw new AgentError({ code: 'no_project_open' });
    await launchNewPreview({
      numberOfWindows:
        Number.isInteger(numberOfWindows) && numberOfWindows > 0
          ? numberOfWindows
          : 1,
    });
    return { started: true };
  },

  hotReload: async () => {
    if (!project) throw new AgentError({ code: 'no_project_open' });
    await launchHotReloadPreview();
    return { hotReloaded: true };
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
      throw new AgentError({ code: 'preview_not_running' });
    }
    targetIds.forEach(id =>
      previewDebuggerServer.sendMessage(id, { command: action })
    );
    return { action, debuggerIds: targetIds };
  },

  closeAll: () => closeAllPreviewWindowsForAgent(ipcRenderer),
});
