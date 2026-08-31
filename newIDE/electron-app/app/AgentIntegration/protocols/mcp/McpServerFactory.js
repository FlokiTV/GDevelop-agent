const crypto = require('crypto');
const { McpServer } = require('@modelcontextprotocol/server');
const { descriptorsToToolRegistrations } = require('./McpToolCatalog');

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

const createMcpServerFactory = ({ rendererBridge }) => async ctx => {
  const targeting = getTargetingFromRequest(ctx && ctx.requestInfo);
  const catalogResult = await rendererBridge.executeCommand({
    command: 'agent.commands.list',
    input: {},
    ...targeting,
  });
  const descriptors =
    catalogResult && catalogResult.data && Array.isArray(catalogResult.data.commands)
      ? catalogResult.data.commands
      : [];

  const server = new McpServer(SERVER_INFO, {
    instructions:
      'Operate the currently open GDevelop editor live. Mutations affect the in-memory project; save explicitly when requested.',
  });

  descriptorsToToolRegistrations(descriptors).forEach(registration => {
    server.registerTool(
      registration.name,
      registration.config,
      async input => {
        const result = await rendererBridge.executeCommand({
          command: registration.name,
          input,
          traceId: crypto.randomUUID(),
          timeoutMs: registration.timeoutMs,
          ...targeting,
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result),
            },
          ],
          structuredContent: result,
        };
      }
    );
  });

  return server;
};

module.exports = {
  SERVER_INFO,
  PROTOCOL_VERSION: '2026-07-28',
  getTargetingFromRequest,
  createMcpServerFactory,
};
