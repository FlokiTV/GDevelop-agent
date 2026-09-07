const crypto = require('crypto');

const DEFAULT_MAX_OPERATIONS = 128;
const OPERATIONS_RESOURCE_URI = 'gdevelop://mcp/operations';

const createLongRunningOperationRegistry = ({
  maxEntries = DEFAULT_MAX_OPERATIONS,
  makeOperationId = () => crypto.randomUUID(),
  now = () => Date.now(),
} = {}) => {
  const operations = new Map();

  const trim = () => {
    if (operations.size <= maxEntries) return;
    for (const [operationId, operation] of operations) {
      if (operation.status === 'running') continue;
      operations.delete(operationId);
      if (operations.size <= maxEntries) return;
    }
  };

  const start = ({ command, traceId = null }) => {
    const operationId = makeOperationId();
    operations.set(operationId, {
      operationId,
      command,
      traceId,
      status: 'running',
      progress: 0,
      total: 1,
      message: 'started',
      startedAt: now(),
      completedAt: null,
      errorCode: null,
    });
    trim();
    return operationId;
  };

  const update = (operationId, patch) => {
    const operation = operations.get(operationId);
    if (!operation) return null;
    Object.assign(operation, patch);
    return { ...operation };
  };

  const complete = (operationId, { ok, errorCode = null, cancelled = false }) =>
    update(operationId, {
      status: cancelled ? 'cancelled' : ok ? 'succeeded' : 'failed',
      progress: 1,
      message: cancelled ? 'cancelled' : ok ? 'completed' : 'failed',
      completedAt: now(),
      errorCode: errorCode || null,
    });

  const snapshot = () => ({
    operations: Array.from(operations.values())
      .map(operation => ({ ...operation }))
      .sort((left, right) => right.startedAt - left.startedAt),
  });

  return { start, update, complete, snapshot };
};

const getProgressToken = requestContext => {
  const meta =
    requestContext &&
    requestContext.mcpReq &&
    requestContext.mcpReq._meta &&
    typeof requestContext.mcpReq._meta === 'object'
      ? requestContext.mcpReq._meta
      : null;
  if (!meta) return null;
  const progressToken = meta.progressToken;
  return typeof progressToken === 'string' || typeof progressToken === 'number'
    ? progressToken
    : null;
};

const sendProgress = async ({
  requestContext,
  progress,
  total = 1,
  message,
}) => {
  const progressToken = getProgressToken(requestContext);
  const notify =
    requestContext &&
    requestContext.mcpReq &&
    typeof requestContext.mcpReq.notify === 'function'
      ? requestContext.mcpReq.notify
      : null;
  if (progressToken == null || !notify) return false;
  await notify({
    method: 'notifications/progress',
    params: {
      progressToken,
      progress,
      total,
      ...(message ? { message } : {}),
    },
  });
  return true;
};

const registerOperationsResource = ({ server, operationRegistry }) => {
  if (!server || !operationRegistry) return;
  server.registerResource(
    'mcp-long-running-operations',
    OPERATIONS_RESOURCE_URI,
    {
      title: 'GDevelop MCP long-running operations',
      description:
        'Sanitized process-local status for bounded long-running MCP operations. Contains no tool inputs or bearer credentials.',
      mimeType: 'application/json',
      _meta: {
        'gdevelop/cacheScope': 'request',
        'gdevelop/live': true,
      },
    },
    async uri => ({
      contents: [
        {
          uri: uri.toString(),
          mimeType: 'application/json',
          text: JSON.stringify(operationRegistry.snapshot()),
        },
      ],
    })
  );
};

module.exports = {
  DEFAULT_MAX_OPERATIONS,
  OPERATIONS_RESOURCE_URI,
  createLongRunningOperationRegistry,
  getProgressToken,
  sendProgress,
  registerOperationsResource,
};
