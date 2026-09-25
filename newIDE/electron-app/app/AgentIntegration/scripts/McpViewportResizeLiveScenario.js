const fs = require('fs');
const os = require('os');
const path = require('path');
const { connectLiveGDevelopMcp, sanitizeForReplay } = require('./McpClient');

const QA_SIZES = [
  { width: 1280, height: 720 },
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1600, height: 900 },
  { width: 1920, height: 1080 },
];

const wait = milliseconds =>
  new Promise(resolve => setTimeout(resolve, milliseconds));

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const run = async ({
  label = 'live',
  evidencePath = path.join(
    os.tmpdir(),
    `gdevelop-dx17-viewport-${process.pid}.json`
  ),
} = {}) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gdevelop-dx17-'));
  const projectFile = path.join(rootDir, 'game.json');
  const session = await connectLiveGDevelopMcp({
    clientId: `gdevelop-dx17-viewport-${label}`,
  });
  let projectOpen = false;
  let previewOpen = false;
  const replay = [];

  const call = async (name, args = {}) => {
    const result = await session.call(name, args);
    replay.push(
      sanitizeForReplay({
        name,
        args,
        result: result.structuredContent || result.data || result.content,
      })
    );
    if (result.isError) {
      throw new Error(
        `${name} failed: ${JSON.stringify(
          result.structuredContent || result.data || result.content
        )}`
      );
    }
    return result.data;
  };

  try {
    const tools = await session.listTools();
    for (const name of [
      'project.status',
      'project.create',
      'project.save-as',
      'project.save',
      'project.close',
      'editor.functions.create-scene',
      'scene.open',
      'preview.start',
      'preview.close-all',
      'preview.qa.capabilities',
      'preview.viewport.status',
      'preview.viewport.set',
      'desktop.window.capture',
      'runtime.snapshot',
      'validation.run',
    ]) {
      assert(tools.some(tool => tool.name === name), `dx17_missing_tool:${name}`);
    }

    const initial = await call('project.status');
    assert(
      !initial || initial.projectOpen !== true,
      'dx17_requires_fresh_editor_without_open_project'
    );

    await call('project.create', { name: 'DX17 Viewport Acceptance' });
    projectOpen = true;
    await wait(400);
    await call('project.save-as', { filePath: projectFile });
    await call('editor.functions.create-scene', {
      scene_name: 'DX17ViewportScene',
    });
    await call('scene.open', {
      sceneName: 'DX17ViewportScene',
      mode: 'scene',
    });
    await call('project.save');

    const capabilities = await call('preview.qa.capabilities');
    const viewportCapability =
      capabilities &&
      capabilities.deviceSimulation &&
      capabilities.deviceSimulation.viewportResize;
    assert(viewportCapability && viewportCapability.supported === true, 'dx17_viewport_capability_missing');
    assert(
      viewportCapability.units === 'device-independent-pixels' &&
        viewportCapability.exactContentViewport === true &&
        viewportCapability.callerChromeCompensationRequired === false,
      'dx17_viewport_capability_invalid'
    );
    assert(
      QA_SIZES.every(size =>
        viewportCapability.commonQaSizes.some(
          candidate =>
            candidate.width === size.width && candidate.height === size.height
        )
      ),
      'dx17_common_qa_sizes_missing'
    );

    const started = await call('preview.start', {
      numberOfWindows: 1,
      waitUntilReady: true,
      readyTimeoutMs: 10000,
    });
    previewOpen = true;
    const target = Array.isArray(started.targets)
      ? started.targets.find(
          item =>
            item &&
            item.ready === true &&
            Number.isInteger(item.windowId) &&
            typeof item.debuggerId === 'string'
        )
      : null;
    assert(target, 'dx17_ready_preview_target_missing');

    const rounds = [];
    for (const requested of QA_SIZES) {
      const resized = await call('preview.viewport.set', {
        previewWindowId: target.windowId,
        width: requested.width,
        height: requested.height,
        waitUntilApplied: true,
        timeoutMs: 5000,
        restoreWindowState: true,
        focus: false,
      });
      assert(resized.exact === true, 'dx17_resize_not_exact');
      assert(
        resized.actualViewport.width === requested.width &&
          resized.actualViewport.height === requested.height,
        'dx17_actual_viewport_mismatch'
      );
      if (resized.rendererViewport) {
        assert(
          resized.rendererViewport.width === requested.width &&
            resized.rendererViewport.height === requested.height,
          'dx17_renderer_viewport_mismatch'
        );
      }

      const status = await call('preview.viewport.status', {
        previewWindowId: target.windowId,
      });
      assert(
        status.actualViewport.width === requested.width &&
          status.actualViewport.height === requested.height,
        'dx17_status_viewport_mismatch'
      );

      const capture = await call('desktop.window.capture', {
        windowId: target.windowId,
        captureAttempts: 4,
        readyTimeoutMs: 3000,
      });
      const captureContentBounds =
        capture &&
        capture.windowState &&
        capture.windowState.contentBounds;
      assert(
        captureContentBounds &&
          captureContentBounds.width === requested.width &&
          captureContentBounds.height === requested.height,
        'dx17_capture_viewport_mismatch'
      );

      let snapshot = null;
      for (let attempt = 0; attempt < 20; attempt++) {
        snapshot = await call('runtime.snapshot', {
          debuggerId: target.debuggerId,
          maxInstances: 1,
        });
        if (
          snapshot &&
          snapshot.viewport &&
          snapshot.viewport.width === requested.width &&
          snapshot.viewport.height === requested.height
        ) {
          break;
        }
        await wait(50);
      }
      assert(
        snapshot &&
          snapshot.viewport &&
          snapshot.viewport.width === requested.width &&
          snapshot.viewport.height === requested.height,
        `dx17_runtime_viewport_mismatch:${JSON.stringify({
          requested,
          snapshotSource: snapshot && snapshot.snapshotSource,
          viewport: snapshot && snapshot.viewport,
          providerError: snapshot && snapshot.snapshotProviderErrorCode,
        })}`
      );

      rounds.push({
        requested,
        applied: resized.actualViewport,
        rendererViewport: resized.rendererViewport || null,
        outerBounds: resized.outerBounds,
        contentBounds: resized.contentBounds,
        captureContentBounds,
        runtimeViewport: snapshot.viewport,
        waitedMs: resized.waitedMs,
      });
    }

    const repeat = await call('preview.viewport.set', {
      previewWindowId: target.windowId,
      width: 1920,
      height: 1080,
      waitUntilApplied: true,
      timeoutMs: 5000,
    });
    assert(
      repeat.exact === true &&
        repeat.actualViewport.width === 1920 &&
        repeat.actualViewport.height === 1080,
      'dx17_idempotent_repeat_failed'
    );

    const validation = await call('validation.run', {
      includeNativeReport: false,
      includeAssets: true,
    });
    assert(validation && validation.ok === true, 'dx17_validation_failed');

    await call('preview.close-all');
    previewOpen = false;
    await call('project.close', { discardUnsavedChanges: false });
    projectOpen = false;

    const evidence = {
      kind: 'dx17-preview-viewport-acceptance',
      label,
      protocolVersion: session.protocolVersion,
      capability: viewportCapability,
      rounds,
      idempotentRepeat: {
        requested: { width: 1920, height: 1080 },
        actual: repeat.actualViewport,
        exact: repeat.exact,
      },
      validationErrors: Array.isArray(validation.errors)
        ? validation.errors.length
        : 0,
      replay,
    };
    fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));

    console.log(
      JSON.stringify(
        {
          ok: true,
          label,
          protocolVersion: session.protocolVersion,
          sizes: rounds.map(round => ({
            requested: round.requested,
            applied: round.applied,
            runtime: {
              width: round.runtimeViewport.width,
              height: round.runtimeViewport.height,
              devicePixelRatio: round.runtimeViewport.devicePixelRatio,
            },
            capture: {
              width: round.captureContentBounds.width,
              height: round.captureContentBounds.height,
            },
          })),
          idempotentRepeat: evidence.idempotentRepeat,
          validationErrors: evidence.validationErrors,
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
    if (projectOpen) {
      try {
        await session.call('project.close', { discardUnsavedChanges: true });
      } catch (_) {}
    }
    await session.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
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

module.exports = { QA_SIZES, run };
