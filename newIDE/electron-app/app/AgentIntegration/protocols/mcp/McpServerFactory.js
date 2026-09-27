const crypto = require('crypto');
const path = require('path');
const { McpServer } = require('@modelcontextprotocol/server');
const { descriptorsToToolRegistrations } = require('./McpToolCatalog');
const { registerGDevelopPrompts } = require('./McpPrompts');
const {
  registerGDevelopResources,
  notifyGDevelopResourcesUpdated,
} = require('./McpResources');
const {
  registerOperationsResource,
  sendProgress,
} = require('./McpLongRunning');
const { requireDestructiveConfirmation } = require('./McpHumanInput');
const { preflightEventMutationInput } = require('./McpEventMutationValidation');
const {
  getTraceContextFromRequest,
  makeToolResultMeta,
  makeToolErrorResult,
  registerMcpDebugResource,
} = require('./McpObservability');

const SERVER_INFO = {
  name: 'gdevelop-live-editor',
  version: '0.1.0',
};

const IDENTITY_PART_PATTERN = /^[A-Za-z0-9._:@-]{1,160}$/;

const readIdentityHeader = (request, name) => {
  if (!request || !request.headers) return null;
  const value = request.headers.get(name);
  return typeof value === 'string' && IDENTITY_PART_PATTERN.test(value)
    ? value
    : null;
};

const getIdentityFromRequest = request => {
  const clientId =
    readIdentityHeader(request, 'x-gdevelop-client-id') || 'anonymous-client';
  const agentId =
    readIdentityHeader(request, 'x-gdevelop-agent-id') || clientId;
  const sessionId =
    readIdentityHeader(request, 'x-gdevelop-session-id') || clientId;
  const taskId = readIdentityHeader(request, 'x-gdevelop-task-id');
  return {
    clientId,
    agentId,
    sessionId,
    ...(taskId ? { taskId } : {}),
    ownerKey: `${agentId}::${sessionId}`,
  };
};

const getTargetingFromRequest = request => {
  if (!request || !request.headers) return {};
  const windowId = request.headers.get('x-gdevelop-window-id');
  const projectPath = request.headers.get('x-gdevelop-project-path');
  return {
    ...(windowId ? { windowId } : {}),
    ...(projectPath ? { projectPath } : {}),
  };
};

const normalizeProjectPath = value => {
  if (!value || typeof value !== 'string') return null;
  try {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  } catch (error) {
    return null;
  }
};

const makeTargetMismatchError = ({
  scope,
  expected,
  actual,
  targetIdentity,
}) => {
  const error = new Error(
    `The active GDevelop target does not match the expected ${scope} target.`
  );
  error.code = 'target_mismatch';
  error.retryable = true;
  error.hint =
    'Read target.status for the selected editor window, reconcile the target identity, then retry with updated expected target preconditions.';
  error.details = {
    conflictScope: scope,
    expected,
    actual,
    targetIdentity,
  };
  return error;
};

const getTargetIdentity = async ({ rendererBridge, targeting, identity }) => {
  const result = await rendererBridge.executeCommand({
    command: 'target.status',
    input: {},
    identity,
    ...targeting,
  });
  return result && result.data ? result.data : null;
};

const matchesPreviewExpectation = (target, expected) => {
  if (!target) return false;
  if (typeof expected === 'string') {
    return (
      target.targetId === expected ||
      (Number.isInteger(target.windowId) &&
        `preview-window:${target.windowId}` === expected) ||
      (typeof target.debuggerId === 'string' &&
        `preview-debugger:${target.debuggerId}` === expected)
    );
  }
  if (!expected || typeof expected !== 'object') return false;
  if (expected.targetId && target.targetId !== expected.targetId) return false;
  if (
    Number.isInteger(expected.windowId) &&
    target.windowId !== expected.windowId
  ) {
    return false;
  }
  if (expected.debuggerId && target.debuggerId !== expected.debuggerId) {
    return false;
  }
  if (
    expected.sceneSelector &&
    target.sceneSelector !== expected.sceneSelector
  ) {
    return false;
  }
  return true;
};

