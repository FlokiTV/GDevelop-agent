// @flow
import debuggerDump from '../fixtures/DebuggerGameDataDump.json';
import {
  createRuntimeTelemetry,
  evaluateRuntimeCondition,
  selectRuntimeValue,
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
  onTimeControl,
  onEventTrace,
}: {|
  dump?: any,
  onRefresh?: number => any,
  dropFirstRefresh?: boolean,
  previewDebuggerIds?: Array<string>,
  onTimeControl?: any => any,
  onEventTrace?: any => any,
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
        } else if (
          typeof message.command === 'string' &&
          message.command.startsWith('timeControl.')
        ) {
          const payload = onTimeControl
            ? onTimeControl(message)
            : {
                ok: true,
                operation: message.command.replace('timeControl.', ''),
                runtimeState: 'paused',
                isPaused: true,
                sceneName: 'New scene',
                timeScale: 1,
                sceneTimeFromStartMs: 100,
                framesAdvanced:
                  message.command === 'timeControl.stepFrames'
                    ? message.frames
                    : 0,
                elapsedSimulatedTimeMs:
                  message.command === 'timeControl.advanceTime'
                    ? message.milliseconds
                    : message.command === 'timeControl.stepFrames'
                    ? message.frames * (message.frameDurationMs || 1000 / 60)
                    : 0,
                wallClockElapsedMs: 1,
                wallClockWaitUsed: false,
              };
          callbacks.onHandleParsedMessage({
            id,
            parsedMessage: {
              command: 'timeControl.status',
              payload,
            },
          });
        } else if (
          typeof message.command === 'string' &&
          message.command.startsWith('eventTrace.')
        ) {
          const payload = onEventTrace
            ? onEventTrace(message)
            : {
                ok: true,
                operation: message.command.replace('eventTrace.', ''),
                enabled: true,
                mode: 'detailed',
                recordCount: 0,
                records: [],
                projectPersistent: false,
              };
          callbacks.onHandleParsedMessage({
            id,
            parsedMessage: {
              command: 'eventTrace.result',
              payload,
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

  it('controls paused runtime time deterministically without wall-clock waits', async () => {
    let simulatedTimeMs = 100;
    let timeScale = 1;
    let paused = true;
    const server = createDebuggerServer({
      onTimeControl: message => {
        if (message.command === 'timeControl.pause') paused = true;
        if (message.command === 'timeControl.resume') paused = false;
        if (message.command === 'timeControl.setTimeScale') {
          timeScale = message.timeScale;
        }
        let framesAdvanced = 0;
        let elapsedSimulatedTimeMs = 0;
        if (message.command === 'timeControl.stepFrames') {
          framesAdvanced = message.frames;
          elapsedSimulatedTimeMs =
            message.frames * (message.frameDurationMs || 1000 / 60) * timeScale;
          simulatedTimeMs += elapsedSimulatedTimeMs;
        }
        if (message.command === 'timeControl.advanceTime') {
          elapsedSimulatedTimeMs = message.milliseconds;
          framesAdvanced = Math.ceil(
            message.milliseconds /
              ((message.frameDurationMs || 1000 / 60) * timeScale)
          );
          simulatedTimeMs += elapsedSimulatedTimeMs;
        }
        return {
          ok: true,
          runtimeState: paused ? 'paused' : 'running',
          isPaused: paused,
          isInGameEdition: false,
          sceneName: 'New scene',
          timeScale,
          sceneTimeFromStartMs: simulatedTimeMs,
          framesAdvanced,
          elapsedSimulatedTimeMs,
          wallClockElapsedMs: 1,
          wallClockWaitUsed: false,
          deterministicStepping: {
            supported: true,
            ready: paused,
            requiresPaused: true,
            timeDomain: 'simulated-game-time',
          },
        };
      },
    });
    const telemetry = createRuntimeTelemetry(server);

    await expect(telemetry.getTimeControlStatus()).resolves.toMatchObject({
      runtimeState: 'paused',
      timeScale: 1,
      integrations: {
        input: { send: 'preview.input.send' },
        asyncJobs: { start: 'agent.jobs.start' },
      },
    });
    await expect(telemetry.pauseRuntime()).resolves.toMatchObject({
      runtimeState: 'paused',
      timeDomain: 'simulated-game-time',
      wallClockWaitUsed: false,
    });
    await expect(
      telemetry.stepRuntimeFrames({ frames: 3, frameDurationMs: 10 })
    ).resolves.toMatchObject({
      framesAdvanced: 3,
      elapsedSimulatedTimeMs: 30,
      runtimeState: 'paused',
    });
    await expect(
      telemetry.setRuntimeTimeScale({ timeScale: 2 })
    ).resolves.toMatchObject({ timeScale: 2 });
    await expect(
      telemetry.advanceRuntimeTime({ milliseconds: 200, frameDurationMs: 10 })
    ).resolves.toMatchObject({
      elapsedSimulatedTimeMs: 200,
      runtimeState: 'paused',
    });
    await expect(telemetry.resumeRuntime()).resolves.toMatchObject({
      runtimeState: 'running',
    });

    telemetry.dispose();
  });

  it('configures, reads and clears ephemeral event tracing through the debugger protocol', async () => {
    const seen = [];
    const server = createDebuggerServer({
      onEventTrace: message => {
        seen.push(message);
        if (message.command === 'eventTrace.read') {
          return {
            ok: true,
            operation: 'read',
            enabled: true,
            mode: 'detailed',
            total: 1,
            recordCount: 1,
            records: [
              {
                kind: 'instruction',
                instructionKind: 'condition',
                phase: 'after',
                eventPath: [0],
                instructionPath: [0],
                result: true,
              },
            ],
            projectPersistent: false,
          };
        }
        return {
          ok: true,
          operation: message.command.replace('eventTrace.', ''),
          enabled: message.command !== 'eventTrace.clear',
          mode: 'detailed',
          recordCount: 0,
          records: [],
          projectPersistent: false,
        };
      },
    });
    const telemetry = createRuntimeTelemetry(server);

    await expect(
      telemetry.configureEventTrace({
        mode: 'detailed',
        sceneName: 'New scene',
        maxRecords: 25,
        eventPaths: [[0]],
        breakpoints: [{ kind: 'event', phase: 'branch', eventPath: [0] }],
      })
    ).resolves.toMatchObject({
      operation: 'configure',
      projectPersistent: false,
    });
    await expect(
      telemetry.readEventTrace({ offset: 0, limit: 20 })
    ).resolves.toMatchObject({
      operation: 'read',
      total: 1,
      records: [
        expect.objectContaining({
          kind: 'instruction',
          result: true,
        }),
      ],
    });
    await expect(telemetry.clearEventTrace()).resolves.toMatchObject({
      operation: 'clear',
      projectPersistent: false,
    });

    expect(seen[0]).toMatchObject({
      command: 'eventTrace.configure',
      options: {
        mode: 'detailed',
        sceneName: 'New scene',
        maxRecords: 25,
        eventPaths: [[0]],
      },
    });
    expect(seen[1]).toMatchObject({
      command: 'eventTrace.read',
      options: { offset: 0, limit: 20 },
    });
    expect(seen[2]).toMatchObject({ command: 'eventTrace.clear' });

    telemetry.dispose();
  });

  it('waits on a predicate by stepping simulated time instead of sleeping', async () => {
    let simulatedTimeMs = 0;
    const makeDumpAtTime = () => {
      const dump = cloneDump();
      const scene = dump._sceneStack._stack[dump._sceneStack._stack.length - 1];
      scene._timeManager._timeFromStart = simulatedTimeMs;
      scene._timeManager._elapsedTime = simulatedTimeMs > 0 ? 20 : 0;
      scene._timeManager._timeScale = 1;
      dump._paused = true;
      return dump;
    };
    const server = createDebuggerServer({
      dump: makeDumpAtTime(),
      onRefresh: () => makeDumpAtTime(),
      onTimeControl: message => {
        if (message.command === 'timeControl.stepFrames') {
          const elapsed =
            (message.frames || 1) * (message.frameDurationMs || 1000 / 60);
          simulatedTimeMs += elapsed;
          return {
            ok: true,
            operation: 'step-frames',
            runtimeState: 'paused',
            isPaused: true,
            sceneName: 'New scene',
            timeScale: 1,
            sceneTimeFromStartMs: simulatedTimeMs,
            framesAdvanced: message.frames || 1,
            elapsedSimulatedTimeMs: elapsed,
            wallClockElapsedMs: 0,
            wallClockWaitUsed: false,
          };
        }
        return {
          ok: true,
          runtimeState: 'paused',
          isPaused: true,
          sceneName: 'New scene',
          timeScale: 1,
          sceneTimeFromStartMs: simulatedTimeMs,
          framesAdvanced: 0,
          elapsedSimulatedTimeMs: 0,
          wallClockElapsedMs: 0,
          wallClockWaitUsed: false,
        };
      },
    });
    const telemetry = createRuntimeTelemetry(server);
    const result = await telemetry.waitUntilRuntime({
      condition: {
        selector: {
          kind: 'scene-time',
          metric: 'time-from-start-ms',
        },
        operator: 'gte',
        value: 60,
      },
      frameDurationMs: 20,
      maxFrames: 10,
    });
    expect(result).toMatchObject({
      passed: true,
      conditionMet: true,
      framesAdvanced: 3,
      elapsedSimulatedTimeMs: 60,
      wallClockWaitUsed: false,
      timeDomain: 'simulated-game-time',
      snapshot: {
        scene: { timeFromStartMs: 60 },
      },
    });
    telemetry.dispose();
  });

  it('turns runtime time-control protocol failures into structured errors', async () => {
    const server = createDebuggerServer({
      onTimeControl: message => ({
        ok: false,
        error: {
          code:
            message.command === 'timeControl.stepFrames'
              ? 'runtime_time_control_requires_paused'
              : 'runtime_time_control_failed',
          details: { command: message.command },
        },
      }),
    });
    const telemetry = createRuntimeTelemetry(server);
    await expect(
      telemetry.stepRuntimeFrames({ frames: 1 })
    ).rejects.toMatchObject({
      code: 'runtime_time_control_requires_paused',
      details: { command: 'timeControl.stepFrames' },
    });
    telemetry.dispose();
  });

  it('selects simulated scene time and time scale through typed selectors', () => {
    const snapshot = summarizeRuntimeDump(debuggerDump, { maxInstances: 10 });
    expect(
      selectRuntimeValue(snapshot, {
        kind: 'scene-time',
        metric: 'time-from-start-ms',
      })
    ).toMatchObject({
      found: true,
      value: snapshot.scene.timeFromStartMs,
      valueType: 'number',
    });
    expect(
      selectRuntimeValue(snapshot, {
        kind: 'scene-time',
        metric: 'time-scale',
      })
    ).toMatchObject({
      found: true,
      value: snapshot.scene.timeScale,
      valueType: 'number',
    });
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

  it('selects typed global, scene, object property and instance variable values', () => {
    const snapshot = {
      globalVariables: {
        Money: { type: 'number', value: 42 },
        Config: {
          type: 'structure',
          value: {
            Locale: { type: 'string', value: 'pt-BR' },
          },
        },
      },
      scene: {
        name: 'CoinIdle',
        variables: {
          Round: { type: 'number', value: 3 },
        },
      },
      objects: {
        RuleText: {
          count: 1,
          instances: [
            {
              id: 7,
              name: 'RuleText',
              type: 'TextObject::Text',
              text: 'Cara ou coroa',
              x: 120,
              variables: {
                Visible: { type: 'boolean', value: true },
              },
            },
          ],
        },
      },
    };

    expect(
      selectRuntimeValue(snapshot, {
        kind: 'global-variable',
        path: 'Money',
      })
    ).toMatchObject({ value: 42, valueType: 'number', found: true });
    expect(
      selectRuntimeValue(snapshot, {
        kind: 'global-variable',
        path: 'Config.Locale',
      })
    ).toMatchObject({ value: 'pt-BR', valueType: 'string', found: true });
    expect(
      selectRuntimeValue(snapshot, {
        kind: 'scene-variable',
        path: 'Round',
      })
    ).toMatchObject({ value: 3, valueType: 'number', found: true });
    expect(
      selectRuntimeValue(snapshot, {
        kind: 'object-property',
        objectName: 'RuleText',
        property: 'text',
      })
    ).toMatchObject({
      value: 'Cara ou coroa',
      valueType: 'string',
      objectName: 'RuleText',
      instanceIndex: 0,
    });
    expect(
      selectRuntimeValue(snapshot, {
        kind: 'object-variable',
        objectName: 'RuleText',
        instanceId: 7,
        path: 'Visible',
      })
    ).toMatchObject({ value: true, valueType: 'boolean', instanceId: 7 });
    expect(
      evaluateRuntimeCondition(snapshot, {
        selector: {
          kind: 'object-property',
          objectName: 'RuleText',
          property: 'text',
        },
        operator: 'contains',
        value: 'coroa',
      })
    ).toMatchObject({ passed: true, actual: 'Cara ou coroa' });
  });

  it('returns clear selector diagnostics for absent runtime state', () => {
    const snapshot = {
      globalVariables: {},
      scene: null,
      objects: {},
    };

    expect(() =>
      selectRuntimeValue(snapshot, {
        kind: 'global-variable',
        path: 'Money',
      })
    ).toThrow(expect.objectContaining({ code: 'runtime_variable_not_found' }));
    expect(() =>
      selectRuntimeValue(snapshot, {
        kind: 'object-property',
        objectName: 'Missing',
        property: 'text',
      })
    ).toThrow(expect.objectContaining({ code: 'runtime_object_not_found' }));

    expect(
      evaluateRuntimeCondition(snapshot, {
        selector: { kind: 'scene-variable', path: 'Ready' },
        operator: 'exists',
      })
    ).toMatchObject({
      passed: false,
      actual: undefined,
      diagnostic: { code: 'runtime_scene_unavailable' },
    });
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

  it('reports window-open/debugger-attaching as runtime not ready instead of preview not running', async () => {
    const server = createDebuggerServer({ previewDebuggerIds: [] });
    const previewLifecycleTracker = {
      getStatus: jest.fn(() => ({
        state: 'debugger-attaching',
        serverState: 'started',
        previewWindowIds: [12],
        debuggerIds: [],
        targets: [{ debuggerId: null, windowId: 12, ready: false }],
      })),
    };
    const telemetry = createRuntimeTelemetry(server, {
      previewLifecycleTracker,
    });

    await expect(telemetry.getStatus()).rejects.toMatchObject({
      code: 'preview_runtime_not_ready',
      details: expect.objectContaining({
        state: 'debugger-attaching',
        previewWindowIds: [12],
      }),
    });
    expect(() => telemetry.getLogs()).toThrow(
      expect.objectContaining({ code: 'preview_runtime_not_ready' })
    );
    await expect(telemetry.getSnapshot()).rejects.toMatchObject({
      code: 'preview_runtime_not_ready',
    });

    telemetry.dispose();
  });

  it('uses the lifecycle debugger-to-window mapping for desktop snapshots', async () => {
    const server = createDebuggerServer();
    const snapshotProvider = jest.fn(async request => ({
      previewWindowId: request.previewWindowId,
      snapshotSource: 'bounded-preview-runtime',
      scene: { name: 'Mapped scene' },
      objects: {},
      globalVariables: {},
    }));
    const lifecycle = {
      state: 'ready',
      targets: [
        {
          debuggerId: 'preview-1',
          windowId: 12,
          ready: true,
          sceneName: 'Mapped scene',
        },
      ],
    };
    const telemetry = createRuntimeTelemetry(server, {
      snapshotProvider,
      previewLifecycleTracker: {
        getStatus: jest.fn(() => lifecycle),
      },
    });

    const snapshot = await telemetry.getSnapshot({ maxInstances: 1 });
    expect(snapshotProvider).toHaveBeenCalledWith(
      expect.objectContaining({ previewWindowId: 12, maxInstances: 1 })
    );
    expect(snapshot).toMatchObject({
      debuggerId: 'preview-1',
      previewWindowId: 12,
      lifecycleState: 'ready',
      lifecycleTarget: expect.objectContaining({
        debuggerId: 'preview-1',
        windowId: 12,
      }),
      scene: { name: 'Mapped scene' },
    });

    const status = await telemetry.getStatus();
    expect(status).toMatchObject({
      debuggerId: 'preview-1',
      previewWindowId: 12,
      lifecycleState: 'ready',
    });

    const logs = telemetry.getLogs();
    expect(logs).toMatchObject({
      debuggerId: 'preview-1',
      previewWindowId: 12,
      lifecycleState: 'ready',
    });

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

  it('inspects and waits on typed selectors through bounded snapshots', async () => {
    const server = createDebuggerServer();
    let calls = 0;
    const snapshotProvider = jest.fn(async request => {
      calls += 1;
      return {
        snapshotSource: 'bounded-preview-runtime',
        paused: false,
        scene: {
          name: 'CoinIdle',
          variables: {
            CurrentLanguage: {
              type: 'string',
              value: calls >= 2 ? 'pt-BR' : 'en',
            },
          },
        },
        globalVariables: {
          Money: { type: 'number', value: 123 },
        },
        objects: {
          RuleText: {
            count: 1,
            instances: [
              {
                id: 1,
                name: 'RuleText',
                type: 'TextObject::Text',
                text: 'Cara ou coroa',
                variables: {},
                behaviors: [],
              },
            ],
            truncated: false,
          },
        },
        totalInstances: 1,
        includedInstances: 1,
        truncatedInstances: 0,
      };
    });
    const telemetry = createRuntimeTelemetry(server, { snapshotProvider });

    await expect(
      telemetry.inspectRuntime({
        selector: { kind: 'global-variable', path: 'Money' },
      })
    ).resolves.toMatchObject({
      value: 123,
      valueType: 'number',
      snapshotSource: 'bounded-preview-runtime',
    });

    await expect(
      telemetry.inspectRuntime({
        selector: {
          kind: 'object-property',
          objectName: 'RuleText',
          property: 'text',
        },
      })
    ).resolves.toMatchObject({
      value: 'Cara ou coroa',
      objectName: 'RuleText',
    });
    expect(snapshotProvider).toHaveBeenLastCalledWith(
      expect.objectContaining({ objectNames: ['RuleText'] })
    );

    calls = 0;
    const waited = await telemetry.waitFor({
      condition: {
        selector: { kind: 'scene-variable', path: 'CurrentLanguage' },
        operator: 'equals',
        value: 'pt-BR',
      },
      timeoutMs: 1000,
      intervalMs: 100,
    });
    expect(waited).toMatchObject({
      passed: true,
      actual: 'pt-BR',
      timedOut: false,
      attempts: 2,
    });
    expect(server.sendMessage).not.toHaveBeenCalled();
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
    const previewLifecycleTracker = {
      refreshWindows: jest.fn(async () => {}),
      getStatus: jest.fn(() => ({
        state: 'ready',
        targets: [
          {
            debuggerId: 'preview-1',
            windowId: 12,
            ready: true,
            windowState: {
              contentBounds: { x: 10, y: 20, width: 1280, height: 720 },
              bounds: { x: 2, y: 3, width: 1296, height: 759 },
            },
          },
        ],
      })),
    };
    const telemetry = createRuntimeTelemetry(server, {
      snapshotProvider,
      previewLifecycleTracker,
    });

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
      viewport: {
        width: 1280,
        height: 720,
        devicePixelRatio: null,
        units: 'device-independent-pixels',
        source: 'electron-content-bounds',
        outerBounds: { x: 2, y: 3, width: 1296, height: 759 },
      },
    });
    expect(previewLifecycleTracker.refreshWindows).toHaveBeenCalledTimes(1);
    expect(snapshotProvider).toHaveBeenCalledTimes(1);
    expect(server.sendMessage).toHaveBeenCalledWith('preview-1', {
      command: 'refresh',
    });
    telemetry.dispose();
  });
});
