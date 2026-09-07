const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createLongRunningOperationRegistry,
  getProgressToken,
  sendProgress,
} = require('./McpLongRunning');

test('tracks bounded long-running operation state without storing tool input', () => {
  let now = 100;
  let nextId = 0;
  const registry = createLongRunningOperationRegistry({
    maxEntries: 2,
    now: () => now,
    makeOperationId: () => `operation-${++nextId}`,
  });

  const first = registry.start({
    command: 'validation.run',
    traceId: 'trace-1',
  });
  now = 110;
  registry.complete(first, { ok: true });
  const second = registry.start({
    command: 'export.html5',
    traceId: 'trace-2',
  });
  now = 120;
  registry.complete(second, { ok: false, errorCode: 'export_failed' });
  const third = registry.start({
    command: 'runtime.gameplay-test',
    traceId: 'trace-3',
  });

  const snapshot = registry.snapshot();
  assert.equal(snapshot.operations.length, 2);
  assert.deepEqual(
    snapshot.operations.map(operation => operation.operationId),
    [third, second]
  );
  assert.equal(snapshot.operations[0].status, 'running');
  assert.equal(snapshot.operations[1].status, 'failed');
  assert.equal(snapshot.operations[1].errorCode, 'export_failed');
  assert.equal(JSON.stringify(snapshot).includes('arguments'), false);
  assert.equal(JSON.stringify(snapshot).includes('input'), false);
});

test('sends progress only when the MCP request carries a progress token', async () => {
  const notifications = [];
  const requestContext = {
    mcpReq: {
      _meta: { progressToken: 'progress-1' },
      notify: async notification => notifications.push(notification),
    },
  };

  assert.equal(getProgressToken(requestContext), 'progress-1');
  assert.equal(
    await sendProgress({
      requestContext,
      progress: 0.5,
      total: 1,
      message: 'halfway',
    }),
    true
  );
  assert.deepEqual(notifications, [
    {
      method: 'notifications/progress',
      params: {
        progressToken: 'progress-1',
        progress: 0.5,
        total: 1,
        message: 'halfway',
      },
    },
  ]);

  assert.equal(await sendProgress({ requestContext: {}, progress: 1 }), false);
});
