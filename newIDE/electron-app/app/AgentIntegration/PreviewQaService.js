const crypto = require('crypto');

const MAX_RECORDING_STEPS = 200;
const MAX_BASELINES = 32;

const makeError = (code, message = code) => {
  const error = new Error(message);
  error.code = code;
  return error;
};

const sha256 = buffer =>
  crypto
    .createHash('sha256')
    .update(buffer)
    .digest('hex');

const createPreviewQaService = ({
  windowCaptureService,
  previewInteractionService,
}) => {
  const recordings = new Map();
  const baselines = new Map();
  let activeRecording = null;

  const capabilities = () => ({
    deterministicGameplay: {
      resetStartState: {
        supported: true,
        source: 'preview.input.runtime-reset',
      },
      inputReplay: { supported: true, source: 'normalized-preview-input' },
      fixedTimestep: {
        supported: false,
        reason: 'preview_fixed_timestep_not_exposed',
      },
      seededRandomness: {
        supported: false,
        reason: 'preview_random_seed_not_exposed',
      },
    },
    visualRegression: {
      screenshotBaseline: { supported: true, format: 'png' },
      exactPngHashComparison: { supported: true },
      pixelToleranceComparison: {
        supported: false,
        reason: 'decoded_pixel_diff_not_available',
      },
      ignoreRegions: {
        supported: false,
        reason: 'decoded_pixel_diff_not_available',
      },
    },
    deviceSimulation: {
      viewportResize: {
        supported: false,
        reason: 'content_viewport_emulation_not_exposed',
      },
      devicePixelRatio: {
        supported: false,
        reason: 'device_scale_factor_emulation_not_exposed',
      },
      orientation: {
        supported: false,
        reason: 'orientation_emulation_not_exposed',
      },
      safeArea: {
        supported: false,
        reason: 'safe_area_emulation_not_exposed',
      },
    },
  });

  const startRecording = input => {
    if (activeRecording)
      throw makeError('preview_input_recording_already_active');
    const recordingId =
      input && typeof input.recordingId === 'string' && input.recordingId.trim()
        ? input.recordingId.trim()
        : `recording-${Date.now()}`;
    if (recordings.has(recordingId))
      throw makeError('preview_input_recording_exists');
    activeRecording = {
      recordingId,
      previewWindowId: Number(input.previewWindowId),
      startedAt: Date.now(),
      lastAt: Date.now(),
      steps: [],
    };
    return { recordingId, previewWindowId: activeRecording.previewWindowId };
  };

  const recordEvent = (previewWindowId, event) => {
    if (
      !activeRecording ||
      activeRecording.previewWindowId !== Number(previewWindowId)
    )
      return;
    if (activeRecording.steps.length >= MAX_RECORDING_STEPS) {
      throw makeError('preview_input_recording_too_many_steps');
    }
    const now = Date.now();
    activeRecording.steps.push({
      event,
      delayMs: Math.min(5000, Math.max(0, now - activeRecording.lastAt)),
    });
    activeRecording.lastAt = now;
  };

  const sendAndRecord = input => {
    const result = previewInteractionService.sendInput(input || {});
    recordEvent(input && input.previewWindowId, result.event);
    return result;
  };

  const stopRecording = input => {
    if (!activeRecording) throw makeError('preview_input_recording_not_active');
    if (
      input &&
      input.recordingId &&
      input.recordingId !== activeRecording.recordingId
    )
      throw makeError('preview_input_recording_mismatch');
    const recording = {
      recordingId: activeRecording.recordingId,
      format: 'gdevelop-preview-input-sequence-v1',
      steps: activeRecording.steps.slice(),
    };
    recordings.set(recording.recordingId, recording);
    activeRecording = null;
    return recording;
  };

  const replay = async input => {
    const recording = recordings.get(input && input.recordingId);
    if (!recording) throw makeError('preview_input_recording_not_found');
    const reset = input.resetBefore !== false;
    if (reset) {
      await previewInteractionService.resetRuntime(input || {});
      previewInteractionService.resetInput(input || {});
    }
    const result = await previewInteractionService.sendSequence({
      previewWindowId: input.previewWindowId,
      steps: recording.steps,
    });
    return {
      recordingId: recording.recordingId,
      resetBefore: reset,
      ...result,
    };
  };

  const captureBaseline = async input => {
    if (baselines.size >= MAX_BASELINES && !baselines.has(input.baselineId))
      throw makeError('too_many_visual_baselines');
    const captured = await windowCaptureService.capture({
      windowId: input.previewWindowId,
      region: input.region,
      maxWidth: input.maxWidth,
      maxHeight: input.maxHeight,
    });
    const baseline = {
      baselineId: input.baselineId,
      sha256: sha256(captured.data),
      bytes: captured.data.length,
      region: captured.region || null,
    };
    baselines.set(input.baselineId, baseline);
    return baseline;
  };

  const compareBaseline = async input => {
    const baseline = baselines.get(input && input.baselineId);
    if (!baseline) throw makeError('visual_baseline_not_found');
    const captured = await windowCaptureService.capture({
      windowId: input.previewWindowId,
      region: input.region || baseline.region,
      maxWidth: input.maxWidth,
      maxHeight: input.maxHeight,
    });
    const actualSha256 = sha256(captured.data);
    return {
      baselineId: baseline.baselineId,
      passed: actualSha256 === baseline.sha256,
      comparison: 'exact-png-sha256',
      expectedSha256: baseline.sha256,
      actualSha256,
      expectedBytes: baseline.bytes,
      actualBytes: captured.data.length,
    };
  };

  return {
    capabilities,
    startRecording,
    sendAndRecord,
    stopRecording,
    replay,
    captureBaseline,
    compareBaseline,
  };
};

module.exports = { createPreviewQaService };
