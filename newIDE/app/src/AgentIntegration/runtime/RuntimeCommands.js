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

const requireDiagnostics = (runtimeDiagnosticsService: any) => {
  if (!runtimeDiagnosticsService) {
    throw new AgentError({ code: 'runtime_diagnostics_unavailable' });
  }
  return runtimeDiagnosticsService;
};

const DEBUGGER_TARGET_PROPERTIES = {
  debuggerId: { type: 'string', minLength: 1, maxLength: 200 },
  requestTimeoutMs: {
    type: 'integer',
    minimum: 250,
    maximum: 10000,
    default: 2500,
  },
};

const PROFILE_PROPERTIES = {
  sceneName: { type: 'string', minLength: 1, maxLength: 500 },
  frames: { type: 'integer', minimum: 1, maximum: 600, default: 60 },
  timeoutMs: {
    type: 'integer',
    minimum: 1000,
    maximum: 120000,
    default: 30000,
  },
  hitchThresholdMs: {
    type: 'number',
    minimum: 0.1,
    maximum: 60000,
    default: 33.3333333333,
  },
};

export const createRuntimeCommandDescriptors = ({
  runtimeTelemetry,
  runtimeDiagnosticsService,
}: {|
  runtimeTelemetry: any,
  runtimeDiagnosticsService?: ?any,
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
    execute: ({ input }) =>
      requireTelemetry(runtimeTelemetry).getSnapshot(input),
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
    description:
      'Evaluate a runtime assertion against the selected preview target.',
    inputSchema: { type: 'object', additionalProperties: true, properties: {} },
    metadata: makeCommandMetadata({ idempotent: false }),
    execute: ({ input }) =>
      requireTelemetry(runtimeTelemetry).assertRuntime(input),
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
  {
    name: 'runtime.debugger.capabilities',
    description:
      'Describe debugger, event-trace, profiler and specialized telemetry capabilities truthfully for the connected GDevelop build, including typed unsupported reasons.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    metadata: makeCommandMetadata({ cacheScope: 'request', ttlMs: 0 }),
    execute: () =>
      requireDiagnostics(runtimeDiagnosticsService).getCapabilities(),
  },
  {
    name: 'runtime.profiler.status',
    description:
      'Return live preview profiler state and the last bounded average profiler output, when one exists.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        debuggerId: DEBUGGER_TARGET_PROPERTIES.debuggerId,
      },
    },
    metadata: makeCommandMetadata(),
    execute: ({ input }) =>
      requireTelemetry(runtimeTelemetry).getProfilerStatus(input),
  },
  {
    name: 'runtime.profiler.start',
    description:
      'Start the native GDevelop profiler on one running preview target. This affects only debugger observation and does not modify the project.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: DEBUGGER_TARGET_PROPERTIES,
    },
    metadata: makeCommandMetadata({ idempotent: false }),
    execute: ({ input }) =>
      requireTelemetry(runtimeTelemetry).startProfiler(input),
  },
  {
    name: 'runtime.profiler.stop',
    description:
      'Stop the native GDevelop profiler and return bounded average frame/section and renderer statistics exposed by the debugger protocol.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: DEBUGGER_TARGET_PROPERTIES,
    },
    metadata: makeCommandMetadata({ idempotent: false }),
    execute: ({ input }) =>
      requireTelemetry(runtimeTelemetry).stopProfiler(input),
  },
  {
    name: 'runtime.profile.run',
    description:
      'Run an ephemeral official gameplay-test probe to capture bounded frame-time distribution, worst frames, max section times, object counts, renderer counters and JS heap when available. The probe is not persisted in the project.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['sceneName'],
      properties: PROFILE_PROPERTIES,
    },
    metadata: makeCommandMetadata({
      idempotent: false,
      longRunning: true,
      requiresProject: true,
      modifiesProject: false,
      defaultTimeoutMs: 2 * 60 * 1000,
    }),
    execute: ({ input, requestContext }) =>
      requireDiagnostics(runtimeDiagnosticsService).runProfile(
        input,
        requestContext && requestContext.signal
      ),
  },
  {
    name: 'runtime.event-trace.capture',
    description:
      'Capture truthful event execution evidence by correlating native named Group profiler sections with stable authoring event handles. Group-scope evidence does not fabricate condition-level evaluation, breakpoints or step support.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['sceneName'],
      properties: {
        ...PROFILE_PROPERTIES,
        handle: { type: 'string', minLength: 1, maxLength: 1000 },
      },
    },
    metadata: makeCommandMetadata({
      idempotent: false,
      longRunning: true,
      requiresProject: true,
      modifiesProject: false,
      defaultTimeoutMs: 2 * 60 * 1000,
    }),
    execute: ({ input, requestContext }) =>
      requireDiagnostics(runtimeDiagnosticsService).captureEventTrace(
        input,
        requestContext && requestContext.signal
      ),
  },
];
