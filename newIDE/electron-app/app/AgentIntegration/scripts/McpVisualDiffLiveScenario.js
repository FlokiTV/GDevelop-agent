const fs = require('fs');
const os = require('os');
const path = require('path');
const { connectLiveGDevelopMcp, sanitizeForReplay } = require('./McpClient');

const BASELINE_ID = 'dx18-background-baseline';
const VIEWPORT = { width: 640, height: 360 };
const SCENES = {
  baseline: { name: 'DX18Baseline', color: '#808080' },
  close: { name: 'DX18Close', color: '#828282' },
  material: { name: 'DX18Material', color: '#f00000' },
};

const wait = milliseconds =>
  new Promise(resolve => setTimeout(resolve, milliseconds));

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const run = async ({
  label = 'live',
  evidencePath = path.join(
    os.tmpdir(),
    `gdevelop-dx18-visual-diff-${process.pid}.json`
  ),
} = {}) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gdevelop-dx18-'));
  const projectFile = path.join(rootDir, 'game.json');
  const session = await connectLiveGDevelopMcp({
    clientId: `gdevelop-dx18-visual-diff-${label}`,
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
    return result;
  };

  const getRevision = async () => {
    const result = await call('project.status');
    const revision =
      result.meta && Number.isInteger(result.meta.projectRevision)
        ? result.meta.projectRevision
        : result.data && Number.isInteger(result.data.projectRevision)
        ? result.data.projectRevision
        : null;
    assert(Number.isInteger(revision), 'dx18_missing_project_revision');
    return revision;
  };

  const mutate = async (name, args) => {
    const revision = await getRevision();
    return call(name, {
      ...args,
      expectedRevision: revision,
      idempotencyKey: `dx18-${name}-${revision}-${replay.length}`,
    });
  };

  const closePreview = async () => {
    if (!previewOpen) return;
    await call('preview.close-all');
    previewOpen = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      const status = await call('preview.status');
      if (status.data && status.data.state === 'stopped') return;
      await wait(100);
    }
    throw new Error('dx18_preview_did_not_stop');
  };

  const startScene = async sceneName => {
    await call('scene.open', { sceneName, mode: 'scene' });
    const started = await call('preview.start', {
      numberOfWindows: 1,
      waitUntilReady: true,
      readyTimeoutMs: 10000,
    });
    previewOpen = true;
    const target =
      started.data &&
      Array.isArray(started.data.targets) &&
      started.data.targets.find(
        item =>
          item &&
          item.ready === true &&
          Number.isInteger(item.windowId) &&
          typeof item.debuggerId === 'string'
      );
    assert(target, `dx18_ready_target_missing:${sceneName}`);
    const resized = await call('preview.viewport.set', {
      previewWindowId: target.windowId,
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      waitUntilApplied: true,
      timeoutMs: 5000,
      restoreWindowState: true,
    });
    assert(
      resized.data &&
        resized.data.exact === true &&
        resized.data.actualViewport.width === VIEWPORT.width &&
        resized.data.actualViewport.height === VIEWPORT.height,
      `dx18_viewport_not_exact:${sceneName}`
    );
    await wait(120);
    return target;
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
      'preview.viewport.set',
      'preview.qa.capabilities',
      'preview.visual.baseline.capture',
      'preview.visual.baseline.compare',
      'validation.run',
    ]) {
      assert(tools.some(tool => tool.name === name), `dx18_missing_tool:${name}`);
    }

    const compareTool = tools.find(
      tool => tool.name === 'preview.visual.baseline.compare'
    );
    const modeSchema =
      compareTool &&
      compareTool.inputSchema &&
      compareTool.inputSchema.properties &&
      compareTool.inputSchema.properties.mode;
    assert(
      modeSchema &&
        Array.isArray(modeSchema.enum) &&
        ['exact', 'pixel-tolerance', 'perceptual'].every(mode =>
          modeSchema.enum.includes(mode)
        ),
      'dx18_compare_mode_schema_missing'
    );

    const initial = await call('project.status');
    assert(
      !initial.data || initial.data.projectOpen !== true,
      'dx18_requires_fresh_editor'
    );

    await call('project.create', { name: 'DX18 Visual Diff Acceptance' });
    projectOpen = true;
    await wait(300);
    await call('project.save-as', { filePath: projectFile });

    for (const scene of Object.values(SCENES)) {
      await mutate('editor.functions.create-scene', {
        scene_name: scene.name,
        background_color: scene.color,
        include_ui_layer: false,
      });
    }
    await call('project.save');

    const capabilities = await call('preview.qa.capabilities');
    const visual = capabilities.data && capabilities.data.visualRegression;
    assert(
      visual &&
        visual.exactPngHashComparison.supported === true &&
        visual.pixelToleranceComparison.supported === true &&
        visual.perceptualComparison.supported === true &&
        visual.divergentRegions.supported === true &&
        visual.diffImage.supported === true,
      'dx18_visual_capabilities_invalid'
    );

    let target = await startScene(SCENES.baseline.name);
    const baseline = await call('preview.visual.baseline.capture', {
      previewWindowId: target.windowId,
      baselineId: BASELINE_ID,
    });
    assert(
      baseline.data &&
        baseline.data.baselineId === BASELINE_ID &&
        baseline.data.bytes > 0,
      'dx18_baseline_capture_failed'
    );
    const exact = await call('preview.visual.baseline.compare', {
      previewWindowId: target.windowId,
      baselineId: BASELINE_ID,
      mode: 'exact',
    });
    assert(
      exact.data &&
        exact.data.passed === true &&
        exact.data.exactPngIdentity === true &&
        exact.data.differentPixelRatio === 0,
      'dx18_exact_same_capture_failed'
    );
    await closePreview();

    target = await startScene(SCENES.close.name);
    const tolerant = await call('preview.visual.baseline.compare', {
      previewWindowId: target.windowId,
      baselineId: BASELINE_ID,
      mode: 'pixel-tolerance',
      channelThreshold: 4,
      maxDifferentPixelRatio: 0.01,
      maxMeanDifference: 4,
      regionSize: 32,
    });
    assert(
      tolerant.data &&
        tolerant.data.passed === true &&
        tolerant.data.exactPixelIdentity === false &&
        tolerant.data.similarity > 0.99,
      `dx18_close_pixel_tolerance_failed:${JSON.stringify(tolerant.data)}`
    );
    const perceptualClose = await call('preview.visual.baseline.compare', {
      previewWindowId: target.windowId,
      baselineId: BASELINE_ID,
      mode: 'perceptual',
      minSimilarity: 0.98,
      perceptualDownscale: 8,
      channelThreshold: 4,
      maxDifferentPixelRatio: 1,
      maxMeanDifference: 255,
    });
    assert(
      perceptualClose.data &&
        perceptualClose.data.passed === true &&
        perceptualClose.data.perceptualSimilarity > 0.98,
      'dx18_close_perceptual_failed'
    );
    await closePreview();

    target = await startScene(SCENES.material.name);
    const material = await call('preview.visual.baseline.compare', {
      previewWindowId: target.windowId,
      baselineId: BASELINE_ID,
      mode: 'perceptual',
      minSimilarity: 0.9,
      perceptualDownscale: 8,
      channelThreshold: 8,
      regionSize: 32,
      regionDifferenceRatioThreshold: 0.1,
      maxRegions: 12,
      includeDiffImage: true,
    });
    assert(
      material.data &&
        material.data.passed === false &&
        material.data.perceptualSimilarity < 0.9 &&
        material.data.differentPixelRatio > 0.5 &&
        Array.isArray(material.data.divergentRegions) &&
        material.data.divergentRegions.length > 0,
      `dx18_material_difference_not_detected:${JSON.stringify(material.data)}`
    );
    assert(
      material.data.diffImage &&
        material.data.diffImage.included === true &&
        material.content.some(
          content =>
            content &&
            content.type === 'image' &&
            content.mimeType === 'image/png' &&
            typeof content.data === 'string' &&
            content.data.length > 0
        ),
      'dx18_diff_heatmap_missing'
    );

    const validation = await call('validation.run', {
      includeNativeReport: false,
      includeAssets: true,
    });
    assert(validation.data && validation.data.ok === true, 'dx18_validation_failed');
    await closePreview();
    await call('project.close', { discardUnsavedChanges: false });
    projectOpen = false;

    const evidence = {
      kind: 'dx18-visual-comparison-acceptance',
      label,
      protocolVersion: session.protocolVersion,
      viewport: VIEWPORT,
      scenes: SCENES,
      capability: visual,
      exact: {
        passed: exact.data.passed,
        similarity: exact.data.similarity,
        differentPixelRatio: exact.data.differentPixelRatio,
      },
      close: {
        pixelTolerance: {
          passed: tolerant.data.passed,
          similarity: tolerant.data.similarity,
          differentPixelRatio: tolerant.data.differentPixelRatio,
          meanDifference: tolerant.data.meanDifference,
          maxDifference: tolerant.data.maxDifference,
        },
        perceptual: {
          passed: perceptualClose.data.passed,
          similarity: perceptualClose.data.perceptualSimilarity,
        },
      },
      material: {
        passed: material.data.passed,
        similarity: material.data.perceptualSimilarity,
        differentPixelRatio: material.data.differentPixelRatio,
        meanDifference: material.data.meanDifference,
        maxDifference: material.data.maxDifference,
        divergentRegions: material.data.divergentRegions,
        diffImageByteLength: material.data.byteLength || null,
      },
      validationErrors: Array.isArray(validation.data.errors)
        ? validation.data.errors.length
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
          exact: evidence.exact,
          close: evidence.close,
          material: {
            passed: evidence.material.passed,
            similarity: evidence.material.similarity,
            differentPixelRatio: evidence.material.differentPixelRatio,
            meanDifference: evidence.material.meanDifference,
            maxDifference: evidence.material.maxDifference,
            divergentRegions: evidence.material.divergentRegions.length,
            diffImageByteLength: evidence.material.diffImageByteLength,
          },
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

module.exports = { BASELINE_ID, SCENES, VIEWPORT, run };
