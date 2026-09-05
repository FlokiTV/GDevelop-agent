// @flow
import { type AgentHost } from './core/AgentHost';
import { attachRendererAgentHostToIpc } from './RendererCommandAdapter';

export const RENDERER_REGISTER_CHANNEL = 'gdevelop-agent-integration:register';

type IpcRenderer = {|
  on: (channel: string, listener: Function) => void,
  removeListener: (channel: string, listener: Function) => void,
  send: (channel: string, payload: any) => void,
|};

export const registerRendererIntegration = ({
  ipcRenderer,
  fileIdentifier,
}: {|
  ipcRenderer: IpcRenderer,
  fileIdentifier: ?string,
|}) => {
  ipcRenderer.send(RENDERER_REGISTER_CHANNEL, {
    fileIdentifier,
    active: true,
  });

  return () => {
    ipcRenderer.send(RENDERER_REGISTER_CHANNEL, {
      fileIdentifier: null,
      active: false,
    });
  };
};

export const attachRendererIntegrationHost = ({
  ipcRenderer,
  agentHost,
}: {|
  ipcRenderer: IpcRenderer,
  agentHost: AgentHost,
|}) => attachRendererAgentHostToIpc({ ipcRenderer, agentHost });
