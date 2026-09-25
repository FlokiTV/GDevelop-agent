const fs = require('fs');
const os = require('os');
const path = require('path');
const { connectLiveGDevelopMcp, sanitizeForReplay } = require('./McpClient');

const SCENE_NAME = 'DX13PreviewLifecycle';

const wait = milliseconds =>
  new Promise(resolve => setTimeout(resolve, milliseconds));

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const getRevision = result => {
  const revision =
    result && result.meta && Number.isInteger(result.meta.projectRevision)
      ? result.meta.projectRevision
      : result &&
        result.structuredContent &&
        result.structuredContent.meta &&
        Number.isInteger(result.structuredContent.meta.projectRevision)
      ? result.structuredContent.meta.projectRevision
      : result && result.data && Number.isInteger(result.data.projectRevision)
      ? result.data.projectRevision
      : null;
  assert(Number.isInteger(revision), 'dx13_missing_project_revision');
  return revision;
};

const readyTarget = data => {
  assert(data && data.state === 'ready', 'dx13_preview_not_ready');
  assert(data.runtimeReady === true, 'dx13_runtime_ready_false');
  const targets = Array.isArray(data.targets) ? data.targets : [];
  const target = targets.find(
    candidate =>
      candidate &&
      candidate.ready === true &&
      typeof candidate.debuggerId === 'string' &&
      Number.isInteger(candidate.windowId)
  );
  assert(target, 'dx13_ready_target_mapping_missing');
  return target;
};

