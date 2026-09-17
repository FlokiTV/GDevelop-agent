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
}: {|
  project: ?gdProject,
  eventTools: ?any,
  editorFunctionService: ?any,
  runtimeTelemetry: ?any,
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
        command: 'preview.control',
        actions: ['pause', 'play'],
      },
      step: {
        supported: false,
        reasonCode: 'debugger_step_not_exposed',
      },
      eventBreakpoints: {
        supported: false,
        reasonCode: 'event_breakpoints_not_exposed',
      },
      conditionEvaluationTrace: {
        supported: false,
        reasonCode: 'condition_trace_not_exposed',
      },
      lastExecutedEventHandles: {
        supported: false,
        reasonCode: 'event_handle_trace_not_exposed',
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
        supported: false,
        reasonCode: 'debugger_step_not_exposed',
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
  };
};
