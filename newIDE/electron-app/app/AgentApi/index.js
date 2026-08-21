const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_PORT = 38473;
const REQUEST_TIMEOUT_MS = 30000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

let server = null;
let started = false;
let config = null;
let windowProjects = new Map();
let pendingRequests = new Map();
let ipcHandlers = null;

const normalizeFileIdentifier = fileIdentifier => {
  if (!fileIdentifier || typeof fileIdentifier !== 'string') return null;
  try {
    const resolved = path.resolve(fileIdentifier);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  } catch (error) {
    return null;
  }
};

const json = (response, statusCode, payload) => {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(body);
};

const png = (response, imageBuffer) => {
  response.writeHead(200, {
    'Content-Type': 'image/png',
    'Content-Length': imageBuffer.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(imageBuffer);
};

const readJsonBody = request =>
  new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        const error = new Error('request_body_too_large');
        error.code = 'request_body_too_large';
        reject(error);
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch (error) {
        const invalidJsonError = new Error('invalid_json');
        invalidJsonError.code = 'invalid_json';
        reject(invalidJsonError);
      }
    });
    request.on('error', reject);
  });

const isAuthorized = request => {
  if (!config) return false;
  const token = request.headers['x-gdevelop-agent-token'];
  return typeof token === 'string' && token === config.token;
};

const pruneWindowProjects = BrowserWindow => {
  for (const windowId of windowProjects.keys()) {
    const window = BrowserWindow.fromId(windowId);
    if (!window || window.isDestroyed()) windowProjects.delete(windowId);
  }
};

const selectTargetWindow = ({ BrowserWindow, projectPath, windowId }) => {
  pruneWindowProjects(BrowserWindow);

  if (windowId != null) {
    const numericWindowId = Number(windowId);
    const window = BrowserWindow.fromId(numericWindowId);
    if (window && !window.isDestroyed() && windowProjects.has(window.id)) {
      return window;
    }
    return null;
  }

  const normalizedProjectPath = normalizeFileIdentifier(projectPath);
  if (normalizedProjectPath) {
    for (const [
      registeredWindowId,
      registeredProjectPath,
    ] of windowProjects.entries()) {
      if (registeredProjectPath !== normalizedProjectPath) continue;
      const window = BrowserWindow.fromId(registeredWindowId);
      if (window && !window.isDestroyed()) return window;
    }
    return null;
  }

  const focusedWindow = BrowserWindow.getFocusedWindow();
  if (
    focusedWindow &&
    !focusedWindow.isDestroyed() &&
    windowProjects.has(focusedWindow.id)
  ) {
    return focusedWindow;
  }

  const availableWindows = Array.from(windowProjects.keys())
    .map(registeredWindowId => BrowserWindow.fromId(registeredWindowId))
    .filter(window => window && !window.isDestroyed());

  return availableWindows.length === 1 ? availableWindows[0] : null;
};

const dispatchToRenderer = ({
  BrowserWindow,
  projectPath,
  windowId,
  request,
}) => {
  const targetWindow = selectTargetWindow({
    BrowserWindow,
    projectPath,
    windowId,
  });
  if (!targetWindow) {
    const error = new Error(
      projectPath
        ? 'project_not_open_in_agent_api'
        : 'target_window_ambiguous_or_missing'
    );
    error.code = 'target_window_not_found';
    return Promise.reject(error);
  }

  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId);
      const error = new Error('renderer_request_timeout');
      error.code = 'renderer_request_timeout';
      reject(error);
    }, REQUEST_TIMEOUT_MS);

    pendingRequests.set(requestId, {
      resolve,
      reject,
      timeout,
      windowId: targetWindow.id,
    });

    targetWindow.webContents.send('gdevelop-agent-api:request', {
      requestId,
      request,
    });
  });
};

const createConfig = app => {
  const portFromEnv = Number.parseInt(
    process.env.GDEVELOP_AGENT_API_PORT || '',
    10
  );
  const port =
    Number.isFinite(portFromEnv) && portFromEnv > 0
      ? portFromEnv
      : DEFAULT_PORT;
  const token = crypto.randomBytes(32).toString('hex');
  const configPath = path.join(app.getPath('userData'), 'agent-api.json');
  const nextConfig = {
    host: '127.0.0.1',
    port,
    token,
    pid: process.pid,
    version: 2,
  };
  try {
    fs.writeFileSync(configPath, JSON.stringify(nextConfig, null, 2), 'utf8');
  } catch (error) {}
  return { ...nextConfig, configPath };
};

