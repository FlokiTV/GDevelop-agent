// @flow
import { serializeAgentError } from './core/AgentError';
import { type AgentHost } from './core/AgentHost';

export const COMMAND_REQUEST_CHANNEL = 'gdevelop-agent-integration:command';
export const COMMAND_RESPONSE_CHANNEL =
  'gdevelop-agent-integration:command-response';
export const COMMAND_CANCEL_CHANNEL = 'gdevelop-agent-integration:command-cancel';

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
  const abortControllers = new Map();

  const onCancel = (event: any, payload: {| requestId?: string |}) => {
    const requestId = payload && payload.requestId;
    if (!requestId || typeof requestId !== 'string') return;
    const controller = abortControllers.get(requestId);
    if (controller) controller.abort();
  };

  const onCommand = async (
    event: any,
    payload: {|
      requestId: string,
      command: string,
      input?: any,
      traceId?: string,
      expectedRevision?: number,
      idempotencyKey?: string,
    |}
  ) => {
    const {
      requestId,
      command,
      input,
      traceId,
      expectedRevision,
      idempotencyKey,
    } = payload || {};
    if (!requestId || typeof requestId !== 'string') return;
    const abortController = new AbortController();
    abortControllers.set(requestId, abortController);

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
        ...(typeof idempotencyKey === 'string' && idempotencyKey
          ? { idempotencyKey }
          : {}),
        signal: abortController.signal,
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
    } finally {
      abortControllers.delete(requestId);
    }
  };

  ipcRenderer.on(COMMAND_REQUEST_CHANNEL, onCommand);
  ipcRenderer.on(COMMAND_CANCEL_CHANNEL, onCancel);
  return () => {
    ipcRenderer.removeListener(COMMAND_REQUEST_CHANNEL, onCommand);
    ipcRenderer.removeListener(COMMAND_CANCEL_CHANNEL, onCancel);
    abortControllers.forEach(controller => controller.abort());
    abortControllers.clear();
  };
};
