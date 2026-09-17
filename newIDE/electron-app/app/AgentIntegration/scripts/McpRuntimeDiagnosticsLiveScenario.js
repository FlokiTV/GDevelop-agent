const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  Client,
  StreamableHTTPClientTransport,
} = require('@modelcontextprotocol/client');
const {
  getDefaultDiscoveryPath,
  loadRuntimeConfig,
  makeRequestHeaders,
  sanitizeForReplay,
} = require('./McpLiveGate');

const REQUIRED_TOOLS = [
  'project.status',
  'project.create',
  'project.save-as',
  'project.close',
  'editor.functions.create-scene',
  'events.read',
  'events.insert',
  'preview.start',
  'preview.status',
  'preview.close-all',
  'runtime.debugger.capabilities',
  'runtime.profiler.start',
  'runtime.profiler.status',
  'runtime.profiler.stop',
  'runtime.profile.run',
  'runtime.event-trace.capture',
  'safety.transactions.begin',
  'safety.transactions.rollback',
];

const getData = response =>
  response && response.structuredContent
    ? response.structuredContent.data != null
      ? response.structuredContent.data
      : response.structuredContent
    : null;

const getMeta = response =>
  response && response.structuredContent && response.structuredContent.meta
    ? response.structuredContent.meta
    : null;

const wait = delayMs => new Promise(resolve => setTimeout(resolve, delayMs));

const parseArgs = argv => {
  const options = { rollback: true, cleanupProject: true };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--allow-mutate') options.allowMutate = true;
    else if (argument === '--persist') options.rollback = false;
    else if (argument === '--keep-project') options.cleanupProject = false;
    else if (argument === '--output') options.outputDir = argv[++index];
    else if (argument === '--window-id') options.windowId = argv[++index];
    else if (argument === '--project-path') options.projectPath = argv[++index];
    else if (argument === '--help') options.help = true;
    else throw new Error(`unknown_argument:${argument}`);
  }
  return options;
};

const assertRequiredTools = tools => {
  const byName = new Map((tools || []).map(tool => [tool.name, tool]));
  const missing = REQUIRED_TOOLS.filter(name => !byName.has(name));
  if (missing.length) {
    throw new Error(`runtime_diagnostics_tools_missing:${missing.join(',')}`);
  }
  for (const name of [
    'runtime.debugger.capabilities',
    'runtime.profiler.status',
  ]) {
    const tool = byName.get(name);
    if (!tool.annotations || tool.annotations.readOnlyHint !== true) {
      throw new Error(`runtime_diagnostics_annotations_invalid:${name}`);
    }
  }
  return byName;
};

const findNestedEvent = (events, predicate) => {
  for (const event of events || []) {
    if (predicate(event)) return event;
    const nested = findNestedEvent(event && event.children, predicate);
    if (nested) return nested;
  }
  return null;
};

const waitForPreview = async (call, timeoutMs = 15000) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = await call('preview.status');
    const ids =
      result.data && Array.isArray(result.data.previewDebuggerIds)
        ? result.data.previewDebuggerIds
        : result.data && Array.isArray(result.data.debuggerIds)
        ? result.data.debuggerIds
        : [];
    if (result.data && result.data.running && ids.length) {
      return { status: result.data, debuggerId: ids[ids.length - 1] };
    }
    await wait(250);
  }
  throw new Error('preview_debugger_timeout');
};

