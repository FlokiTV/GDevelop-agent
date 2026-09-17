const DEFAULT_MAX_EVENTS = 500;
const MAX_EVENTS_LIMIT = 2000;
const SENSITIVE_QUERY_KEY = /^(?:access[_-]?token|api[_-]?key|auth|authorization|code|credential|key|password|secret|session|sig|signature|token)$/i;
const SENSITIVE_HEADER = /^(?:authorization|cookie|proxy-authorization|set-cookie|x-api-key)$/i;

const makeError = code => {
  const error = new Error(code);
  error.code = code;
  return error;
};

const redactUrl = rawUrl => {
  if (typeof rawUrl !== 'string') return null;
  try {
    const parsed = new URL(rawUrl);
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (SENSITIVE_QUERY_KEY.test(key))
        parsed.searchParams.set(key, '[REDACTED]');
    }
    parsed.username = parsed.username ? '[REDACTED]' : '';
    parsed.password = parsed.password ? '[REDACTED]' : '';
    return parsed.toString();
  } catch (error) {
    return rawUrl.replace(
      /([?&](?:token|key|secret|password|auth)\s*=)[^&#]*/gi,
      '$1[REDACTED]'
    );
  }
};

const redactHeaders = headers => {
  if (!headers || typeof headers !== 'object') return {};
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key,
      SENSITIVE_HEADER.test(key) ? '[REDACTED]' : String(value),
    ])
  );
};

