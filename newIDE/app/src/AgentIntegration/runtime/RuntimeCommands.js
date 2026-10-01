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

const RUNTIME_SELECTOR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind'],
  properties: {
    kind: {
      type: 'string',
      enum: [
        'global-variable',
        'scene-variable',
        'scene-time',
        'object-count',
        'object-instance',
        'object-property',
        'object-variable',
      ],
    },
    path: { type: 'string', minLength: 1, maxLength: 1000 },
    metric: {
      type: 'string',
      enum: ['time-from-start-ms', 'elapsed-time-ms', 'time-scale'],
      description:
        'Metric for kind=scene-time. Values come from the runtime scene TimeManager.',
    },
    objectName: { type: 'string', minLength: 1, maxLength: 500 },
    instanceIndex: { type: 'integer', minimum: 0, maximum: 999 },
    instanceId: {
      anyOf: [
        { type: 'string', minLength: 1, maxLength: 200 },
        { type: 'number' },
      ],
    },
    property: {
      type: 'string',
      enum: [
        'id',
        'name',
        'type',
        'x',
        'y',
        'z',
        'angle',
        'zOrder',
        'layer',
        'hidden',
        'livingOnScene',
        'text',
        'opacity',
        'animation',
        'flippedX',
        'flippedY',
      ],
    },
  },
};

const RUNTIME_CONDITION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: {
      anyOf: [
        { type: 'string', minLength: 1, maxLength: 2000 },
        {
          type: 'array',
          minItems: 1,
          maxItems: 100,
          items: { type: 'string', minLength: 1, maxLength: 500 },
        },
      ],
    },
    selector: RUNTIME_SELECTOR_SCHEMA,
    operator: {
      type: 'string',
      enum: [
        'equals',
        'eq',
        'notEquals',
        'neq',
        'gt',
        'gte',
        'lt',
        'lte',
        'contains',
        'exists',
        'not-exists',
        'truthy',
        'falsy',
      ],
      default: 'equals',
    },
    value: {},
  },
  anyOf: [{ required: ['path'] }, { required: ['selector'] }],
};

