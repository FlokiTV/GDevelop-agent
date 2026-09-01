const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DEFAULT_HOST, DEFAULT_PORT } = require('./McpHttpServer');

const DISCOVERY_FILENAME = 'gdevelop-mcp.json';
const TOKEN_FILENAME = 'gdevelop-mcp-token';
const DISCOVERY_VERSION = 1;

const resolveConfiguredPort = () => {
  const portFromEnv = Number.parseInt(process.env.GDEVELOP_MCP_PORT || '', 10);
  return Number.isFinite(portFromEnv) && portFromEnv > 0
    ? portFromEnv
    : DEFAULT_PORT;
};

const createMcpRuntimeConfig = app => {
  const userDataPath = app.getPath('userData');
  return {
    host: DEFAULT_HOST,
    port: resolveConfiguredPort(),
    token: crypto.randomBytes(32).toString('hex'),
    discoveryPath: path.join(userDataPath, DISCOVERY_FILENAME),
    tokenPath: path.join(userDataPath, TOKEN_FILENAME),
  };
};

const writePrivateFile = (filePath, contents) => {
  fs.writeFileSync(filePath, contents, {
    encoding: 'utf8',
    mode: 0o600,
  });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch (error) {
    // Windows does not provide POSIX mode semantics. Keeping the files inside
    // Electron userData still avoids exposing credentials through the MCP
    // discovery payload or logs.
  }
};

const publishMcpDiscovery = ({ runtimeConfig, serverInfo }) => {
  writePrivateFile(runtimeConfig.tokenPath, `${runtimeConfig.token}\n`);
  const discovery = {
    service: 'gdevelop-mcp',
    version: DISCOVERY_VERSION,
    transport: 'streamable-http',
    endpoint: serverInfo.url,
    host: serverInfo.host,
    port: serverInfo.port,
    path: serverInfo.path,
    protocolVersion: serverInfo.protocolVersion,
    pid: process.pid,
    auth: {
      type: 'bearer',
      tokenFile: runtimeConfig.tokenPath,
    },
  };
  writePrivateFile(
    runtimeConfig.discoveryPath,
    `${JSON.stringify(discovery, null, 2)}\n`
  );
  return discovery;
};

const removeMcpDiscovery = runtimeConfig => {
  if (!runtimeConfig) return;
  [runtimeConfig.discoveryPath, runtimeConfig.tokenPath].forEach(filePath => {
    try {
      fs.unlinkSync(filePath);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
  });
};

module.exports = {
  DISCOVERY_FILENAME,
  TOKEN_FILENAME,
  DISCOVERY_VERSION,
  createMcpRuntimeConfig,
  publishMcpDiscovery,
  removeMcpDiscovery,
  resolveConfiguredPort,
};
