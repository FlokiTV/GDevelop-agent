const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createPreviewInputTools } = require('./PreviewInputTools');
const { createAgentPreviewRuntime } = require('./AgentPreviewRuntime');
const { createWindowRegistry } = require('../AgentIntegration/WindowRegistry');
const { createRendererBridge } = require('../AgentIntegration/RendererBridge');
const { isPreviewWindow } = require('../PreviewWindow');

let electronDesktopCapturer = null;
try {
  electronDesktopCapturer = require('electron').desktopCapturer || null;
} catch (error) {}

const DEFAULT_PORT = 38473;
const REQUEST_TIMEOUT_MS = 30000;
const MAX_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const GAMEPLAY_TEST_DEFAULT_TIMEOUT_MS = 30000;
// Gameplay tests may spend up to 60s booting a fresh game and the runner
// keeps a 10s result watchdog margin. Keep a little extra IPC/serialization
// room so the HTTP envelope never expires before the runner's own budget.
const GAMEPLAY_TEST_REQUEST_OVERHEAD_MS = 75 * 1000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

const getGameplayTestRequestBudgetMs = call => {
  if (!call || call.name !== 'run_gameplay_test') return 0;
  const requestedTimeoutMs = Number(
    call.arguments && call.arguments.timeout_ms
  );
  const testTimeoutMs =
    Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0
      ? requestedTimeoutMs
      : GAMEPLAY_TEST_DEFAULT_TIMEOUT_MS;
  return testTimeoutMs + GAMEPLAY_TEST_REQUEST_OVERHEAD_MS;
};

const getRendererRequestTimeoutMs = request => {
  let longRunningBudgetMs = 0;
  if (request && request.type === 'editor-function') {
    longRunningBudgetMs = getGameplayTestRequestBudgetMs(request);
  } else if (
    request &&
    request.type === 'editor-functions' &&
    Array.isArray(request.calls)
  ) {
    longRunningBudgetMs = request.calls.reduce(
      (total, call) => total + getGameplayTestRequestBudgetMs(call),
      0
    );
  } else if (
    request &&
    request.type === 'validation-report' &&
    Array.isArray(request.gameplayTests)
  ) {
    longRunningBudgetMs = request.gameplayTests.reduce(
      (total, argumentsForTest) =>
        total +
        getGameplayTestRequestBudgetMs({
          name: 'run_gameplay_test',
          arguments:
            argumentsForTest && typeof argumentsForTest === 'object'
              ? argumentsForTest
              : {},
        }),
      0
    );
  }

  if (longRunningBudgetMs <= 0) return REQUEST_TIMEOUT_MS;
  return Math.min(
    MAX_REQUEST_TIMEOUT_MS,
    Math.max(REQUEST_TIMEOUT_MS, longRunningBudgetMs)
  );
};

let server = null;
let started = false;
let config = null;
let windowRegistry = null;
let windowRegistryCleanup = null;
let rendererBridge = null;
let previewInputTools = null;
let agentPreviewRuntime = null;

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

const captureWindowPng = async ({ targetWindow, desktopCapturer }) => {
  const image = await targetWindow.webContents.capturePage();
  const directBuffer = image && image.toPNG ? image.toPNG() : Buffer.alloc(0);
  if (directBuffer.length > 0) return directBuffer;

  if (!desktopCapturer || typeof desktopCapturer.getSources !== 'function') {
    const error = new Error('window_capture_empty');
    error.code = 'window_capture_empty';
    throw error;
  }

  const bounds = targetWindow.getBounds();
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: {
      width: Math.max(1, bounds.width),
      height: Math.max(1, bounds.height),
    },
    fetchWindowIcons: false,
  });
  const mediaSourceId =
    typeof targetWindow.getMediaSourceId === 'function'
      ? targetWindow.getMediaSourceId()
      : null;
  let source = mediaSourceId
    ? sources.find(candidate => candidate.id === mediaSourceId)
    : null;
  if (!source && typeof targetWindow.getTitle === 'function') {
    const title = targetWindow.getTitle();
    source = sources.find(candidate => candidate.name === title);
  }

  const fallbackBuffer =
    source && source.thumbnail && source.thumbnail.toPNG
      ? source.thumbnail.toPNG()
      : Buffer.alloc(0);
  if (fallbackBuffer.length > 0) return fallbackBuffer;

  const error = new Error('window_capture_empty');
  error.code = 'window_capture_empty';
  throw error;
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

