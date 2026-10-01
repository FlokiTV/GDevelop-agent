const fs = require('fs');
const os = require('os');
const path = require('path');
const { connectLiveGDevelopMcp, sanitizeForReplay } = require('./McpClient');

const REQUIRED_TOOLS = [
  'project.status',
  'project.create',
  'project.save-as',
  'project.close',
  'project.persistence.status',
  'objects.definitions.create',
  'scene.instances.create',
  'scene.open',
  'preview.start',
  'preview.status',
  'preview.close-all',
  'preview.input.send',
  'runtime.status',
  'runtime.snapshot',
  'runtime.inspect',
  'runtime.assert',
  'runtime.time.status',
  'runtime.time.pause',
  'runtime.time.resume',
  'runtime.time.set-scale',
  'runtime.time.step',
  'runtime.time.advance',
  'runtime.time.wait-until',
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
  assert(Number.isInteger(revision), 'dx35_missing_project_revision');
  return revision;
};

const findTool = (tools, name) => {
  const tool = tools.find(candidate => candidate.name === name);
  assert(tool, 'dx35_missing_tool:' + name);
  return tool;
};

const assertTimeControlToolSchemas = tools => {
  REQUIRED_TOOLS.forEach(name => findTool(tools, name));
  const step = findTool(tools, 'runtime.time.step');
  const advance = findTool(tools, 'runtime.time.advance');
  const waitUntil = findTool(tools, 'runtime.time.wait-until');
  const scale = findTool(tools, 'runtime.time.set-scale');
  assert(
    step.inputSchema &&
      step.inputSchema.properties &&
      step.inputSchema.properties.frames &&
      step.inputSchema.properties.snapshot &&
      step.inputSchema.properties.assertion,
    'dx35_step_schema_missing'
  );
  assert(
    advance.inputSchema &&
      advance.inputSchema.required.includes('milliseconds') &&
      advance.inputSchema.properties.maxFrames,
    'dx35_advance_schema_missing'
  );
  assert(
    waitUntil.inputSchema &&
      waitUntil.inputSchema.required.includes('condition') &&
      waitUntil.inputSchema.properties.maxFrames,
    'dx35_wait_until_schema_missing'
  );
  assert(
    scale.inputSchema && scale.inputSchema.required.includes('timeScale'),
    'dx35_time_scale_schema_missing'
  );
};

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
        'dx35_clean_room_repository_read_forbidden:' + path.basename(resolved)
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
    `gdevelop-dx35-runtime-time-${process.pid}.json`
  ),
} = {}) => {
  const rootDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gdevelop-dx35-runtime-time-')
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
      clientId: `gdevelop-dx35-runtime-time-${label}-${suffix}`,
      confirmDestructiveOperations: true,
    });

  const call = async (name, args = {}, { allowError = false } = {}) => {
    const result = await session.call(name, args);
    record(name, args, result);
    if (result.isError && !allowError) {
      const error = extractError(result);
      throw new Error(
        `dx35_tool_failed:${name}:${
          error && error.code ? error.code : 'unknown'
        }`
      );
    }
    return result;
  };

  const mutate = async (name, args = {}) => {
    const revision = revisionOf(await call('project.status'));
    const result = await call(name, {
      ...args,
      expectedRevision: revision,
      idempotencyKey: `dx35-${name}-${revision}-${replay.length}`,
    });
    if (transactionId) {
      const meta =
        result.meta ||
        (result.structuredContent && result.structuredContent.meta) ||
        null;
      assert(
        meta && meta.transactionId === transactionId,
        `dx35_transaction_metadata_missing:${name}`
      );
    }
    return result;
  };

  const waitForPreviewReady = async () => {
    for (let attempt = 0; attempt < 80; attempt++) {
      const data = getData(await call('preview.status'));
      if (data && data.runtimeReady && data.debuggerAttached) return data;
      await wait(100);
    }
    throw new Error('dx35_preview_ready_timeout');
  };

  const waitForPreviewStopped = async () => {
    for (let attempt = 0; attempt < 80; attempt++) {
      const data = getData(await call('preview.status'));
      if (!data || data.state === 'stopped' || !data.running) return data;
      await wait(100);
    }
    throw new Error('dx35_preview_stop_timeout');
  };

  try {
    session = await connect('initial');
    const tools = await session.listTools();
    assertTimeControlToolSchemas(tools);

    const initialStatus = getData(await call('project.status'));
    assert(
      !initialStatus || initialStatus.projectOpen !== true,
      'dx35_requires_fresh_editor'
    );

    await call('project.create', {
      name: 'DX35 Runtime Time Acceptance',
      idempotencyKey: 'dx35-create-project',
    });
    projectOpen = true;
    await call('project.save-as', {
      filePath: projectFile,
      name: 'DX35 Runtime Time Acceptance',
    });

    const statusAfterCreate = getData(await call('project.status'));
    assert(
      statusAfterCreate &&
        Array.isArray(statusAfterCreate.sceneNames) &&
        statusAfterCreate.sceneNames.length > 0,
      'dx35_project_scene_missing'
    );
    const sceneName = statusAfterCreate.sceneNames[0];

    const baselinePersistence = getData(
      await call('project.persistence.status')
    );
    assert(
      baselinePersistence &&
        baselinePersistence.persisted &&
        baselinePersistence.persisted.serializedHash,
      'dx35_baseline_persistence_missing'
    );

    const begun = getData(
      await call('safety.transactions.begin', {
        label: 'DX-35 runtime time-control acceptance',
      })
    );
    transactionId = begun && begun.transactionId;
    assert(transactionId, 'dx35_transaction_missing');

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

    await call('scene.open', { sceneName });
    const projectRevisionBeforeRuntime = revisionOf(
      await call('project.status')
    );

    await call('preview.start', {
      numberOfWindows: 1,
      waitUntilReady: true,
      readyTimeoutMs: 30000,
    });
    let previewStatus = await waitForPreviewReady();
    let previewWindowId = extractPreviewWindowId(previewStatus);
    assert(Number.isInteger(previewWindowId), 'dx35_preview_window_id_missing');

    const runningStatus = getData(await call('runtime.time.status'));
    assert(
      runningStatus &&
        runningStatus.runtimeState === 'running' &&
        runningStatus.isPaused === false &&
        runningStatus.deterministicStepping &&
        runningStatus.deterministicStepping.supported === true,
      'dx35_running_status_invalid'
    );
    assert(
      runningStatus.integrations &&
        runningStatus.integrations.input &&
        runningStatus.integrations.input.send === 'preview.input.send' &&
        runningStatus.integrations.asyncJobs &&
        runningStatus.integrations.asyncJobs.start === 'agent.jobs.start',
      'dx35_integration_discovery_missing'
    );

    const paused = getData(await call('runtime.time.pause'));
    assert(
      paused && paused.runtimeState === 'paused' && paused.isPaused === true,
      'dx35_pause_failed'
    );

    const beforeWorker = getData(
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
      beforeWorker && beforeWorker.found === true,
      'dx35_worker_before_missing'
    );

    await call('preview.input.send', {
      previewWindowId,
      event: { type: 'keyDown', keyCode: 'Space' },
    });
    const stepped = getData(
      await call('runtime.time.step', {
        frames: 3,
        frameDurationMs: 20,
        snapshot: true,
        assertion: {
          selector: {
            kind: 'object-count',
            objectName: 'Worker',
          },
          operator: 'equals',
          value: 1,
        },
      })
    );
    assert(
      stepped &&
        stepped.framesAdvanced === 3 &&
        stepped.elapsedSimulatedTimeMs > 0 &&
        stepped.wallClockWaitUsed === false &&
        stepped.runtimeState === 'paused' &&
        stepped.snapshot &&
        stepped.assertion &&
        stepped.assertion.passed === true,
      'dx35_pause_step_snapshot_order_failed'
    );
    await call('preview.input.send', {
      previewWindowId,
      event: { type: 'keyUp', keyCode: 'Space' },
    });

    const scaled = getData(
      await call('runtime.time.set-scale', { timeScale: 2 })
    );
    assert(scaled && scaled.timeScale === 2, 'dx35_time_scale_set_failed');

    const beforeAdvanceStatus = getData(await call('runtime.time.status'));
    const advance = getData(
      await call('runtime.time.advance', {
        milliseconds: 400,
        frameDurationMs: 20,
        maxFrames: 100,
        snapshot: true,
      })
    );
    assert(
      advance &&
        advance.elapsedSimulatedTimeMs >= 399.9 &&
        advance.framesAdvanced > 0 &&
        advance.wallClockWaitUsed === false &&
        advance.timeDomain === 'simulated-game-time',
      'dx35_simulated_advance_failed'
    );

    const afterWorker = getData(
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
      afterWorker &&
        afterWorker.found === true &&
        afterWorker.value === beforeWorker.value,
      'dx35_worker_idle_checkpoint_changed'
    );

    const waitTarget =
      Number(beforeAdvanceStatus.sceneTimeFromStartMs || 0) + 600;
    const waited = getData(
      await call('runtime.time.wait-until', {
        condition: {
          selector: {
            kind: 'scene-time',
            metric: 'time-from-start-ms',
          },
          operator: 'gte',
          value: waitTarget,
        },
        frameDurationMs: 20,
        maxFrames: 100,
      })
    );
    assert(
      waited &&
        waited.conditionMet === true &&
        waited.passed === true &&
        waited.framesAdvanced > 0 &&
        waited.wallClockWaitUsed === false &&
        waited.snapshot &&
        waited.snapshot.scene &&
        waited.snapshot.scene.timeFromStartMs >= waitTarget,
      'dx35_wait_until_failed'
    );

    const resumed = getData(await call('runtime.time.resume'));
    assert(
      resumed &&
        resumed.runtimeState === 'running' &&
        resumed.isPaused === false,
      'dx35_resume_failed'
    );

    const projectRevisionAfterRuntime = revisionOf(
      await call('project.status')
    );
    assert(
      projectRevisionAfterRuntime === projectRevisionBeforeRuntime,
      'dx35_runtime_control_changed_project_revision'
    );

    const jobsCapabilities = getData(await call('agent.jobs.capabilities'));
    const eligible =
      jobsCapabilities &&
      (jobsCapabilities.eligibleCommands ||
        jobsCapabilities.supportedStepCommands ||
        jobsCapabilities.commands);
    assert(
      Array.isArray(eligible) &&
        eligible.includes('runtime.time.step') &&
        eligible.includes('runtime.time.advance') &&
        eligible.includes('runtime.time.wait-until'),
      'dx35_async_job_integration_missing'
    );

    await call('preview.close-all');
    await waitForPreviewStopped();

    await call('preview.start', {
      numberOfWindows: 1,
      waitUntilReady: true,
      readyTimeoutMs: 30000,
    });
    previewStatus = await waitForPreviewReady();
    previewWindowId = extractPreviewWindowId(previewStatus);
    assert(
      Number.isInteger(previewWindowId),
      'dx35_restart_preview_window_id_missing'
    );
    const restartPaused = getData(await call('runtime.time.pause'));
    assert(
      restartPaused &&
        restartPaused.runtimeState === 'paused' &&
        restartPaused.timeScale === 1,
      'dx35_time_scale_persisted_across_preview_restart'
    );

    const validation = getData(await call('validation.run'));
    const errors = validationErrorCount(validation);
    assert(errors === 0, 'dx35_validation_errors:' + errors);

    await call('preview.close-all');
    await waitForPreviewStopped();

    const rollback = getData(
      await call('safety.transactions.rollback', { transactionId })
    );
    assert(
      rollback && rollback.rolledBack !== false,
      'dx35_transaction_rollback_failed'
    );
    transactionId = null;

    await call('project.close', { discardUnsavedChanges: false });
    projectOpen = false;

    const evidence = {
      label,
      protocolVersion: session.protocolVersion,
      sceneName,
      runningStateExposed: true,
      pauseResume: true,
      framesAdvanced: stepped.framesAdvanced,
      stepSimulatedTimeMs: stepped.elapsedSimulatedTimeMs,
      snapshotAfterStep: true,
      assertionAfterStep: true,
      inputThenStepSynchronized: true,
      timeScaleApplied: scaled.timeScale,
      advanceSimulatedTimeMs: advance.elapsedSimulatedTimeMs,
      advanceFrames: advance.framesAdvanced,
      workerIdleReproduced: afterWorker.value === beforeWorker.value,
      workerX: beforeWorker.value,
      waitUntilFrames: waited.framesAdvanced,
      waitUntilSimulatedTimeMs: waited.elapsedSimulatedTimeMs,
      wallClockWaitUsedForSimulation:
        stepped.wallClockWaitUsed ||
        advance.wallClockWaitUsed ||
        waited.wallClockWaitUsed,
      projectRevisionStableAcrossRuntimeControl:
        projectRevisionAfterRuntime === projectRevisionBeforeRuntime,
      asyncJobIntegration: true,
      timeScaleResetOnPreviewRestart: restartPaused.timeScale === 1,
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
      try {
        fs.rmSync(rootDir, { recursive: true, force: true });
      } catch (_) {}
    }
  }
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const readArg = name => {
    const index = args.indexOf(name);
    return index >= 0 && args[index + 1] ? args[index + 1] : null;
  };
  run({
    label: readArg('--label') || 'live',
    evidencePath: readArg('--evidence') || undefined,
  })
    .then(result => {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    })
    .catch(error => {
      process.stderr.write((error && error.stack) || String(error));
      process.stderr.write('\n');
      process.exitCode = 1;
    });
}

module.exports = {
  REQUIRED_TOOLS,
  assertTimeControlToolSchemas,
  extractPreviewWindowId,
  validationErrorCount,
  run,
};
