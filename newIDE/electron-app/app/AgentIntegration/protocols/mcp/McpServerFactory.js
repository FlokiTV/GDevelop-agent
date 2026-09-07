const crypto = require('crypto');
const { McpServer } = require('@modelcontextprotocol/server');
const { descriptorsToToolRegistrations } = require('./McpToolCatalog');
const { registerGDevelopPrompts } = require('./McpPrompts');
const { registerGDevelopResources } = require('./McpResources');
const {
  registerOperationsResource,
  sendProgress,
} = require('./McpLongRunning');
const { requireDestructiveConfirmation } = require('./McpHumanInput');
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

const getTargetingFromRequest = request => {
  if (!request || !request.headers) return {};
  const windowId = request.headers.get('x-gdevelop-window-id');
  const projectPath = request.headers.get('x-gdevelop-project-path');
  return {
    ...(windowId ? { windowId } : {}),
    ...(projectPath ? { projectPath } : {}),
  };
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
  const connectionTraceContext = getTraceContextFromRequest(
    ctx && ctx.requestInfo
  );
  const catalogResult = await rendererBridge.executeCommand({
    command: 'agent.commands.list',
    input: {},
    ...targeting,
  });
  const rendererDescriptors =
    catalogResult &&
    catalogResult.data &&
    Array.isArray(catalogResult.data.commands)
      ? catalogResult.data.commands
      : [];
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
            idempotencyKey,
            ...commandInput
          } = normalizedInput;

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
            });
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
            result = await rendererBridge.executeCommand({
              command: registration.name,
              input: commandInput,
              traceId: traceContext.traceId,
              traceContext,
              ...(registration.modifiesProject &&
              Number.isInteger(expectedRevision) &&
              expectedRevision >= 0
                ? { expectedRevision }
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
  getTargetingFromRequest,
  mergeCommandDescriptors,
  toMcpToolResult,
  createMcpServerFactory,
};
