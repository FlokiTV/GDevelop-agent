// @flow
import {
  attachRendererIntegrationHost,
  createRendererIntegrationHostBinding,
  registerRendererIntegration,
  RENDERER_REGISTER_CHANNEL,
} from './RendererIntegrationLifecycle';
import {
  COMMAND_REQUEST_CHANNEL,
  COMMAND_RESPONSE_CHANNEL,
} from './RendererCommandAdapter';

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

describe('RendererIntegrationLifecycle', () => {
  it('registers the renderer and unregisters it on cleanup', () => {
    const ipcRenderer = createIpcRenderer();
    const dispose = registerRendererIntegration({
      ipcRenderer,
      fileIdentifier: 'C:\\Games\\project.json',
    });

    expect(ipcRenderer.send).toHaveBeenNthCalledWith(
      1,
      RENDERER_REGISTER_CHANNEL,
      {
        fileIdentifier: 'C:\\Games\\project.json',
        active: true,
      }
    );

    dispose();

    expect(ipcRenderer.send).toHaveBeenNthCalledWith(
      2,
      RENDERER_REGISTER_CHANNEL,
      {
        fileIdentifier: null,
        active: false,
      }
    );
  });

  it('updates the host without aborting a command already in flight', async () => {
    const ipcRenderer = createIpcRenderer();
    let firstSignal;
    let resolveFirst;
    const firstAgentHost = {
      execute: jest.fn(
        (command, input, context) =>
          new Promise(resolve => {
            firstSignal = context.signal;
            resolveFirst = resolve;
          })
      ),
    };
    const secondAgentHost = {
      execute: jest.fn(async () => ({ host: 'second' })),
    };
    const binding = createRendererIntegrationHostBinding({
      ipcRenderer,
      agentHost: firstAgentHost,
    });
    const listener = ipcRenderer.listeners.get(COMMAND_REQUEST_CHANNEL);

    const firstRequest = listener(null, {
      requestId: 'req-in-flight',
      command: 'build.start',
    });
    expect(firstSignal.aborted).toBe(false);

    binding.updateAgentHost(secondAgentHost);
    expect(firstSignal.aborted).toBe(false);

    resolveFirst({ host: 'first' });
    await firstRequest;
    await listener(null, {
      requestId: 'req-after-update',
      command: 'project.status',
    });

    expect(firstAgentHost.execute).toHaveBeenCalledTimes(1);
    expect(secondAgentHost.execute).toHaveBeenCalledTimes(1);
    expect(ipcRenderer.send).toHaveBeenCalledWith(
      COMMAND_RESPONSE_CHANNEL,
      expect.objectContaining({
        requestId: 'req-in-flight',
        ok: true,
        result: { host: 'first' },
      })
    );
    expect(ipcRenderer.send).toHaveBeenCalledWith(
      COMMAND_RESPONSE_CHANNEL,
      expect.objectContaining({
        requestId: 'req-after-update',
        ok: true,
        result: { host: 'second' },
      })
    );

    binding.dispose();
  });

  it('attaches one command listener and removes the same listener on cleanup', async () => {
    const ipcRenderer = createIpcRenderer();
    const agentHost = {
      execute: jest.fn(async () => ({ ok: true })),
    };
    const dispose = attachRendererIntegrationHost({ ipcRenderer, agentHost });
    const listener = ipcRenderer.listeners.get(COMMAND_REQUEST_CHANNEL);

    expect(typeof listener).toBe('function');
    await listener(null, {
      requestId: 'req-1',
      command: 'project.status',
    });
    expect(agentHost.execute).toHaveBeenCalledTimes(1);
    expect(ipcRenderer.send).toHaveBeenCalledWith(
      COMMAND_RESPONSE_CHANNEL,
      expect.objectContaining({ requestId: 'req-1', ok: true })
    );

    dispose();

    expect(ipcRenderer.removeListener).toHaveBeenCalledWith(
      COMMAND_REQUEST_CHANNEL,
      listener
    );
    expect(ipcRenderer.listeners.has(COMMAND_REQUEST_CHANNEL)).toBe(false);
  });
});
