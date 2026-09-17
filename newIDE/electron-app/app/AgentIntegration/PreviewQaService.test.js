const assert = require('node:assert/strict');
const test = require('node:test');
const { createPreviewQaService } = require('./PreviewQaService');

const makeService = () => {
  let capture = Buffer.from('same-png');
  const sent = [];
  const resets = [];
  const service = createPreviewQaService({
    windowCaptureService: {
      capture: async input => ({ data: capture, region: input.region || null }),
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
      capture = Buffer.from(value);
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
    false
  );
  assert.equal(capabilities.deviceSimulation.viewportResize.supported, false);
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
  assert.equal(baseline.bytes, 8);
  assert.equal(
    (await service.compareBaseline({ previewWindowId: 4, baselineId: 'menu' }))
      .passed,
    true
  );
  setCapture('changed-png');
  const changed = await service.compareBaseline({
    previewWindowId: 4,
    baselineId: 'menu',
  });
  assert.equal(changed.passed, false);
  assert.equal(changed.comparison, 'exact-png-sha256');
  assert.notEqual(changed.expectedSha256, changed.actualSha256);
});
