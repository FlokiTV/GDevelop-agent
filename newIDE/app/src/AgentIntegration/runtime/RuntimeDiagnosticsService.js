// @flow
import { AgentError } from '../core/AgentError';

const GROUP_EVENT_TYPE = 'BuiltinCommonInstructions::Group';
const DEFAULT_PROFILE_FRAMES = 60;
const MAX_PROFILE_FRAMES = 600;
const DEFAULT_HITCH_THRESHOLD_MS = 1000 / 30;
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = 120000;

const clampInteger = (
  value: any,
  fallback: number,
  minimum: number,
  maximum: number
): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(parsed)));
};

const clampNumber = (
  value: any,
  fallback: number,
  minimum: number,
  maximum: number
): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
};

const makeError = (code: string, message?: string, details?: any): AgentError =>
  new AgentError({ code, message, retryable: false, details });

const getSerializedEventType = (eventJson: any): ?string => {
  if (!eventJson || !eventJson.type) return null;
  return typeof eventJson.type === 'object'
    ? eventJson.type.value || null
    : eventJson.type;
};

export const indexProfiledEvents = (eventRead: any): any => {
  const records = [];
  const groups = [];
  const eventsJson = Array.isArray(eventRead && eventRead.eventsJson)
    ? eventRead.eventsJson
    : [];
  const canonicalEvents = Array.isArray(eventRead && eventRead.events)
    ? eventRead.events
    : [];

  const visit = (
    rawEvents: Array<any>,
    nodes: Array<any>,
    parentGroupNames: Array<string>,
    parentGroups: Array<any>
  ) => {
    rawEvents.forEach((eventJson, index) => {
      const node = nodes[index] || null;
      if (!node || !node.handle) return;
      const type = getSerializedEventType(eventJson) || node.type || null;
      const isGroup = type === GROUP_EVENT_TYPE;
      const groupName =
        isGroup && typeof eventJson.name === 'string' ? eventJson.name : null;
      const profilerPath =
        isGroup && groupName !== null
          ? ['events', ...parentGroupNames, groupName].join(' > ')
          : null;
      const groupEntry = isGroup
        ? {
            handle: node.handle,
            path: node.path,
            name: groupName,
            profilerPath,
            disabled: !!node.disabled,
          }
        : null;
      const record = {
        handle: node.handle,
        path: node.path,
        type,
        disabled: !!node.disabled,
        raw: eventJson,
        canonical: node,
        profilerPath,
        ancestorGroups: parentGroups,
      };
      records.push(record);
      if (groupEntry) groups.push(groupEntry);

      const childRawEvents = Array.isArray(eventJson && eventJson.events)
        ? eventJson.events
        : [];
      const childNodes = Array.isArray(node.children) ? node.children : [];
      visit(
        childRawEvents,
        childNodes,
        groupEntry && groupName !== null
          ? [...parentGroupNames, groupName]
          : parentGroupNames,
        groupEntry ? [...parentGroups, groupEntry] : parentGroups
      );
    });
  };

  visit(eventsJson, canonicalEvents, [], []);
  const profilerPathCounts = new Map();
  groups.forEach(group => {
    if (!group.profilerPath) return;
    profilerPathCounts.set(
      group.profilerPath,
      (profilerPathCounts.get(group.profilerPath) || 0) + 1
    );
  });

  return {
    records,
    groups: groups.map(group => ({
      ...group,
      ambiguousProfilerPath:
        !!group.profilerPath &&
        (profilerPathCounts.get(group.profilerPath) || 0) > 1,
    })),
  };
};

const tracePathKey = (path: any): string =>
  Array.isArray(path) ? path.map(Number).join('.') : '';

