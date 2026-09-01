const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  DISCOVERY_FILENAME,
  TOKEN_FILENAME,
  createMcpRuntimeConfig,
  publishMcpDiscovery,
  removeMcpDiscovery,
  resolveConfiguredPort,
} = require('./McpDiscovery');

const makeTempUserData = () =>
  fs.mkdtempSync(path.join(os.tmpdir(), 'gdevelop-mcp-discovery-'));

const makeApp = userDataPath => ({
  getPath: name => {
    assert.equal(name, 'userData');
    return userDataPath;
  },
});

test('publishes MCP discovery without embedding the bearer token', () => {
  const userDataPath = makeTempUserData();
  const runtimeConfig = createMcpRuntimeConfig(makeApp(userDataPath));
  const serverInfo = {
    host: '127.0.0.1',
    port: 45678,
    path: '/mcp',
    url: 'http://127.0.0.1:45678/mcp',
    protocolVersion: '2026-07-28',
  };

  try {
    const discovery = publishMcpDiscovery({ runtimeConfig, serverInfo });
    const discoveryText = fs.readFileSync(
      path.join(userDataPath, DISCOVERY_FILENAME),
      'utf8'
    );
    const tokenText = fs.readFileSync(
      path.join(userDataPath, TOKEN_FILENAME),
      'utf8'
    );

    assert.equal(discovery.service, 'gdevelop-mcp');
    assert.equal(discovery.transport, 'streamable-http');
    assert.equal(discovery.endpoint, serverInfo.url);
    assert.equal(discovery.protocolVersion, '2026-07-28');
    assert.equal(discovery.auth.type, 'bearer');
    assert.equal(discovery.auth.tokenFile, runtimeConfig.tokenPath);
    assert.equal(discoveryText.includes(runtimeConfig.token), false);
    assert.equal(tokenText.trim(), runtimeConfig.token);
  } finally {
    removeMcpDiscovery(runtimeConfig);
    fs.rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('removes both MCP discovery files and honors an explicit port override', () => {
  const previousPort = process.env.GDEVELOP_MCP_PORT;
  process.env.GDEVELOP_MCP_PORT = '41234';
  const userDataPath = makeTempUserData();
  const runtimeConfig = createMcpRuntimeConfig(makeApp(userDataPath));

  try {
    assert.equal(resolveConfiguredPort(), 41234);
    assert.equal(runtimeConfig.port, 41234);
    publishMcpDiscovery({
      runtimeConfig,
      serverInfo: {
        host: '127.0.0.1',
        port: 41234,
        path: '/mcp',
        url: 'http://127.0.0.1:41234/mcp',
        protocolVersion: '2026-07-28',
      },
    });
    removeMcpDiscovery(runtimeConfig);
    assert.equal(fs.existsSync(runtimeConfig.discoveryPath), false);
    assert.equal(fs.existsSync(runtimeConfig.tokenPath), false);
  } finally {
    if (previousPort === undefined) delete process.env.GDEVELOP_MCP_PORT;
    else process.env.GDEVELOP_MCP_PORT = previousPort;
    fs.rmSync(userDataPath, { recursive: true, force: true });
  }
});
