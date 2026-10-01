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
              path: [0],
              eventPath: [0, 0],
              instructionKind: 'condition',
              type: 'BuiltinCommonInstructions::CompareNumbers',
              parameters: ['1', '=', '2'],
            },
            {
              handle: 'condition:fp:skipped',
              path: [1],
              eventPath: [0, 0],
              instructionKind: 'condition',
              type: 'BuiltinCommonInstructions::CompareNumbers',
              parameters: ['3', '=', '3'],
            },
          ],
          whileConditions: [],
          actions: [
            {
              handle: 'action:fp:setx',
              path: [0],
              eventPath: [0, 0],
              instructionKind: 'action',
              type: 'SetX',
              parameters: ['Worker', '=', '10'],
            },
          ],
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
  let inspectCount = 0;
  const runtimeTelemetry = {
    configureEventTrace: jest.fn(async request => ({
      debuggerId: request.debuggerId || 'preview-ws-0',
      operation: 'configure',
      enabled: true,
      mode: request.mode || 'summary',
      recordCount: 0,
      projectPersistent: false,
    })),
    readEventTrace: jest.fn(async () => ({
      debuggerId: 'preview-ws-0',
      operation: 'read',
      enabled: true,
      mode: 'detailed',
      recordCount: 4,
      total: 4,
      offset: 0,
      limit: 1000,
      filteredRecordCounts: {
        'instance-context-unavailable': 2,
      },
      records: [
        {
          kind: 'event',
          phase: 'branch',
          eventPath: [0, 0],
          result: false,
          sourceNamespace: 'gdjs.SceneCode',
          sequence: 0,
          frameIndex: 1,
          sceneTimeMs: 20,
          simulatedElapsedMs: 20,
        },
        {
          kind: 'instruction',
          instructionKind: 'condition',
          phase: 'after',
          eventPath: [0, 0],
          instructionPath: [0],
          instructionType: 'BuiltinCommonInstructions::CompareNumbers',
          parameters: ['1', '=', '2'],
          sourceNamespace: 'gdjs.SceneCode',
          result: false,
          sequence: 1,
          frameIndex: 1,
          sceneTimeMs: 20,
          simulatedElapsedMs: 20,
        },
        {
          kind: 'instruction',
          instructionKind: 'action',
          phase: 'before',
          eventPath: [0, 0],
          instructionPath: [0],
          instructionType: 'SetX',
          parameters: ['Worker', '=', '10'],
          sourceNamespace: 'gdjs.SceneCode',
          targetContext: { instanceIds: ['worker-1'] },
          sequence: 2,
          frameIndex: 2,
          sceneTimeMs: 40,
          simulatedElapsedMs: 40,
        },
        {
          kind: 'instruction',
          instructionKind: 'action',
          phase: 'after',
          eventPath: [0, 0],
          instructionPath: [0],
          instructionType: 'SetX',
          parameters: ['Worker', '=', '10'],
          sourceNamespace: 'gdjs.SceneCode',
          targetContext: { instanceIds: ['worker-1'] },
          sequence: 3,
          frameIndex: 2,
          sceneTimeMs: 40,
          simulatedElapsedMs: 40,
        },
      ],
      projectPersistent: false,
    })),
    clearEventTrace: jest.fn(async () => ({
      debuggerId: 'preview-ws-0',
      operation: 'clear',
      enabled: true,
      recordCount: 0,
      projectPersistent: false,
    })),
    getTimeControlStatus: jest.fn(async () => ({
      debuggerId: 'preview-ws-0',
      isPaused: false,
      runtimeState: 'running',
    })),
    pauseRuntime: jest.fn(async () => ({
      debuggerId: 'preview-ws-0',
      isPaused: true,
      runtimeState: 'paused',
    })),
    resumeRuntime: jest.fn(async () => ({
      debuggerId: 'preview-ws-0',
      isPaused: false,
      runtimeState: 'running',
    })),
    stepRuntimeFrames: jest.fn(async () => ({
      debuggerId: 'preview-ws-0',
      framesAdvanced: 1,
      elapsedSimulatedTimeMs: 16.6666666667,
    })),
    inspectRuntime: jest.fn(async () => {
      inspectCount++;
      return {
        debuggerId: 'preview-ws-0',
        found: true,
        value: inspectCount >= 3 ? 11 : 10,
      };
    }),
  };
  const metadataDiscoveryService = {
    searchInstructions: jest.fn(({ kind, query }) => {
      if (kind === 'action' && query === 'SetX') {
        return {
          items: [
            {
              id: 'SetX',
              parameters: [
                { name: 'Object', valueType: { object: true } },
                { name: 'Operator', valueType: {} },
                { name: 'Value', valueType: {} },
              ],
            },
          ],
        };
      }
      return {
        items: [
          {
            id: query,
            parameters: [],
          },
        ],
      };
    }),
  };
  const service = createRuntimeDiagnosticsService({
    project: { hasLayoutNamed: jest.fn(name => name === 'Scene') },
    eventTools,
    editorFunctionService,
    runtimeTelemetry,
    metadataDiscoveryService,
  });
  return {
    service,
    eventTools,
    editorFunctionService,
    runtimeTelemetry,
  };
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

  test('configures live tracing by stable handle and translates breakpoint handles to runtime source paths', async () => {
    const { service, runtimeTelemetry } = makeService();
    const configured = await service.configureLiveEventTrace({
      sceneName: 'Scene',
      handle: 'event:fp:child',
      includeSubevents: true,
      mode: 'detailed',
      maxRecords: 50,
      sourceNamespaces: ['gdjs.SceneCode'],
      objectNames: ['Worker'],
      instanceIds: ['worker-1'],
      breakpoints: [{ handle: 'condition:fp:condition', phase: 'after' }],
    });

    expect(runtimeTelemetry.configureEventTrace).toHaveBeenCalledWith(
      expect.objectContaining({
        sceneName: 'Scene',
        mode: 'detailed',
        maxRecords: 50,
        sourceNamespaces: ['gdjs.SceneCode'],
        objectNames: null,
        instanceIds: ['worker-1'],
        eventPaths: expect.arrayContaining([[0, 0]]),
        instructionPaths: expect.arrayContaining([
          {
            eventPath: [0, 0],
            instructionKind: 'action',
            instructionPath: [0],
          },
        ]),
        breakpoints: [
          {
            kind: 'instruction',
            phase: 'after',
            eventPath: [0, 0],
            instructionKind: 'condition',
            instructionPath: [0],
          },
        ],
      })
    );
    expect(configured).toMatchObject({
      sceneName: 'Scene',
      eventsRevision: 'events:test',
      projectPersistent: false,
      resolvedObjectTargets: [
        expect.objectContaining({
          instructionHandle: 'action:fp:setx',
          objectNames: ['Worker'],
        }),
      ],
      requestedFilters: {
        sourceNamespaces: ['gdjs.SceneCode'],
        objectNames: ['Worker'],
        instanceIds: ['worker-1'],
      },
      capabilities: {
        conditionResults: true,
        actionExecution: true,
        eventBranchResults: true,
        breakpoints: true,
        filters: {
          scene: 'authoritative',
          generatedSourceNamespace: 'authoritative',
          objectName: 'authoritative-typed-authoring-parameter',
          instanceId:
            'authoritative-only-when-runtime-hook-exposes-targetContext-instance-id',
        },
      },
    });
  });

  test('maps live condition/action records to stable handles and explains short-circuiting without re-evaluating expressions', async () => {
    const { service } = makeService();
    const trace = await service.readLiveEventTrace({
      sceneName: 'Scene',
    });

    expect(trace.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'instruction',
          instructionKind: 'condition',
          instructionHandle: 'condition:fp:condition',
          eventHandle: 'event:fp:child',
          result: false,
          branchPath: [
            expect.objectContaining({ eventHandle: 'event:fp:group' }),
            expect.objectContaining({ eventHandle: 'event:fp:child' }),
          ],
          parameters: expect.objectContaining({
            authoring: ['1', '=', '2'],
            dynamicEvaluation: 'not-re-evaluated-to-avoid-side-effects',
          }),
        }),
        expect.objectContaining({
          kind: 'instruction',
          instructionKind: 'action',
          instructionHandle: 'action:fp:setx',
          eventHandle: 'event:fp:child',
          sourceNamespace: 'gdjs.SceneCode',
          targetContext: {
            authoringObjectNames: ['Worker'],
            objectParameterIndices: [0],
            instanceIds: ['worker-1'],
            runtimeInstanceContextAvailable: true,
            availability: 'runtime-hook',
          },
        }),
      ])
    );
    expect(trace.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'conditions_short_circuited',
          eventHandle: 'event:fp:child',
          causedByInstructionHandle: 'condition:fp:condition',
          skipped: [
            expect.objectContaining({
              instructionHandle: 'condition:fp:skipped',
            }),
          ],
        }),
      ])
    );
    expect(trace.projectModified).toBe(false);
  });

  test('filters live trace by generated scope, typed object target and runtime instance id without inference', async () => {
    const { service } = makeService();
    const trace = await service.readLiveEventTrace({
      sceneName: 'Scene',
      sourceNamespace: 'gdjs.SceneCode',
      objectName: 'Worker',
      instanceId: 'worker-1',
    });

    expect(trace.records).toHaveLength(2);
    expect(trace.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          instructionHandle: 'action:fp:setx',
          sourceNamespace: 'gdjs.SceneCode',
          targetContext: expect.objectContaining({
            authoringObjectNames: ['Worker'],
            instanceIds: ['worker-1'],
          }),
        }),
      ])
    );
    expect(trace.filterSummary).toMatchObject({
      requested: {
        sourceNamespaces: ['gdjs.SceneCode'],
        objectNames: ['Worker'],
        instanceIds: ['worker-1'],
      },
      runtimeFilteredRecordCounts: {
        'instance-context-unavailable': 2,
      },
    });
    expect(trace.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'event_trace_instance_context_unavailable',
          severity: 'info',
          requestedInstanceIds: ['worker-1'],
          filteredCount: 2,
        }),
      ])
    );
  });

  test('runs frame-boundary watchpoints with DX-35 stepping and returns the correlated trace on change', async () => {
    const { service, runtimeTelemetry } = makeService();
    const result = await service.watchLiveEventTrace({
      sceneName: 'Scene',
      selector: {
        kind: 'object-property',
        objectName: 'Worker',
        instanceIndex: 0,
        property: 'x',
      },
      maxFrames: 5,
      frameDurationMs: 20,
    });

    expect(runtimeTelemetry.pauseRuntime).toHaveBeenCalled();
    expect(runtimeTelemetry.stepRuntimeFrames).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      changed: true,
      framesAdvanced: 2,
      elapsedSimulatedTimeMs: expect.any(Number),
      wallClockWaitUsed: false,
      timeDomain: 'simulated-game-time',
      runtimeStateAfter: 'paused',
      projectModified: false,
      trace: {
        sceneName: 'Scene',
        projectModified: false,
      },
    });
    expect(result.before.value).toBe(10);
    expect(result.after.value).toBe(11);
  });

  test('advertises live trace/breakpoint/watchpoint capabilities without overstating precision', () => {
    const { service } = makeService();
    const capabilities = service.getCapabilities();
    expect(capabilities.debugger.pauseContinue.supported).toBe(true);
    expect(capabilities.debugger.timeControl).toMatchObject({
      supported: true,
      statusCommand: 'runtime.time.status',
      stepCommand: 'runtime.time.step',
      advanceCommand: 'runtime.time.advance',
      waitUntilCommand: 'runtime.time.wait-until',
      timeDomain: 'simulated-game-time',
      wallClockPollingRequired: false,
    });
    expect(capabilities.debugger.step).toEqual({
      supported: true,
      command: 'runtime.time.step',
      requiresPaused: true,
      source: 'RuntimeGame.SceneStack.step',
    });
    expect(capabilities.debugger.eventBreakpoints).toMatchObject({
      supported: true,
      configureCommand: 'runtime.event-trace.configure',
      readCommand: 'runtime.event-trace.read',
      precision: 'pause-requested-next-frame-boundary',
      projectPersistent: false,
    });
    expect(capabilities.debugger.conditionEvaluationTrace).toMatchObject({
      supported: true,
      resultGranularity: 'condition-node',
      stableHandleMapping: true,
    });
    expect(capabilities.debugger.watchpoints).toMatchObject({
      supported: true,
      command: 'runtime.event-trace.watch',
      precision: 'frame-boundary',
      timeDomain: 'simulated-game-time',
    });
    expect(capabilities.debugger.eventTraceFilters).toMatchObject({
      supported: true,
      scene: true,
      generatedSourceNamespace: true,
      stableEventOrInstructionHandle: true,
      objectName: true,
      instanceId: {
        supported: true,
        availability: 'runtime-hook-target-context-dependent',
        noInferenceFallback: true,
      },
    });
    expect(capabilities.telemetry.audio.supported).toBe(false);
    expect(capabilities.telemetry.physics.supported).toBe(false);
    expect(capabilities.telemetry.pathfinding.supported).toBe(false);
    expect(capabilities.telemetry.network.reasonCode).toBe(
      'network_telemetry_reserved_for_cap21'
    );
  });
});