const run = async ({
  label = 'live',
  evidencePath = path.join(
    os.tmpdir(),
    `gdevelop-dx13-preview-lifecycle-${process.pid}.json`
  ),
} = {}) => {
  const session = await connectLiveGDevelopMcp({
    clientId: `gdevelop-dx13-preview-lifecycle-${label}`,
  });
  let transactionId = null;
  let previewOpen = false;
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
  const call = async (name, args = {}) => {
    const result = await session.call(name, args);
    record(name, args, result);
    if (result.isError) {
      throw new Error(
        `${name} failed: ${JSON.stringify(
          result.structuredContent || result.content || result.data
        )}`
      );
    }
    return result;
  };
  const waitForStopped = async () => {
    let latest = null;
    for (let attempt = 0; attempt < 30; attempt++) {
      latest = await call('preview.status');
      if (
        latest.data &&
        latest.data.state === 'stopped' &&
        latest.data.windowOpen === false &&
        latest.data.debuggerAttached === false
      ) {
        return latest.data;
      }
      await wait(100);
    }
    throw new Error(
      `dx13_preview_did_not_stop:${JSON.stringify(latest && latest.data)}`
    );
  };

  try {
    const tools = await session.listTools();
    [
      'project.create',
      'project.close',
      'project.status',
      'editor.functions.create-scene',
      'scene.open',
      'preview.status',
      'preview.start',
      'preview.close-all',
      'runtime.status',
      'runtime.logs',
      'runtime.snapshot',
      'validation.run',
      'safety.transactions.begin',
      'safety.transactions.rollback',
    ].forEach(name =>
      assert(
        tools.some(tool => tool.name === name),
        `dx13_missing_tool:${name}`
      )
    );

    const previewStartTool = tools.find(tool => tool.name === 'preview.start');
    const startProperties =
      previewStartTool &&
      previewStartTool.inputSchema &&
      previewStartTool.inputSchema.properties;
    assert(startProperties, 'dx13_preview_start_schema_missing');
    assert(
      startProperties.waitUntilReady,
      'dx13_wait_until_ready_schema_missing'
    );
    assert(startProperties.readyTimeoutMs, 'dx13_ready_timeout_schema_missing');

    const before = await call('project.status');
    if (before.data && before.data.preview && before.data.preview.running) {
      await call('preview.close-all');
      await waitForStopped();
    }
    if (before.data && before.data.projectOpen) {
      assert(
        before.data.hasUnsavedChanges === false,
        'dx13_requires_clean_or_fresh_editor'
      );
      await call('project.close', {
        expectedRevision:
          before.meta && Number.isInteger(before.meta.projectRevision)
            ? before.meta.projectRevision
            : undefined,
        idempotencyKey: 'dx13-close-clean-auto-open-project',
      });
    }

    await call('project.create', {
      name: 'DX13 Preview Lifecycle Acceptance',
      idempotencyKey: 'dx13-create-project',
    });
    const tx = await call('safety.transactions.begin', {
      label: 'DX-13 preview lifecycle acceptance',
    });
    transactionId = tx.data && tx.data.transactionId;
    assert(transactionId, 'dx13_transaction_missing');

    const scene = await call('editor.functions.create-scene', {
      scene_name: SCENE_NAME,
      idempotencyKey: 'dx13-create-scene',
    });
    const revisionAfterScene = getRevision(scene);
    await call('scene.open', { sceneName: SCENE_NAME, mode: 'scene' });

    const initial = await call('preview.status');
    assert(
      initial.data.state === 'stopped',
      'dx13_initial_preview_not_stopped'
    );

    const revisionBeforeLifecycle = getRevision(await call('project.status'));

    const firstStart = await call('preview.start', {
      numberOfWindows: 1,
      waitUntilReady: true,
      readyTimeoutMs: 10000,
    });
    previewOpen = true;
    const firstTarget = readyTarget(firstStart.data);

    const firstStatus = await call('preview.status');
    const firstStatusTarget = readyTarget(firstStatus.data);
    assert(
      firstStatusTarget.debuggerId === firstTarget.debuggerId &&
        firstStatusTarget.windowId === firstTarget.windowId,
      'dx13_preview_status_target_mismatch'
    );

    const runtimeStatus = await call('runtime.status', {
      debuggerId: firstTarget.debuggerId,
    });
    assert(
      runtimeStatus.data.debuggerId === firstTarget.debuggerId &&
        runtimeStatus.data.previewWindowId === firstTarget.windowId &&
        runtimeStatus.data.lifecycleState === 'ready',
      'dx13_runtime_status_target_mismatch'
    );

    const runtimeLogs = await call('runtime.logs', {
      debuggerId: firstTarget.debuggerId,
      limit: 10,
    });
    assert(
      runtimeLogs.data.debuggerId === firstTarget.debuggerId &&
        runtimeLogs.data.previewWindowId === firstTarget.windowId &&
        runtimeLogs.data.lifecycleState === 'ready',
      'dx13_runtime_logs_target_mismatch'
    );

    const runtimeSnapshot = await call('runtime.snapshot', {
      debuggerId: firstTarget.debuggerId,
      maxInstances: 5,
    });
    assert(
      runtimeSnapshot.data.debuggerId === firstTarget.debuggerId &&
        runtimeSnapshot.data.previewWindowId === firstTarget.windowId &&
        runtimeSnapshot.data.lifecycleState === 'ready',
      'dx13_runtime_snapshot_target_mismatch'
    );

    const revisionAfterFirstLifecycle = getRevision(
      await call('project.status')
    );
    assert(
      revisionAfterFirstLifecycle === revisionBeforeLifecycle,
      'dx13_preview_lifecycle_changed_project_revision'
    );

    await call('preview.close-all');
    previewOpen = false;
    const stoppedAfterFirst = await waitForStopped();

    const secondStart = await call('preview.start', {
      numberOfWindows: 1,
      waitUntilReady: true,
      readyTimeoutMs: 10000,
    });
    previewOpen = true;
    const secondTarget = readyTarget(secondStart.data);
    const secondRuntime = await call('runtime.status', {
      debuggerId: secondTarget.debuggerId,
    });
    assert(
      secondRuntime.data.previewWindowId === secondTarget.windowId &&
        secondRuntime.data.lifecycleState === 'ready',
      'dx13_restart_runtime_target_mismatch'
    );

    await call('preview.close-all');
    previewOpen = false;
    const stoppedAfterRestart = await waitForStopped();

    const revisionAfterRestart = getRevision(await call('project.status'));
    assert(
      revisionAfterRestart === revisionBeforeLifecycle,
      'dx13_restart_changed_project_revision'
    );

    const validation = await call('validation.run', {
      includeNativeReport: false,
      includeAssets: false,
    });
    const validationErrors =
      validation.data &&
      validation.data.summary &&
      Number.isInteger(validation.data.summary.errors)
        ? validation.data.summary.errors
        : validation.data && Array.isArray(validation.data.errors)
        ? validation.data.errors.length
        : 0;
    assert(validationErrors === 0, 'dx13_validation_has_errors');

    const evidence = sanitizeForReplay({
      kind: 'dx13-preview-lifecycle',
      label,
      protocolVersion: session.protocolVersion,
      revisionAfterScene,
      lifecycleStates: [
        initial.data.state,
        firstStart.data.state,
        stoppedAfterFirst.state,
        secondStart.data.state,
        stoppedAfterRestart.state,
      ],
      firstTarget,
      secondTarget,
      runtimeAgreement: {
        status: {
          debuggerId: runtimeStatus.data.debuggerId,
          previewWindowId: runtimeStatus.data.previewWindowId,
          lifecycleState: runtimeStatus.data.lifecycleState,
        },
        logs: {
          debuggerId: runtimeLogs.data.debuggerId,
          previewWindowId: runtimeLogs.data.previewWindowId,
          lifecycleState: runtimeLogs.data.lifecycleState,
        },
        snapshot: {
          debuggerId: runtimeSnapshot.data.debuggerId,
          previewWindowId: runtimeSnapshot.data.previewWindowId,
          lifecycleState: runtimeSnapshot.data.lifecycleState,
        },
      },
      projectRevision: {
        before: revisionBeforeLifecycle,
        afterFirstLifecycle: revisionAfterFirstLifecycle,
        afterRestart: revisionAfterRestart,
        unchanged:
          revisionBeforeLifecycle === revisionAfterFirstLifecycle &&
          revisionBeforeLifecycle === revisionAfterRestart,
      },
      validationErrors,
      replay,
    });
    fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));

    await call('safety.transactions.rollback', { transactionId });
    transactionId = null;

    console.log(
      JSON.stringify(
        {
          ok: true,
          label,
          protocolVersion: session.protocolVersion,
          lifecycleStates: evidence.lifecycleStates,
          firstTarget: evidence.firstTarget,
          secondTarget: evidence.secondTarget,
          runtimeAgreement: evidence.runtimeAgreement,
          projectRevision: evidence.projectRevision,
          validationErrors,
          evidencePath,
        },
        null,
        2
      )
    );
  } finally {
    if (previewOpen) {
      try {
        await session.call('preview.close-all', {});
      } catch (_) {}
    }
    if (transactionId) {
      try {
        await session.call('safety.transactions.rollback', { transactionId });
      } catch (_) {}
    }
    await session.close();
  }
};

if (require.main === module) {
  let label = 'live';
  let evidencePath;
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--label') label = args[++index];
    else if (args[index] === '--evidence') evidencePath = args[++index];
    else throw new Error(`unknown_argument:${args[index]}`);
  }
  run({ label, ...(evidencePath ? { evidencePath } : {}) }).catch(error => {
    console.error(error && error.stack ? error.stack : String(error));
    process.exitCode = 1;
  });
}

module.exports = { run, SCENE_NAME };
