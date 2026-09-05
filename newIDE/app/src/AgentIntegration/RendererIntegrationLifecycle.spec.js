// @flow
import {
  attachRendererIntegrationHost,
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

    expect(ipcRenderer.send).toHaveBeenNthCalledWith(1, RENDERER_REGISTER_CHANNEL, {
      fileIdentifier: 'C:\\Games\\project.json',
      active: true,
    });

    dispose();

    expect(ipcRenderer.send).toHaveBeenNthCalledWith(2, RENDERER_REGISTER_CHANNEL, {
      fileIdentifier: null,
      active: false,
    });
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
