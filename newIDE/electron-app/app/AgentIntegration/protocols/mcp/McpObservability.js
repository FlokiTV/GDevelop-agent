const crypto = require('crypto');

const TRACEPARENT_PATTERN = /^[0-9a-f]{2}-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;
const MAX_TRACESTATE_LENGTH = 512;
const MAX_BAGGAGE_LENGTH = 4096;

const readHeader = (requestInfo, name) => {
  const headers = requestInfo && requestInfo.headers;
  if (!headers || typeof headers.get !== 'function') return null;
  const value = headers.get(name);
  return typeof value === 'string' && value ? value : null;
};

const sanitizeTraceHeader = (value, maxLength) => {
  if (typeof value !== 'string' || !value || value.length > maxLength) {
    return null;
  }
  if (value.includes('\r') || value.includes('\n')) return null;
  return value;
};

const parseTraceparent = value => {
  const normalized = sanitizeTraceHeader(value, 128);
  if (!normalized) return null;
  const match = TRACEPARENT_PATTERN.exec(normalized);
  if (!match || normalized.toLowerCase().startsWith('ff-')) return null;
  if (/^0{32}$/i.test(match[1]) || /^0{16}$/i.test(match[2])) return null;
  return {
    traceparent: normalized,
    traceId: match[1].toLowerCase(),
  };
};

const getTraceContextFromRequest = (
  requestInfo,
  makeTraceId = crypto.randomUUID
) => {
  const parsedTraceparent = parseTraceparent(
    readHeader(requestInfo, 'traceparent')
  );
  const tracestate = sanitizeTraceHeader(
    readHeader(requestInfo, 'tracestate'),
    MAX_TRACESTATE_LENGTH
  );
  const baggage = sanitizeTraceHeader(
    readHeader(requestInfo, 'baggage'),
    MAX_BAGGAGE_LENGTH
  );
  return {
    traceId: parsedTraceparent ? parsedTraceparent.traceId : makeTraceId(),
    traceparent: parsedTraceparent ? parsedTraceparent.traceparent : null,
    tracestate,
    baggage,
  };
};

const createMcpMetrics = ({ now = Date.now } = {}) => {
  const startedAt = now();
  const commands = new Map();
  let calls = 0;
  let failures = 0;
  let idempotencyReplays = 0;
  let totalDurationMs = 0;
  let maxDurationMs = 0;

  const record = ({ command, ok, durationMs, idempotencyReplayed = false }) => {
    const safeDurationMs = Number.isFinite(durationMs)
      ? Math.max(0, durationMs)
      : 0;
    calls++;
    if (!ok) failures++;
    if (idempotencyReplayed) idempotencyReplays++;
    totalDurationMs += safeDurationMs;
    maxDurationMs = Math.max(maxDurationMs, safeDurationMs);

    const key = typeof command === 'string' && command ? command : 'unknown';
    const entry = commands.get(key) || {
      calls: 0,
      failures: 0,
      idempotencyReplays: 0,
      totalDurationMs: 0,
      maxDurationMs: 0,
    };
    entry.calls++;
    if (!ok) entry.failures++;
    if (idempotencyReplayed) entry.idempotencyReplays++;
    entry.totalDurationMs += safeDurationMs;
    entry.maxDurationMs = Math.max(entry.maxDurationMs, safeDurationMs);
    commands.set(key, entry);
  };

  const summarizeEntry = entry => ({
    calls: entry.calls,
    failures: entry.failures,
    idempotencyReplays: entry.idempotencyReplays,
    averageDurationMs:
      entry.calls > 0
        ? Math.round((entry.totalDurationMs / entry.calls) * 100) / 100
        : 0,
    maxDurationMs: entry.maxDurationMs,
  });

  const snapshot = () => ({
    startedAt,
    uptimeMs: Math.max(0, now() - startedAt),
    totals: summarizeEntry({
      calls,
      failures,
      idempotencyReplays,
      totalDurationMs,
      maxDurationMs,
    }),
    commands: Object.fromEntries(
      Array.from(commands.entries())
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, entry]) => [name, summarizeEntry(entry)])
    ),
  });

  return { record, snapshot };
};

