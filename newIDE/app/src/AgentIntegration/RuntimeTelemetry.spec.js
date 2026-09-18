// @flow
import debuggerDump from '../fixtures/DebuggerGameDataDump.json';
import {
  createRuntimeTelemetry,
  evaluateRuntimeCondition,
  summarizeProfilerOutput,
  summarizeRuntimeDump,
  transformVariablesContainer,
} from './RuntimeTelemetry';

const cloneDump = () => JSON.parse(JSON.stringify(debuggerDump));

const createDebuggerServer = ({
  dump = debuggerDump,
  onRefresh,
  dropFirstRefresh = false,
  previewDebuggerIds = ['preview-1'],
}: {|
  dump?: any,
  onRefresh?: number => any,
  dropFirstRefresh?: boolean,
  previewDebuggerIds?: Array<string>,
|} = {}) => {
  let callbacks = null;
  let refreshCount = 0;
  const server = {
    registerCallbacks: jest.fn(nextCallbacks => {
      callbacks = nextCallbacks;
      return () => {
        callbacks = null;
      };
    }),
    getExistingPreviewDebuggerIds: jest.fn(() => previewDebuggerIds),
    getExistingDebuggerIds: jest.fn(() => previewDebuggerIds),
    sendMessage: jest.fn((id, message) => {
      Promise.resolve().then(() => {
        if (!callbacks) return;
        if (message.command === 'getStatus') {
          callbacks.onHandleParsedMessage({
            id,
            parsedMessage: {
              command: 'status',
              payload: {
                isPaused: false,
                isInGameEdition: false,
                sceneName: 'New scene',
              },
            },
          });
        } else if (message.command === 'refresh') {
          refreshCount += 1;
          if (dropFirstRefresh && refreshCount === 1) return;
          callbacks.onHandleParsedMessage({
            id,
            parsedMessage: {
              command: 'dump',
              payload: onRefresh ? onRefresh(refreshCount) : dump,
            },
          });
        }
      });
    }),
    emitLog: log => {
      if (!callbacks) return;
      callbacks.onHandleParsedMessage({
        id: 'preview-1',
        parsedMessage: { command: 'console.log', payload: log },
      });
    },
    emitMessage: (command, payload = null, id = 'preview-1') => {
      if (!callbacks) return;
      callbacks.onHandleParsedMessage({
        id,
        parsedMessage: { command, payload },
      });
    },
  };
  return server;
};

