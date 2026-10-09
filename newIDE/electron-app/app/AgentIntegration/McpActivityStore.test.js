const test = require('node:test');
const assert = require('node:assert/strict');
const { createMcpActivityStore } = require('./McpActivityStore');
const { observeMcpMetrics } = require('./McpMetricsActivityObserver');
const { CHANNEL, registerMcpActivityIpc } = require('./McpActivityIpc');

test('offline, recent activity TTL and active command counters are explicit', () => {
  let time = 100000;
  const activity = createMcpActivityStore({
    now: () => time,
    recentAgentMs: 90,
  });
  assert.equal(activity.snapshot().serverOnline, false);
  activity.setServerOnline(true);
  const id = activity.start({
    command: 'scene.inspect',
    identity: { agentId: 'agent-1', clientId: 'client-1' },
  });
  assert.equal(activity.snapshot().activeCalls, 1);
  assert.equal(activity.snapshot().clients.length, 1);
  time += 25;
  activity.finish(id, { status: 'success' });
  assert.equal(activity.snapshot().activeCalls, 0);
  assert.equal(activity.snapshot().entries[0].durationMs, 25);
  time += 100;
  assert.equal(activity.snapshot().clients.length, 0);
  activity.setServerOnline(false);
  assert.equal(activity.snapshot().serverOnline, false);
});

test('bounded timeline excludes payloads, invalid identity and secrets', () => {
  let time = 5000;
  const activity = createMcpActivityStore({
    now: () => time++,
    historyLimit: 2,
  });
  activity.setServerOnline(true);
  for (let i = 0; i < 3; i++) {
    const id = activity.start({
      command: 'project.status',
      identity: { agentId: 'not safe: secret=bearer', clientId: 'client-2' },
      token: 'do-not-store',
      input: { password: 'do-not-store' },
    });
    activity.finish(id, { status: 'error', errorCode: 'oops secret' });
  }
  const snapshot = activity.snapshot();
  assert.equal(snapshot.entries.length, 2);
  assert.equal(snapshot.entries[0].agentId, 'anonymous');
  assert.equal(snapshot.entries[0].errorCode, 'unknown_error');
  assert.equal(JSON.stringify(snapshot).includes('do-not-store'), false);
  assert.equal(JSON.stringify(snapshot).includes('secret=bearer'), false);
});

test('metrics observer preserves aggregation and records only completed commands', () => {
  let now = 1000;
  const activity = createMcpActivityStore({ now: () => now });
  activity.setServerOnline(true);
  const calls = [];
  const metrics = {
    record: row => {
      calls.push(row);
    },
  };
  const original = metrics.record;
  const stop = observeMcpMetrics({ metrics, activity });
  now = 2000;
  metrics.record({ command: 'project.save', ok: true, durationMs: 123 });
  metrics.record({ command: 'events.patch', ok: false, durationMs: 30 });
  assert.equal(calls.length, 2);
  const snapshot = activity.snapshot();
  assert.equal(snapshot.entries[0].command, 'events.patch');
  assert.equal(snapshot.entries[0].agentId, 'mcp-client');
  assert.equal(snapshot.entries[0].clientId, 'unidentified');
  assert.equal(snapshot.entries[0].status, 'error');
  assert.equal(snapshot.entries[1].durationMs, 123);
  assert.equal(snapshot.entries[1].saved, false); // A successful response is not proof of save.
  assert.equal(snapshot.entries[1].startedAt, 1877);
  assert.equal(snapshot.activeCalls, 0);
  stop();
  assert.equal(metrics.record, original);
});

test('read-only IPC emits sanitized snapshots and removes handler', async () => {
  const handlers = new Map();
  const ipcMain = {
    handle: (name, callback) => handlers.set(name, callback),
    removeHandler: name => handlers.delete(name),
  };
  const activity = createMcpActivityStore();
  const stop = registerMcpActivityIpc({
    ipcMain,
    getSnapshot: () => activity.snapshot(),
  });
  assert.equal(typeof handlers.get(CHANNEL), 'function');
  assert.equal((await handlers.get(CHANNEL)()).serverOnline, false);
  stop();
  assert.equal(handlers.has(CHANNEL), false);
  const unavailable = registerMcpActivityIpc({
    ipcMain,
    getSnapshot: () => {
      throw Error('unavailable');
    },
  });
  assert.equal((await handlers.get(CHANNEL)()).serverOnline, false);
  unavailable();
});
