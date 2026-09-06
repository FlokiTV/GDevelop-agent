const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseTraceparent,
  getTraceContextFromRequest,
  createMcpMetrics,
  makeToolResultMeta,
  serializeMcpToolError,
  makeToolErrorResult,
} = require('./McpObservability');

const makeRequestInfo = headers => ({
  headers: {
    get: name => headers[String(name).toLowerCase()] || null,
  },
});

test('parses valid W3C traceparent and rejects invalid identifiers', () => {
  const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
  assert.deepEqual(parseTraceparent(traceparent), {
    traceparent,
    traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
  });
  assert.equal(
    parseTraceparent('00-00000000000000000000000000000000-00f067aa0ba902b7-01'),
    null
  );
  assert.equal(parseTraceparent('not-a-traceparent'), null);
});

test('extracts bounded trace context without exposing baggage in result metadata', () => {
  const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
  const traceContext = getTraceContextFromRequest(
    makeRequestInfo({
      traceparent,
      tracestate: 'vendor=value',
      baggage: 'private-key=private-value',
    }),
    () => 'fallback-trace'
  );
  assert.deepEqual(traceContext, {
    traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
    traceparent,
    tracestate: 'vendor=value',
    baggage: 'private-key=private-value',
  });

  const meta = makeToolResultMeta({
    traceContext,
    durationMs: 25,
    timeoutMs: 90000,
    result: {
      meta: { durationMs: 20, idempotencyReplayed: true },
    },
  });
  assert.deepEqual(meta, {
    'gdevelop/traceId': '4bf92f3577b34da6a3ce929d0e0e4736',
    'gdevelop/traceparent': traceparent,
    'gdevelop/tracestate': 'vendor=value',
    'gdevelop/durationMs': 25,
    'gdevelop/timeoutMs': 90000,
    'gdevelop/rendererDurationMs': 20,
    'gdevelop/idempotencyReplayed': true,
  });
  assert.equal(JSON.stringify(meta).includes('private-key'), false);
  assert.equal(JSON.stringify(meta).includes('private-value'), false);
});

test('generates fallback trace id and drops oversized or multiline trace headers', () => {
  const traceContext = getTraceContextFromRequest(
    makeRequestInfo({
      traceparent: 'invalid',
      tracestate: 'x'.repeat(513),
      baggage: 'safe=value\nunsafe=yes',
    }),
    () => 'generated-trace'
  );
  assert.deepEqual(traceContext, {
    traceId: 'generated-trace',
    traceparent: null,
    tracestate: null,
    baggage: null,
  });
});

test('preserves actionable tool errors without leaking stack or cause', () => {
  const cause = new Error('private stack');
  const error = new Error('stale revision');
  error.code = 'revision_conflict';
  error.retryable = true;
  error.hint = 'Read the project again.';
  error.recovery = 'Retry with the latest expectedRevision.';
  error.currentRevision = 9;
  error.details = { expectedRevision: 8 };
  error.cause = cause;

  assert.deepEqual(serializeMcpToolError(error, 'trace-fallback'), {
    code: 'revision_conflict',
    message: 'stale revision',
    retryable: true,
    hint: 'Read the project again.',
    recovery: 'Retry with the latest expectedRevision.',
    currentRevision: 9,
    details: { expectedRevision: 8 },
    traceId: 'trace-fallback',
  });

  const result = makeToolErrorResult({
    error,
    traceContext: {
      traceId: 'trace-fallback',
      traceparent: null,
      tracestate: null,
      baggage: 'secret=value',
    },
    durationMs: 12,
    timeoutMs: 30000,
  });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, 'revision_conflict');
  assert.equal(result.structuredContent.error.recovery, error.recovery);
  assert.equal(result._meta['gdevelop/errorCode'], 'revision_conflict');
  assert.equal(result._meta['gdevelop/retryable'], true);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('private stack'), false);
  assert.equal(serialized.includes('secret=value'), false);
});

test('aggregates only command counts, failures, replay and latency', () => {
  let now = 1000;
  const metrics = createMcpMetrics({ now: () => now });
  metrics.record({ command: 'project.status', ok: true, durationMs: 10 });
  metrics.record({
    command: 'events.update',
    ok: true,
    durationMs: 30,
    idempotencyReplayed: true,
  });
  metrics.record({ command: 'events.update', ok: false, durationMs: 50 });
  now = 1100;

  assert.deepEqual(metrics.snapshot(), {
    startedAt: 1000,
    uptimeMs: 100,
    totals: {
      calls: 3,
      failures: 1,
      idempotencyReplays: 1,
      averageDurationMs: 30,
      maxDurationMs: 50,
    },
    commands: {
      'events.update': {
        calls: 2,
        failures: 1,
        idempotencyReplays: 1,
        averageDurationMs: 40,
        maxDurationMs: 50,
      },
      'project.status': {
        calls: 1,
        failures: 0,
        idempotencyReplays: 0,
        averageDurationMs: 10,
        maxDurationMs: 10,
      },
    },
  });
  const serialized = JSON.stringify(metrics.snapshot());
  assert.equal(serialized.includes('input'), false);
  assert.equal(serialized.includes('token'), false);
});
