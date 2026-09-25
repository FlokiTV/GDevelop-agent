const fs = require('fs');
const os = require('os');
const path = require('path');
const { connectLiveGDevelopMcp, sanitizeForReplay } = require('./McpClient');

const SCENE_NAME = 'DX14WindowCapture';

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const wait = milliseconds =>
  new Promise(resolve => setTimeout(resolve, milliseconds));

const getRevision = result => {
  const revision =
    result && result.meta && Number.isInteger(result.meta.projectRevision)
      ? result.meta.projectRevision
      : result &&
        result.data &&
        Number.isInteger(result.data.projectRevision)
      ? result.data.projectRevision
      : null;
  assert(Number.isInteger(revision), 'dx14_missing_project_revision');
  return revision;
};

const getImageBuffer = result => {
  const image =
    result &&
    Array.isArray(result.content) &&
    result.content.find(item => item && item.type === 'image');
  assert(image && image.data, 'dx14_capture_missing_image');
  const buffer = Buffer.from(image.data, 'base64');
  assert(buffer.length > 24, 'dx14_capture_image_too_small');
  const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  assert(
    buffer.subarray(0, 8).equals(pngSignature),
    'dx14_capture_not_png'
  );
  return buffer;
};

const getPngDimensions = buffer => ({
  width: buffer.readUInt32BE(16),
  height: buffer.readUInt32BE(20),
});

const findPreviewWindow = windows =>
  (Array.isArray(windows) ? windows : []).find(
    window => window && window.previewWindow === true
  );

