const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const {
  COMMAND_REQUEST_CHANNEL,
  COMMAND_RESPONSE_CHANNEL,
  createRendererBridge,
  normalizeTimeoutMs,
} = require('./RendererBridge');

const makeFixture = () => {
  const ipcMain = new EventEmitter();
  const windows = new Map();
  const BrowserWindow = {
    fromWebContents: sender =>
      Array.from(windows.values()).find(window => window.webContents === sender) ||
      null,
  };
  const sent = [];
  const targetWindow = {
    id: 1,
    webContents: {
      send: (channel, payload) => sent.push({ channel, payload }),
    },
  };
  const spoofWindow = { id: 2, webContents: {} };
  windows.set(1, targetWindow);
  windows.set(2, spoofWindow);
  const windowRegistry = {
    select: () => targetWindow,
  };
  let nextId = 0;
  const bridge = createRendererBridge({
    BrowserWindow,
    ipcMain,
    windowRegistry,
    makeRequestId: () => `request-${++nextId}`,
  });
  return { ipcMain, sent, targetWindow, spoofWindow, bridge };
};

test('executes commands only over AgentIntegration channels', async () => {
  const fixture = makeFixture();
  const promise = fixture.bridge.executeCommand({
    command: 'project.status',
    input: {},
    traceId: 'trace-1',
  });
  assert.deepEqual(fixture.sent[0], {
    channel: COMMAND_REQUEST_CHANNEL,
    payload: {
      requestId: 'request-1',
      command: 'project.status',
      input: {},
      traceId: 'trace-1',
    },
  });
  fixture.ipcMain.emit(
    COMMAND_RESPONSE_CHANNEL,
    { sender: fixture.targetWindow.webContents },
    { requestId: 'request-1', ok: true, result: { command: 'project.status' } }
  );
  assert.deepEqual(await promise, { command: 'project.status' });
  fixture.bridge.dispose();
});

test('ignores spoofed responses from another BrowserWindow', async () => {
  const fixture = makeFixture();
  const promise = fixture.bridge.executeCommand({ command: 'project.status' });
  fixture.ipcMain.emit(
    COMMAND_RESPONSE_CHANNEL,
    { sender: fixture.spoofWindow.webContents },
    { requestId: 'request-1', ok: true, result: { spoofed: true } }
  );
  assert.equal(fixture.bridge.pendingCount, 1);
  fixture.ipcMain.emit(
    COMMAND_RESPONSE_CHANNEL,
    { sender: fixture.targetWindow.webContents },
    { requestId: 'request-1', ok: true, result: { spoofed: false } }
  );
  assert.deepEqual(await promise, { spoofed: false });
  fixture.bridge.dispose();
});

test('maps structured command errors without losing recovery metadata', async () => {
  const fixture = makeFixture();
  const promise = fixture.bridge.executeCommand({ command: 'events.apply' });
  fixture.ipcMain.emit(
    COMMAND_RESPONSE_CHANNEL,
    { sender: fixture.targetWindow.webContents },
    {
      requestId: 'request-1',
      ok: false,
      error: {
        code: 'revision_conflict',
        message: 'stale revision',
        retryable: true,
        hint: 'read again',
        currentRevision: 9,
        traceId: 'trace-9',
        details: { expected: 8 },
      },
    }
  );
  await assert.rejects(promise, error => {
    assert.equal(error.code, 'revision_conflict');
    assert.equal(error.retryable, true);
    assert.equal(error.hint, 'read again');
    assert.equal(error.currentRevision, 9);
    assert.equal(error.traceId, 'trace-9');
    assert.deepEqual(error.details, { expected: 8 });
    return true;
  });
  fixture.bridge.dispose();
});

test('rejects pending requests and removes command listener on dispose', async () => {
  const fixture = makeFixture();
  const promise = fixture.bridge.executeCommand({ command: 'project.status' });
  fixture.bridge.dispose();
  await assert.rejects(promise, error => error.code === 'renderer_bridge_stopped');
  assert.equal(fixture.ipcMain.listenerCount(COMMAND_RESPONSE_CHANNEL), 0);
  assert.equal(fixture.bridge.pendingCount, 0);
});

test('normalizes timeout values and enforces the ten minute ceiling', () => {
  assert.equal(normalizeTimeoutMs(), 30000);
  assert.equal(normalizeTimeoutMs(5000), 5000);
  assert.equal(normalizeTimeoutMs(60 * 60 * 1000), 10 * 60 * 1000);
});