const buildLiveTraceSourceIndex = (
  eventRead: any,
  metadataDiscoveryService?: ?any
): any => {
  const events = Array.isArray(eventRead && eventRead.events)
    ? eventRead.events
    : [];
  const eventByPath = new Map();
  const instructionBySource = new Map();
  const sourceByHandle = new Map();
  const instructionMetadataCache = new Map();

  const getObjectParameterIndices = (
    instruction: any,
    instructionKind: string
  ): Array<number> => {
    if (!metadataDiscoveryService || !instruction || !instruction.type)
      return [];
    const metadataKind = instructionKind === 'action' ? 'action' : 'condition';
    const cacheKey = `${metadataKind}:${instruction.type}`;
    if (!instructionMetadataCache.has(cacheKey)) {
      let records = [];
      try {
        const result = metadataDiscoveryService.searchInstructions({
          kind: metadataKind,
          query: instruction.type,
          deprecated: 'include',
          includeHidden: true,
          limit: 100,
          offset: 0,
        });
        records = (result.items || []).filter(
          item => item && item.id === instruction.type
        );
      } catch (error) {
        records = [];
      }
      instructionMetadataCache.set(cacheKey, records);
    }
    const records = instructionMetadataCache.get(cacheKey) || [];
    const indices = new Set();
    records.forEach(record => {
      (record.parameters || []).forEach((parameter, index) => {
        if (parameter && parameter.valueType && parameter.valueType.object) {
          indices.add(index);
        }
      });
    });
    return Array.from(indices).sort((left, right) => left - right);
  };

  const visitInstructions = (
    instructions: Array<any>,
    eventPath: Array<number>,
    instructionKind: string
  ) => {
    (instructions || []).forEach(instruction => {
      if (!instruction || !instruction.handle) return;
      const objectParameterIndices = getObjectParameterIndices(
        instruction,
        instructionKind
      );
      const parameters = instruction.parameters || [];
      const source = {
        kind: 'instruction',
        eventPath,
        instructionKind,
        instructionPath: instruction.path || [],
        handle: instruction.handle,
        type: instruction.type || null,
        parameters,
        objectParameterIndices,
        authoringObjectNames: objectParameterIndices
          .map(index => parameters[index])
          .filter(value => typeof value === 'string' && value.length > 0),
        inverted: !!instruction.inverted,
      };
      instructionBySource.set(
        `${tracePathKey(eventPath)}|${instructionKind}|${tracePathKey(
          source.instructionPath
        )}`,
        source
      );
      sourceByHandle.set(instruction.handle, source);
      visitInstructions(instruction.children || [], eventPath, instructionKind);
    });
  };

  const visitEvents = (nodes: Array<any>, ancestors: Array<any> = []) => {
    (nodes || []).forEach(node => {
      if (!node || !node.handle) return;
      const path = node.path || [];
      const eventSource = {
        kind: 'event',
        eventPath: path,
        handle: node.handle,
        type: node.type || null,
        disabled: !!node.disabled,
        ancestors: ancestors.map(ancestor => ({
          handle: ancestor.handle,
          path: ancestor.path,
          type: ancestor.type || null,
        })),
        node,
      };
      eventByPath.set(tracePathKey(path), eventSource);
      sourceByHandle.set(node.handle, eventSource);
      visitInstructions(node.conditions || [], path, 'condition');
      visitInstructions(node.whileConditions || [], path, 'whileCondition');
      visitInstructions(node.actions || [], path, 'action');
      visitEvents(node.children || [], [...ancestors, node]);
    });
  };

  visitEvents(events);
  return { eventByPath, instructionBySource, sourceByHandle };
};

const safeLiteralValue = (value: any): any => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(trimmed)) {
    const numberValue = Number(trimmed);
    return Number.isFinite(numberValue)
      ? { kind: 'number-literal', value: numberValue }
      : null;
  }
  if (trimmed === 'true' || trimmed === 'false') {
    return { kind: 'boolean-literal', value: trimmed === 'true' };
  }
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return {
      kind: 'string-literal',
      value: trimmed.slice(1, -1),
    };
  }
  return null;
};

const mapLiveTraceRecord = (record: any, sourceIndex: any): any => {
  const eventSource = sourceIndex.eventByPath.get(
    tracePathKey(record && record.eventPath)
  );
  let instructionSource = null;
  if (record && record.kind === 'instruction') {
    const candidateKinds =
      record.instructionKind === 'condition'
        ? ['condition', 'whileCondition']
        : [record.instructionKind];
    for (const instructionKind of candidateKinds) {
      instructionSource = sourceIndex.instructionBySource.get(
        `${tracePathKey(record.eventPath)}|${instructionKind}|${tracePathKey(
          record.instructionPath
        )}`
      );
      if (instructionSource) break;
    }
  }
  const source = instructionSource || eventSource || null;
  const authoringParameters =
    instructionSource && Array.isArray(instructionSource.parameters)
      ? instructionSource.parameters
      : Array.isArray(record && record.parameters)
      ? record.parameters
      : [];
  const evaluatedSafeLiterals = authoringParameters
    .map((value, index) => ({ index, value: safeLiteralValue(value) }))
    .filter(entry => entry.value);
  const authoringObjectNames =
    instructionSource && Array.isArray(instructionSource.authoringObjectNames)
      ? instructionSource.authoringObjectNames
      : [];
  const runtimeTargetContext =
    record &&
    record.targetContext &&
    typeof record.targetContext === 'object' &&
    !Array.isArray(record.targetContext)
      ? record.targetContext
      : null;
  const runtimeInstanceIds = runtimeTargetContext
    ? [
        ...(Array.isArray(runtimeTargetContext.instanceIds)
          ? runtimeTargetContext.instanceIds
          : []),
        ...(runtimeTargetContext.instanceId != null
          ? [runtimeTargetContext.instanceId]
          : []),
      ]
    : [];

  return {
    ...record,
    eventHandle: eventSource ? eventSource.handle : null,
    instructionHandle: instructionSource ? instructionSource.handle : null,
    sourceMapped: !!source,
    sourceType: source ? source.type : record.instructionType || null,
    targetContext:
      record && record.kind === 'instruction'
        ? {
            authoringObjectNames,
            objectParameterIndices:
              instructionSource &&
              Array.isArray(instructionSource.objectParameterIndices)
                ? instructionSource.objectParameterIndices
                : [],
            instanceIds: runtimeInstanceIds,
            runtimeInstanceContextAvailable: runtimeInstanceIds.length > 0,
            availability:
              runtimeInstanceIds.length > 0
                ? 'runtime-hook'
                : authoringObjectNames.length > 0
                ? 'authoring-object-only'
                : 'not-exposed-by-generic-instruction-hook',
          }
        : undefined,
    branchPath: eventSource
      ? [
          ...eventSource.ancestors.map(ancestor => ({
            eventHandle: ancestor.handle,
            eventPath: ancestor.path,
            eventType: ancestor.type,
          })),
          {
            eventHandle: eventSource.handle,
            eventPath: eventSource.eventPath,
            eventType: eventSource.type,
          },
        ]
      : [],
    parameters:
      record && record.kind === 'instruction'
        ? {
            authoring: authoringParameters,
            evaluatedSafeLiterals,
            dynamicEvaluation:
              evaluatedSafeLiterals.length === authoringParameters.length
                ? 'all-parameters-static-literals'
                : 'not-re-evaluated-to-avoid-side-effects',
          }
        : undefined,
  };
};

