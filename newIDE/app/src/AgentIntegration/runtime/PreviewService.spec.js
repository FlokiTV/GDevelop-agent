// @flow
import { closeAllPreviewWindowsForAgent } from '../../AgentApi/PreviewLifecycleTools';
import { createPreviewService, getPreviewStatus } from './PreviewService';

jest.mock('../../AgentApi/PreviewLifecycleTools', () => ({
  closeAllPreviewWindowsForAgent: jest.fn(async () => ({ closed: 2 })),
}));

const makeDebuggerServer = () => ({
  getExistingDebuggerIds: jest.fn(() => ['gameplay-test-frame', 'preview-1']),
  getExistingPreviewDebuggerIds: jest.fn(() => ['preview-1']),
  getServerState: jest.fn(() => 'started'),
  sendMessage: jest.fn(),
});

describe('PreviewService', () => {
  beforeEach(() => jest.clearAllMocks());

  test('separates preview debugger ids from gameplay test ids', () => {
    expect(getPreviewStatus(makeDebuggerServer())).toMatchObject({
      available: true,
      debuggerIds: ['gameplay-test-frame', 'preview-1'],
      previewDebuggerIds: ['preview-1'],
      running: true,
    });
  });

  test('starts, hot reloads and controls previews', async () => {
    const previewDebuggerServer = makeDebuggerServer();
    const launchNewPreview = jest.fn(async () => {});
    const launchHotReloadPreview = jest.fn(async () => {});
    const service = createPreviewService({
      project: ({}: any),
      previewDebuggerServer,
      launchNewPreview,
      launchHotReloadPreview,
      ipcRenderer: {},
    });
    await expect(service.start({ numberOfWindows: 2 })).resolves.toEqual({
      started: true,
    });
    await expect(service.hotReload()).resolves.toEqual({ hotReloaded: true });
    expect(service.control({ action: 'pause', debuggerId: 'preview-1' })).toEqual({
      action: 'pause',
      debuggerIds: ['preview-1'],
    });
    expect(launchNewPreview).toHaveBeenCalledWith({ numberOfWindows: 2 });
    expect(launchHotReloadPreview).toHaveBeenCalledTimes(1);
    expect(previewDebuggerServer.sendMessage).toHaveBeenCalledWith('preview-1', {
      command: 'pause',
    });
  });

  test('closes previews through the isolated lifecycle helper', async () => {
    closeAllPreviewWindowsForAgent.mockResolvedValue({ closed: 2 });
    const ipcRenderer: any = {};
    const service = createPreviewService({
      project: ({}: any),
      previewDebuggerServer: makeDebuggerServer(),
      launchNewPreview: jest.fn(async () => {}),
      launchHotReloadPreview: jest.fn(async () => {}),
      ipcRenderer,
    });
    await expect(service.closeAll()).resolves.toEqual({ closed: 2 });
    expect(closeAllPreviewWindowsForAgent).toHaveBeenCalledWith(ipcRenderer);
  });

  test('rejects project-required and invalid control operations', async () => {
    const service = createPreviewService({
      project: null,
      previewDebuggerServer: makeDebuggerServer(),
      launchNewPreview: jest.fn(async () => {}),
      launchHotReloadPreview: jest.fn(async () => {}),
      ipcRenderer: {},
    });
    await expect(service.start()).rejects.toMatchObject({ code: 'no_project_open' });
    expect(() => service.control({ action: 'stop' })).toThrow(
      expect.objectContaining({ code: 'unsupported_preview_action' })
    );
  });
});