const dispatchToRenderer = ({ projectPath, windowId, request }) => {
  if (!rendererBridge) {
    const error = new Error('renderer_bridge_unavailable');
    error.code = 'renderer_bridge_unavailable';
    return Promise.reject(error);
  }
  return rendererBridge.dispatchLegacy({
    projectPath,
    windowId,
    request,
    timeoutMs: getRendererRequestTimeoutMs(request),
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
  windowRegistry = createWindowRegistry({ BrowserWindow });
  windowRegistryCleanup = windowRegistry.installIpc(ipcMain);
  rendererBridge = createRendererBridge({
    BrowserWindow,
    ipcMain,
    windowRegistry,
  });
  previewInputTools = createPreviewInputTools({
    BrowserWindow,
    isEditorWindow: windowId => windowRegistry.isRegistered(windowId),
    isRegisteredPreviewWindow: isPreviewWindow,
  });
  agentPreviewRuntime = createAgentPreviewRuntime({
    BrowserWindow,
    isEditorWindow: windowId => windowRegistry.isRegistered(windowId),
    isRegisteredPreviewWindow: isPreviewWindow,
  });

  server = http.createServer(async (request, response) => {
    try {
      const url = new URL(
        request.url || '/',
        `http://${config.host}:${config.port}`
      );

      if (request.method === 'GET' && url.pathname === '/health') {
        windowRegistry.prune();
        json(response, 200, {
          ok: true,
          service: 'gdevelop-agent-api',
          version: config.version,
          pid: process.pid,
          registeredWindows: windowRegistry.size,
        });
        return;
      }

      if (!isAuthorized(request)) {
        json(response, 401, { ok: false, error: 'unauthorized' });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/v1/status') {
        windowRegistry.prune();
        json(response, 200, {
          ok: true,
          windows: windowRegistry.listRegistered(),
        });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/v1/windows') {
        windowRegistry.prune();
        json(response, 200, {
          ok: true,
          windows: BrowserWindow.getAllWindows().map(window => ({
            windowId: window.id,
            title: window.getTitle(),
            url: window.webContents.getURL(),
            bounds: window.getBounds(),
            visible: window.isVisible(),
            focused: window.isFocused(),
            editorWindow: windowRegistry.isRegistered(window.id),
            previewWindow: isPreviewWindow(window.id),
            projectPath: windowRegistry.isRegistered(window.id)
              ? windowRegistry.getProjectPath(window.id)
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
        const imageBuffer = await captureWindowPng({
          targetWindow,
          desktopCapturer: electronDesktopCapturer,
        });
        png(response, imageBuffer);
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

      if (request.method === 'GET' && url.pathname === '/v1/diagnostics') {
        const result = await dispatchToRenderer({
          BrowserWindow,
          projectPath: url.searchParams.get('projectPath'),
          windowId: url.searchParams.get('windowId'),
          request: {
            type: 'diagnostics-project',
            includeAssets: !['0', 'false'].includes(
              String(url.searchParams.get('includeAssets') || '').toLowerCase()
            ),
            includeNativeReport: !['0', 'false'].includes(
              String(
                url.searchParams.get('includeNativeReport') || ''
              ).toLowerCase()
            ),
          },
        });
        json(response, 200, { ok: true, result });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/v1/functions') {
        const result = await dispatchToRenderer({
          BrowserWindow,
          projectPath: url.searchParams.get('projectPath'),
          windowId: url.searchParams.get('windowId'),
          request: {
            type: 'list-functions',
            query: url.searchParams.get('q') || url.searchParams.get('query'),
            executableOnly: ['1', 'true'].includes(
              String(url.searchParams.get('executableOnly') || '').toLowerCase()
            ),
          },
        });
        json(response, 200, { ok: true, result });
        return;
      }

      const functionPathMatch = url.pathname.match(
        /^\/v1\/functions\/([^/]+)$/
      );
      if (request.method === 'GET' && functionPathMatch) {
        const functionName = decodeURIComponent(functionPathMatch[1]);
        const result = await dispatchToRenderer({
          BrowserWindow,
          projectPath: url.searchParams.get('projectPath'),
          windowId: url.searchParams.get('windowId'),
          request: { type: 'describe-function', name: functionName },
        });
        json(response, 200, { ok: true, result });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/v1/validate') {
        const body = await readJsonBody(request);
        const targeting = getTargeting(request, body);
        const result = await dispatchToRenderer({
          BrowserWindow,
          ...targeting,
          request: { ...body, type: 'validation-report' },
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
        if (previewInputTools && previewInputTools.canHandleAction(body.type)) {
          const result = await previewInputTools.handleAction(body);
          json(response, 200, { ok: true, result });
          return;
        }
        if (
          agentPreviewRuntime &&
          agentPreviewRuntime.canHandleAction(body.type)
        ) {
          const result = await agentPreviewRuntime.handleAction(body);
          json(response, 200, { ok: true, result });
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
      const code = error && error.code ? String(error.code) : 'agent_api_error';
      const statusCode =
        code === 'target_window_not_found'
          ? 409
          : code === 'preview_window_not_found' || code === 'function_not_found'
          ? 404
          : code === 'renderer_request_timeout'
          ? 504
          : code === 'request_body_too_large'
          ? 413
          : code === 'invalid_json' ||
            code.startsWith('invalid_input') ||
            code.startsWith('invalid_touch') ||
            code.startsWith('invalid_gamepad') ||
            code.startsWith('missing_input') ||
            code.startsWith('missing_preview') ||
            code.startsWith('unsupported_input') ||
            code === 'too_many_input_sequence_steps' ||
            code === 'input_sequence_too_long' ||
            code === 'too_many_validation_gameplay_tests' ||
            code === 'too_many_runtime_assertions'
          ? 400
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
  if (rendererBridge) rendererBridge.dispose();
  if (windowRegistryCleanup) windowRegistryCleanup();
  if (windowRegistry) windowRegistry.clear();
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
  previewInputTools = null;
  agentPreviewRuntime = null;
  rendererBridge = null;
  windowRegistryCleanup = null;
  windowRegistry = null;
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
  captureWindowPng,
  getRendererRequestTimeoutMs,
};
