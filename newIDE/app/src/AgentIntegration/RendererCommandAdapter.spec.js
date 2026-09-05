// @flow
import {
  attachRendererAgentHostToIpc,
  COMMAND_REQUEST_CHANNEL,
  COMMAND_RESPONSE_CHANNEL,
  COMMAND_CANCEL_CHANNEL,
} from './RendererCommandAdapter';

describe('RendererCommandAdapter', () => {
  const createIpcRenderer = () => {
    const listeners = new Map();
    return {
      listeners,
      on: jest.fn((channel, listener) => listeners.set(channel, listener)),
      removeListener: jest.fn((channel, listener) => {
        if (listeners.get(channel) === listener) listeners.delete(channel);
      }),
      send: jest.fn(),
    };
  };

  test('executes commands and returns the AgentHost result envelope', async () => {
    const ipcRenderer = createIpcRenderer();
    const agentHost = {
      execute: jest.fn(async (command, input, context) => ({
        command,
        data: input,
        meta: { traceId: context.traceId },
      })),
    };
    const detach = attachRendererAgentHostToIpc({ ipcRenderer, agentHost });

    const listener = ipcRenderer.listeners.get(COMMAND_REQUEST_CHANNEL);
    await listener(null, {
      requestId: 'request-1',
      command: 'project.status',
      input: {},
      expectedRevision: 7,
      idempotencyKey: 'retry-1',
    });

    expect(agentHost.execute).toHaveBeenCalledWith('project.status', {}, {
      traceId: 'request-1',
      expectedRevision: 7,
      idempotencyKey: 'retry-1',
      signal: expect.anything(),
    });
    expect(ipcRenderer.send).toHaveBeenCalledWith(COMMAND_RESPONSE_CHANNEL, {
      requestId: 'request-1',
      ok: true,
      result: expect.objectContaining({ command: 'project.status' }),
    });

    detach();
    expect(ipcRenderer.listeners.has(COMMAND_REQUEST_CHANNEL)).toBe(false);
  });

  test('aborts an in-flight AgentHost command when the desktop bridge cancels it', async () => {
    const ipcRenderer = createIpcRenderer();
    let capturedSignal;
    let release;
    const agentHost = {
      execute: jest.fn((command, input, context) => {
        capturedSignal = context.signal;
        return new Promise(resolve => {
          release = resolve;
        });
      }),
    };
    attachRendererAgentHostToIpc({ ipcRenderer, agentHost });

    const listener = ipcRenderer.listeners.get(COMMAND_REQUEST_CHANNEL);
    const commandPromise = listener(null, {
      requestId: 'request-cancel',
      command: 'validation.run',
      input: {},
    });
    expect(capturedSignal.aborted).toBe(false);

    const cancelListener = ipcRenderer.listeners.get(COMMAND_CANCEL_CHANNEL);
    cancelListener(null, { requestId: 'request-cancel' });
    expect(capturedSignal.aborted).toBe(true);

    release({ command: 'validation.run', data: {}, meta: {} });
    await commandPromise;
  });

  test('serializes command failures for the desktop bridge', async () => {
    const ipcRenderer = createIpcRenderer();
    const error: any = new Error('No project');
    error.code = 'no_project_open';
    const agentHost = { execute: jest.fn(async () => Promise.reject(error)) };
    attachRendererAgentHostToIpc({ ipcRenderer, agentHost });

    const listener = ipcRenderer.listeners.get(COMMAND_REQUEST_CHANNEL);
    await listener(null, {
      requestId: 'request-2',
      command: 'events.read',
      input: {},
      traceId: 'trace-2',
    });

    expect(ipcRenderer.send).toHaveBeenCalledWith(COMMAND_RESPONSE_CHANNEL, {
      requestId: 'request-2',
      ok: false,
      error: expect.objectContaining({
        code: 'no_project_open',
        message: 'No project',
      }),
    });
  });
});
