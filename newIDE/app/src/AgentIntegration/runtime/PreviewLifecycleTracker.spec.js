// @flow
import { createPreviewLifecycleTracker } from './PreviewLifecycleTracker';

const makeHarness = () => {
  let debuggerIds = [];
  let serverState = 'stopped';
  let windows = [];
  const callbacks = [];

  const previewDebuggerServer = {
    registerCallbacks: jest.fn(callbacksToRegister => {
      callbacks.push(callbacksToRegister);
      return () => {
        const index = callbacks.indexOf(callbacksToRegister);
        if (index !== -1) callbacks.splice(index, 1);
      };
    }),
    getExistingPreviewDebuggerIds: jest.fn(() => debuggerIds.slice()),
    getExistingDebuggerIds: jest.fn(() => debuggerIds.slice()),
    getServerState: jest.fn(() => serverState),
    sendMessage: jest.fn(),
  };

  const ipcRenderer = {
    invoke: jest.fn(async () => ({
      ok: true,
      data: {
        windows: windows.slice(),
        activated: windows.map(window => ({
          windowId: window.windowId,
          identity: { announced: true, windowId: window.windowId },
        })),
      },
    })),
  };

  const emit = (name, payload) =>
    callbacks.forEach(callback => {
      if (typeof callback[name] === 'function') callback[name](payload);
    });

  return {
    previewDebuggerServer,
    ipcRenderer,
    setWindows: nextWindows => {
      windows = nextWindows;
    },
    setServerState: nextState => {
      serverState = nextState;
    },
    connect: id => {
      debuggerIds = [...debuggerIds, id];
      emit('onConnectionOpened', { id, debuggerIds: debuggerIds.slice() });
    },
    close: id => {
      debuggerIds = debuggerIds.filter(candidate => candidate !== id);
      emit('onConnectionClosed', { id, debuggerIds: debuggerIds.slice() });
    },
    message: (id, command, payload) =>
      emit('onHandleParsedMessage', {
        id,
        parsedMessage: { command, payload },
      }),
  };
};

describe('PreviewLifecycleTracker', () => {
  it('tracks single-window readiness with deterministic 1:1 mapping', async () => {
    const harness = makeHarness();
    const tracker = createPreviewLifecycleTracker({
      previewDebuggerServer: harness.previewDebuggerServer,
      ipcRenderer: harness.ipcRenderer,
    });

    expect(tracker.getStatus()).toMatchObject({
      state: 'stopped',
      running: false,
      windowOpen: false,
      debuggerAttached: false,
      runtimeReady: false,
    });

    tracker.markStarting();
    expect(tracker.getStatus().state).toBe('starting');

    harness.setServerState('started');
    harness.setWindows([{ windowId: 12, title: 'Preview' }]);
    await tracker.refreshWindows();
    expect(tracker.getStatus().state).toBe('starting');

    tracker.markLaunchCompleted();
    expect(tracker.getStatus()).toMatchObject({
      state: 'debugger-attaching',
      previewWindowIds: [12],
      windowOpen: true,
      debuggerAttached: false,
    });

    harness.connect('preview-1');
    expect(harness.previewDebuggerServer.sendMessage).toHaveBeenCalledWith(
      'preview-1',
      { command: 'getStatus' }
    );
    harness.message('preview-1', 'status', {
      sceneName: 'Game',
      isPaused: false,
      isInGameEdition: false,
    });
    expect(tracker.getStatus()).toMatchObject({
      state: 'ready',
      debuggerIds: ['preview-1'],
      previewWindowIds: [12],
      debuggerAttached: true,
      runtimeReady: true,
      targets: [
        expect.objectContaining({
          debuggerId: 'preview-1',
          windowId: 12,
          ready: true,
          sceneName: 'Game',
        }),
      ],
    });

    harness.close('preview-1');
    harness.setWindows([]);
    harness.setServerState('stopped');
    await tracker.refreshWindows();
    expect(tracker.getStatus()).toMatchObject({
      state: 'stopped',
      running: false,
      previewWindowIds: [],
      debuggerIds: [],
    });

    tracker.markStarting();
    harness.setServerState('started');
    harness.setWindows([{ windowId: 13, title: 'Preview restarted' }]);
    await tracker.refreshWindows();
    tracker.markLaunchCompleted();
    harness.connect('preview-2');
    harness.message('preview-2', 'status', {
      sceneName: 'Game',
      isPaused: false,
      isInGameEdition: false,
    });
    harness.message('preview-2', 'agent.preview.identity', { windowId: 13 });
    expect(tracker.getStatus()).toMatchObject({
      state: 'ready',
      previewWindowIds: [13],
      debuggerIds: ['preview-2'],
      targets: [
        expect.objectContaining({
          debuggerId: 'preview-2',
          windowId: 13,
          ready: true,
        }),
      ],
    });

    tracker.dispose();
  });

  it('requires all desktop preview windows to be mapped before ready', async () => {
    const harness = makeHarness();
    const tracker = createPreviewLifecycleTracker({
      previewDebuggerServer: harness.previewDebuggerServer,
      ipcRenderer: harness.ipcRenderer,
    });
    harness.setServerState('started');
    harness.setWindows([{ windowId: 12 }, { windowId: 13 }]);
    await tracker.refreshWindows();

    harness.connect('preview-a');
    harness.message('preview-a', 'status', { sceneName: 'Game' });
    harness.message('preview-a', 'agent.preview.identity', { windowId: 12 });
    expect(tracker.getStatus().state).toBe('debugger-attaching');

    harness.connect('preview-b');
    harness.message('preview-b', 'status', { sceneName: 'Game' });
    harness.message('preview-b', 'agent.preview.identity', { windowId: 13 });
    expect(tracker.getStatus()).toMatchObject({
      state: 'ready',
      runtimeReady: true,
    });

    tracker.dispose();
  });

  it('returns actionable timeout and failure diagnostics', async () => {
    const harness = makeHarness();
    const tracker = createPreviewLifecycleTracker({
      previewDebuggerServer: harness.previewDebuggerServer,
      ipcRenderer: harness.ipcRenderer,
    });
    harness.setServerState('started');
    harness.setWindows([{ windowId: 12 }]);
    await tracker.refreshWindows();

    await expect(
      tracker.waitUntilReady({ timeoutMs: 100 })
    ).rejects.toMatchObject({
      code: 'preview_ready_timeout',
      details: expect.objectContaining({
        state: 'debugger-attaching',
        previewWindowIds: [12],
        debuggerIds: [],
      }),
    });

    tracker.markFailed({ code: 'preview_launch_failed', message: 'boom' });
    expect(tracker.getStatus()).toMatchObject({
      state: 'failed',
      failure: {
        code: 'preview_launch_failed',
        message: 'boom',
      },
    });

    tracker.dispose();
  });
});
