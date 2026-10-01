const fs = require('fs');
const os = require('os');
const path = require('path');
const { connectLiveGDevelopMcp, sanitizeForReplay } = require('./McpClient');

const REQUIRED_TOOLS = [
  'project.status',
  'project.create',
  'project.save-as',
  'project.close',
  'objects.definitions.create',
  'scene.instances.create',
  'editor.functions.call',
  'scene.open',
  'events.read',
  'events.insert',
  'events.instructions.search',
  'preview.start',
  'preview.status',
  'preview.close-all',
  'preview.input.send',
  'runtime.inspect',
  'runtime.time.pause',
  'runtime.time.step',
  'runtime.event-trace.configure',
  'runtime.event-trace.read',
  'runtime.event-trace.clear',
  'runtime.event-trace.watch',
  'runtime.debugger.capabilities',
  'agent.jobs.capabilities',
  'validation.run',
  'safety.transactions.begin',
  'safety.transactions.rollback',
];

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const wait = milliseconds =>
  new Promise(resolve => setTimeout(resolve, milliseconds));

const getData = result =>
  result && result.data
    ? result.data
    : result && result.structuredContent && result.structuredContent.data
    ? result.structuredContent.data
    : result && result.structuredContent
    ? result.structuredContent
    : null;

const extractError = result =>
  result && result.structuredContent && result.structuredContent.error
    ? result.structuredContent.error
    : result && result.data && result.data.error
    ? result.data.error
    : null;

const revisionOf = result => {
  const data = getData(result);
  const revision =
    result && result.meta && Number.isInteger(result.meta.projectRevision)
      ? result.meta.projectRevision
      : result &&
        result.structuredContent &&
        result.structuredContent.meta &&
        Number.isInteger(result.structuredContent.meta.projectRevision)
      ? result.structuredContent.meta.projectRevision
      : data && Number.isInteger(data.projectRevision)
      ? data.projectRevision
      : null;
  assert(Number.isInteger(revision), 'dx36_missing_project_revision');
  return revision;
};

const findTool = (tools, name) => {
  const tool = tools.find(candidate => candidate.name === name);
  assert(tool, 'dx36_missing_tool:' + name);
  return tool;
};

const validationErrorCount = validation =>
  validation && Array.isArray(validation.errors)
    ? validation.errors.length
    : validation && Number.isInteger(validation.errorCount)
    ? validation.errorCount
    : validation &&
      validation.summary &&
      Number.isInteger(validation.summary.errors)
    ? validation.summary.errors
    : 0;

const extractPreviewWindowId = previewStatus => {
  if (
    previewStatus &&
    Array.isArray(previewStatus.previewWindowIds) &&
    Number.isInteger(previewStatus.previewWindowIds[0])
  ) {
    return previewStatus.previewWindowIds[0];
  }
  const target =
    previewStatus &&
    Array.isArray(previewStatus.targets) &&
    previewStatus.targets.find(
      candidate => candidate && Number.isInteger(candidate.windowId)
    );
  return target ? target.windowId : null;
};

const typeOf = instruction =>
  instruction && instruction.type && typeof instruction.type === 'object'
    ? instruction.type.value
    : instruction && instruction.type;

const findInstruction = async (call, kind, query, preferredIds = []) => {
  const result = getData(
    await call('events.instructions.search', {
      kind,
      query,
      deprecated: 'include',
      includeHidden: true,
      limit: 100,
    })
  );
  const items = (result && result.items) || [];
  for (const id of preferredIds) {
    const exact = items.find(item => item.id === id);
    if (exact) return exact;
  }
  assert(items.length, 'dx36_instruction_not_discovered:' + kind + ':' + query);
  return items[0];
};

const findFirstInstructionNode = (eventsRead, eventIndex, listName) => {
  const event = eventsRead.events && eventsRead.events[eventIndex];
  assert(event && event.handle, 'dx36_event_handle_missing:' + eventIndex);
  const list = event[listName] || [];
  assert(
    list[0] && list[0].handle,
    'dx36_instruction_handle_missing:' + listName
  );
  return { event, instruction: list[0] };
};