const collectStaticTraceDiagnostics = (
  sourceIndex: any,
  mappedRecords: Array<any>
): Array<any> => {
  const diagnostics = [];
  sourceIndex.eventByPath.forEach(source => {
    if (source.disabled) {
      diagnostics.push({
        code: 'event_disabled',
        severity: 'info',
        eventHandle: source.handle,
        eventPath: source.eventPath,
        reason: 'disabled-in-authoring-source',
      });
    }
  });

  const falseConditions = mappedRecords.filter(
    record =>
      record.kind === 'instruction' &&
      (record.instructionKind === 'condition' ||
        record.instructionKind === 'whileCondition') &&
      record.phase === 'after' &&
      record.result === false &&
      record.instructionHandle
  );
  falseConditions.forEach(record => {
    const eventSource = sourceIndex.eventByPath.get(
      tracePathKey(record.eventPath)
    );
    if (!eventSource || !eventSource.node) return;
    const instructions =
      record.instructionKind === 'whileCondition'
        ? eventSource.node.whileConditions || []
        : eventSource.node.conditions || [];
    const topLevelIndex =
      Array.isArray(record.instructionPath) && record.instructionPath.length
        ? record.instructionPath[0]
        : null;
    if (!Number.isInteger(topLevelIndex)) return;
    const skipped = instructions.slice(topLevelIndex + 1).map(instruction => ({
      instructionHandle: instruction.handle,
      type: instruction.type || null,
    }));
    if (skipped.length) {
      diagnostics.push({
        code: 'conditions_short_circuited',
        severity: 'info',
        eventHandle: record.eventHandle,
        causedByInstructionHandle: record.instructionHandle,
        frameIndex: record.frameIndex,
        skipped,
      });
    }
  });
  return diagnostics;
};

const getProfileSectionMap = (profile: any): Map<string, any> => {
  const sectionMap = new Map();
  const sections = Array.isArray(profile && profile.sections)
    ? profile.sections
    : [];
  sections.forEach(section => {
    if (section && typeof section.name === 'string') {
      sectionMap.set(section.name, section);
    }
  });
  return sectionMap;
};

const makeGroupTrace = (group: any, sectionMap: Map<string, any>): any => {
  const section = group.profilerPath
    ? sectionMap.get(group.profilerPath) || null
    : null;
  return {
    handle: group.handle,
    path: group.path,
    name: group.name,
    profilerPath: group.profilerPath,
    disabled: group.disabled,
    traceable: !!group.profilerPath && !group.ambiguousProfilerPath,
    ambiguousProfilerPath: group.ambiguousProfilerPath,
    observed: !!section,
    avgTimeMs: section ? section.avgTimeMs : null,
    maxTimeMs: section ? section.maxTimeMs : null,
    evidenceMeaning:
      'A profiler section proves that the named Group event scope was entered; it does not prove that every nested condition passed or action executed.',
  };
};

export const analyzeProfileHitches = (
  profile: any,
  hitchThresholdMs: number
): any => {
  const frameTimesMs = Array.isArray(profile && profile.frameTimesMs)
    ? profile.frameTimesMs
    : [];
  const frameTimesBucketSize =
    Number.isInteger(profile && profile.frameTimesBucketSize) &&
    profile.frameTimesBucketSize > 0
      ? profile.frameTimesBucketSize
      : 1;
  const worstFrames = Array.isArray(profile && profile.worstFrames)
    ? profile.worstFrames
    : [];
  const threshold = clampNumber(
    hitchThresholdMs,
    DEFAULT_HITCH_THRESHOLD_MS,
    0.1,
    60000
  );
  return {
    thresholdMs: threshold,
    maxStepTimeMs:
      typeof (profile && profile.maxStepTimeMs) === 'number'
        ? profile.maxStepTimeMs
        : null,
    averageStepTimeMs:
      typeof (profile && profile.avgStepTimeMs) === 'number'
        ? profile.avgStepTimeMs
        : null,
    frameTimesBucketSize,
    bucketsAtOrAboveThreshold: frameTimesMs.filter(time => time >= threshold)
      .length,
    exactFramesAtOrAboveThreshold:
      frameTimesBucketSize === 1
        ? frameTimesMs.filter(time => time >= threshold).length
        : null,
    exactFrameCountAvailable: frameTimesBucketSize === 1,
    worstFramesAtOrAboveThreshold: worstFrames.filter(
      frame => frame && frame.timeMs >= threshold
    ),
  };
};