const assertTargetPreconditions = async ({
  registration,
  commandInput,
  preconditions,
  rendererBridge,
  targeting,
  identity,
  targetIdentitySupported,
  capturePreviewWindowId,
}) => {
  const automaticPreviewWindowId =
    registration.name.startsWith('preview.') &&
    Number.isInteger(commandInput.previewWindowId)
      ? commandInput.previewWindowId
      : Number.isInteger(capturePreviewWindowId)
      ? capturePreviewWindowId
      : null;
  const automaticPreviewWindowGuard = Number.isInteger(
    automaticPreviewWindowId
  );
  const hasExplicitPrecondition = Object.values(preconditions).some(
    value => value !== undefined && value !== null
  );
  if (!automaticPreviewWindowGuard && !hasExplicitPrecondition) return null;
  if (!targetIdentitySupported) {
    if (!hasExplicitPrecondition) return null;
    const error = new Error(
      'The selected renderer does not publish target.status required by explicit target preconditions.'
    );
    error.code = 'target_identity_unavailable';
    error.retryable = true;
    error.hint =
      'Reconnect to a renderer that supports target.status, or remove explicit target preconditions only when legacy compatibility is intentional.';
    throw error;
  }

  const targetIdentity = await getTargetIdentity({
    rendererBridge,
    targeting,
    identity,
  });
  const project = targetIdentity && targetIdentity.project;
  const editor = targetIdentity && targetIdentity.editor;
  const preview = targetIdentity && targetIdentity.preview;
  const previewTargets =
    preview && Array.isArray(preview.targets) ? preview.targets : [];

  if (
    preconditions.expectedProjectId &&
    (!project || project.projectId !== preconditions.expectedProjectId)
  ) {
    throw makeTargetMismatchError({
      scope: 'project',
      expected: { projectId: preconditions.expectedProjectId },
      actual: project || null,
      targetIdentity,
    });
  }

  if (preconditions.expectedProjectPath) {
    const expectedPath = normalizeProjectPath(
      preconditions.expectedProjectPath
    );
    const actualPath = normalizeProjectPath(
      project && project.normalizedProjectPath
    );
    if (!expectedPath || expectedPath !== actualPath) {
      throw makeTargetMismatchError({
        scope: 'project-path',
        expected: { normalizedProjectPath: expectedPath },
        actual: project || null,
        targetIdentity,
      });
    }
  }

  if (preconditions.expectedEditorSelector) {
    const activeTargets =
      editor && Array.isArray(editor.activeTargets) ? editor.activeTargets : [];
    const matched = activeTargets.some(
      target =>
        target &&
        (target.editorSelector === preconditions.expectedEditorSelector ||
          target.selector === preconditions.expectedEditorSelector)
    );
    if (!matched) {
      throw makeTargetMismatchError({
        scope: 'editor',
        expected: { selector: preconditions.expectedEditorSelector },
        actual: activeTargets,
        targetIdentity,
      });
    }
  }

  const explicitSceneName =
    typeof commandInput.sceneName === 'string' && commandInput.sceneName
      ? commandInput.sceneName
      : typeof commandInput.scene_name === 'string' && commandInput.scene_name
      ? commandInput.scene_name
      : null;
  const projectScenes =
    project && Array.isArray(project.scenes) ? project.scenes : [];
  const explicitSceneIdentity = explicitSceneName
    ? projectScenes.find(
        scene => scene && scene.sceneName === explicitSceneName
      ) || null
    : null;
  const actualScene = explicitSceneName
    ? explicitSceneIdentity
      ? { ...explicitSceneIdentity, source: 'command-input' }
      : {
          sceneName: explicitSceneName,
          sceneId: explicitSceneName,
          selector: `scene:${explicitSceneName}`,
          identityKind: 'name-fallback',
          source: 'command-input',
        }
    : editor && editor.activeScene
    ? editor.activeScene
    : null;

  if (
    preconditions.expectedSceneId &&
    (!actualScene || actualScene.sceneId !== preconditions.expectedSceneId)
  ) {
    throw makeTargetMismatchError({
      scope: 'scene',
      expected: { sceneId: preconditions.expectedSceneId },
      actual: actualScene,
      targetIdentity,
    });
  }
  if (
    preconditions.expectedSceneSelector &&
    (!actualScene ||
      actualScene.selector !== preconditions.expectedSceneSelector)
  ) {
    throw makeTargetMismatchError({
      scope: 'scene',
      expected: { selector: preconditions.expectedSceneSelector },
      actual: actualScene,
      targetIdentity,
    });
  }

  let expectedPreviewTargetMatch = null;
  if (preconditions.expectedPreviewTarget) {
    expectedPreviewTargetMatch = previewTargets.find(target =>
      matchesPreviewExpectation(target, preconditions.expectedPreviewTarget)
    );
    if (!expectedPreviewTargetMatch) {
      throw makeTargetMismatchError({
        scope: 'preview',
        expected: preconditions.expectedPreviewTarget,
        actual: previewTargets,
        targetIdentity,
      });
    }
  }

  if (automaticPreviewWindowGuard) {
    const requestedPreviewTarget = previewTargets.find(
      target => target && target.windowId === automaticPreviewWindowId
    );
    if (!requestedPreviewTarget) {
      throw makeTargetMismatchError({
        scope: 'preview-window',
        expected: { windowId: automaticPreviewWindowId },
        actual: previewTargets,
        targetIdentity,
      });
    }
    if (
      preconditions.expectedPreviewTarget &&
      !matchesPreviewExpectation(
        requestedPreviewTarget,
        preconditions.expectedPreviewTarget
      )
    ) {
      throw makeTargetMismatchError({
        scope: 'preview-window',
        expected: {
          windowId: automaticPreviewWindowId,
          previewTarget: preconditions.expectedPreviewTarget,
        },
        actual: requestedPreviewTarget,
        targetIdentity,
      });
    }
  }

  return targetIdentity;
};