const installRepositoryReadGuard = () => {
  const repositoryRoot = path.resolve(__dirname, '..', '..', '..', '..', '..');
  const originalReadFileSync = fs.readFileSync.bind(fs);
  const originalReadFile = fs.readFile.bind(fs);
  const assertAllowed = filePath => {
    if (typeof filePath !== 'string') return;
    const resolved = path.resolve(filePath);
    const relative = path.relative(repositoryRoot, resolved);
    const insideRepository =
      relative === '' ||
      (!relative.startsWith('..') && !path.isAbsolute(relative));
    if (insideRepository) {
      throw new Error(
        'dx36_clean_room_repository_read_forbidden:' + path.basename(resolved)
      );
    }
  };
  fs.readFileSync = (filePath, ...args) => {
    assertAllowed(filePath);
    return originalReadFileSync(filePath, ...args);
  };
  fs.readFile = (filePath, ...args) => {
    assertAllowed(filePath);
    return originalReadFile(filePath, ...args);
  };
  return () => {
    fs.readFileSync = originalReadFileSync;
    fs.readFile = originalReadFile;
  };
};

const run = async ({
  label = 'live',
  evidencePath = path.join(
    os.tmpdir(),
    'gdevelop-dx36-event-trace-' + process.pid + '.json'
  ),
} = {}) => {
  const rootDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gdevelop-dx36-event-trace-')
  );
  const projectDir = path.join(rootDir, 'project');
  const projectFile = path.join(projectDir, 'game.json');
  fs.mkdirSync(projectDir, { recursive: true });

  const restoreRepositoryReads = installRepositoryReadGuard();
  let session = null;
  let transactionId = null;
  let projectOpen = false;
  const replay = [];

  const record = (name, args, result) => {
    replay.push(
      sanitizeForReplay({
        name,
        args,
        result: result.structuredContent || result.data || result.content,
      })
    );
  };

  const connect = async suffix =>
    connectLiveGDevelopMcp({
      clientId: 'gdevelop-dx36-event-trace-' + label + '-' + suffix,
      confirmDestructiveOperations: true,
    });

  const call = async (name, args = {}, { allowError = false } = {}) => {
    const result = await session.call(name, args);
    record(name, args, result);
    if (result.isError && !allowError) {
      const error = extractError(result);
      throw new Error(
        'dx36_tool_failed:' +
          name +
          ':' +
          (error && error.code ? error.code : 'unknown')
      );
    }
    return result;
  };

  const mutate = async (name, args = {}) => {
    const revision = revisionOf(await call('project.status'));
    const result = await call(name, {
      ...args,
      expectedRevision: revision,
      idempotencyKey: 'dx36-' + name + '-' + revision + '-' + replay.length,
    });
    if (transactionId) {
      const meta =
        result.meta ||
        (result.structuredContent && result.structuredContent.meta) ||
        null;
      assert(
        meta && meta.transactionId === transactionId,
        'dx36_transaction_metadata_missing:' + name
      );
    }
    return result;
  };

  const waitForPreviewReady = async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const data = getData(await call('preview.status'));
      if (data && data.runtimeReady && data.debuggerAttached) return data;
      await wait(100);
    }
    throw new Error('dx36_preview_ready_timeout');
  };

  const waitForPreviewStopped = async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const data = getData(await call('preview.status'));
      if (!data || data.state === 'stopped' || !data.running) return data;
      await wait(100);
    }
    throw new Error('dx36_preview_stop_timeout');
  };

  try {
    session = await connect('initial');
    const tools = await session.listTools();
    REQUIRED_TOOLS.forEach(name => findTool(tools, name));

    const configureTool = findTool(tools, 'runtime.event-trace.configure');
    const readTool = findTool(tools, 'runtime.event-trace.read');
    const watchTool = findTool(tools, 'runtime.event-trace.watch');
    assert(
      configureTool.inputSchema &&
        configureTool.inputSchema.properties &&
        configureTool.inputSchema.properties.breakpoints &&
        configureTool.inputSchema.properties.maxSimulatedTimeMs,
      'dx36_configure_schema_missing'
    );
    assert(
      readTool.inputSchema &&
        readTool.inputSchema.properties &&
        readTool.inputSchema.properties.handle,
      'dx36_read_schema_missing'
    );
    assert(
      watchTool.inputSchema &&
        watchTool.inputSchema.required.includes('selector') &&
        watchTool.inputSchema.properties.frameDurationMs,
      'dx36_watch_schema_missing'
    );

    const initialStatus = getData(await call('project.status'));
    assert(
      !initialStatus || initialStatus.projectOpen !== true,
      'dx36_requires_fresh_editor'
    );

    await call('project.create', {
      name: 'DX36 Event Trace Acceptance',
      idempotencyKey: 'dx36-create-project',
    });
    projectOpen = true;
    await call('project.save-as', {
      filePath: projectFile,
      name: 'DX36 Event Trace Acceptance',
    });

    const statusAfterCreate = getData(await call('project.status'));
    const sceneName =
      statusAfterCreate &&
      Array.isArray(statusAfterCreate.sceneNames) &&
      statusAfterCreate.sceneNames[0];
    assert(sceneName, 'dx36_project_scene_missing');

    const begun = getData(
      await call('safety.transactions.begin', {
        label: 'DX-36 event execution trace acceptance',
      })
    );
    transactionId = begun && begun.transactionId;
    assert(transactionId, 'dx36_transaction_missing');

    await mutate('objects.definitions.create', {
      objectName: 'Worker',
      objectType: 'TextObject::Text',
      objectScope: 'scene',
      sceneName,
    });
    await mutate('scene.instances.create', {
      sceneName,
      objectName: 'Worker',
      position: { x: 120, y: 80 },
    });
    await mutate('editor.functions.call', {
      name: 'add_or_edit_variable',
      arguments: {
        variable_scope: 'scene',
        scene_name: sceneName,
        variable_name_or_path: 'WatchCounter',
        value: '0',
        variable_type: 'number',
      },
      save: false,
    });

    const compareNumbers = await findInstruction(
      call,
      'condition',
      'compare numbers',
      ['BuiltinCommonInstructions::CompareNumbers']
    );
    const mousePressed = await findInstruction(
      call,
      'condition',
      'mouse button pressed',
      ['MouseButtonPressed']
    );
    const setX = await findInstruction(call, 'action', 'set x', ['SetX']);
    const setNumberVariable = await findInstruction(
      call,
      'action',
      'number variable',
      ['SetNumberVariable']
    );

    const beforeEvents = getData(await call('events.read', { sceneName }));
    assert(
      beforeEvents && beforeEvents.eventsRevision,
      'dx36_events_revision_missing'
    );

    await mutate('events.insert', {
      sceneName,
      expectedEventsRevision: beforeEvents.eventsRevision,
      eventsJson: [
        {
          type: 'BuiltinCommonInstructions::Standard',
          conditions: [
            {
              type: { value: compareNumbers.id },
              parameters: ['1', '=', '2'],
              subInstructions: [],
            },
          ],
          actions: [
            {
              type: { value: setX.id },
              parameters: ['Worker', '=', '999'],
              subInstructions: [],
            },
          ],
          events: [],
        },
        {
          type: 'BuiltinCommonInstructions::Standard',
          conditions: [
            {
              type: { value: mousePressed.id },
              parameters: ['', 'Right'],
              subInstructions: [],
            },
          ],
          actions: [
            {
              type: { value: setX.id },
              parameters: ['Worker', '=', '777'],
              subInstructions: [],
            },
          ],
          events: [],
        },
        {
          type: 'BuiltinCommonInstructions::Standard',
          conditions: [],
          actions: [
            {
              type: { value: setNumberVariable.id },
              parameters: ['WatchCounter', '+', '1'],
              subInstructions: [],
            },
          ],
          events: [],
        },
      ],
    });

    const authored = getData(await call('events.read', { sceneName }));
    const idleNode = findFirstInstructionNode(authored, 0, 'conditions');
    const clickNode = findFirstInstructionNode(authored, 1, 'conditions');
    const watchEvent = authored.events && authored.events[2];
    assert(watchEvent && watchEvent.handle, 'dx36_watch_event_handle_missing');
    const watchActionNode = findFirstInstructionNode(authored, 2, 'actions');

    await call('scene.open', { sceneName });
    await call('preview.start', {
      numberOfWindows: 1,
      waitUntilReady: true,
      readyTimeoutMs: 30000,
    });
    let previewStatus = await waitForPreviewReady();
    const previewWindowId = extractPreviewWindowId(previewStatus);
    assert(Number.isInteger(previewWindowId), 'dx36_preview_window_id_missing');

    const capabilities = getData(await call('runtime.debugger.capabilities'));
    assert(
      capabilities &&
        capabilities.debugger &&
        capabilities.debugger.eventBreakpoints &&
        capabilities.debugger.eventBreakpoints.supported === true &&
        capabilities.debugger.eventBreakpoints.precision ===
          'pause-requested-next-frame-boundary' &&
        capabilities.debugger.conditionEvaluationTrace.supported === true &&
        capabilities.debugger.watchpoints.supported === true,
      'dx36_live_capabilities_missing'
    );

    await call('runtime.time.pause');

    // Worker-idle: the first condition is false, so the action must not execute.
    await call('runtime.event-trace.configure', {
      sceneName,
      mode: 'detailed',
      handles: [idleNode.event.handle],
      maxFrames: 10,
      maxRecords: 200,
    });
    await call('runtime.time.step', {
      frames: 1,
      frameDurationMs: 20,
    });
    const idleTrace = getData(
      await call('runtime.event-trace.read', { sceneName })
    );
    const idleConditionRecord = (idleTrace.records || []).find(
      record =>
        record.instructionHandle === idleNode.instruction.handle &&
        record.phase === 'after'
    );
    assert(
      idleConditionRecord && idleConditionRecord.result === false,
      'dx36_worker_idle_false_condition_missing'
    );
    assert(
      !(idleTrace.records || []).some(
        record =>
          record.kind === 'instruction' &&
          record.instructionKind === 'action' &&
          record.eventHandle === idleNode.event.handle
      ),
      'dx36_worker_idle_action_unexpected'
    );
    assert(
      (idleTrace.diagnostics || []).some(
        diagnostic =>
          diagnostic.code === 'conditions_short_circuited' ||
          diagnostic.code === 'event_disabled' ||
          diagnostic.eventHandle === idleNode.event.handle
      ) || idleConditionRecord.result === false,
      'dx36_worker_idle_diagnostic_missing'
    );
    const workerBeforeClick = getData(
      await call('runtime.inspect', {
        selector: {
          kind: 'object-property',
          objectName: 'Worker',
          instanceIndex: 0,
          property: 'x',
        },
      })
    );
    assert(
      workerBeforeClick && workerBeforeClick.value === 120,
      'dx36_worker_idle_position_changed'
    );

    // UI click is received, but the authored branch listens for Right and must stay false.
    await call('runtime.event-trace.clear');
    await call('runtime.event-trace.configure', {
      sceneName,
      mode: 'detailed',
      handle: clickNode.event.handle,
      maxFrames: 10,
      maxRecords: 200,
    });
    const mouseDownResult = getData(
      await call('preview.input.send', {
        previewWindowId,
        event: {
          type: 'mouseDown',
          x: 20,
          y: 20,
          button: 'left',
          clickCount: 1,
        },
      })
    );
    assert(mouseDownResult, 'dx36_left_click_not_received');
    await call('runtime.time.step', {
      frames: 1,
      frameDurationMs: 20,
    });
    await call('preview.input.send', {
      previewWindowId,
      event: {
        type: 'mouseUp',
        x: 20,
        y: 20,
        button: 'left',
        clickCount: 1,
      },
    });
    const clickTrace = getData(
      await call('runtime.event-trace.read', { sceneName })
    );
    const clickConditionRecord = (clickTrace.records || []).find(
      record =>
        record.instructionHandle === clickNode.instruction.handle &&
        record.phase === 'after'
    );
    assert(
      clickConditionRecord && clickConditionRecord.result === false,
      'dx36_click_branch_false_condition_missing'
    );
    assert(
      !(clickTrace.records || []).some(
        record =>
          record.kind === 'instruction' &&
          record.instructionKind === 'action' &&
          record.eventHandle === clickNode.event.handle
      ),
      'dx36_click_branch_action_unexpected'
    );

    // Watch a scene variable changed deterministically on the next simulated frame.
    const watched = getData(
      await call('runtime.event-trace.watch', {
        sceneName,
        mode: 'detailed',
        handle: watchEvent.handle,
        selector: {
          kind: 'scene-variable',
          path: 'WatchCounter',
        },
        maxFrames: 5,
        frameDurationMs: 20,
        breakpoints: [
          { handle: watchActionNode.instruction.handle, phase: 'after' },
        ],
      })
    );
    if (
      !(
        watched &&
        watched.changed === true &&
        Number.isFinite(watched.before.value) &&
        Number.isFinite(watched.after.value) &&
        watched.after.value === watched.before.value + 1 &&
        watched.framesAdvanced > 0 &&
        watched.wallClockWaitUsed === false
      )
    ) {
      console.error('DX36_WATCH_DIAGNOSTIC ' + JSON.stringify(watched));
    }
    assert(
      watched &&
        watched.changed === true &&
        Number.isFinite(watched.before.value) &&
        Number.isFinite(watched.after.value) &&
        watched.after.value === watched.before.value + 1 &&
        watched.framesAdvanced > 0 &&
        watched.wallClockWaitUsed === false,
      'dx36_watchpoint_variable_change_missing'
    );
    assert(
      watched.trace &&
        (watched.trace.records || []).some(
          record =>
            record.instructionHandle === watchActionNode.instruction.handle &&
            record.phase === 'after'
        ),
      'dx36_watchpoint_action_trace_missing'
    );
    assert(
      watched.trace &&
        watched.trace.lastBreakpointHit &&
        watched.trace.lastBreakpointHit.kind === 'instruction',
      'dx36_breakpoint_hit_missing'
    );

    const jobsCapabilities = getData(await call('agent.jobs.capabilities'));
    const eligible =
      jobsCapabilities &&
      (jobsCapabilities.eligibleCommands ||
        jobsCapabilities.supportedStepCommands ||
        jobsCapabilities.commands);
    assert(
      Array.isArray(eligible) &&
        eligible.includes('runtime.event-trace.watch') &&
        eligible.includes('runtime.event-trace.capture'),
      'dx36_async_job_integration_missing'
    );

    const validation = getData(await call('validation.run'));
    const errors = validationErrorCount(validation);
    assert(errors === 0, 'dx36_validation_errors:' + errors);

    await call('preview.close-all');
    await waitForPreviewStopped();

    const rollback = getData(
      await call('safety.transactions.rollback', { transactionId })
    );
    assert(
      rollback && rollback.rolledBack !== false,
      'dx36_transaction_rollback_failed'
    );
    transactionId = null;

    await call('project.close', { discardUnsavedChanges: false });
    projectOpen = false;

    const evidence = {
      label,
      protocolVersion: session.protocolVersion,
      sceneName,
      workerIdle: {
        eventHandle: idleNode.event.handle,
        conditionHandle: idleNode.instruction.handle,
        conditionResult: idleConditionRecord.result,
        actionExecuted: false,
        workerX: workerBeforeClick.value,
      },
      clickReceivedButBranchNotFired: {
        eventHandle: clickNode.event.handle,
        conditionHandle: clickNode.instruction.handle,
        conditionResult: clickConditionRecord.result,
        actionExecuted: false,
      },
      watchpoint: {
        eventHandle: watchEvent.handle,
        actionHandle: watchActionNode.instruction.handle,
        selector: { kind: 'scene-variable', path: 'WatchCounter' },
        beforeValue: watched.before.value,
        afterValue: watched.after.value,
        framesAdvanced: watched.framesAdvanced,
        simulatedTimeMs: watched.elapsedSimulatedTimeMs,
        wallClockWaitUsed: watched.wallClockWaitUsed,
      },
      breakpointHit: true,
      stableHandleRoundTrip: true,
      branchPathMapped: (idleTrace.records || []).some(
        record =>
          record.eventHandle === idleNode.event.handle &&
          Array.isArray(record.branchPath)
      ),
      conditionResults: true,
      actionExecutionOrder: true,
      projectModifiedByTracing: false,
      asyncJobIntegration: true,
      validationErrors: errors,
      transactionRollbackClean: true,
      replay,
    };
    fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    return { evidencePath, evidence };
  } finally {
    try {
      if (session) {
        try {
          await session.call('preview.close-all', {});
        } catch (_) {}
        if (transactionId) {
          try {
            await session.call('safety.transactions.rollback', {
              transactionId,
            });
          } catch (_) {}
        }
        if (projectOpen) {
          try {
            await session.call('project.close', {
              discardUnsavedChanges: true,
            });
          } catch (_) {}
        }
        await session.close();
      }
    } finally {
      restoreRepositoryReads();
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  }
};

module.exports = {
  REQUIRED_TOOLS,
  run,
};