const installIpcHandlers = ({ ipcMain, BrowserWindow }) => {
  const onRegister = (event, payload = {}) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return;
    if (payload.active === false) {
      windowProjects.delete(window.id);
      return;
    }
    const normalized = normalizeFileIdentifier(payload.fileIdentifier);
    // A registered editor window remains targetable even when no project is
    // open. This is required for initialize_project and project-open actions.
    windowProjects.set(window.id, normalized);
  };

  const onResponse = (event, payload = {}) => {
    const pending = pendingRequests.get(payload.requestId);
    if (!pending) return;

    const sourceWindow = BrowserWindow.fromWebContents(event.sender);
    if (!sourceWindow || sourceWindow.id !== pending.windowId) return;

    clearTimeout(pending.timeout);
    pendingRequests.delete(payload.requestId);
    if (payload.ok) pending.resolve(payload.result);
    else {
      const error = new Error(payload.error || 'renderer_request_failed');
      error.code = payload.code || 'renderer_request_failed';
      pending.reject(error);
    }
  };

  ipcMain.on('gdevelop-agent-api:register', onRegister);
  ipcMain.on('gdevelop-agent-api:response', onResponse);
  ipcHandlers = { ipcMain, onRegister, onResponse };
};

const uninstallIpcHandlers = () => {
  if (!ipcHandlers) return;
  ipcHandlers.ipcMain.removeListener(
    'gdevelop-agent-api:register',
    ipcHandlers.onRegister
  );
  ipcHandlers.ipcMain.removeListener(
    'gdevelop-agent-api:response',
    ipcHandlers.onResponse
  );
  ipcHandlers = null;
};

const getTargeting = (request, body) => ({
  projectPath:
    (body && typeof body.projectPath === 'string' && body.projectPath) || null,
  windowId:
    (body && body.windowId != null && body.windowId) ||
    request.headers['x-gdevelop-window-id'] ||
    null,
});