const mergeCommandDescriptors = (rendererDescriptors, desktopDescriptors) => {
  const descriptors = [];
  const names = new Set();
  [...rendererDescriptors, ...desktopDescriptors].forEach(descriptor => {
    if (!descriptor || typeof descriptor.name !== 'string') return;
    if (names.has(descriptor.name)) {
      throw new Error(`duplicate_mcp_command:${descriptor.name}`);
    }
    names.add(descriptor.name);
    descriptors.push(descriptor);
  });
  return descriptors;
};

const toMcpToolResult = result => {
  const imageBuffer =
    result && result.data && Buffer.isBuffer(result.data.imageBuffer)
      ? result.data.imageBuffer
      : null;
  if (imageBuffer) {
    const { imageBuffer: ignoredImageBuffer, ...imageData } = result.data;
    return {
      content: [
        {
          type: 'image',
          data: imageBuffer.toString('base64'),
          mimeType: imageData.mimeType || 'image/png',
        },
      ],
      structuredContent: {
        ...result,
        data: {
          ...imageData,
          byteLength: imageBuffer.length,
        },
      },
    };
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(result),
      },
    ],
    structuredContent: result,
  };
};

const createMcpServerFactory = ({
  rendererBridge,
  desktopCommandRegistry = null,
  metrics,
  operationRegistry = null,
}) => async ctx => {
  const targeting = getTargetingFromRequest(ctx && ctx.requestInfo);
  const connectionIdentity = getIdentityFromRequest(ctx && ctx.requestInfo);
  const connectionTraceContext = getTraceContextFromRequest(
    ctx && ctx.requestInfo
  );
  const catalogResult = await rendererBridge.executeCommand({
    command: 'agent.commands.list',
    input: {},
    identity: connectionIdentity,
    ...targeting,
  });
  const rendererDescriptors =
    catalogResult &&
    catalogResult.data &&
    Array.isArray(catalogResult.data.commands)
      ? catalogResult.data.commands
      : [];
  const targetIdentitySupported = rendererDescriptors.some(
    descriptor => descriptor && descriptor.name === 'target.status'
  );
  const desktopDescriptors = desktopCommandRegistry
    ? desktopCommandRegistry.listDescriptors()
    : [];
  const descriptors = mergeCommandDescriptors(
    rendererDescriptors,
    desktopDescriptors
  );

  const server = new McpServer(SERVER_INFO, {
    instructions:
      'Operate the currently open GDevelop editor live. Mutations affect the in-memory project; save explicitly when requested.',
  });
  registerGDevelopPrompts(server);
  registerGDevelopResources({ server, rendererBridge, targeting });
  if (metrics) {
    registerMcpDebugResource({
      server,
      metrics,
      protocolVersion: '2026-07-28',
      targeting,
    });
  }
  if (operationRegistry) {
    registerOperationsResource({ server, operationRegistry });
  }

  descriptorsToToolRegistrations(descriptors).forEach(registration => {
    server.registerTool(
      registration.name,
      registration.config,
      async (input, requestContext) => {
        const startedAt = Date.now();
        const traceContext = connectionTraceContext.traceparent
          ? connectionTraceContext
          : { ...connectionTraceContext, traceId: crypto.randomUUID() };
        const requestSignal =
          requestContext &&
          requestContext.mcpReq &&
          requestContext.mcpReq.signal
            ? requestContext.mcpReq.signal
            : requestContext && requestContext.signal
            ? requestContext.signal
            : null;
        let operationId = null;
        try {
          const normalizedInput =
            input && typeof input === 'object' ? input : {};
          const {
            expectedRevision,
            expectedSemanticRevisions,
            semanticLeaseOwner,
            idempotencyKey,
            expectedProjectId,
            expectedProjectPath,
            expectedEditorSelector,
            expectedSceneId,
            expectedSceneSelector,
            expectedPreviewTarget,
            ...commandInput
          } = normalizedInput;

          let capturePreviewWindowId = null;
          if (
            registration.name === 'desktop.window.capture' &&
            Number.isInteger(commandInput.windowId) &&
            desktopCommandRegistry
          ) {
            try {
              const windowsResult = await desktopCommandRegistry.execute({
                command: 'desktop.windows.list',
                input: {},
                requestContext: {
                  identity: connectionIdentity,
                  traceId: traceContext.traceId,
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
            preconditions: {
              expectedProjectId,
              expectedProjectPath,
              expectedEditorSelector,
              expectedSceneId,
              expectedSceneSelector,
              expectedPreviewTarget,
            },
            rendererBridge,
            targeting,
            identity: connectionIdentity,
            targetIdentitySupported,
            capturePreviewWindowId,
          });

          const confirmation = requireDestructiveConfirmation({
            command: registration.name,
            input: commandInput,
            requestContext,
          });
          if (confirmation.inputRequired) return confirmation.inputRequired;
          if (confirmation.declined) {
            const error = new Error(
              'Human confirmation was declined or cancelled.'
            );
            error.code = 'human_confirmation_declined';
            error.retryable = false;
            error.hint = `The operation '${
              confirmation.action
            }' was not executed.`;
            return makeToolErrorResult({
              error,
              traceContext,
              durationMs: Math.max(0, Date.now() - startedAt),
              timeoutMs: registration.timeoutMs,
            });
          }

          if (registration.longRunning && operationRegistry) {
            operationId = operationRegistry.start({
              command: registration.name,
              traceId: traceContext.traceId,
            });
            await sendProgress({
              requestContext,
              progress: 0,
              total: 1,
              message: `${registration.name} started (${operationId})`,
            }).catch(() => {});
          }

          let result;
          if (
            desktopCommandRegistry &&
            desktopCommandRegistry.has(registration.name)
          ) {
            let desktopInput = commandInput;
            if (
              registration.name === 'desktop.window.capture' &&
              desktopInput.windowId == null &&
              targeting.windowId &&
              /^\d+$/.test(targeting.windowId)
            ) {
              desktopInput = {
                ...desktopInput,
                windowId: Number(targeting.windowId),
              };
            }
            result = await desktopCommandRegistry.execute({
              command: registration.name,
              input: desktopInput,
              requestContext: {
                identity: connectionIdentity,
                traceId: traceContext.traceId,
                signal: requestSignal,
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
                  targeting,
                  identity: connectionIdentity,
                });
              } catch (error) {}
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
            if (registration.name === 'desktop.window.capture' && result.data) {
              let projectRevision = null;
              let sceneName = null;
              try {
                const projectStatus = await rendererBridge.executeCommand({
                  command: 'project.status',
                  input: {},
                  ...targeting,
                });
                projectRevision =
                  projectStatus &&
                  projectStatus.meta &&
                  Number.isInteger(projectStatus.meta.projectRevision)
                    ? projectStatus.meta.projectRevision
                    : projectStatus &&
                      projectStatus.data &&
                      Number.isInteger(projectStatus.data.projectRevision)
                    ? projectStatus.data.projectRevision
                    : null;
                const visualStatus = await rendererBridge.executeCommand({
                  command: 'editor.visual.status',
                  input: {},
                  ...targeting,
                });
                const openSceneEditors =
                  visualStatus &&
                  visualStatus.data &&
                  Array.isArray(visualStatus.data.openSceneEditors)
                    ? visualStatus.data.openSceneEditors
                    : [];
                const activeScene = openSceneEditors.find(
                  entry => entry.active
                );
                sceneName = activeScene ? activeScene.sceneName : null;
              } catch (error) {}
              result = {
                ...result,
                data: {
                  ...result.data,
                  projectRevision,
                  sceneName,
                },
              };
            }
          } else {
            await preflightEventMutationInput({
              command: registration.name,
              input: commandInput,
              rendererBridge,
              targeting,
            });
            result = await rendererBridge.executeCommand({
              command: registration.name,
              input: commandInput,
              traceId: traceContext.traceId,
              traceContext,
              identity: connectionIdentity,
              ...(registration.modifiesProject &&
              Number.isInteger(expectedRevision) &&
              expectedRevision >= 0
                ? { expectedRevision }
                : {}),
              ...(registration.modifiesProject &&
              expectedSemanticRevisions &&
              typeof expectedSemanticRevisions === 'object' &&
              !Array.isArray(expectedSemanticRevisions)
                ? { expectedSemanticRevisions }
                : {}),
              ...(registration.modifiesProject &&
              typeof semanticLeaseOwner === 'string' &&
              semanticLeaseOwner
                ? { semanticLeaseOwner }
                : {}),
              ...(registration.modifiesProject &&
              typeof idempotencyKey === 'string' &&
              idempotencyKey
                ? { idempotencyKey }
                : {}),
              timeoutMs: registration.timeoutMs,
              signal: requestSignal,
              ...targeting,
            });
          }
          if (registration.modifiesProject) {
            await notifyGDevelopResourcesUpdated({
              server,
              command: registration.name,
            });
          }
          const durationMs = Math.max(0, Date.now() - startedAt);
          if (operationId && operationRegistry) {
            operationRegistry.complete(operationId, { ok: true });
            await sendProgress({
              requestContext,
              progress: 1,
              total: 1,
              message: `${registration.name} completed (${operationId})`,
            }).catch(() => {});
          }
          if (metrics) {
            metrics.record({
              command: registration.name,
              ok: true,
              durationMs,
              idempotencyReplayed: !!(
                result &&
                result.meta &&
                result.meta.idempotencyReplayed
              ),
            });
          }
          const toolResult = toMcpToolResult(result);
          toolResult._meta = {
            ...makeToolResultMeta({
              traceContext,
              durationMs,
              timeoutMs: registration.timeoutMs,
              result,
            }),
            'gdevelop/identity': connectionIdentity,
            ...(operationId ? { 'gdevelop/operationId': operationId } : {}),
          };
          return toolResult;
        } catch (error) {
          const durationMs = Math.max(0, Date.now() - startedAt);
          const cancelled = !!(
            error &&
            (error.name === 'AbortError' ||
              error.code === 'ABORT_ERR' ||
              error.code === 'renderer_request_cancelled' ||
              error.code === 'request_cancelled')
          );
          if (operationId && operationRegistry) {
            operationRegistry.complete(operationId, {
              ok: false,
              cancelled,
              errorCode:
                error && typeof error.code === 'string' ? error.code : null,
            });
            await sendProgress({
              requestContext,
              progress: 1,
              total: 1,
              message: `${registration.name} ${
                cancelled ? 'cancelled' : 'failed'
              } (${operationId})`,
            }).catch(() => {});
          }
          if (metrics) {
            metrics.record({
              command: registration.name,
              ok: false,
              durationMs,
            });
          }
          const toolError = makeToolErrorResult({
            error,
            traceContext,
            durationMs,
            timeoutMs: registration.timeoutMs,
          });
          if (operationId) {
            toolError._meta['gdevelop/operationId'] = operationId;
          }
          return toolError;
        }
      }
    );
  });

  return server;
};

module.exports = {
  SERVER_INFO,
  PROTOCOL_VERSION: '2026-07-28',
  getIdentityFromRequest,
  getTargetingFromRequest,
  mergeCommandDescriptors,
  toMcpToolResult,
  assertTargetPreconditions,
  makeTargetMismatchError,
  normalizeProjectPath,
  createMcpServerFactory,
};
