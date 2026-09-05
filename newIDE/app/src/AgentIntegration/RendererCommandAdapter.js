// @flow
import { serializeAgentError } from './core/AgentError';
import { type AgentHost } from './core/AgentHost';

export const COMMAND_REQUEST_CHANNEL = 'gdevelop-agent-integration:command';
export const COMMAND_RESPONSE_CHANNEL =
  'gdevelop-agent-integration:command-response';

type IpcRenderer = {|
  on: (channel: string, listener: Function) => void,
  removeListener: (channel: string, listener: Function) => void,
  send: (channel: string, payload: any) => void,
|};

export const attachRendererAgentHostToIpc = ({
  ipcRenderer,
  agentHost,
}: {|
  ipcRenderer: IpcRenderer,
  agentHost: AgentHost,
|}) => {
  const onCommand = async (
    event: any,
    payload: {|
      requestId: string,
      command: string,
      input?: any,
      traceId?: string,
      expectedRevision?: number,
    |}
  ) => {
    const { requestId, command, input, traceId, expectedRevision } = payload || {};
    if (!requestId || typeof requestId !== 'string') return;

    try {
      if (!command || typeof command !== 'string') {
        throw new Error('missing_command_name');
      }
      const result = await agentHost.execute(command, input, {
        traceId:
          typeof traceId === 'string' && traceId ? traceId : requestId,
        ...(Number.isInteger(expectedRevision) && expectedRevision >= 0
          ? { expectedRevision }
          : {}),
      });
      ipcRenderer.send(COMMAND_RESPONSE_CHANNEL, {
        requestId,
        ok: true,
        result,
      });
    } catch (error) {
      ipcRenderer.send(COMMAND_RESPONSE_CHANNEL, {
        requestId,
        ok: false,
        error: serializeAgentError(error),
      });
    }
  };

  ipcRenderer.on(COMMAND_REQUEST_CHANNEL, onCommand);
  return () => {
    ipcRenderer.removeListener(COMMAND_REQUEST_CHANNEL, onCommand);
  };
};