const RUNTIME_SNAPSHOT_PROPERTIES = {
  ...DEBUGGER_TARGET_PROPERTIES,
  maxInstances: {
    type: 'integer',
    minimum: 1,
    maximum: 1000,
    default: 200,
  },
  objectNames: {
    type: 'array',
    maxItems: 200,
    items: { type: 'string', minLength: 1, maxLength: 500 },
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

const TIME_CONTROL_COMMON_PROPERTIES = {
  ...DEBUGGER_TARGET_PROPERTIES,
};

const EVENT_TRACE_COMMON_PROPERTIES = {
  ...DEBUGGER_TARGET_PROPERTIES,
  sceneName: { type: 'string', minLength: 1, maxLength: 500 },
  mode: {
    type: 'string',
    enum: ['summary', 'detailed'],
    default: 'summary',
  },
  handle: { type: 'string', minLength: 1, maxLength: 1000 },
  handles: {
    type: 'array',
    maxItems: 100,
    items: { type: 'string', minLength: 1, maxLength: 1000 },
  },
  includeSubevents: { type: 'boolean', default: true },
  sourceNamespaces: {
    type: 'array',
    maxItems: 100,
    uniqueItems: true,
    description:
      'Exact generated source namespaces observed in trace records. This allows filtering generated scene/external/function scopes without fabricating source-sheet identity.',
    items: { type: 'string', minLength: 1, maxLength: 1000 },
  },
  objectNames: {
    type: 'array',
    maxItems: 100,
    uniqueItems: true,
    description:
      'Object/group names used as authoring parameters. The service additionally resolves typed object parameters when metadata is available.',
    items: { type: 'string', minLength: 1, maxLength: 500 },
  },
  instanceIds: {
    type: 'array',
    maxItems: 100,
    uniqueItems: true,
    description:
      'Runtime instance ids. Matching is authoritative only for hooks that expose targetContext instance ids; unavailable context is reported instead of inferred.',
    items: {
      anyOf: [
        { type: 'string', minLength: 1, maxLength: 200 },
        { type: 'number' },
      ],
    },
  },
  maxRecords: {
    type: 'integer',
    minimum: 1,
    maximum: 10000,
    default: 500,
  },
  maxFrames: { type: 'integer', minimum: 1, maximum: 10000 },
  maxSimulatedTimeMs: {
    type: 'number',
    minimum: 0.1,
    maximum: 600000,
  },
  instructionKinds: {
    type: 'array',
    maxItems: 2,
    uniqueItems: true,
    items: { type: 'string', enum: ['condition', 'action'] },
  },
  breakpoints: {
    type: 'array',
    maxItems: 100,
    items: {
      type: 'object',
      additionalProperties: false,
      required: ['handle'],
      properties: {
        handle: { type: 'string', minLength: 1, maxLength: 1000 },
        phase: {
          type: 'string',
          enum: ['before', 'after', 'branch'],
          default: 'after',
        },
      },
    },
  },
};

const TIME_OBSERVATION_PROPERTIES = {
  snapshot: {
    type: 'boolean',
    default: false,
    description:
      'Capture runtime.snapshot immediately after deterministic advancement, before any resume or wall-clock wait.',
  },
  assertion: RUNTIME_CONDITION_SCHEMA,
  maxInstances: RUNTIME_SNAPSHOT_PROPERTIES.maxInstances,
  objectNames: RUNTIME_SNAPSHOT_PROPERTIES.objectNames,
};

const TIME_STEP_PROPERTIES = {
  frames: { type: 'integer', minimum: 1, maximum: 10000, default: 1 },
  frameDurationMs: {
    type: 'number',
    exclusiveMinimum: 0,
    maximum: 1000,
    default: 16.6666666667,
    description:
      'Raw frame delta before the current scene TimeManager timeScale is applied.',
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
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: RUNTIME_SNAPSHOT_PROPERTIES,
    },
    metadata: makeCommandMetadata(),
    execute: ({ input }) =>
      requireTelemetry(runtimeTelemetry).getSnapshot(input),
  },
  {
    name: 'runtime.inspect',
    description:
      'Read one targeted runtime value using a typed selector for variables, object counts, instances, properties or instance variables.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['selector'],
      properties: {
        ...RUNTIME_SNAPSHOT_PROPERTIES,
        selector: RUNTIME_SELECTOR_SCHEMA,
      },
    },
    metadata: makeCommandMetadata(),
    execute: ({ input }) =>
      requireTelemetry(runtimeTelemetry).inspectRuntime(input),
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
      'Evaluate a read-only runtime assertion using a typed selector or legacy snapshot path.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['condition'],
      properties: {
        ...RUNTIME_SNAPSHOT_PROPERTIES,
        condition: RUNTIME_CONDITION_SCHEMA,
      },
    },
    metadata: makeCommandMetadata({ idempotent: false }),
    execute: ({ input }) =>
      requireTelemetry(runtimeTelemetry).assertRuntime(input),
  },
  {
    name: 'runtime.wait-for',
    description:
      'Poll read-only runtime state until a selector/path condition becomes true or times out.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['condition'],
      properties: {
        ...RUNTIME_SNAPSHOT_PROPERTIES,
        condition: RUNTIME_CONDITION_SCHEMA,
        timeoutMs: {
          type: 'integer',
          minimum: 100,
          maximum: 30000,
          default: 5000,
        },
        intervalMs: {
          type: 'integer',
          minimum: 100,
          maximum: 5000,
          default: 250,
        },
      },
    },
    metadata: makeCommandMetadata({
      idempotent: false,
      longRunning: true,
      defaultTimeoutMs: 2 * 60 * 1000,
    }),
    execute: ({ input }) => requireTelemetry(runtimeTelemetry).waitFor(input),
  },
  {
    name: 'runtime.time.status',
    description:
      'Return authoritative pause/running state, current scene time scale and simulated scene time for one preview debugger target, plus deterministic stepping readiness and integration discovery.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: TIME_CONTROL_COMMON_PROPERTIES,
    },
    metadata: makeCommandMetadata({ cacheScope: 'request', ttlMs: 0 }),
    execute: ({ input }) =>
      requireTelemetry(runtimeTelemetry).getTimeControlStatus(input),
  },
  {
    name: 'runtime.time.pause',
    description:
      'Pause one preview runtime and acknowledge the resulting authoritative paused state. This is non-persistent and never edits project/Event Sheet data.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: TIME_CONTROL_COMMON_PROPERTIES,
    },
    metadata: makeCommandMetadata({
      readOnly: false,
      idempotent: true,
      modifiesProject: false,
    }),
    execute: ({ input }) =>
      requireTelemetry(runtimeTelemetry).pauseRuntime(input),
  },
  {
    name: 'runtime.time.resume',
    description:
      'Resume one paused preview runtime and acknowledge the resulting authoritative running state. This is non-persistent.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: TIME_CONTROL_COMMON_PROPERTIES,
    },
    metadata: makeCommandMetadata({
      readOnly: false,
      idempotent: true,
      modifiesProject: false,
    }),
    execute: ({ input }) =>
      requireTelemetry(runtimeTelemetry).resumeRuntime(input),
  },
  {
    name: 'runtime.time.set-scale',
    description:
      'Set the current runtime scene time scale for QA/debugging only. Values are runtime-only and reset with preview lifecycle; 0 freezes simulated scene time while the debugger runtime remains paused/running independently.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['timeScale'],
      properties: {
        ...TIME_CONTROL_COMMON_PROPERTIES,
        timeScale: { type: 'number', minimum: 0, maximum: 100 },
      },
    },
    metadata: makeCommandMetadata({
      readOnly: false,
      idempotent: false,
      modifiesProject: false,
    }),
    execute: ({ input }) =>
      requireTelemetry(runtimeTelemetry).setRuntimeTimeScale(input),
  },
  {
    name: 'runtime.time.step',
    description:
      'Advance exactly one or N deterministic frames while the runtime is paused. Uses the same SceneStack.step/InputManager frame-ending path as the official gameplay-test harness and can capture a snapshot/assertion immediately after the final step without sleeps.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...TIME_CONTROL_COMMON_PROPERTIES,
        ...TIME_STEP_PROPERTIES,
        ...TIME_OBSERVATION_PROPERTIES,
      },
    },
    metadata: makeCommandMetadata({
      readOnly: false,
      idempotent: false,
      modifiesProject: false,
    }),
    execute: ({ input }) =>
      requireTelemetry(runtimeTelemetry).stepRuntimeFrames(input),
  },
  {
    name: 'runtime.time.advance',
    description:
      'Advance a bounded amount of simulated game time while paused. Completion is measured from actual TimeManager elapsed simulation time, not wall-clock sleeping; returns frames advanced and both simulated/wall-clock elapsed values.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['milliseconds'],
      properties: {
        ...TIME_CONTROL_COMMON_PROPERTIES,
        milliseconds: {
          type: 'number',
          exclusiveMinimum: 0,
          maximum: 600000,
        },
        frameDurationMs: TIME_STEP_PROPERTIES.frameDurationMs,
        maxFrames: {
          type: 'integer',
          minimum: 1,
          maximum: 100000,
          default: 10000,
        },
        ...TIME_OBSERVATION_PROPERTIES,
      },
    },
    metadata: makeCommandMetadata({
      readOnly: false,
      idempotent: false,
      modifiesProject: false,
      longRunning: true,
      defaultTimeoutMs: 2 * 60 * 1000,
    }),
    execute: ({ input }) =>
      requireTelemetry(runtimeTelemetry).advanceRuntimeTime(input),
  },
  {
    name: 'runtime.time.wait-until',
    description:
      'Evaluate a runtime selector/path predicate, deterministically step one frame while paused when it is false, and repeat up to maxFrames. No wall-clock polling sleep is used; the returned snapshot is from the exact checkpoint where the predicate passed or the bound was reached.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['condition'],
      properties: {
        ...TIME_CONTROL_COMMON_PROPERTIES,
        condition: RUNTIME_CONDITION_SCHEMA,
        frameDurationMs: TIME_STEP_PROPERTIES.frameDurationMs,
        maxFrames: {
          type: 'integer',
          minimum: 1,
          maximum: 10000,
          default: 600,
        },
        maxInstances: RUNTIME_SNAPSHOT_PROPERTIES.maxInstances,
        objectNames: RUNTIME_SNAPSHOT_PROPERTIES.objectNames,
      },
    },
    metadata: makeCommandMetadata({
      readOnly: false,
      idempotent: false,
      modifiesProject: false,
      longRunning: true,
      defaultTimeoutMs: 2 * 60 * 1000,
    }),
    execute: ({ input }) =>
      requireTelemetry(runtimeTelemetry).waitUntilRuntime(input),
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
    name: 'runtime.event-trace.configure',
    description:
      'Configure ephemeral live Event Sheet tracing for a running preview. Filters may target stable event/instruction handles, instruction kind, scene, generated source namespace, authoring object/group name and runtime instance id where the hook exposes instance context, plus bounded frame/simulated-time/record windows. Breakpoints request a pause when a matching runtime hook is observed; precision is the next frame boundary.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['sceneName'],
      properties: {
        ...EVENT_TRACE_COMMON_PROPERTIES,
        enabled: { type: 'boolean', default: true },
      },
    },
    metadata: makeCommandMetadata({
      idempotent: false,
      requiresProject: true,
      modifiesProject: false,
    }),
    execute: ({ input }) =>
      requireDiagnostics(runtimeDiagnosticsService).configureLiveEventTrace(
        input
      ),
  },
  {
    name: 'runtime.event-trace.read',
    description:
      'Read bounded live event-trace records and map runtime structural source paths back to current stable Event Sheet handles. Returns event branch paths, condition results, executed actions, safe literal parameter values and structured skipped/disabled diagnostics without re-evaluating dynamic expressions.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['sceneName'],
      properties: {
        ...DEBUGGER_TARGET_PROPERTIES,
        sceneName: { type: 'string', minLength: 1, maxLength: 500 },
        offset: { type: 'integer', minimum: 0, default: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 5000, default: 1000 },
        handle: { type: 'string', minLength: 1, maxLength: 1000 },
        sourceNamespace: { type: 'string', minLength: 1, maxLength: 1000 },
        sourceNamespaces: {
          type: 'array',
          maxItems: 100,
          uniqueItems: true,
          items: { type: 'string', minLength: 1, maxLength: 1000 },
        },
        objectName: { type: 'string', minLength: 1, maxLength: 500 },
        objectNames: {
          type: 'array',
          maxItems: 100,
          uniqueItems: true,
          items: { type: 'string', minLength: 1, maxLength: 500 },
        },
        instanceId: {
          anyOf: [
            { type: 'string', minLength: 1, maxLength: 200 },
            { type: 'number' },
          ],
        },
        instanceIds: {
          type: 'array',
          maxItems: 100,
          uniqueItems: true,
          items: {
            anyOf: [
              { type: 'string', minLength: 1, maxLength: 200 },
              { type: 'number' },
            ],
          },
        },
        kinds: {
          type: 'array',
          maxItems: 2,
          uniqueItems: true,
          items: { type: 'string', enum: ['event', 'instruction'] },
        },
      },
    },
    metadata: makeCommandMetadata({
      requiresProject: true,
      modifiesProject: false,
      cacheScope: 'request',
      ttlMs: 0,
    }),
    execute: ({ input }) =>
      requireDiagnostics(runtimeDiagnosticsService).readLiveEventTrace(input),
  },
  {
    name: 'runtime.event-trace.clear',
    description:
      'Clear the ephemeral live event-trace buffer for one preview debugger target. This never modifies Event Sheets or project state.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: DEBUGGER_TARGET_PROPERTIES,
    },
    metadata: makeCommandMetadata({
      idempotent: true,
      requiresProject: true,
      modifiesProject: false,
    }),
    execute: ({ input }) =>
      requireDiagnostics(runtimeDiagnosticsService).clearLiveEventTrace(input),
  },
  {
    name: 'runtime.event-trace.watch',
    description:
      'Run a deterministic frame-boundary watchpoint for one runtime selector while collecting live Event Sheet trace evidence. The preview is auto-paused by default and stepped using DX-35 simulated time until the selected value changes or maxFrames is reached.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['sceneName', 'selector'],
      properties: {
        ...EVENT_TRACE_COMMON_PROPERTIES,
        selector: RUNTIME_SELECTOR_SCHEMA,
        frameDurationMs: {
          type: 'number',
          exclusiveMinimum: 0,
          maximum: 1000,
          default: 16.6666666667,
        },
        autoPause: { type: 'boolean', default: true },
        configureTrace: { type: 'boolean', default: true },
        keepPaused: { type: 'boolean', default: true },
      },
    },
    metadata: makeCommandMetadata({
      idempotent: false,
      longRunning: true,
      requiresProject: true,
      modifiesProject: false,
      defaultTimeoutMs: 2 * 60 * 1000,
    }),
    execute: ({ input }) =>
      requireDiagnostics(runtimeDiagnosticsService).watchLiveEventTrace(input),
  },
  {
    name: 'runtime.event-trace.capture',
    description:
      'Capture the legacy profiler-group trace fallback by correlating native named Group profiler sections with stable authoring event handles. Prefer runtime.event-trace.configure/read for condition/action-level live tracing; this command remains useful when low-level live hooks are unavailable.',
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
