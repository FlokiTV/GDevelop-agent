const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const Module = require('module');

// PreviewWindow is imported by AgentApi and normally runs inside Electron.
// Provide only the inert Electron surface needed while loading that module in
// this Node-only HTTP routing test.
const originalModuleLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: { isPackaged: true },
      BrowserWindow: function BrowserWindow() {},
      ipcMain: new EventEmitter(),
      shell: { openExternal: () => {} },
      screen: {
        getPrimaryDisplay: () => ({
          workAreaSize: { width: 1280, height: 720 },
        }),
      },
      protocol: {},
    };
  }
  return originalModuleLoad.call(this, request, parent, isMain);
};
const { startAgentApi, stopAgentApi } = require('./index');
Module._load = originalModuleLoad;

const waitForFetch = async (url, options) => {
  let lastError = null;
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      return await fetch(url, options);
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  throw lastError;
};

test('serves searchable function listing and per-function metadata routes', async () => {
  const previousPort = process.env.GDEVELOP_AGENT_API_PORT;
  const port = 38571;
  process.env.GDEVELOP_AGENT_API_PORT = String(port);
  const userData = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gdevelop-agent-api-test-')
  );
  const ipcMain = new EventEmitter();
  const rendererRequests = [];

  const webContents = {
    send: (channel, payload) => {
      if (channel !== 'gdevelop-agent-api:request') return;
      rendererRequests.push(payload.request);
      let result;
      if (payload.request.type === 'describe-function') {
        result = { function: { name: payload.request.name } };
      } else if (payload.request.type === 'diagnostics-project') {
        result = { summary: { ok: true, errors: 0, warnings: 0 } };
      } else if (payload.request.type === 'validation-report') {
        result = { ok: true, summary: { checksRun: 0, checksFailed: 0 } };
      } else {
        result = {
          functions: [],
          query: payload.request.query || null,
          executableOnly: !!payload.request.executableOnly,
        };
      }
      setImmediate(() => {
        ipcMain.emit(
          'gdevelop-agent-api:response',
          { sender: webContents },
          { requestId: payload.requestId, ok: true, result }
        );
      });
    },
    getURL: () => 'file:///editor/index.html',
    capturePage: async () => ({ toPNG: () => Buffer.from([]) }),
  };
  const editorWindow = {
    id: 1,
    webContents,
    isDestroyed: () => false,
    isVisible: () => true,
    isFocused: () => true,
    getTitle: () => 'GDevelop',
    getBounds: () => ({ x: 0, y: 0, width: 1280, height: 720 }),
  };
  const BrowserWindow = {
    fromWebContents: sender => (sender === webContents ? editorWindow : null),
    fromId: id => (Number(id) === editorWindow.id ? editorWindow : null),
    getFocusedWindow: () => editorWindow,
    getAllWindows: () => [editorWindow],
  };
  const app = {
    getPath: name => {
      assert.equal(name, 'userData');
      return userData;
    },
  };

  const config = startAgentApi({ app, ipcMain, BrowserWindow, log: null });
  ipcMain.emit(
    'gdevelop-agent-api:register',
    { sender: webContents },
    { active: true, fileIdentifier: null }
  );

  try {
    const headers = { 'X-GDevelop-Agent-Token': config.token };
    const base = `http://${config.host}:${config.port}`;
    const listResponse = await waitForFetch(
      `${base}/v1/functions?q=existing_instance_ids&executableOnly=true`,
      { headers }
    );
    assert.equal(listResponse.status, 200);
    const listBody = await listResponse.json();
    assert.equal(listBody.ok, true);
    assert.deepEqual(rendererRequests[0], {
      type: 'list-functions',
      query: 'existing_instance_ids',
      executableOnly: true,
    });

    const describeResponse = await fetch(
      `${base}/v1/functions/${encodeURIComponent('put_2d_instances')}`,
      { headers }
    );
    assert.equal(describeResponse.status, 200);
    const describeBody = await describeResponse.json();
    assert.equal(describeBody.result.function.name, 'put_2d_instances');
    assert.deepEqual(rendererRequests[1], {
      type: 'describe-function',
      name: 'put_2d_instances',
    });

    const diagnosticsResponse = await fetch(
      `${base}/v1/diagnostics?includeAssets=false&includeNativeReport=false`,
      { headers }
    );
    assert.equal(diagnosticsResponse.status, 200);
    const diagnosticsBody = await diagnosticsResponse.json();
    assert.equal(diagnosticsBody.result.summary.ok, true);
    assert.deepEqual(rendererRequests[2], {
      type: 'diagnostics-project',
      includeAssets: false,
      includeNativeReport: false,
    });

    const validateResponse = await fetch(`${base}/v1/validate`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ checkpointId: 'cp-1' }),
    });
    assert.equal(validateResponse.status, 200);
    const validateBody = await validateResponse.json();
    assert.equal(validateBody.result.ok, true);
    assert.deepEqual(rendererRequests[3], {
      checkpointId: 'cp-1',
      type: 'validation-report',
    });
  } finally {
    stopAgentApi();
    fs.rmSync(userData, { recursive: true, force: true });
    if (previousPort === undefined) delete process.env.GDEVELOP_AGENT_API_PORT;
    else process.env.GDEVELOP_AGENT_API_PORT = previousPort;
  }
});
