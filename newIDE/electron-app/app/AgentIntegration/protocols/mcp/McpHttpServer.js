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
const DEFAULT_MAX_CONCURRENT_REQUESTS = 32;

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

const readJsonBodyWithLimit = async (request, maxBodyBytes) => {
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
  return JSON.parse(Buffer.concat(chunks, totalBytes).toString('utf8'));
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
  maxConcurrentRequests = DEFAULT_MAX_CONCURRENT_REQUESTS,
  log = null,
}) => {
  const handler = createMcpHandler(
    createMcpServerFactory({ rendererBridge, desktopCommandRegistry }),
    {
      legacy: 'reject',
      onerror: error => {
        if (log) log.error('[AgentIntegration:MCP] Request error:', error);
      },
    }
  );
  const nodeHandler = toNodeHandler(handler, {
    onerror: error => {
      if (log) log.error('[AgentIntegration:MCP] Node adapter error:', error);
    },
  });
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  let activeRequests = 0;

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

      activeRequests++;
      try {
        const parsedBody =
          request.method === 'POST'
            ? await readJsonBodyWithLimit(request, maxBodyBytes)
            : undefined;
        await nodeHandler(request, response, parsedBody);
      } finally {
        activeRequests--;
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
      if (!response.headersSent && error instanceof SyntaxError) {
        makeJsonRpcErrorResponse({
          response,
          statusCode: 400,
          code: -32700,
          message: 'Parse error',
        });
        return;
      }
      if (log) log.error('[AgentIntegration:MCP] HTTP error:', error);
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
  DEFAULT_MAX_CONCURRENT_REQUESTS,
  MCP_PATH,
  isAuthorized,
  readJsonBodyWithLimit,
  startMcpHttpServer,
};