const runRuntimeDiagnosticsLiveScenario = async ({
  allowMutate,
  rollback = true,
  cleanupProject = true,
  outputDir = path.resolve(
    process.cwd(),
    'artifacts',
    'mcp-runtime-diagnostics-live-e2e'
  ),
  windowId,
  projectPath,
  env = process.env,
}) => {
  if (!allowMutate) throw new Error('mutation_requires_--allow-mutate');
  fs.mkdirSync(outputDir, { recursive: true });
  const projectRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gdevelop-cap16-17-live-')
  );
  const projectFile = path.join(projectRoot, 'game.json');

  const runtime = loadRuntimeConfig(getDefaultDiscoveryPath(env));
  const client = new Client(
    { name: 'gdevelop-runtime-diagnostics-live-e2e', version: '1.0.0' },
    {
      capabilities: { elicitation: { form: {} } },
      versionNegotiation: { mode: { pin: runtime.protocolVersion } },
    }
  );
  client.setRequestHandler('elicitation/create', async request => {
    const message = String((request.params && request.params.message) || '');
    if (/discard|close|rollback/i.test(message)) {
      return { action: 'accept', content: { confirm: true } };
    }
    return { action: 'decline' };
  });

  const transport = new StreamableHTTPClientTransport(
    new URL(runtime.endpoint),
    {
      requestInit: {
        headers: makeRequestHeaders({
          token: runtime.token,
          clientId: 'gdevelop-runtime-diagnostics-live-e2e',
          windowId,
          projectPath,
        }),
      },
    }
  );

  const replay = [];
  let revision = null;
  let transactionId = null;
  let createdProject = false;
  let previewStarted = false;

  const record = (name, args, response) => {
    const data = sanitizeForReplay(getData(response));
    const meta = sanitizeForReplay(getMeta(response));
    replay.push({ name, args: sanitizeForReplay(args), data, meta });
    return { response, data, meta };
  };

  const call = async (
    name,
    args = {},
    { allowError = false, timeout = 120000 } = {}
  ) => {
    const response = await client.callTool(
      { name, arguments: args },
      { timeout }
    );
    const result = record(name, args, response);
    if (response.isError && !allowError) {
      const toolError = result.data && result.data.error;
      throw new Error(
        `tool_failed:${name}:${
          toolError && toolError.code ? toolError.code : 'unknown'
        }:${toolError && toolError.message ? toolError.message : 'no_message'}`
      );
    }
    return result;
  };

  const mutate = async (name, args) => {
    const result = await call(name, {
      ...args,
      ...(Number.isInteger(revision) ? { expectedRevision: revision } : {}),
      idempotencyKey: `cap16-17-${Date.now().toString(36)}-${replay.length}`,
    });
    if (result.meta && Number.isInteger(result.meta.projectRevision)) {
      revision = result.meta.projectRevision;
    } else {
      revision = (await call('project.status')).data.projectRevision;
    }
    return result;
  };

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assertRequiredTools(tools.tools);

    const initial = await call('project.status');
    if (initial.data && initial.data.projectOpen) {
      throw new Error(
        'live_scenario_requires_fresh_editor_without_open_project'
      );
    }

    await call('project.create', {
      name: `MCP Runtime Diagnostics ${Date.now().toString(36)}`,
    });
    createdProject = true;
    await wait(1200);
    await call('project.save-as', { filePath: projectFile });
    await wait(500);
    const savedStatus = await call('project.status');
    if (!savedStatus.data || !savedStatus.data.projectOpen) {
      throw new Error('temporary_project_not_open_after_save');
    }
    revision = savedStatus.data.projectRevision;
    const originalRevision = revision;

    const transaction = await call('safety.transactions.begin', {
      label: 'CAP-16/17 runtime diagnostics live E2E',
    });
    transactionId = transaction.data.transactionId;
    if (!transactionId) throw new Error('transaction_id_missing');

    const suffix = Date.now().toString(36);
    const sceneName = `Runtime Diagnostics ${suffix}`;
    const groupName = `False Guard ${suffix}`;
    await mutate('editor.functions.create-scene', { scene_name: sceneName });

    const beforeEvents = await call('events.read', { sceneName });
    await mutate('events.insert', {
      sceneName,
      expectedEventsRevision: beforeEvents.data.eventsRevision,
      eventsJson: [
        {
          disabled: false,
          folded: false,
          type: 'BuiltinCommonInstructions::Group',
          name: groupName,
          source: '',
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
    });

    const events = await call('events.read', { sceneName });
    const groupEvent = findNestedEvent(
      events.data.events,
      event => event && event.type === 'BuiltinCommonInstructions::Group'
    );
    const childEvent = findNestedEvent(
      groupEvent && groupEvent.children,
      event =>
        event &&
        Array.isArray(event.conditions) &&
        event.conditions.some(
          condition =>
            condition &&
            condition.type === 'BuiltinCommonInstructions::CompareNumbers'
        )
    );
    if (
      !groupEvent ||
      !groupEvent.handle ||
      !childEvent ||
      !childEvent.handle
    ) {
      throw new Error('runtime_diagnostics_event_handles_missing');
    }

    const capabilities = await call('runtime.debugger.capabilities');
    if (
      !capabilities.data ||
      capabilities.data.debugger.step.supported !== false ||
      capabilities.data.debugger.eventBreakpoints.supported !== false ||
      capabilities.data.debugger.conditionEvaluationTrace.supported !== false ||
      capabilities.data.debugger.profiledGroupTrace.supported !== true ||
      capabilities.data.profiler.deterministicGameplayProfile.supported !== true
    ) {
      throw new Error('runtime_diagnostics_capabilities_invalid');
    }

    await call('preview.start');
    previewStarted = true;
    const preview = await waitForPreview(call);
    const profilerStart = await call('runtime.profiler.start', {
      debuggerId: preview.debuggerId,
      requestTimeoutMs: 5000,
    });
    if (!profilerStart.data || profilerStart.data.profiling !== true) {
      throw new Error('runtime_profiler_start_failed');
    }
    await wait(700);
    const profilerStatus = await call('runtime.profiler.status', {
      debuggerId: preview.debuggerId,
    });
    if (!profilerStatus.data || profilerStatus.data.profiling !== true) {
      throw new Error('runtime_profiler_status_invalid');
    }
    const profilerStop = await call('runtime.profiler.stop', {
      debuggerId: preview.debuggerId,
      requestTimeoutMs: 5000,
    });
    if (
      !profilerStop.data ||
      profilerStop.data.profiling !== false ||
      !profilerStop.data.output ||
      !Array.isArray(profilerStop.data.output.sections)
    ) {
      throw new Error('runtime_profiler_stop_invalid');
    }

    await call('preview.close-all');
    previewStarted = false;

    const profile = await call('runtime.profile.run', {
      sceneName,
      frames: 12,
      hitchThresholdMs: 33.3333333333,
      timeoutMs: 30000,
    });
    if (
      !profile.data ||
      profile.data.status !== 'passed' ||
      profile.data.projectModified !== false ||
      !profile.data.profile ||
      !Array.isArray(profile.data.profile.sections) ||
      !profile.data.hitchAnalysis
    ) {
      throw new Error('runtime_profile_run_invalid');
    }

    const trace = await call('runtime.event-trace.capture', {
      sceneName,
      handle: childEvent.handle,
      frames: 12,
      timeoutMs: 30000,
    });
    const ancestorTrace =
      trace.data &&
      trace.data.target &&
      Array.isArray(trace.data.target.ancestorGroupTraces)
        ? trace.data.target.ancestorGroupTraces.find(
            item => item && item.handle === groupEvent.handle
          )
        : null;
    if (
      !trace.data ||
      trace.data.traceMode !== 'profiler-group-sections' ||
      !trace.data.target ||
      trace.data.target.handle !== childEvent.handle ||
      trace.data.target.executionConclusion !== 'group-scope-evidence-only' ||
      !ancestorTrace ||
      ancestorTrace.observed !== true ||
      trace.data.conditionEvaluation.supported !== false ||
      trace.data.conditionEvaluation.reasonCode !==
        'condition_trace_not_exposed' ||
      trace.data.breakpoints.supported !== false ||
      trace.data.stepping.supported !== false
    ) {
      throw new Error('runtime_event_trace_invalid');
    }
    const falseCondition = trace.data.target.conditions.find(
      condition =>
        condition &&
        condition.type === 'BuiltinCommonInstructions::CompareNumbers'
    );
    if (
      !falseCondition ||
      JSON.stringify(falseCondition.parameters) !==
        JSON.stringify(['1', '=', '2'])
    ) {
      throw new Error('deliberately_false_condition_not_preserved');
    }

    await call('preview.close-all');
    previewStarted = false;

    if (rollback) {
      await call('safety.transactions.rollback', { transactionId });
      transactionId = null;
    }
    const finalStatus = await call('project.status');
    if (rollback && finalStatus.data.projectRevision !== originalRevision) {
      throw new Error(
        `rollback_revision_mismatch:${originalRevision}:${
          finalStatus.data.projectRevision
        }`
      );
    }

    const result = {
      ok: true,
      rollback,
      protocolVersion: client.getNegotiatedProtocolVersion(),
      toolCount: tools.tools.length,
      sceneName,
      groupName,
      groupHandle: groupEvent.handle,
      childHandle: childEvent.handle,
      capabilities: capabilities.data,
      liveProfiler: {
        debuggerId: preview.debuggerId,
        averageFrameTimeMs: profilerStop.data.output.averageFrameTimeMs,
        estimatedFps: profilerStop.data.output.estimatedFps,
        sectionCount: profilerStop.data.output.sections.length,
      },
      deterministicProfile: {
        requestedFrames: profile.data.requestedFrames,
        framesExecuted: profile.data.framesExecuted,
        maxStepTimeMs: profile.data.profile.maxStepTimeMs,
        averageStepTimeMs: profile.data.profile.avgStepTimeMs,
        hitchAnalysis: profile.data.hitchAnalysis,
      },
      eventTrace: {
        traceMode: trace.data.traceMode,
        executionConclusion: trace.data.target.executionConclusion,
        ancestorGroupObserved: ancestorTrace.observed,
        falseCondition: falseCondition.parameters,
        conditionEvaluation: trace.data.conditionEvaluation,
      },
      originalRevision,
      finalRevision: finalStatus.data.projectRevision,
      replay,
    };
    fs.writeFileSync(
      path.join(outputDir, 'replay.json'),
      `${JSON.stringify(result, null, 2)}\n`
    );

    if (createdProject) {
      await call('project.close', { discardUnsavedChanges: true });
      createdProject = false;
    }
    if (cleanupProject) {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
    return result;
  } catch (error) {
    if (previewStarted) {
      try {
        await call('preview.close-all');
      } catch (_) {}
    }
    if (transactionId) {
      try {
        await call('safety.transactions.rollback', { transactionId });
      } catch (_) {}
    }
    if (createdProject) {
      try {
        await call('project.close', { discardUnsavedChanges: true });
      } catch (_) {}
    }
    if (cleanupProject) {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
    throw error;
  } finally {
    await client.close();
  }
};

const printHelp = () => {
  process.stdout.write(
    [
      'Usage: node AgentIntegration/scripts/McpRuntimeDiagnosticsLiveScenario.js --allow-mutate [options]',
      '',
      'Exercises CAP-16/17 against a fresh desktop editor: stable event handles, named-Group profiler evidence, truthful unsupported condition/breakpoint/step capabilities, live preview profiler, deterministic gameplay profile, rollback and cleanup.',
      '',
      'Options:',
      '  --allow-mutate          Required explicit project-mutation opt-in.',
      '  --persist               Do not roll back temporary event mutations.',
      '  --keep-project          Keep the temporary saved project directory.',
      '  --output <dir>          Sanitized replay evidence directory.',
      '  --window-id <id>        Optional editor targeting header.',
      '  --project-path <path>   Optional project targeting header.',
      '  --help                  Show help.',
      '',
    ].join('\n')
  );
};

if (require.main === module) {
  (async () => {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) return printHelp();
    const result = await runRuntimeDiagnosticsLiveScenario(options);
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: result.ok,
          rollback: result.rollback,
          protocolVersion: result.protocolVersion,
          toolCount: result.toolCount,
          groupHandle: result.groupHandle,
          childHandle: result.childHandle,
          liveProfiler: result.liveProfiler,
          deterministicProfile: result.deterministicProfile,
          eventTrace: result.eventTrace,
          originalRevision: result.originalRevision,
          finalRevision: result.finalRevision,
        },
        null,
        2
      )}\n`
    );
  })().catch(error => {
    process.stderr.write(
      `MCP runtime-diagnostics live scenario failed: ${
        error && error.message ? error.message : String(error)
      }\n`
    );
    process.exitCode = 1;
  });
}

module.exports = {
  REQUIRED_TOOLS,
  assertRequiredTools,
  findNestedEvent,
  parseArgs,
  runRuntimeDiagnosticsLiveScenario,
};
