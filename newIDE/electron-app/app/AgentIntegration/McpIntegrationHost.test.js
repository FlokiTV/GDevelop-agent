const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMcpIntegrationHost } = require('./McpIntegrationHost');

const makeTempUserData = () =>
  fs.mkdtempSync(path.join(os.tmpdir(), 'gdevelop-mcp-host-'));

const makeApp = userDataPath => ({
  getPath: name => {
    assert.equal(name, 'userData');
    return userDataPath;
  },
});

test('starts MCP once, publishes discovery and disposes server credentials', async () => {
  const userDataPath = makeTempUserData();
  const starts = [];
  let stopCalls = 0;
  const startServer = async options => {
    starts.push(options);
    return {
      host: options.host,
      port: 45678,
      path: '/mcp',
      url: `http://${options.host}:45678/mcp`,
      protocolVersion: '2026-07-28',
      stop: async () => {
        stopCalls += 1;
      },
    };
  };
  const host = createMcpIntegrationHost({
    app: makeApp(userDataPath),
    rendererBridge: { executeCommand: async () => ({}) },
    startServer,
  });

  try {
    const first = await host.start();
    const second = await host.start();

    assert.equal(starts.length, 1);
    assert.equal(first, second);
    assert.equal(first.url, 'http://127.0.0.1:45678/mcp');
    assert.equal(first.discovery.endpoint, first.url);
    assert.equal(host.serverInfo, first);
    assert.equal(typeof starts[0].token, 'string');
    assert.ok(starts[0].token.length >= 32);

    const discoveryText = fs.readFileSync(host.runtimeConfig.discoveryPath, 'utf8');
    assert.equal(discoveryText.includes(starts[0].token), false);
    assert.equal(
      fs.readFileSync(host.runtimeConfig.tokenPath, 'utf8').trim(),
      starts[0].token
    );

    await host.dispose();
    await host.dispose();
    assert.equal(stopCalls, 1);
    assert.equal(fs.existsSync(host.runtimeConfig.discoveryPath), false);
    assert.equal(fs.existsSync(host.runtimeConfig.tokenPath), false);
    await assert.rejects(host.start(), /mcp_integration_host_disposed/);
  } finally {
    await host.dispose();
    fs.rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('cleans discovery files when MCP startup fails', async () => {
  const userDataPath = makeTempUserData();
  const host = createMcpIntegrationHost({
    app: makeApp(userDataPath),
    rendererBridge: {},
    startServer: async () => {
      throw new Error('listen_failed');
    },
  });

  try {
    await assert.rejects(host.start(), /listen_failed/);
    assert.equal(fs.existsSync(host.runtimeConfig.discoveryPath), false);
    assert.equal(fs.existsSync(host.runtimeConfig.tokenPath), false);
  } finally {
    await host.dispose();
    fs.rmSync(userDataPath, { recursive: true, force: true });
  }
});