const run = async ({
  label = 'live',
  evidencePath = path.join(
    os.tmpdir(),
    `gdevelop-dx14-window-capture-${process.pid}.json`
  ),
} = {}) => {
  const session = await connectLiveGDevelopMcp({
    clientId: `gdevelop-dx14-window-capture-${label}`,
  });
  let transactionId = null;
  let previewOpen = false;
  const replay = [];

  const call = async (name, args = {}) => {
    const result = await session.call(name, args);
    replay.push(
      sanitizeForReplay({
        name,
        args,
        data: result.data,
        meta: result.meta,
        isError: result.isError,
      })
    );
    if (result.isError) {
      throw new Error(
        `${name} failed: ${JSON.stringify(
          result.structuredContent || result.data || result.content
        )}`
      );
    }
    return result;
  };

  try {
    const tools = await session.listTools();
    [
      'project.create',
      'project.close',
      'project.status',
      'editor.functions.create-scene',
      'scene.open',
      'preview.start',
      'preview.status',
      'preview.close-all',
      'desktop.windows.list',
      'desktop.window.capture',
      'validation.run',
      'safety.transactions.begin',
      'safety.transactions.rollback',
    ].forEach(name =>
      assert(tools.some(tool => tool.name === name), `dx14_missing_tool:${name}`)
    );

    const captureTool = tools.find(
      tool => tool.name === 'desktop.window.capture'
    );
    const captureProperties =
      captureTool &&
      captureTool.inputSchema &&
      captureTool.inputSchema.properties;
    assert(captureProperties, 'dx14_capture_schema_missing');
    assert(captureProperties.captureAttempts, 'dx14_capture_attempts_missing');
    assert(captureProperties.retryDelayMs, 'dx14_retry_delay_missing');
    assert(captureProperties.readyTimeoutMs, 'dx14_ready_timeout_missing');

    const before = await call('project.status');
    if (before.data && before.data.preview && before.data.preview.running) {
      await call('preview.close-all');
      await wait(250);
    }
    if (before.data && before.data.projectOpen) {
      assert(
        before.data.hasUnsavedChanges === false,
        'dx14_requires_clean_or_fresh_editor'
      );
      await call('project.close', {
        expectedRevision:
          before.meta && Number.isInteger(before.meta.projectRevision)
            ? before.meta.projectRevision
            : undefined,
        idempotencyKey: 'dx14-close-clean-auto-open-project',
      });
    }

    await call('project.create', {
      name: 'DX14 Window Capture Acceptance',
      idempotencyKey: 'dx14-create-project',
    });
    const tx = await call('safety.transactions.begin', {
      label: 'DX-14 window capture acceptance',
    });
    transactionId = tx.data && tx.data.transactionId;
    assert(transactionId, 'dx14_transaction_missing');

    await call('editor.functions.create-scene', {
      scene_name: SCENE_NAME,
      idempotencyKey: 'dx14-create-scene',
    });
    await call('scene.open', { sceneName: SCENE_NAME, mode: 'scene' });

    const revisionBeforeCapture = getRevision(await call('project.status'));

    const started = await call('preview.start', {
      numberOfWindows: 1,
      waitUntilReady: true,
      readyTimeoutMs: 10000,
    });
    previewOpen = true;
    assert(started.data && started.data.state === 'ready', 'dx14_preview_not_ready');

    let previewWindow = null;
    for (let attempt = 0; attempt < 20 && !previewWindow; attempt++) {
      const windows = await call('desktop.windows.list');
      previewWindow = findPreviewWindow(windows.data);
      if (!previewWindow) await wait(100);
    }
    assert(previewWindow, 'dx14_preview_window_not_found');

    const firstCapture = await call('desktop.window.capture', {
      windowId: previewWindow.windowId,
      maxWidth: 640,
      maxHeight: 480,
      captureAttempts: 4,
      retryDelayMs: 120,
      readyTimeoutMs: 3000,
    });
    const firstBuffer = getImageBuffer(firstCapture);
    const firstPngSize = getPngDimensions(firstBuffer);
    assert(
      firstCapture.data &&
        ['capturePage', 'desktopCapturer'].includes(
          firstCapture.data.captureMethod
        ),
      'dx14_capture_method_invalid'
    );
    assert(
      firstCapture.data.attempts >= 1 && firstCapture.data.attempts <= 4,
      'dx14_capture_attempts_invalid'
    );
    assert(
      firstCapture.data.readiness &&
        firstCapture.data.readiness.reason === 'ready',
      'dx14_capture_readiness_invalid'
    );
    assert(
      firstPngSize.width <= 640 && firstPngSize.height <= 480,
      'dx14_capture_max_size_not_respected'
    );
    if (firstCapture.data.outputSize) {
      assert(
        firstCapture.data.outputSize.width === firstPngSize.width &&
          firstCapture.data.outputSize.height === firstPngSize.height,
        'dx14_output_size_metadata_mismatch'
      );
    }

    const secondCapture = await call('desktop.window.capture', {
      windowId: previewWindow.windowId,
      maxWidth: 320,
      maxHeight: 240,
      captureAttempts: 4,
      retryDelayMs: 120,
      readyTimeoutMs: 3000,
    });
    const secondBuffer = getImageBuffer(secondCapture);
    const secondPngSize = getPngDimensions(secondBuffer);
    assert(
      secondPngSize.width <= 320 && secondPngSize.height <= 240,
      'dx14_scaled_capture_max_size_not_respected'
    );
    assert(
      secondPngSize.width <= firstPngSize.width &&
        secondPngSize.height <= firstPngSize.height,
      'dx14_scaled_capture_not_smaller'
    );

    const revisionAfterCapture = getRevision(await call('project.status'));
    assert(
      revisionAfterCapture === revisionBeforeCapture,
      'dx14_capture_changed_project_revision'
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
    assert(validationErrors === 0, 'dx14_validation_has_errors');

    await call('preview.close-all');
    previewOpen = false;
    await wait(150);

    const evidence = sanitizeForReplay({
      kind: 'dx14-window-capture',
      label,
      protocolVersion: session.protocolVersion,
      previewWindow: {
        windowId: previewWindow.windowId,
        bounds: previewWindow.bounds,
        contentBounds: previewWindow.contentBounds || null,
        visible: previewWindow.visible,
        minimized: previewWindow.minimized,
      },
      firstCapture: {
        method: firstCapture.data.captureMethod,
        attempts: firstCapture.data.attempts,
        readiness: firstCapture.data.readiness,
        sourceSize: firstCapture.data.sourceSize,
        outputSize: firstCapture.data.outputSize,
        pngSize: firstPngSize,
        byteLength: firstBuffer.length,
        fallback: firstCapture.data.fallback,
      },
      secondCapture: {
        method: secondCapture.data.captureMethod,
        attempts: secondCapture.data.attempts,
        outputSize: secondCapture.data.outputSize,
        pngSize: secondPngSize,
        byteLength: secondBuffer.length,
      },
      projectRevision: {
        before: revisionBeforeCapture,
        after: revisionAfterCapture,
        unchanged: revisionBeforeCapture === revisionAfterCapture,
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
          captureMethod: evidence.firstCapture.method,
          attempts: evidence.firstCapture.attempts,
          firstPngSize,
          secondPngSize,
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

module.exports = { run, SCENE_NAME, getPngDimensions };
