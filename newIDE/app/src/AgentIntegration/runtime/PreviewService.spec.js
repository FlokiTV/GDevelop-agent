// @flow
import { closeAllPreviewWindowsForAgent } from '../PreviewLifecycleTools';
import { createPreviewService, getPreviewStatus } from './PreviewService';

jest.mock('../PreviewLifecycleTools', () => ({
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

  test('optionally waits for authoritative runtime readiness', async () => {
    const previewLifecycleTracker = {
      getStatus: jest.fn(() => ({
        state: 'debugger-attaching',
        runtimeReady: false,
      })),
      refreshWindows: jest.fn(async () => ({
        state: 'debugger-attaching',
        runtimeReady: false,
        previewWindowIds: [12],
        debuggerIds: [],
        targets: [{ debuggerId: null, windowId: 12, ready: false }],
      })),
      markStarting: jest.fn(),
      markLaunchCompleted: jest.fn(),
      markFailed: jest.fn(),
      waitUntilReady: jest.fn(async ({ timeoutMs }) => ({
        state: 'ready',
        runtimeReady: true,
        previewWindowIds: [12],
        debuggerIds: ['preview-1'],
        targets: [
          {
            debuggerId: 'preview-1',
            windowId: 12,
            ready: true,
          },
        ],
        readyWait: { elapsedMs: 42, timedOut: false },
        timeoutMs,
      })),
    };
    const launchNewPreview = jest.fn(async () => {});
    const service = createPreviewService({
      project: ({}: any),
      previewDebuggerServer: makeDebuggerServer(),
      previewLifecycleTracker,
      launchNewPreview,
      launchHotReloadPreview: jest.fn(async () => {}),
      ipcRenderer: {},
    });

    const result = await service.start({
      numberOfWindows: 1,
      waitUntilReady: true,
      readyTimeoutMs: 5000,
    });

    expect(previewLifecycleTracker.markStarting).toHaveBeenCalledTimes(1);
    expect(previewLifecycleTracker.refreshWindows).toHaveBeenCalledTimes(1);
    expect(previewLifecycleTracker.markLaunchCompleted).toHaveBeenCalledTimes(1);
    expect(previewLifecycleTracker.waitUntilReady).toHaveBeenCalledWith({
      timeoutMs: 5000,
    });
    expect(result).toMatchObject({
      started: true,
      state: 'ready',
      runtimeReady: true,
      previewWindowIds: [12],
      debuggerIds: ['preview-1'],
      targets: [
        expect.objectContaining({
          debuggerId: 'preview-1',
          windowId: 12,
          ready: true,
        }),
      ],
    });
  });

  test('closes previews without synchronously re-inspecting closing windows', async () => {
    closeAllPreviewWindowsForAgent.mockResolvedValue({ closed: 2 });
    const ipcRenderer: any = {};
    const previewLifecycleTracker = {
      getStatus: jest.fn(() => ({
        state: 'ready',
        runtimeReady: true,
      })),
      refreshWindows: jest.fn(),
    };
    const service = createPreviewService({
      project: ({}: any),
      previewDebuggerServer: makeDebuggerServer(),
      previewLifecycleTracker,
      launchNewPreview: jest.fn(async () => {}),
      launchHotReloadPreview: jest.fn(async () => {}),
      ipcRenderer,
    });
    await expect(service.closeAll()).resolves.toEqual({
      closed: 2,
      lifecycle: {
        state: 'ready',
        runtimeReady: true,
      },
    });
    expect(closeAllPreviewWindowsForAgent).toHaveBeenCalledWith(ipcRenderer);
    expect(previewLifecycleTracker.refreshWindows).not.toHaveBeenCalled();
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