const createPreviewNetworkDiagnosticsService = ({
  BrowserWindow,
  isRegisteredPreviewWindow,
  multiplayerPreviewService,
}) => {
  const sessions = new Map();

  const resolveClient = alias => {
    const client = multiplayerPreviewService.resolveAlias(alias);
    const window = BrowserWindow.fromId(client.previewWindowId);
    if (
      !window ||
      window.isDestroyed() ||
      !isRegisteredPreviewWindow(window.id)
    ) {
      throw makeError('preview_window_not_found');
    }
    return { ...client, window };
  };

  const capabilities = () => ({
    supported: true,
    transport: 'electron-webcontents-debugger-cdp',
    protocols: { http: true, webSocket: true },
    bounded: true,
    redactionByDefault: true,
    responseBodies: false,
    networkShaping: { supported: false, reason: 'network_shaping_not_exposed' },
  });

  const stopSession = session => {
    if (!session) return;
    const { debuggerApi, onMessage } = session;
    if (debuggerApi && onMessage)
      debuggerApi.removeListener('message', onMessage);
    if (debuggerApi && debuggerApi.isAttached()) debuggerApi.detach();
    sessions.delete(session.alias);
  };

  const start = async ({ alias, maxEvents = DEFAULT_MAX_EVENTS } = {}) => {
    const client = resolveClient(alias);
    const boundedMaxEvents = Number(maxEvents);
    if (
      !Number.isInteger(boundedMaxEvents) ||
      boundedMaxEvents < 1 ||
      boundedMaxEvents > MAX_EVENTS_LIMIT
    ) {
      throw makeError('invalid_network_max_events');
    }
    if (sessions.has(client.alias))
      throw makeError('network_capture_already_active');
    const debuggerApi = client.window.webContents.debugger;
    if (!debuggerApi || typeof debuggerApi.attach !== 'function') {
      throw makeError('network_debugger_unavailable');
    }
    if (debuggerApi.isAttached()) throw makeError('network_debugger_in_use');
    debuggerApi.attach('1.3');
    await debuggerApi.sendCommand('Network.enable');

    const session = {
      alias: client.alias,
      previewWindowId: client.previewWindowId,
      debuggerApi,
      maxEvents: boundedMaxEvents,
      droppedEvents: 0,
      events: [],
      requests: new Map(),
      startedAt: Date.now(),
      onMessage: null,
    };
    const push = event => {
      if (session.events.length >= session.maxEvents) {
        session.events.shift();
        session.droppedEvents += 1;
      }
      session.events.push(event);
    };
    session.onMessage = (_event, method, params = {}) => {
      const at = Date.now();
      if (method === 'Network.requestWillBeSent') {
        const request = params.request || {};
        session.requests.set(params.requestId, at);
        push({
          type: 'http-request',
          at,
          requestId: params.requestId || null,
          method: request.method || null,
          url: redactUrl(request.url),
          headers: redactHeaders(request.headers),
        });
      } else if (method === 'Network.responseReceived') {
        const response = params.response || {};
        const startedAt = session.requests.get(params.requestId);
        push({
          type: 'http-response',
          at,
          requestId: params.requestId || null,
          url: redactUrl(response.url),
          status: Number.isFinite(response.status) ? response.status : null,
          mimeType: response.mimeType || null,
          protocol: response.protocol || null,
          headers: redactHeaders(response.headers),
          latencyMs: startedAt == null ? null : Math.max(0, at - startedAt),
        });
      } else if (method === 'Network.loadingFailed') {
        push({
          type: 'http-failed',
          at,
          requestId: params.requestId || null,
          errorText: params.errorText || null,
          canceled: !!params.canceled,
        });
      } else if (method === 'Network.webSocketCreated') {
        push({
          type: 'websocket-created',
          at,
          requestId: params.requestId || null,
          url: redactUrl(params.url),
        });
      } else if (method === 'Network.webSocketHandshakeResponseReceived') {
        const response = params.response || {};
        push({
          type: 'websocket-handshake',
          at,
          requestId: params.requestId || null,
          status: Number.isFinite(response.status) ? response.status : null,
          headers: redactHeaders(response.headers),
        });
      } else if (method === 'Network.webSocketClosed') {
        push({
          type: 'websocket-closed',
          at,
          requestId: params.requestId || null,
        });
      } else if (method === 'Network.webSocketFrameError') {
        push({
          type: 'websocket-error',
          at,
          requestId: params.requestId || null,
          errorMessage: params.errorMessage || null,
        });
      }
    };
    debuggerApi.on('message', session.onMessage);
    sessions.set(client.alias, session);
    return {
      alias: client.alias,
      previewWindowId: client.previewWindowId,
      maxEvents: boundedMaxEvents,
      startedAt: session.startedAt,
    };
  };

  const status = ({ alias } = {}) => {
    const normalized = multiplayerPreviewService.resolveAlias(alias).alias;
    const session = sessions.get(normalized);
    return session
      ? {
          alias: normalized,
          active: true,
          previewWindowId: session.previewWindowId,
          eventCount: session.events.length,
          droppedEvents: session.droppedEvents,
          maxEvents: session.maxEvents,
        }
      : { alias: normalized, active: false, eventCount: 0, droppedEvents: 0 };
  };

  const read = ({ alias, limit = 100, clear = false } = {}) => {
    const normalized = multiplayerPreviewService.resolveAlias(alias).alias;
    const session = sessions.get(normalized);
    if (!session) throw makeError('network_capture_not_active');
    const boundedLimit = Math.min(
      Math.max(Number(limit) || 100, 1),
      session.maxEvents
    );
    const events = session.events.slice(-boundedLimit);
    if (clear) session.events.length = 0;
    return {
      alias: normalized,
      previewWindowId: session.previewWindowId,
      events,
      droppedEvents: session.droppedEvents,
      active: true,
    };
  };

  const stop = ({ alias } = {}) => {
    const normalized = multiplayerPreviewService.resolveAlias(alias).alias;
    const session = sessions.get(normalized);
    if (!session) throw makeError('network_capture_not_active');
    const result = {
      alias: normalized,
      previewWindowId: session.previewWindowId,
      events: session.events.slice(),
      droppedEvents: session.droppedEvents,
      active: false,
    };
    stopSession(session);
    return result;
  };

  const dispose = () => {
    for (const session of Array.from(sessions.values())) stopSession(session);
  };

  return { capabilities, start, status, read, stop, dispose };
};

module.exports = {
  DEFAULT_MAX_EVENTS,
  MAX_EVENTS_LIMIT,
  redactUrl,
  redactHeaders,
  createPreviewNetworkDiagnosticsService,
};