describe('AgentIntegration RuntimeTelemetry', () => {
  it('summarizes scene, time, instances, variables and behaviors', () => {
    const snapshot = summarizeRuntimeDump(debuggerDump, { maxInstances: 200 });

    expect(snapshot.scene.name).toBe('New scene');
    expect(snapshot.scene.elapsedTimeMs).toBeCloseTo(16.666, 2);
    expect(snapshot.scene.fpsApprox).toBeCloseTo(60, 0);
    expect(snapshot.scene.variables.Score.value).toBe(0);
    expect(snapshot.objects.Player.count).toBe(1);
    expect(snapshot.objects.Coin.count).toBe(12);
    expect(snapshot.objects.Player.instances[0].x).toBeCloseTo(37.2766, 3);
    expect(snapshot.objects.Player.instances[0].behaviors).toEqual(
      expect.any(Array)
    );
    expect(snapshot.totalInstances).toBeGreaterThan(0);
  });

  it('limits instance payloads globally', () => {
    const snapshot = summarizeRuntimeDump(debuggerDump, { maxInstances: 3 });
    expect(snapshot.includedInstances).toBe(3);
    expect(snapshot.truncatedInstances).toBe(snapshot.totalInstances - 3);
  });

  it('keeps snapshots bounded with hundreds of runtime instances', () => {
    const dump = cloneDump();
    const scene = dump._sceneStack._stack[0];
    const template = scene._instances.items.Player[0];
    scene._instances.items.StressObject = Array.from(
      { length: 500 },
      (_, index) => ({
        ...template,
        id: `stress-${index}`,
        x: index,
        y: index * 2,
      })
    );

    const snapshot = summarizeRuntimeDump(dump, { maxInstances: 100 });
    expect(snapshot.totalInstances).toBeGreaterThanOrEqual(500);
    expect(snapshot.includedInstances).toBe(100);
    expect(snapshot.truncatedInstances).toBe(snapshot.totalInstances - 100);
    expect(snapshot.objects.StressObject.count).toBe(500);
  });

  it('transforms typed runtime variables', () => {
    const variables = transformVariablesContainer({
      _variables: {
        items: {
          Name: { _type: 'string', _str: 'Player' },
          Score: { _type: 'number', _value: 42 },
          Alive: { _type: 'boolean', _bool: true },
          Stats: {
            _type: 'structure',
            _children: {
              Coins: { _type: 'number', _value: 7 },
            },
          },
        },
      },
    });

    expect(variables.Name).toEqual({ type: 'string', value: 'Player' });
    expect(variables.Score.value).toBe(42);
    expect(variables.Alive.value).toBe(true);
    expect(variables.Stats.value.Coins.value).toBe(7);
  });

  it('evaluates safe path assertions without eval', () => {
    const snapshot = summarizeRuntimeDump(debuggerDump);
    expect(
      evaluateRuntimeCondition(snapshot, {
        path: 'objects.Coin.count',
        operator: 'gte',
        value: 10,
      }).passed
    ).toBe(true);
    expect(
      evaluateRuntimeCondition(snapshot, {
        path: 'scene.name',
        operator: 'equals',
        value: 'Wrong scene',
      }).passed
    ).toBe(false);
  });

  it('requests native status and dump and keeps bounded console logs', async () => {
    const server = createDebuggerServer();
    const telemetry = createRuntimeTelemetry(server);

    const status = await telemetry.getStatus();
    expect(status).toMatchObject({
      debuggerId: 'preview-1',
      isPaused: false,
      sceneName: 'New scene',
    });

    const snapshot = await telemetry.getSnapshot({ maxInstances: 5 });
    expect(snapshot.debuggerId).toBe('preview-1');
    expect(snapshot.scene.name).toBe('New scene');
    expect(snapshot.includedInstances).toBe(5);

    server.emitLog({
      type: 'warning',
      group: 'Game',
      message: 'watch this',
      timestamp: 10,
    });
    const logs = telemetry.getLogs();
    expect(logs.total).toBe(1);
    expect(logs.warnings).toBe(1);
    expect(logs.logs[0].message).toBe('watch this');

    telemetry.dispose();
  });

  it('retries one transient debugger dump timeout', async () => {
    const server = createDebuggerServer({ dropFirstRefresh: true });
    const telemetry = createRuntimeTelemetry(server);

    const snapshot = await telemetry.getSnapshot({
      requestTimeoutMs: 250,
      maxInstances: 1,
    });

    expect(snapshot.scene.name).toBe('New scene');
    expect(server.sendMessage).toHaveBeenCalledTimes(2);
    telemetry.dispose();
  });

  it('prefers the newest preview debugger while hot reload connections overlap', async () => {
    const server = createDebuggerServer({
      previewDebuggerIds: ['preview-old', 'preview-new'],
    });
    const telemetry = createRuntimeTelemetry(server);

    const snapshot = await telemetry.getSnapshot({ maxInstances: 1 });

    expect(snapshot.debuggerId).toBe('preview-new');
    expect(server.sendMessage).toHaveBeenCalledWith('preview-new', {
      command: 'refresh',
    });
    telemetry.dispose();
  });

  it('waits until a runtime condition becomes true', async () => {
    const server = createDebuggerServer({
      onRefresh: count => {
        const dump = cloneDump();
        if (count >= 2) dump._sceneStack._stack[0]._name = 'Won';
        return dump;
      },
    });
    const telemetry = createRuntimeTelemetry(server);

    const result = await telemetry.waitFor({
      condition: {
        path: 'scene.name',
        operator: 'equals',
        value: 'Won',
      },
      timeoutMs: 1000,
      intervalMs: 100,
      maxInstances: 1,
    });

    expect(result.passed).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.attempts).toBe(2);
    telemetry.dispose();
  });

  it('summarizes native profiler output with bounded section paths', () => {
    expect(
      summarizeProfilerOutput({
        framesAverageMeasures: {
          time: 20,
          subsections: {
            events: {
              time: 8,
              subsections: {
                Guard: { time: 3, subsections: {} },
              },
            },
          },
        },
        stats: { framesCount: 10, averageDrawCallsCount: 4 },
      })
    ).toMatchObject({
      averageFrameTimeMs: 20,
      estimatedFps: 50,
      sections: [
        { name: 'events', averageTimeMs: 8 },
        { name: 'events > Guard', averageTimeMs: 3 },
      ],
      stats: { framesCount: 10, averageDrawCallsCount: 4 },
      limitations: { frameDistribution: false, maxSectionTimes: false },
    });
  });

  it('starts and stops the native preview profiler through existing debugger messages', async () => {
    const server = createDebuggerServer();
    const telemetry = createRuntimeTelemetry(server);

    const startPromise = telemetry.startProfiler();
    server.emitMessage('profiler.started');
    await expect(startPromise).resolves.toMatchObject({
      debuggerId: 'preview-1',
      profiling: true,
      alreadyRunning: false,
    });
    expect(server.sendMessage).toHaveBeenCalledWith('preview-1', {
      command: 'profiler.start',
    });
    expect(telemetry.getProfilerStatus()).toMatchObject({
      profiling: true,
      hasOutput: false,
    });

    const stopPromise = telemetry.stopProfiler();
    server.emitMessage('profiler.output', {
      framesAverageMeasures: { time: 25, subsections: {} },
      stats: { framesCount: 5 },
    });
    server.emitMessage('profiler.stopped');
    await expect(stopPromise).resolves.toMatchObject({
      debuggerId: 'preview-1',
      profiling: false,
      output: { averageFrameTimeMs: 25, estimatedFps: 40 },
    });
    expect(telemetry.getProfilerStatus()).toMatchObject({
      profiling: false,
      hasOutput: true,
    });
    telemetry.dispose();
  });

  it('uses the bounded desktop snapshot provider without sending legacy refresh dumps', async () => {
    const server = createDebuggerServer();
    const snapshotProvider = jest.fn(async request => ({
      snapshotSource: 'bounded-preview-runtime',
      ...summarizeRuntimeDump(debuggerDump, request),
    }));
    const telemetry = createRuntimeTelemetry(server, { snapshotProvider });

    const snapshot = await telemetry.getSnapshot({
      maxInstances: 2,
      objectNames: ['Player'],
    });
    expect(snapshot).toMatchObject({
      debuggerId: 'preview-1',
      snapshotSource: 'bounded-preview-runtime',
      scene: { name: 'New scene' },
      objects: { Player: { count: 1 } },
    });
    expect(snapshotProvider).toHaveBeenCalledWith({
      maxInstances: 2,
      objectNames: ['Player'],
    });
    expect(server.sendMessage).not.toHaveBeenCalled();

    const assertion = await telemetry.assertRuntime({
      condition: {
        path: ['objects', 'Player', 'count'],
        operator: 'equals',
        value: 1,
      },
      maxInstances: 2,
      objectNames: ['Player'],
    });
    expect(assertion.passed).toBe(true);
    expect(server.sendMessage).not.toHaveBeenCalled();
    telemetry.dispose();
  });

  it('falls back to the official debugger dump when the desktop snapshot provider fails', async () => {
    const server = createDebuggerServer();
    const providerError: any = new Error(
      'preview runtime snapshot unavailable'
    );
    providerError.code = 'preview_runtime_snapshot_failed';
    const snapshotProvider = jest.fn(async () => {
      throw providerError;
    });
    const telemetry = createRuntimeTelemetry(server, { snapshotProvider });

    const snapshot = await telemetry.getSnapshot({
      maxInstances: 2,
      objectNames: ['Player'],
    });

    expect(snapshot).toMatchObject({
      debuggerId: 'preview-1',
      snapshotSource: 'debugger-dump-fallback',
      snapshotProviderErrorCode: 'preview_runtime_snapshot_failed',
      scene: { name: 'New scene' },
      objects: { Player: { count: 1 } },
    });
    expect(snapshotProvider).toHaveBeenCalledTimes(1);
    expect(server.sendMessage).toHaveBeenCalledWith('preview-1', {
      command: 'refresh',
    });
    telemetry.dispose();
  });
});
