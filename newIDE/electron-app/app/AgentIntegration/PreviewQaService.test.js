const assert = require('node:assert/strict');
const test = require('node:test');
const { createPreviewQaService } = require('./PreviewQaService');
const { encodeRgbaPng } = require('./ImageComparison');

const makePng = (value, width = 8, height = 8) => {
  const data = Buffer.alloc(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel++) {
    const offset = pixel * 4;
    data[offset] = value;
    data[offset + 1] = value;
    data[offset + 2] = value;
    data[offset + 3] = 255;
  }
  return encodeRgbaPng({ width, height, data });
};

const makeService = () => {
  let capture = makePng(80);
  const sent = [];
  const resets = [];
  const service = createPreviewQaService({
    windowCaptureService: {
      capture: async input => ({ data: capture, region: input.region || null }),
    },
    previewViewportService: {
      capabilities: () => ({
        supported: true,
        units: 'device-independent-pixels',
        exactContentViewport: true,
      }),
    },
    previewInteractionService: {
      sendInput: input => {
        const result = {
          sent: true,
          windowId: input.previewWindowId,
          event: input.event,
        };
        sent.push(result.event);
        return result;
      },
      sendSequence: async input => ({
        sent: true,
        windowId: input.previewWindowId,
        steps: input.steps.length,
        totalDelayMs: input.steps.reduce((n, step) => n + step.delayMs, 0),
      }),
      resetInput: input => {
        resets.push(['input', input.previewWindowId]);
        return { reset: true };
      },
      resetRuntime: async input => {
        resets.push(['runtime', input.previewWindowId]);
        return { reset: true };
      },
    },
  });
  return {
    service,
    sent,
    resets,
    setCapture: value => {
      capture = Buffer.isBuffer(value) ? Buffer.from(value) : makePng(value);
    },
  };
};

test('reports truthful deterministic and device capability gaps', () => {
  const { service } = makeService();
  const capabilities = service.capabilities();
  assert.equal(capabilities.deterministicGameplay.inputReplay.supported, true);
  assert.equal(
    capabilities.deterministicGameplay.fixedTimestep.supported,
    false
  );
  assert.equal(
    capabilities.deterministicGameplay.seededRandomness.supported,
    false
  );
  assert.equal(
    capabilities.visualRegression.exactPngHashComparison.supported,
    true
  );
  assert.equal(
    capabilities.visualRegression.pixelToleranceComparison.supported,
    true
  );
  assert.equal(
    capabilities.visualRegression.perceptualComparison.supported,
    true
  );
  assert.equal(capabilities.visualRegression.diffImage.supported, true);
  assert.equal(capabilities.deviceSimulation.viewportResize.supported, true);
  assert.equal(
    capabilities.deviceSimulation.viewportResize.units,
    'device-independent-pixels'
  );
});

test('records normalized sent events and replays with reset by default', async () => {
  const { service, resets } = makeService();
  service.startRecording({ previewWindowId: 7, recordingId: 'walk' });
  service.sendAndRecord({
    previewWindowId: 7,
    event: { type: 'keyDown', keyCode: 'KeyD' },
  });
  const recording = service.stopRecording({ recordingId: 'walk' });
  assert.equal(recording.format, 'gdevelop-preview-input-sequence-v1');
  assert.equal(recording.steps.length, 1);
  const replay = await service.replay({
    previewWindowId: 7,
    recordingId: 'walk',
  });
  assert.equal(replay.steps, 1);
  assert.deepEqual(resets, [['runtime', 7], ['input', 7]]);
});

test('captures and compares exact PNG baselines with structured evidence', async () => {
  const { service, setCapture } = makeService();
  const baseline = await service.captureBaseline({
    previewWindowId: 4,
    baselineId: 'menu',
  });
  assert.ok(baseline.bytes > 8);
  const same = await service.compareBaseline({
    previewWindowId: 4,
    baselineId: 'menu',
  });
  assert.equal(same.passed, true);
  assert.equal(same.comparison, 'exact');
  assert.equal(same.exactPngIdentity, true);
  assert.equal(same.differentPixelRatio, 0);

  setCapture(120);
  const changed = await service.compareBaseline({
    previewWindowId: 4,
    baselineId: 'menu',
  });
  assert.equal(changed.passed, false);
  assert.equal(changed.comparison, 'exact');
  assert.notEqual(changed.expectedSha256, changed.actualSha256);
  assert.ok(changed.meanDifference > 0);
});

test('supports tolerant/perceptual baseline comparison and optional heatmap image', async () => {
  const { service, setCapture } = makeService();
  await service.captureBaseline({
    previewWindowId: 4,
    baselineId: 'menu',
  });

  setCapture(84);
  const tolerant = await service.compareBaseline({
    previewWindowId: 4,
    baselineId: 'menu',
    mode: 'pixel-tolerance',
    channelThreshold: 8,
    maxDifferentPixelRatio: 0.01,
    maxMeanDifference: 5,
  });
  assert.equal(tolerant.passed, true);
  assert.equal(tolerant.comparison, 'pixel-tolerance');
  assert.ok(tolerant.similarity > 0.98);

  const perceptual = await service.compareBaseline({
    previewWindowId: 4,
    baselineId: 'menu',
    mode: 'perceptual',
    minSimilarity: 0.98,
    perceptualDownscale: 4,
  });
  assert.equal(perceptual.passed, true);
  assert.ok(perceptual.perceptualSimilarity > 0.98);

  setCapture(220);
  const material = await service.compareBaseline({
    previewWindowId: 4,
    baselineId: 'menu',
    mode: 'perceptual',
    minSimilarity: 0.9,
    regionSize: 4,
    includeDiffImage: true,
  });
  assert.equal(material.passed, false);
  assert.ok(material.differentPixelRatio > 0.9);
  assert.ok(material.divergentRegions.length > 0);
  assert.ok(Buffer.isBuffer(material.imageBuffer));
  assert.equal(material.mimeType, 'image/png');
  assert.equal(material.diffImage.included, true);
});
