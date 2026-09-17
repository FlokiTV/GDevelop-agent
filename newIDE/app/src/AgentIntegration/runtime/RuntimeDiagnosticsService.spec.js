// @flow
import {
  analyzeProfileHitches,
  createRuntimeDiagnosticsService,
  indexProfiledEvents,
} from './RuntimeDiagnosticsService';

const PROFILE = {
  startFrame: 0,
  endFrame: 4,
  avgStepTimeMs: 12,
  maxStepTimeMs: 45,
  sections: [
    { name: 'events', avgTimeMs: 4, maxTimeMs: 10 },
    { name: 'events > Guard', avgTimeMs: 2, maxTimeMs: 8 },
  ],
  worstFrames: [{ frame: 3, timeMs: 45 }, { frame: 2, timeMs: 15 }],
  frameTimesMs: [10, 15, 45, 9],
  frameTimesBucketSize: 1,
  objectCounts: { Player: 1 },
  renderer: null,
  jsHeapUsedMb: 23.5,
};

const EVENT_READ = {
  eventsRevision: 'events:test',
  eventsJson: [
    {
      type: 'BuiltinCommonInstructions::Group',
      name: 'Guard',
      events: [
        {
          type: 'BuiltinCommonInstructions::Standard',
          conditions: [
            {
              type: { value: 'BuiltinCommonInstructions::CompareNumbers' },
              parameters: ['1', '=', '2'],
            },
          ],
          actions: [],
        },
      ],
    },
  ],
  events: [
    {
      handle: 'event:fp:group',
      path: [0],
      type: 'BuiltinCommonInstructions::Group',
      disabled: false,
      conditions: [],
      whileConditions: [],
      actions: [],
      children: [
        {
          handle: 'event:fp:child',
          path: [0, 0],
          type: 'BuiltinCommonInstructions::Standard',
          disabled: false,
          conditions: [
            {
              handle: 'condition:fp:condition',
              type: 'BuiltinCommonInstructions::CompareNumbers',
              parameters: ['1', '=', '2'],
            },
          ],
          whileConditions: [],
          actions: [],
          children: [],
        },
      ],
    },
  ],
};

const createFinishedProfileRun = () => ({
  results: [
    {
      status: 'finished',
      success: true,
      output: {
        status: 'passed',
        framesExecuted: 4,
        durationMs: 20,
        errors: [],
        eventLog: [{ frame: 1, event: 'sceneChanged', sceneName: 'Scene' }],
        finalState: { sceneName: 'Scene' },
        profiles: [PROFILE],
      },
    },
  ],
  didModifyProject: false,
});

const makeService = () => {
  const editorFunctionService = {
    run: jest.fn(async () => createFinishedProfileRun()),
  };
  const eventTools = {
    readEventsJson: jest.fn(() => EVENT_READ),
  };
  const service = createRuntimeDiagnosticsService({
    project: { hasLayoutNamed: jest.fn(name => name === 'Scene') },
    eventTools,
    editorFunctionService,
    runtimeTelemetry: {},
  });
  return { service, eventTools, editorFunctionService };
};

describe('RuntimeDiagnosticsService', () => {
  test('indexes named Group events with profiler paths and stable handles', () => {
    const index = indexProfiledEvents(EVENT_READ);
    expect(index.groups).toEqual([
      expect.objectContaining({
        handle: 'event:fp:group',
        name: 'Guard',
        profilerPath: 'events > Guard',
        ambiguousProfilerPath: false,
      }),
    ]);
    expect(index.records[1]).toMatchObject({
      handle: 'event:fp:child',
      ancestorGroups: [expect.objectContaining({ handle: 'event:fp:group' })],
    });
  });

  test('reports exact hitch counts only for unbucketed frame timelines', () => {
    expect(analyzeProfileHitches(PROFILE, 30)).toMatchObject({
      thresholdMs: 30,
      bucketsAtOrAboveThreshold: 1,
      exactFramesAtOrAboveThreshold: 1,
      exactFrameCountAvailable: true,
    });
    expect(
      analyzeProfileHitches(
        { ...PROFILE, frameTimesMs: [45, 20], frameTimesBucketSize: 2 },
        30
      )
    ).toMatchObject({
      bucketsAtOrAboveThreshold: 1,
      exactFramesAtOrAboveThreshold: null,
      exactFrameCountAvailable: false,
    });
  });

  test('runs an ephemeral gameplay-test profile without persisting project state', async () => {
    const { service, editorFunctionService } = makeService();
    const result = await service.runProfile({
      sceneName: 'Scene',
      frames: 4,
      hitchThresholdMs: 30,
    });

    expect(result).toMatchObject({
      sceneName: 'Scene',
      requestedFrames: 4,
      status: 'passed',
      projectModified: false,
      profile: PROFILE,
      hitchAnalysis: { exactFramesAtOrAboveThreshold: 1 },
    });
    expect(editorFunctionService.run).toHaveBeenCalledWith(
      expect.objectContaining({
        calls: [
          expect.objectContaining({
            name: 'run_gameplay_test',
            arguments: expect.objectContaining({ persist: false }),
          }),
        ],
        save: false,
        signal: null,
      })
    );
  });

  test('maps Group profiler evidence to a nested event stable handle without fabricating condition trace', async () => {
    const { service, eventTools } = makeService();
    const trace = await service.captureEventTrace({
      sceneName: 'Scene',
      frames: 4,
      handle: 'event:fp:child',
    });

    expect(eventTools.readEventsJson).toHaveBeenCalledWith({
      sceneName: 'Scene',
    });
    expect(trace.groups[0]).toMatchObject({
      handle: 'event:fp:group',
      observed: true,
      avgTimeMs: 2,
      maxTimeMs: 8,
    });
    expect(trace.target).toMatchObject({
      handle: 'event:fp:child',
      traceableAtOwnScope: false,
      executionConclusion: 'group-scope-evidence-only',
      ancestorGroupTraces: [
        expect.objectContaining({
          handle: 'event:fp:group',
          observed: true,
        }),
      ],
    });
    expect(trace.conditionEvaluation).toEqual({
      supported: false,
      reasonCode: 'condition_trace_not_exposed',
    });
  });

  test('advertises unsupported low-level debugger/telemetry primitives explicitly', () => {
    const { service } = makeService();
    const capabilities = service.getCapabilities();
    expect(capabilities.debugger.pauseContinue.supported).toBe(true);
    expect(capabilities.debugger.step).toEqual({
      supported: false,
      reasonCode: 'debugger_step_not_exposed',
    });
    expect(capabilities.debugger.eventBreakpoints.supported).toBe(false);
    expect(capabilities.debugger.conditionEvaluationTrace.supported).toBe(
      false
    );
    expect(capabilities.telemetry.audio.supported).toBe(false);
    expect(capabilities.telemetry.physics.supported).toBe(false);
    expect(capabilities.telemetry.pathfinding.supported).toBe(false);
    expect(capabilities.telemetry.network.reasonCode).toBe(
      'network_telemetry_reserved_for_cap21'
    );
  });
});
