// @flow
import debuggerDump from '../fixtures/DebuggerGameDataDump.json';
import {
  createRuntimeTelemetry,
  evaluateRuntimeCondition,
  summarizeRuntimeDump,
  transformVariablesContainer,
} from './RuntimeTelemetry';

const cloneDump = () => JSON.parse(JSON.stringify(debuggerDump));

const createDebuggerServer = ({
  dump = debuggerDump,
  onRefresh,
  dropFirstRefresh = false,
}: {|
  dump?: any,
  onRefresh?: number => any,
  dropFirstRefresh?: boolean,
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
    getExistingPreviewDebuggerIds: jest.fn(() => ['preview-1']),
    getExistingDebuggerIds: jest.fn(() => ['preview-1']),
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
  };
  return server;
};

describe('AgentApi RuntimeTelemetry', () => {
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
});
