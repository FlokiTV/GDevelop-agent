// @flow
import { AgentError } from '../core/AgentError';
import {
  makeCommandMetadata,
  type CommandDescriptor,
} from '../core/CommandRegistry';

const requireTelemetry = (runtimeTelemetry: any) => {
  if (!runtimeTelemetry) {
    throw new AgentError({ code: 'preview_debugger_unavailable' });
  }
  return runtimeTelemetry;
};

export const createRuntimeCommandDescriptors = ({
  runtimeTelemetry,
}: {|
  runtimeTelemetry: any,
|}): Array<CommandDescriptor> => [
  {
    name: 'runtime.status',
    description: 'Return runtime debugger status for a preview target.',
    inputSchema: { type: 'object', additionalProperties: true, properties: {} },
    metadata: makeCommandMetadata(),
    execute: ({ input }) => requireTelemetry(runtimeTelemetry).getStatus(input),
  },
  {
    name: 'runtime.snapshot',
    description: 'Capture a structured runtime snapshot from a preview target.',
    inputSchema: { type: 'object', additionalProperties: true, properties: {} },
    metadata: makeCommandMetadata(),
    execute: ({ input }) => requireTelemetry(runtimeTelemetry).getSnapshot(input),
  },
  {
    name: 'runtime.logs',
    description: 'Read recent runtime console logs and errors.',
    inputSchema: { type: 'object', additionalProperties: true, properties: {} },
    metadata: makeCommandMetadata(),
    execute: ({ input }) => requireTelemetry(runtimeTelemetry).getLogs(input),
  },
  {
    name: 'runtime.assert',
    description: 'Evaluate a runtime assertion against the selected preview target.',
    inputSchema: { type: 'object', additionalProperties: true, properties: {} },
    metadata: makeCommandMetadata({ idempotent: false }),
    execute: ({ input }) => requireTelemetry(runtimeTelemetry).assertRuntime(input),
  },
  {
    name: 'runtime.wait-for',
    description: 'Wait until a runtime assertion or condition becomes true.',
    inputSchema: { type: 'object', additionalProperties: true, properties: {} },
    metadata: makeCommandMetadata({
      idempotent: false,
      longRunning: true,
      defaultTimeoutMs: 2 * 60 * 1000,
    }),
    execute: ({ input }) => requireTelemetry(runtimeTelemetry).waitFor(input),
  },
];
