const http = require('http');
const { createMcpHandler } = require('@modelcontextprotocol/server');
const {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} = require('@modelcontextprotocol/node');
const {
  createMcpServerFactory,
  PROTOCOL_VERSION,
} = require('./McpServerFactory');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 38473;
const MCP_PATH = '/mcp';
const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_JSON_DEPTH = 64;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 32;
const DEFAULT_MAX_CONCURRENT_REQUESTS_PER_CLIENT = 8;

const formatMcpErrorForLog = error => {
  if (!error) return 'unknown_error';
  if (typeof error === 'string') return error;

  const parts = [];
  if (typeof error.name === 'string' && error.name && error.name !== 'Error') {
    parts.push(error.name);
  }
  if (error.code != null) parts.push(`code=${String(error.code)}`);
  if (typeof error.message === 'string' && error.message) {
    parts.push(error.message);
  }
  if (parts.length) return parts.join(' ');

  try {
    const serialized = JSON.stringify(error);
    if (serialized && serialized !== '{}') return serialized;
  } catch (serializationError) {}
  return String(error) || 'unknown_error';
};

const isExpectedMcpCancellation = error =>
  !!error &&
  (error.name === 'AbortError' ||
    error.code === 'ABORT_ERR' ||
    error.code === 'renderer_request_cancelled' ||
    error.code === 'request_cancelled');

const logMcpError = (log, label, error) => {
  if (!log) return;
  const message = `[AgentIntegration:MCP] ${label}: ${formatMcpErrorForLog(
    error
  )}`;
  if (isExpectedMcpCancellation(error)) {
    if (typeof log.debug === 'function') log.debug(message);
    return;
  }
  log.error(message);
};

const makeJsonRpcErrorResponse = ({
  response,
  statusCode,
  code,
  message,
  headers = {},
}) => {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  response.end(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code, message },
      id: null,
    })
  );
};

const assertJsonDepthWithinLimit = (value, maxJsonDepth) => {
  const stack = [{ value, depth: 1 }];
  while (stack.length) {
    const current = stack.pop();
    if (!current) continue;
    const { value: currentValue, depth } = current;
    if (depth > maxJsonDepth) {
      const error = new Error('request_json_too_deep');
      error.code = 'request_json_too_deep';
      throw error;
    }
    if (!currentValue || typeof currentValue !== 'object') continue;
    const children = Array.isArray(currentValue)
      ? currentValue
      : Object.values(currentValue);
    children.forEach(child => stack.push({ value: child, depth: depth + 1 }));
  }
};

const readJsonBodyWithLimit = async (
  request,
  maxBodyBytes,
  maxJsonDepth = DEFAULT_MAX_JSON_DEPTH
) => {
  const contentLength = Number(request.headers['content-length']);
  if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
    const error = new Error('request_body_too_large');
    error.code = 'request_body_too_large';
    throw error;
  }

  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > maxBodyBytes) {
      const error = new Error('request_body_too_large');
      error.code = 'request_body_too_large';
      throw error;
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return undefined;
  const parsedBody = JSON.parse(
    Buffer.concat(chunks, totalBytes).toString('utf8')
  );
  assertJsonDepthWithinLimit(parsedBody, maxJsonDepth);
  return parsedBody;
};

const makeUnauthorizedResponse = response =>
  makeJsonRpcErrorResponse({
    response,
    statusCode: 401,
    code: -32001,
    message: 'Unauthorized',
    headers: { 'WWW-Authenticate': 'Bearer realm="gdevelop-mcp"' },
  });

const isAuthorized = (request, token) => {
  if (!token || typeof token !== 'string') return false;
  const authorization = request.headers.authorization;
  return authorization === `Bearer ${token}`;
};

const getClientAdmissionKey = request => {
  const explicitClientId = request.headers['x-gdevelop-client-id'];
  if (
    typeof explicitClientId === 'string' &&
    /^[A-Za-z0-9._:-]{1,128}$/.test(explicitClientId)
  ) {
    return `client:${explicitClientId}`;
  }

  const windowId = request.headers['x-gdevelop-window-id'];
  if (typeof windowId === 'string' && /^\d{1,12}$/.test(windowId)) {
    return `window:${windowId}`;
  }

  const remoteAddress =
    request.socket && typeof request.socket.remoteAddress === 'string'
      ? request.socket.remoteAddress
      : 'unknown';
  return `remote:${remoteAddress}`;
};

const listen = (server, port, host) =>
  new Promise((resolve, reject) => {
    const onError = error => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });

const closeHttpServer = server =>
  new Promise(resolve => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });

const startMcpHttpServer = async ({
  rendererBridge,
  desktopCommandRegistry = null,
  token,
  host = DEFAULT_HOST,
  port = DEFAULT_PORT,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  maxJsonDepth = DEFAULT_MAX_JSON_DEPTH,
  maxConcurrentRequests = DEFAULT_MAX_CONCURRENT_REQUESTS,
  maxConcurrentRequestsPerClient = DEFAULT_MAX_CONCURRENT_REQUESTS_PER_CLIENT,
  log = null,
}) => {
  const handler = createMcpHandler(
    createMcpServerFactory({ rendererBridge, desktopCommandRegistry }),
    {
      legacy: 'reject',
      onerror: error => {
        logMcpError(log, 'Request error', error);
      },
    }
  );
  const nodeHandler = toNodeHandler(handler, {
    onerror: error => {
      logMcpError(log, 'Node adapter error', error);
    },
  });
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  let activeRequests = 0;
  const activeRequestsByClient = new Map();

  const server = http.createServer(async (request, response) => {
    try {
      const requestUrl = new URL(
        request.url || '/',
        `http://${request.headers.host || `${host}:${port}`}`
      );
      if (requestUrl.pathname !== MCP_PATH) {
        response.writeHead(404, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        response.end(JSON.stringify({ ok: false, error: 'not_found' }));
        return;
      }
      if (!validateHost(request, response)) return;
      if (!validateOrigin(request, response)) return;
      if (!isAuthorized(request, token)) {
        makeUnauthorizedResponse(response);
        return;
      }
      if (activeRequests >= maxConcurrentRequests) {
        makeJsonRpcErrorResponse({
          response,
          statusCode: 429,
          code: -32002,
          message: 'Too many concurrent requests',
          headers: { 'Retry-After': '1' },
        });
        return;
      }

      const clientAdmissionKey = getClientAdmissionKey(request);
      const activeClientRequests =
        activeRequestsByClient.get(clientAdmissionKey) || 0;
      if (activeClientRequests >= maxConcurrentRequestsPerClient) {
        makeJsonRpcErrorResponse({
          response,
          statusCode: 429,
          code: -32004,
          message: 'Too many concurrent requests for this client',
          headers: { 'Retry-After': '1' },
        });
        return;
      }

      activeRequests++;
      activeRequestsByClient.set(clientAdmissionKey, activeClientRequests + 1);
      try {
        const parsedBody =
          request.method === 'POST'
            ? await readJsonBodyWithLimit(request, maxBodyBytes, maxJsonDepth)
            : undefined;
        await nodeHandler(request, response, parsedBody);
      } finally {
        activeRequests--;
        const remainingClientRequests =
          (activeRequestsByClient.get(clientAdmissionKey) || 1) - 1;
        if (remainingClientRequests > 0) {
          activeRequestsByClient.set(
            clientAdmissionKey,
            remainingClientRequests
          );
        } else {
          activeRequestsByClient.delete(clientAdmissionKey);
        }
      }
    } catch (error) {
      if (
        !response.headersSent &&
        error &&
        error.code === 'request_body_too_large'
      ) {
        makeJsonRpcErrorResponse({
          response,
          statusCode: 413,
          code: -32003,
          message: 'Request body too large',
        });
        return;
      }
      if (
        !response.headersSent &&
        error &&
        error.code === 'request_json_too_deep'
      ) {
        makeJsonRpcErrorResponse({
          response,
          statusCode: 400,
          code: -32600,
          message: 'Request JSON nesting too deep',
        });
        return;
      }
      if (!response.headersSent && error instanceof SyntaxError) {
        makeJsonRpcErrorResponse({
          response,
          statusCode: 400,
          code: -32700,
          message: 'Parse error',
        });
        return;
      }
      logMcpError(log, 'HTTP error', error);
      if (!response.headersSent) {
        response.writeHead(500, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
      }
      if (!response.writableEnded) {
        response.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal server error' },
            id: null,
          })
        );
      }
    }
  });

  await listen(server, port, host);
  const address = server.address();
  const actualPort =
    address && typeof address === 'object' ? address.port : port;
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await handler.close();
    await closeHttpServer(server);
  };

  return {
    host,
    port: actualPort,
    path: MCP_PATH,
    url: `http://${host}:${actualPort}${MCP_PATH}`,
    protocolVersion: PROTOCOL_VERSION,
    stop,
    server,
    handler,
  };
};

module.exports = {
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_MAX_JSON_DEPTH,
  DEFAULT_MAX_CONCURRENT_REQUESTS,
  DEFAULT_MAX_CONCURRENT_REQUESTS_PER_CLIENT,
  MCP_PATH,
  formatMcpErrorForLog,
  isExpectedMcpCancellation,
  isAuthorized,
  logMcpError,
  readJsonBodyWithLimit,
  startMcpHttpServer,
};
