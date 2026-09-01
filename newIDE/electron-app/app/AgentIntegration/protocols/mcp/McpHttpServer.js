const http = require('http');
const {
  createMcpHandler,
} = require('@modelcontextprotocol/server');
const {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} = require('@modelcontextprotocol/node');
const { createMcpServerFactory, PROTOCOL_VERSION } = require('./McpServerFactory');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 38473;
const MCP_PATH = '/mcp';

const makeUnauthorizedResponse = response => {
  response.writeHead(401, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'WWW-Authenticate': 'Bearer realm="gdevelop-mcp"',
  });
  response.end(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Unauthorized' },
      id: null,
    })
  );
};

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
  log = null,
}) => {
  const handler = createMcpHandler(
    createMcpServerFactory({ rendererBridge, desktopCommandRegistry }),
    {
    legacy: 'reject',
    onerror: error => {
      if (log) log.error('[AgentIntegration:MCP] Request error:', error);
    },
  });
  const nodeHandler = toNodeHandler(handler, {
    onerror: error => {
      if (log) log.error('[AgentIntegration:MCP] Node adapter error:', error);
    },
  });
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();

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
      await nodeHandler(request, response);
    } catch (error) {
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
  const actualPort = address && typeof address === 'object' ? address.port : port;
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
  MCP_PATH,
  isAuthorized,
  startMcpHttpServer,
};