const extractGameplayTestOutput = (runResult: any): any => {
  const results = Array.isArray(runResult && runResult.results)
    ? runResult.results
    : [];
  const finished = results.find(
    result => result && result.status === 'finished'
  );
  if (!finished || !finished.output) {
    throw makeError(
      'runtime_profile_failed',
      'The gameplay-test profiler did not return a finished result.'
    );
  }
  const output = finished.output;
  const profiles = Array.isArray(output.profiles) ? output.profiles : [];
  const profile = profiles.length ? profiles[profiles.length - 1] : null;
  if (!finished.success || output.status !== 'passed' || !profile) {
    throw makeError(
      'runtime_profile_failed',
      'The gameplay-test profiler did not complete successfully.',
      {
        status: output.status || null,
        errors: Array.isArray(output.errors) ? output.errors : [],
      }
    );
  }
  return { output, profile };
};

export const createRuntimeDiagnosticsService = ({
  project,
  eventTools,
  editorFunctionService,
  runtimeTelemetry,
  metadataDiscoveryService,
}: {|
  project: ?gdProject,
  eventTools: ?any,
  editorFunctionService: ?any,
  runtimeTelemetry: ?any,
  metadataDiscoveryService?: ?any,
|}): any => {
  const requireProjectScene = (sceneName: any) => {
    if (!project) throw makeError('no_project_open');
    if (
      typeof sceneName !== 'string' ||
      !sceneName ||
      !project.hasLayoutNamed(sceneName)
    ) {
      throw makeError('scene_not_found');
    }
  };

  const runGameplayProfile = async (
    request: any = {},
    signal?: any
  ): Promise<any> => {
    requireProjectScene(request.sceneName);
    if (!editorFunctionService) {
      throw makeError('gameplay_test_runtime_unavailable');
    }
    const frames = clampInteger(
      request.frames,
      DEFAULT_PROFILE_FRAMES,
      1,
      MAX_PROFILE_FRAMES
    );
    const timeoutMs = clampInteger(
      request.timeoutMs,
      DEFAULT_TIMEOUT_MS,
      1000,
      MAX_TIMEOUT_MS
    );
    const source = [
      `await harness.goToScene(${JSON.stringify(request.sceneName)});`,
      'harness.startProfiling();',
      `await harness.stepFrames(${frames});`,
      'const profile = harness.stopProfiling();',
      "harness.assert(!!profile, 'AgentIntegration runtime profile captured');",
    ].join('\n');
    const runResult = await editorFunctionService.run({
      calls: [
        {
          name: 'run_gameplay_test',
          arguments: {
            scope: { type: 'project' },
            test_name: 'AgentIntegration Runtime Diagnostics',
            source,
            persist: false,
            screenshots: 'off',
            timeout_ms: timeoutMs,
          },
        },
      ],
      save: false,
      // run_gameplay_test temporarily replaces the editor gameplay-test frame.
      // That lifecycle can abort the outer renderer command signal itself, so
      // feeding it back into the nested runner makes the profile self-cancel.
      // The outer RendererBridge still owns timeout/cancellation for this tool.
      signal: null,
    });
    const { output, profile } = extractGameplayTestOutput(runResult);
    return {
      sceneName: request.sceneName,
      requestedFrames: frames,
      status: output.status,
      framesExecuted: output.framesExecuted,
      durationMs: output.durationMs,
      profile,
      hitchAnalysis: analyzeProfileHitches(profile, request.hitchThresholdMs),
      eventLog: Array.isArray(output.eventLog) ? output.eventLog : [],
      finalState: output.finalState || null,
      persistence: 'ephemeral-gameplay-test-source',
      projectModified: false,
    };
  };

  const getCapabilities = (): any => ({
    debugger: {
      pauseContinue: {
        supported: true,
        command: 'runtime.time.pause',
        resumeCommand: 'runtime.time.resume',
        legacyCommand: 'preview.control',
        actions: ['pause', 'resume'],
      },
      timeControl: {
        supported: true,
        statusCommand: 'runtime.time.status',
        pauseCommand: 'runtime.time.pause',
        resumeCommand: 'runtime.time.resume',
        stepCommand: 'runtime.time.step',
        advanceCommand: 'runtime.time.advance',
        waitUntilCommand: 'runtime.time.wait-until',
        timeScaleCommand: 'runtime.time.set-scale',
        timeDomain: 'simulated-game-time',
        wallClockPollingRequired: false,
      },
      step: {
        supported: true,
        command: 'runtime.time.step',
        requiresPaused: true,
        source: 'RuntimeGame.SceneStack.step',
      },
      eventBreakpoints: {
        supported: !!runtimeTelemetry && !!eventTools,
        configureCommand: 'runtime.event-trace.configure',
        readCommand: 'runtime.event-trace.read',
        precision: 'pause-requested-next-frame-boundary',
        phases: ['before', 'after', 'branch'],
        projectPersistent: false,
      },
      conditionEvaluationTrace: {
        supported: !!runtimeTelemetry && !!eventTools,
        resultGranularity: 'condition-node',
        parameterCoverage:
          'authoring parameters plus evaluated static literals; dynamic expressions are not re-evaluated to avoid side effects',
        stableHandleMapping: true,
      },
      lastExecutedEventHandles: {
        supported: !!runtimeTelemetry && !!eventTools,
        command: 'runtime.event-trace.read',
        stableHandleMapping: true,
      },
      eventTraceFilters: {
        supported: !!runtimeTelemetry && !!eventTools,
        scene: true,
        generatedSourceNamespace: true,
        stableEventOrInstructionHandle: true,
        objectName: !!metadataDiscoveryService,
        instanceId: {
          supported: true,
          availability: 'runtime-hook-target-context-dependent',
          noInferenceFallback: true,
        },
      },
      watchpoints: {
        supported: !!runtimeTelemetry,
        command: 'runtime.event-trace.watch',
        precision: 'frame-boundary',
        timeDomain: 'simulated-game-time',
        requiresPausedOrAutoPause: true,
      },
      profiledGroupTrace: {
        supported: !!project && !!eventTools && !!editorFunctionService,
        granularity: 'named-group-event',
        stableHandleMapping: true,
        evidenceLimitation:
          'Group profiler sections show that a Group scope was entered, not which nested conditions passed.',
      },
    },
    profiler: {
      livePreviewAverage: {
        supported: !!runtimeTelemetry,
        source: 'gdevelop-debugger-profiler',
        frameDistribution: false,
      },
      deterministicGameplayProfile: {
        supported: !!project && !!editorFunctionService,
        source: 'gdevelop-gameplay-test-profiler',
        frameDistribution: true,
        worstFrames: true,
        maxSectionTime: true,
      },
    },
    telemetry: {
      frameTiming: { supported: true, source: 'gameplay-test-profiler' },
      renderer3D: {
        supported: true,
        availability: 'when-3d-renderer-is-active',
        metrics: ['drawCalls', 'triangles', 'geometries', 'textures'],
      },
      jsHeap: {
        supported: true,
        availability: 'when-performance-memory-is-exposed',
      },
      audio: { supported: false, reasonCode: 'audio_telemetry_not_exposed' },
      physics: {
        supported: false,
        reasonCode: 'physics_telemetry_not_exposed',
      },
      pathfinding: {
        supported: false,
        reasonCode: 'pathfinding_telemetry_not_exposed',
      },
      network: {
        supported: false,
        reasonCode: 'network_telemetry_reserved_for_cap21',
      },
    },
  });

  const runProfile = (request: any = {}, signal?: any): Promise<any> =>
    runGameplayProfile(request, signal);

  const requireLiveTrace = (sceneName: any) => {
    requireProjectScene(sceneName);
    if (!eventTools) throw makeError('event_tools_unavailable');
    if (!runtimeTelemetry) throw makeError('preview_debugger_unavailable');
  };

  const resolveTraceSelection = (eventRead: any, request: any = {}): any => {
    const sourceIndex = buildLiveTraceSourceIndex(
      eventRead,
      metadataDiscoveryService
    );
    const requestedHandles = [
      ...(typeof request.handle === 'string' && request.handle
        ? [request.handle]
        : []),
      ...(Array.isArray(request.handles) ? request.handles : []),
    ];
    const eventPaths = [];
    const instructionPaths = [];
    const resolvedHandles = [];

    const addEventAndDescendants = source => {
      sourceIndex.eventByPath.forEach(candidate => {
        const parentPath = source.eventPath || [];
        const path = candidate.eventPath || [];
        const isDescendant =
          path.length >= parentPath.length &&
          parentPath.every((value, index) => path[index] === value);
        if (
          tracePathKey(path) === tracePathKey(parentPath) ||
          (request.includeSubevents !== false && isDescendant)
        ) {
          eventPaths.push(path);
        }
      });
    };

    requestedHandles.forEach(handle => {
      const source = sourceIndex.sourceByHandle.get(handle);
      if (!source) {
        throw makeError('event_trace_handle_not_found', undefined, { handle });
      }
      resolvedHandles.push({ handle, ...source });
      if (source.kind === 'event') {
        addEventAndDescendants(source);
      } else {
        eventPaths.push(source.eventPath);
        instructionPaths.push({
          eventPath: source.eventPath,
          instructionKind:
            source.instructionKind === 'whileCondition'
              ? 'condition'
              : source.instructionKind,
          instructionPath: source.instructionPath,
        });
      }
    });

    const requestedObjectNames = Array.isArray(request.objectNames)
      ? request.objectNames.filter(
          value => typeof value === 'string' && value.length > 0
        )
      : [];
    const resolvedObjectTargets = [];
    if (requestedObjectNames.length) {
      sourceIndex.instructionBySource.forEach(source => {
        const matchingObjectNames = (source.authoringObjectNames || []).filter(
          objectName => requestedObjectNames.includes(objectName)
        );
        if (!matchingObjectNames.length) return;
        eventPaths.push(source.eventPath);
        instructionPaths.push({
          eventPath: source.eventPath,
          instructionKind:
            source.instructionKind === 'whileCondition'
              ? 'condition'
              : source.instructionKind,
          instructionPath: source.instructionPath,
        });
        resolvedObjectTargets.push({
          instructionHandle: source.handle,
          eventPath: source.eventPath,
          instructionKind: source.instructionKind,
          instructionPath: source.instructionPath,
          objectNames: matchingObjectNames,
        });
      });
      // An object filter that resolves to no typed instruction must match
      // nothing rather than silently widening to the entire Event Sheet.
      if (!resolvedObjectTargets.length) {
        eventPaths.push([2147483647]);
        instructionPaths.push({
          eventPath: [2147483647],
          instructionKind: 'action',
          instructionPath: [2147483647],
        });
      }
    }

    const breakpoints = (Array.isArray(request.breakpoints)
      ? request.breakpoints
      : []
    ).map(breakpoint => {
      if (!breakpoint || typeof breakpoint.handle !== 'string') {
        throw makeError('invalid_event_trace_breakpoint');
      }
      const source = sourceIndex.sourceByHandle.get(breakpoint.handle);
      if (!source) {
        throw makeError('event_trace_handle_not_found', undefined, {
          handle: breakpoint.handle,
        });
      }
      return {
        kind: source.kind,
        phase:
          typeof breakpoint.phase === 'string' ? breakpoint.phase : 'after',
        eventPath: source.eventPath,
        ...(source.kind === 'instruction'
          ? {
              instructionKind:
                source.instructionKind === 'whileCondition'
                  ? 'condition'
                  : source.instructionKind,
              instructionPath: source.instructionPath,
            }
          : {}),
      };
    });

    const uniquePaths = paths => {
      const seen = new Set();
      return paths.filter(path => {
        const key = tracePathKey(path);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    };
    const uniqueInstructionPaths = paths => {
      const seen = new Set();
      return paths.filter(entry => {
        const key = `${tracePathKey(entry.eventPath)}|${
          entry.instructionKind
        }|${tracePathKey(entry.instructionPath)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    };

    return {
      sourceIndex,
      resolvedHandles,
      resolvedObjectTargets,
      eventPaths: eventPaths.length ? uniquePaths(eventPaths) : null,
      instructionPaths: instructionPaths.length
        ? uniqueInstructionPaths(instructionPaths)
        : null,
      breakpoints,
    };
  };

  const configureLiveEventTrace = async (request: any = {}): Promise<any> => {
    requireLiveTrace(request.sceneName);
    const eventRead = eventTools.readEventsJson({
      sceneName: request.sceneName,
    });
    const selection = resolveTraceSelection(eventRead, request);
    const configured = await runtimeTelemetry.configureEventTrace({
      debuggerId: request.debuggerId,
      requestTimeoutMs: request.requestTimeoutMs,
      enabled: request.enabled !== false,
      mode: request.mode === 'detailed' ? 'detailed' : 'summary',
      sceneName: request.sceneName,
      maxRecords: request.maxRecords,
      maxFrames: request.maxFrames,
      maxSimulatedTimeMs: request.maxSimulatedTimeMs,
      eventPaths: selection.eventPaths,
      instructionPaths: selection.instructionPaths,
      instructionKinds: request.instructionKinds,
      sourceNamespaces: request.sourceNamespaces,
      // Object names are resolved against typed authoring parameter metadata
      // above, so the runtime receives structural paths instead of matching
      // arbitrary string parameters.
      objectNames: null,
      instanceIds: request.instanceIds,
      breakpoints: selection.breakpoints,
    });
    return {
      ...configured,
      sceneName: request.sceneName,
      eventsRevision: eventRead.eventsRevision,
      resolvedHandles: selection.resolvedHandles.map(source => ({
        handle: source.handle,
        kind: source.kind,
        eventPath: source.eventPath,
        ...(source.kind === 'instruction'
          ? {
              instructionKind: source.instructionKind,
              instructionPath: source.instructionPath,
            }
          : {}),
      })),
      resolvedObjectTargets: selection.resolvedObjectTargets,
      requestedFilters: {
        sourceNamespaces: Array.isArray(request.sourceNamespaces)
          ? request.sourceNamespaces
          : [],
        objectNames: Array.isArray(request.objectNames)
          ? request.objectNames
          : [],
        instanceIds: Array.isArray(request.instanceIds)
          ? request.instanceIds
          : [],
      },
      capabilities: {
        conditionResults: true,
        actionExecution: true,
        eventBranchResults: true,
        branchPaths: true,
        breakpoints: true,
        watchpointsCommand: 'runtime.event-trace.watch',
        breakpointPrecision: 'pause-requested-next-frame-boundary',
        filters: {
          scene: 'authoritative',
          generatedSourceNamespace: 'authoritative',
          eventOrInstructionHandle: 'authoritative-current-events-revision',
          objectName: metadataDiscoveryService
            ? 'authoritative-typed-authoring-parameter'
            : 'unavailable-without-instruction-metadata',
          instanceId:
            'authoritative-only-when-runtime-hook-exposes-targetContext-instance-id',
        },
        projectPersistent: false,
      },
    };
  };

  const readLiveEventTrace = async (request: any = {}): Promise<any> => {
    requireLiveTrace(request.sceneName);
    const eventRead = eventTools.readEventsJson({
      sceneName: request.sceneName,
    });
    const sourceIndex = buildLiveTraceSourceIndex(
      eventRead,
      metadataDiscoveryService
    );
    const raw = await runtimeTelemetry.readEventTrace({
      debuggerId: request.debuggerId,
      requestTimeoutMs: request.requestTimeoutMs,
      offset: request.offset,
      limit: request.limit,
    });
    let records = (raw.records || []).map(record =>
      mapLiveTraceRecord(record, sourceIndex)
    );

    if (typeof request.handle === 'string' && request.handle) {
      records = records.filter(
        record =>
          record.eventHandle === request.handle ||
          record.instructionHandle === request.handle ||
          record.branchPath.some(entry => entry.eventHandle === request.handle)
      );
    }

    const requestedSourceNamespaces = [
      ...(typeof request.sourceNamespace === 'string' && request.sourceNamespace
        ? [request.sourceNamespace]
        : []),
      ...(Array.isArray(request.sourceNamespaces)
        ? request.sourceNamespaces
        : []),
    ];
    if (requestedSourceNamespaces.length) {
      records = records.filter(record =>
        requestedSourceNamespaces.includes(record.sourceNamespace)
      );
    }

    const requestedObjectNames = [
      ...(typeof request.objectName === 'string' && request.objectName
        ? [request.objectName]
        : []),
      ...(Array.isArray(request.objectNames) ? request.objectNames : []),
    ];
    if (requestedObjectNames.length) {
      records = records.filter(record => {
        const targetObjectNames =
          record.targetContext &&
          Array.isArray(record.targetContext.authoringObjectNames)
            ? record.targetContext.authoringObjectNames
            : [];
        return requestedObjectNames.some(objectName =>
          targetObjectNames.includes(objectName)
        );
      });
    }

    const requestedInstanceIds = [
      ...(request.instanceId !== undefined && request.instanceId !== null
        ? [request.instanceId]
        : []),
      ...(Array.isArray(request.instanceIds) ? request.instanceIds : []),
    ].map(String);
    if (requestedInstanceIds.length) {
      records = records.filter(record => {
        const recordInstanceIds =
          record.targetContext &&
          Array.isArray(record.targetContext.instanceIds)
            ? record.targetContext.instanceIds.map(String)
            : [];
        return requestedInstanceIds.some(instanceId =>
          recordInstanceIds.includes(instanceId)
        );
      });
    }

    if (Array.isArray(request.kinds) && request.kinds.length) {
      records = records.filter(record => request.kinds.includes(record.kind));
    }

    const diagnostics = collectStaticTraceDiagnostics(sourceIndex, records);
    const filteredRecordCounts =
      raw &&
      raw.filteredRecordCounts &&
      typeof raw.filteredRecordCounts === 'object'
        ? raw.filteredRecordCounts
        : {};
    if (
      requestedInstanceIds.length &&
      filteredRecordCounts['instance-context-unavailable']
    ) {
      diagnostics.push({
        code: 'event_trace_instance_context_unavailable',
        severity: 'info',
        requestedInstanceIds,
        filteredCount: filteredRecordCounts['instance-context-unavailable'],
        reason:
          'The generic instruction hook did not expose runtime target instance ids for these records. No instance identity was inferred from object order or authoring text.',
      });
    }
    return {
      ...raw,
      sceneName: request.sceneName,
      eventsRevision: eventRead.eventsRevision,
      records,
      diagnostics,
      filterSummary: {
        requested: {
          sourceNamespaces: requestedSourceNamespaces,
          objectNames: requestedObjectNames,
          instanceIds: requestedInstanceIds,
        },
        runtimeFilteredRecordCounts: filteredRecordCounts,
      },
      sourceMapping: {
        stableHandles: true,
        eventPathSource: 'generated-runtime-structural-path',
        handleSource: 'current-EventTools-canonical-index',
        requiresMatchingEventsRevision: true,
      },
      coverage: {
        sceneEvents: 'authoritative-runtime-hooks',
        conditions:
          'true/false results for generated condition nodes; short-circuited later conditions are diagnosed',
        actions:
          'before/after execution hooks with metadata-resolved authoring object target names and runtime instance ids only when the hook exposes targetContext',
        filters: {
          scene: 'authoritative',
          generatedSourceNamespace: 'authoritative',
          stableHandle: 'authoritative-current-events-revision',
          objectName: metadataDiscoveryService
            ? 'typed-authoring-parameter'
            : 'unavailable-without-instruction-metadata',
          instanceId:
            'hook-dependent; unavailable context is diagnosed and never inferred',
        },
        parameters:
          'authoring values plus static-literal evaluation only; dynamic expressions are not re-evaluated',
        externalEvents:
          'linked events can be flattened by preprocessing; sourceNamespace is retained but stable external-sheet mapping is not fabricated',
        extensionFunctions:
          'runtime sourceNamespace is retained; stable function-sheet mapping requires a matching function target index',
      },
      projectModified: false,
    };
  };

  const clearLiveEventTrace = async (request: any = {}): Promise<any> => {
    if (!runtimeTelemetry) throw makeError('preview_debugger_unavailable');
    return runtimeTelemetry.clearEventTrace({
      debuggerId: request.debuggerId,
      requestTimeoutMs: request.requestTimeoutMs,
    });
  };

  const watchLiveEventTrace = async (request: any = {}): Promise<any> => {
    requireLiveTrace(request.sceneName);
    if (!request.selector || typeof request.selector !== 'object') {
      throw makeError('invalid_runtime_watchpoint_selector');
    }
    const maxFrames = clampInteger(request.maxFrames, 120, 1, 10000);
    const frameDurationMs = clampNumber(
      request.frameDurationMs,
      1000 / 60,
      0.1,
      1000
    );
    const statusBefore = await runtimeTelemetry.getTimeControlStatus({
      debuggerId: request.debuggerId,
      requestTimeoutMs: request.requestTimeoutMs,
    });
    const wasPaused = statusBefore.isPaused === true;
    if (!wasPaused) {
      if (request.autoPause === false) {
        throw makeError('runtime_watchpoint_requires_paused');
      }
      await runtimeTelemetry.pauseRuntime({
        debuggerId: request.debuggerId,
        requestTimeoutMs: request.requestTimeoutMs,
      });
    }

    if (request.configureTrace !== false) {
      await configureLiveEventTrace({
        ...request,
        enabled: true,
        mode: request.mode || 'detailed',
        maxFrames,
      });
    }

    const before = await runtimeTelemetry.inspectRuntime({
      debuggerId: request.debuggerId,
      requestTimeoutMs: request.requestTimeoutMs,
      selector: request.selector,
    });
    const beforeKey = JSON.stringify({
      found: before.found,
      value: before.value,
    });
    let after = before;
    let framesAdvanced = 0;
    let elapsedSimulatedTimeMs = 0;
    let changed = false;

    while (framesAdvanced < maxFrames) {
      const step = await runtimeTelemetry.stepRuntimeFrames({
        debuggerId: request.debuggerId,
        requestTimeoutMs: request.requestTimeoutMs,
        frames: 1,
        frameDurationMs,
      });
      framesAdvanced += step.framesAdvanced || 0;
      elapsedSimulatedTimeMs += step.elapsedSimulatedTimeMs || 0;
      after = await runtimeTelemetry.inspectRuntime({
        debuggerId: request.debuggerId,
        requestTimeoutMs: request.requestTimeoutMs,
        selector: request.selector,
      });
      const afterKey = JSON.stringify({
        found: after.found,
        value: after.value,
      });
      if (afterKey !== beforeKey) {
        changed = true;
        break;
      }
      if (!step.framesAdvanced) break;
    }

    const trace = await readLiveEventTrace(request);
    if (!changed && !wasPaused && request.keepPaused !== true) {
      await runtimeTelemetry.resumeRuntime({
        debuggerId: request.debuggerId,
        requestTimeoutMs: request.requestTimeoutMs,
      });
    }

    return {
      changed,
      selector: request.selector,
      before,
      after,
      framesAdvanced,
      elapsedSimulatedTimeMs,
      wallClockWaitUsed: false,
      timeDomain: 'simulated-game-time',
      runtimeStateAfter:
        changed || wasPaused || request.keepPaused === true
          ? 'paused'
          : 'running',
      trace,
      projectModified: false,
    };
  };

  const captureEventTrace = async (
    request: any = {},
    signal?: any
  ): Promise<any> => {
    requireProjectScene(request.sceneName);
    if (!eventTools) throw makeError('event_tools_unavailable');
    const eventRead = eventTools.readEventsJson({
      sceneName: request.sceneName,
    });
    const eventIndex = indexProfiledEvents(eventRead);
    const profileResult = await runGameplayProfile(request, signal);
    const sectionMap = getProfileSectionMap(profileResult.profile);
    const groups = eventIndex.groups.map(group =>
      makeGroupTrace(group, sectionMap)
    );

    let target = null;
    if (request.handle) {
      const record = eventIndex.records.find(
        event => event.handle === request.handle
      );
      if (!record) {
        throw makeError('event_handle_not_found', undefined, {
          handle: request.handle,
        });
      }
      const ownGroup = groups.find(group => group.handle === record.handle);
      const ancestorGroups = record.ancestorGroups.map(ancestor => {
        const traced = groups.find(group => group.handle === ancestor.handle);
        return traced || makeGroupTrace(ancestor, sectionMap);
      });
      target = {
        handle: record.handle,
        path: record.path,
        type: record.type,
        disabled: record.disabled,
        conditions: record.canonical.conditions || [],
        whileConditions: record.canonical.whileConditions || [],
        actions: record.canonical.actions || [],
        traceableAtOwnScope: !!ownGroup,
        ownGroupTrace: ownGroup || null,
        ancestorGroupTraces: ancestorGroups,
        executionConclusion:
          ownGroup || ancestorGroups.length
            ? 'group-scope-evidence-only'
            : 'not-traceable-with-current-build',
      };
    }

    return {
      sceneName: request.sceneName,
      eventsRevision: eventRead.eventsRevision,
      traceMode: 'profiler-group-sections',
      groups,
      target,
      conditionEvaluation: {
        supported: false,
        reasonCode: 'condition_trace_not_exposed',
      },
      breakpoints: {
        supported: false,
        reasonCode: 'event_breakpoints_not_exposed',
      },
      stepping: {
        supported: true,
        command: 'runtime.time.step',
        requiresPaused: true,
        timeDomain: 'simulated-game-time',
      },
      profile: profileResult.profile,
      hitchAnalysis: profileResult.hitchAnalysis,
      eventLog: profileResult.eventLog,
      finalState: profileResult.finalState,
      projectModified: false,
    };
  };

  return {
    getCapabilities,
    runProfile,
    captureEventTrace,
    configureLiveEventTrace,
    readLiveEventTrace,
    clearLiveEventTrace,
    watchLiveEventTrace,
  };
};