const makeToolResultMeta = ({
  traceContext,
  durationMs,
  timeoutMs,
  result,
}) => ({
  'gdevelop/traceId': traceContext.traceId,
  ...(traceContext.traceparent
    ? { 'gdevelop/traceparent': traceContext.traceparent }
    : {}),
  ...(traceContext.tracestate
    ? { 'gdevelop/tracestate': traceContext.tracestate }
    : {}),
  // Baggage may contain application data. It is propagated internally but is
  // intentionally not echoed into result metadata or debug resources.
  'gdevelop/durationMs': Math.max(0, durationMs),
  ...(Number.isFinite(timeoutMs) ? { 'gdevelop/timeoutMs': timeoutMs } : {}),
  ...(result && result.meta && Number.isFinite(result.meta.durationMs)
    ? { 'gdevelop/rendererDurationMs': result.meta.durationMs }
    : {}),
  ...(result && result.meta && result.meta.idempotencyReplayed
    ? { 'gdevelop/idempotencyReplayed': true }
    : {}),
});

const serializeMcpToolError = (error, fallbackTraceId = null) => {
  const value = error && typeof error === 'object' ? error : {};
  const code =
    typeof value.code === 'string' && value.code
      ? value.code
      : 'agent_internal_error';
  const message =
    typeof value.message === 'string' && value.message ? value.message : code;
  return {
    code,
    message,
    retryable: !!value.retryable,
    ...(typeof value.hint === 'string' && value.hint
      ? { hint: value.hint }
      : {}),
    ...(typeof value.recovery === 'string' && value.recovery
      ? { recovery: value.recovery }
      : {}),
    ...(value.currentRevision !== undefined
      ? { currentRevision: value.currentRevision }
      : {}),
    ...(value.details !== undefined ? { details: value.details } : {}),
    traceId:
      typeof value.traceId === 'string' && value.traceId
        ? value.traceId
        : fallbackTraceId,
  };
};

const makeToolErrorResult = ({
  error,
  traceContext,
  durationMs,
  timeoutMs,
}) => {
  const serializedError = serializeMcpToolError(
    error,
    traceContext && traceContext.traceId
  );
  return {
    content: [{ type: 'text', text: JSON.stringify(serializedError) }],
    structuredContent: { error: serializedError },
    isError: true,
    _meta: {
      ...makeToolResultMeta({
        traceContext,
        durationMs,
        timeoutMs,
        result: null,
      }),
      'gdevelop/errorCode': serializedError.code,
      'gdevelop/retryable': serializedError.retryable,
    },
  };
};

const registerMcpDebugResource = ({
  server,
  metrics,
  protocolVersion,
  targeting,
}) => {
  server.registerResource(
    'gdevelop-mcp-debug',
    'gdevelop://mcp/debug',
    {
      title: 'GDevelop MCP debug status',
      description:
        'Sanitized local MCP metrics and targeting state. Contains no bearer token, command inputs, binary payloads or project path.',
      mimeType: 'application/json',
      _meta: {
        'gdevelop/cacheScope': 'request',
        'gdevelop/live': true,
      },
    },
    async () => ({
      contents: [
        {
          uri: 'gdevelop://mcp/debug',
          mimeType: 'application/json',
          text: JSON.stringify({
            protocolVersion,
            targeting: {
              windowTargeted: !!(targeting && targeting.windowId),
              projectTargeted: !!(targeting && targeting.projectPath),
            },
            metrics: metrics.snapshot(),
          }),
        },
      ],
    })
  );
};

module.exports = {
  TRACEPARENT_PATTERN,
  parseTraceparent,
  getTraceContextFromRequest,
  createMcpMetrics,
  makeToolResultMeta,
  serializeMcpToolError,
  makeToolErrorResult,
  registerMcpDebugResource,
};
