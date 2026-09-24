// @flow
import { AgentHost } from '../core/AgentHost';
import { createRuntimeCommandDescriptors } from './RuntimeCommands';

const makeHost = (runtimeTelemetry: any) =>
  new AgentHost({
    environment: {},
    descriptors: createRuntimeCommandDescriptors({ runtimeTelemetry }),
  });

describe('RuntimeCommands', () => {
  test('delegates status, snapshot, inspect, logs, assert and wait-for', async () => {
    const runtimeTelemetry = {
      getStatus: jest.fn(async input => ({ kind: 'status', input })),
      getSnapshot: jest.fn(async input => ({ kind: 'snapshot', input })),
      inspectRuntime: jest.fn(async input => ({ kind: 'inspect', input })),
      getLogs: jest.fn(input => ({ kind: 'logs', input })),
      assertRuntime: jest.fn(async input => ({ passed: true, input })),
      waitFor: jest.fn(async input => ({ matched: true, input })),
    };
    const host = makeHost(runtimeTelemetry);

    await expect(
      host.execute('runtime.status', { debuggerId: 'a' })
    ).resolves.toMatchObject({ data: { kind: 'status' } });
    await expect(
      host.execute('runtime.snapshot', { debuggerId: 'b' })
    ).resolves.toMatchObject({ data: { kind: 'snapshot' } });
    await expect(
      host.execute('runtime.inspect', {
        selector: { kind: 'global-variable', path: 'Money' },
      })
    ).resolves.toMatchObject({ data: { kind: 'inspect' } });
    await expect(
      host.execute('runtime.logs', { limit: 10 })
    ).resolves.toMatchObject({ data: { kind: 'logs' } });
    await expect(
      host.execute('runtime.assert', {
        condition: {
          selector: { kind: 'global-variable', path: 'Money' },
          operator: 'gte',
          value: 0,
        },
      })
    ).resolves.toMatchObject({ data: { passed: true } });
    await expect(
      host.execute('runtime.wait-for', {
        condition: {
          selector: { kind: 'scene-variable', path: 'Ready' },
          operator: 'truthy',
        },
        timeoutMs: 1000,
      })
    ).resolves.toMatchObject({ data: { matched: true } });
    expect(host.describeCommand('runtime.inspect').inputSchema).toMatchObject({
      additionalProperties: false,
      required: ['selector'],
    });
    expect(host.describeCommand('runtime.wait-for').metadata).toMatchObject({
      longRunning: true,
      defaultTimeoutMs: 120000,
    });
  });

  test('returns a structured error when telemetry is unavailable', async () => {
    const host = makeHost(null);
    await expect(host.execute('runtime.snapshot')).rejects.toMatchObject({
      code: 'preview_debugger_unavailable',
    });
  });
});