const startAgentApi = ({ app, ipcMain, BrowserWindow, log }) => {
  if (started) return config;
  started = true;
  config = createConfig(app);
  installIpcHandlers({ ipcMain, BrowserWindow });

  server = http.createServer(async (request, response) => {
    try {
      const url = new URL(
        request.url || '/',
        `http://${config.host}:${config.port}`
      );

      if (request.method === 'GET' && url.pathname === '/health') {
        pruneWindowProjects(BrowserWindow);
        json(response, 200, {
          ok: true,
          service: 'gdevelop-agent-api',
          version: config.version,
          pid: process.pid,
          registeredWindows: windowProjects.size,
        });
        return;
      }

      if (!isAuthorized(request)) {
        json(response, 401, { ok: false, error: 'unauthorized' });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/v1/status') {
        pruneWindowProjects(BrowserWindow);
        json(response, 200, {
          ok: true,
          windows: Array.from(windowProjects.entries()).map(
            ([windowId, projectPath]) => ({ windowId, projectPath })
          ),
        });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/v1/windows') {
        pruneWindowProjects(BrowserWindow);
        json(response, 200, {
          ok: true,
          windows: BrowserWindow.getAllWindows().map(window => ({
            windowId: window.id,
            title: window.getTitle(),
            url: window.webContents.getURL(),
            bounds: window.getBounds(),
            visible: window.isVisible(),
            focused: window.isFocused(),
            editorWindow: windowProjects.has(window.id),
            projectPath: windowProjects.has(window.id)
              ? windowProjects.get(window.id)
              : null,
          })),
        });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/v1/capture') {
        const requestedWindowId = url.searchParams.get('windowId');
        const targetWindow = requestedWindowId
          ? BrowserWindow.fromId(Number(requestedWindowId))
          : BrowserWindow.getFocusedWindow();
        if (!targetWindow || targetWindow.isDestroyed()) {
          json(response, 404, { ok: false, error: 'window_not_found' });
          return;
        }
        const image = await targetWindow.webContents.capturePage();
        png(response, image.toPNG());
        return;
      }

      if (request.method === 'GET' && url.pathname === '/v1/capabilities') {
        const result = await dispatchToRenderer({
          BrowserWindow,
          projectPath: url.searchParams.get('projectPath'),
          windowId: url.searchParams.get('windowId'),
          request: { type: 'capabilities' },
        });
        json(response, 200, { ok: true, result });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/v1/project') {
        const result = await dispatchToRenderer({
          BrowserWindow,
          projectPath: url.searchParams.get('projectPath'),
          windowId: url.searchParams.get('windowId'),
          request: { type: 'status' },
        });
        json(response, 200, { ok: true, result });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/v1/functions') {
        const result = await dispatchToRenderer({
          BrowserWindow,
          projectPath: url.searchParams.get('projectPath'),
          windowId: url.searchParams.get('windowId'),
          request: { type: 'list-functions' },
        });
        json(response, 200, { ok: true, result });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/v1/action') {
        const body = await readJsonBody(request);
        if (!body || typeof body.type !== 'string' || !body.type) {
          json(response, 400, { ok: false, error: 'missing_action_type' });
          return;
        }
        const targeting = getTargeting(request, body);
        const result = await dispatchToRenderer({
          BrowserWindow,
          ...targeting,
          request: body,
        });
        json(response, 200, { ok: true, result });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/v1/call') {
        const body = await readJsonBody(request);
        if (!body || typeof body.name !== 'string' || !body.name) {
          json(response, 400, { ok: false, error: 'missing_function_name' });
          return;
        }
        const targeting = getTargeting(request, body);
        const result = await dispatchToRenderer({
          BrowserWindow,
          ...targeting,
          request: {
            type: 'editor-function',
            name: body.name,
            arguments:
              body.arguments && typeof body.arguments === 'object'
                ? body.arguments
                : {},
            callId: typeof body.callId === 'string' ? body.callId : undefined,
            save: !!body.save,
          },
        });
        json(response, 200, { ok: true, result });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/v1/calls') {
        const body = await readJsonBody(request);
        if (!body || !Array.isArray(body.calls) || body.calls.length === 0) {
          json(response, 400, { ok: false, error: 'missing_function_calls' });
          return;
        }
        const targeting = getTargeting(request, body);
        const result = await dispatchToRenderer({
          BrowserWindow,
          ...targeting,
          request: {
            type: 'editor-functions',
            calls: body.calls,
            save: !!body.save,
          },
        });
        json(response, 200, { ok: true, result });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/v1/save') {
        const body = await readJsonBody(request);
        const targeting = getTargeting(request, body);
        const result = await dispatchToRenderer({
          BrowserWindow,
          ...targeting,
          request: { type: 'save-project' },
        });
        json(response, 200, { ok: true, result });
        return;
      }

      json(response, 404, { ok: false, error: 'not_found' });
    } catch (error) {
      const code = error && error.code ? error.code : 'agent_api_error';
      const statusCode =
        code === 'target_window_not_found'
          ? 409
          : code === 'renderer_request_timeout'
          ? 504
          : code === 'invalid_json'
          ? 400
          : code === 'request_body_too_large'
          ? 413
          : 500;
      json(response, statusCode, {
        ok: false,
        error: code,
        message: error && error.message ? error.message : String(error),
      });
    }
  });

  server.on('error', error => {
    if (log) log.error('[AgentApi] HTTP server error:', error);
  });

  server.listen(config.port, config.host, () => {
    if (log) {
      log.info(
        `[AgentApi] Listening on http://${config.host}:${config.port}; config=${
          config.configPath
        }`
      );
    }
  });

  return config;
};

const stopAgentApi = () => {
  for (const pending of pendingRequests.values()) {
    clearTimeout(pending.timeout);
    pending.reject(new Error('agent_api_stopped'));
  }
  pendingRequests.clear();
  windowProjects.clear();
  uninstallIpcHandlers();
  if (server) {
    try {
      server.close();
    } catch (error) {}
  }
  if (config && config.configPath) {
    try {
      fs.unlinkSync(config.configPath);
    } catch (error) {}
  }
  server = null;
  config = null;
  started = false;
};

const installAgentApi = dependencies => {
  const { app } = dependencies;
  const start = () => startAgentApi(dependencies);
  const stop = () => stopAgentApi();

  if (app.isReady()) start();
  else app.once('ready', start);
  app.once('before-quit', stop);

  return () => {
    app.removeListener('ready', start);
    app.removeListener('before-quit', stop);
    stop();
  };
};

module.exports = {
  installAgentApi,
  startAgentApi,
  stopAgentApi,
};
