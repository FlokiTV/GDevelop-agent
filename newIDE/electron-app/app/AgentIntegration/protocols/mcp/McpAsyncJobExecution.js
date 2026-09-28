const crypto = require('crypto');
const {
  makeSuccessEnvelope,
  makeInputValidationError,
  normalizeError,
} = require('./McpResponseContract');
const { isAsyncJobStepCommandAllowed } = require('./McpAsyncJobs');

const ASYNC_JOB_INPUT_MUTATING_COMMANDS = new Set([
  'preview.input.interact',
  'preview.input.send',
  'preview.input.sequence',
  'preview.input.reset',
  'preview.input.runtime-reset',
  'preview.input.record.send',
  'preview.input.replay',
]);

const createAsyncJobExecutionContext = ({
  registrations,
  desktopCommandRegistry,
  rendererBridge,
  targetIdentitySupported,
  assertTargetPreconditions,
  getTargetIdentity,
}) => {
  const registrationsByName = new Map(
    registrations.map(registration => [registration.name, registration])
  );

  const validateStepInput = async (registration, input) => {
    const normalizedInput = input && typeof input === 'object' ? input : {};
    const validationResult =
      typeof registration.validateInput === 'function'
        ? await registration.validateInput(normalizedInput)
        : { value: normalizedInput };
    if (
      validationResult &&
      Array.isArray(validationResult.issues) &&
      validationResult.issues.length
    ) {
      throw makeInputValidationError(
        registration.name,
        validationResult.issues
      );
    }
    const validatedInput =
      validationResult &&
      Object.prototype.hasOwnProperty.call(validationResult, 'value')
        ? validationResult.value
        : normalizedInput;
    const {
      expectedProjectId,
      expectedProjectPath,
      expectedEditorSelector,
      expectedSceneId,
      expectedSceneSelector,
      expectedPreviewTarget,
      ...commandInput
    } = validatedInput;
    return {
      commandInput,
      preconditions: {
        expectedProjectId,
        expectedProjectPath,
        expectedEditorSelector,
        expectedSceneId,
        expectedSceneSelector,
        expectedPreviewTarget,
      },
    };
  };

  const createResources = () => ({
    inputTouchedPreviewWindowIds: new Set(),
    originalViewports: new Map(),
    activeRecordingIds: new Set(),
    activeNetworkAliases: new Set(),
  });

  const executeStep = async (step, executionContext) => {
    if (!isAsyncJobStepCommandAllowed(step.command)) {
      const error = new Error('async_job_command_not_eligible');
      error.code = 'async_job_command_not_eligible';
      error.details = { command: step.command };
      throw error;
    }
    const registration = registrationsByName.get(step.command);
    if (!registration) {
      const error = new Error('async_job_step_command_unavailable');
      error.code = 'async_job_step_command_unavailable';
      error.retryable = true;
      error.details = { command: step.command };
      throw error;
    }
    if (registration.modifiesProject) {
      const error = new Error('async_job_project_mutation_rejected');
      error.code = 'async_job_project_mutation_rejected';
      error.details = { command: step.command };
      throw error;
    }

    const { commandInput, preconditions } = await validateStepInput(
      registration,
      step.input
    );
    const resources = executionContext.resources;
    if (
      resources &&
      ASYNC_JOB_INPUT_MUTATING_COMMANDS.has(registration.name) &&
      Number.isInteger(commandInput.previewWindowId)
    ) {
      resources.inputTouchedPreviewWindowIds.add(commandInput.previewWindowId);
    }

    if (
      resources &&
      registration.name === 'preview.viewport.set' &&
      Number.isInteger(commandInput.previewWindowId) &&
      !resources.originalViewports.has(commandInput.previewWindowId) &&
      desktopCommandRegistry &&
      desktopCommandRegistry.has('preview.viewport.status')
    ) {
      const viewportStatus = await desktopCommandRegistry.execute({
        command: 'preview.viewport.status',
        input: { previewWindowId: commandInput.previewWindowId },
        requestContext: {
          identity: executionContext.identity,
          traceId: executionContext.traceId,
          signal: executionContext.signal,
        },
      });
      const actualViewport =
        viewportStatus &&
        viewportStatus.data &&
        viewportStatus.data.actualViewport;
      if (
        actualViewport &&
        Number.isInteger(actualViewport.width) &&
        Number.isInteger(actualViewport.height)
      ) {
        resources.originalViewports.set(commandInput.previewWindowId, {
          width: actualViewport.width,
          height: actualViewport.height,
        });
      }
    }

    let capturePreviewWindowId = null;
    if (
      registration.name === 'desktop.window.capture' &&
      Number.isInteger(commandInput.windowId) &&
      desktopCommandRegistry &&
      desktopCommandRegistry.has('desktop.windows.list')
    ) {
      try {
        const windowsResult = await desktopCommandRegistry.execute({
          command: 'desktop.windows.list',
          input: {},
          requestContext: {
            identity: executionContext.identity,
            traceId: executionContext.traceId,
            signal: executionContext.signal,
          },
        });
        const windows =
          windowsResult && Array.isArray(windowsResult.data)
            ? windowsResult.data
            : [];
        const candidate = windows.find(
          window => window && window.windowId === commandInput.windowId
        );
        if (candidate && candidate.previewWindow) {
          capturePreviewWindowId = commandInput.windowId;
        }
      } catch (error) {}
    }

    let targetIdentity = await assertTargetPreconditions({
      registration,
      commandInput,
      preconditions,
      rendererBridge,
      targeting: executionContext.targeting,
      identity: executionContext.identity,
      targetIdentitySupported,
      capturePreviewWindowId,
    });

    let result;
    if (
      desktopCommandRegistry &&
      desktopCommandRegistry.has(registration.name)
    ) {
      let desktopInput = commandInput;
      if (
        registration.name === 'desktop.window.capture' &&
        desktopInput.windowId == null &&
        executionContext.targeting.windowId &&
        /^\d+$/.test(executionContext.targeting.windowId)
      ) {
        desktopInput = {
          ...desktopInput,
          windowId: Number(executionContext.targeting.windowId),
        };
      }
      result = await desktopCommandRegistry.execute({
        command: registration.name,
        input: desktopInput,
        requestContext: {
          identity: executionContext.identity,
          traceId: executionContext.traceId,
          signal: executionContext.signal,
        },
      });
      if (
        targetIdentitySupported &&
        !targetIdentity &&
        (registration.name === 'desktop.window.capture' ||
          registration.name.startsWith('preview.'))
      ) {
        try {
          targetIdentity = await getTargetIdentity({
            rendererBridge,
            targeting: executionContext.targeting,
            identity: executionContext.identity,
          });
        } catch (error) {}
      }
    } else {
      result = await rendererBridge.executeCommand({
        command: registration.name,
        input: commandInput,
        traceId: executionContext.traceId,
        traceContext: { traceId: executionContext.traceId },
        identity: executionContext.identity,
        timeoutMs: registration.timeoutMs,
        signal: executionContext.signal,
        ...executionContext.targeting,
      });
    }

    if (targetIdentity) {
      result = {
        ...result,
        meta: {
          ...(result.meta || {}),
          targetIdentity,
        },
      };
    }

    if (resources && result && result.data) {
      if (
        registration.name === 'preview.input.record.start' &&
        typeof result.data.recordingId === 'string'
      ) {
        resources.activeRecordingIds.add(result.data.recordingId);
      } else if (registration.name === 'preview.input.record.stop') {
        const recordingId =
          typeof commandInput.recordingId === 'string'
            ? commandInput.recordingId
            : result.data.recordingId;
        if (typeof recordingId === 'string') {
          resources.activeRecordingIds.delete(recordingId);
        }
      } else if (
        registration.name === 'preview.network.capture.start' &&
        typeof commandInput.alias === 'string'
      ) {
        resources.activeNetworkAliases.add(commandInput.alias);
      } else if (
        registration.name === 'preview.network.capture.stop' &&
        typeof commandInput.alias === 'string'
      ) {
        resources.activeNetworkAliases.delete(commandInput.alias);
      }
    }

    let normalizedResult = result;
    const imageBuffer =
      result && result.data && Buffer.isBuffer(result.data.imageBuffer)
        ? result.data.imageBuffer
        : null;
    if (imageBuffer) {
      const imageData = { ...result.data };
      delete imageData.imageBuffer;
      normalizedResult = {
        ...result,
        data: {
          ...imageData,
          imageArtifact: {
            mimeType: imageData.mimeType || 'image/png',
            byteLength: imageBuffer.length,
            sha256: crypto
              .createHash('sha256')
              .update(imageBuffer)
              .digest('hex'),
            payloadRetained: false,
          },
        },
      };
    }

    return {
      requestTimeoutMs: Number.isFinite(registration.timeoutMs)
        ? registration.timeoutMs
        : null,
      envelope: makeSuccessEnvelope(normalizedResult, {
        input: commandInput,
      }),
    };
  };

  const cleanup = async ({
    identity,
    targeting: cleanupTargeting,
    resources,
    traceId,
  }) => {
    const actions = [];
    const diagnostics = [];
    if (!resources || !desktopCommandRegistry) {
      return { actions, diagnostics };
    }

    const runCleanupCommand = async (command, input, label) => {
      if (!desktopCommandRegistry.has(command)) return;
      try {
        await desktopCommandRegistry.execute({
          command,
          input,
          requestContext: {
            identity,
            traceId,
            signal: null,
          },
        });
        actions.push({ command, label, ok: true });
      } catch (error) {
        const diagnostic = normalizeError(error, traceId);
        diagnostics.push(diagnostic);
        actions.push({
          command,
          label,
          ok: false,
          errorCode: diagnostic.code,
        });
      }
    };

    for (const alias of resources.activeNetworkAliases) {
      await runCleanupCommand(
        'preview.network.capture.stop',
        { alias },
        `network-capture:${alias}`
      );
    }
    resources.activeNetworkAliases.clear();

    for (const recordingId of resources.activeRecordingIds) {
      await runCleanupCommand(
        'preview.input.record.stop',
        { recordingId },
        `input-recording:${recordingId}`
      );
    }
    resources.activeRecordingIds.clear();

    for (const previewWindowId of resources.inputTouchedPreviewWindowIds) {
      await runCleanupCommand(
        'preview.input.reset',
        { previewWindowId },
        `input-reset:${previewWindowId}`
      );
    }

    for (const [previewWindowId, viewport] of resources.originalViewports) {
      await runCleanupCommand(
        'preview.viewport.set',
        {
          previewWindowId,
          width: viewport.width,
          height: viewport.height,
        },
        `viewport-restore:${previewWindowId}`
      );
    }

    return {
      actions,
      diagnostics,
      targeting: { ...cleanupTargeting },
    };
  };

  return {
    createResources,
    executeStep,
    cleanup,
  };
};

module.exports = {
  createAsyncJobExecutionContext,
};
