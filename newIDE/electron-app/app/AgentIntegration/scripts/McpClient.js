const fs = require('fs');
const path = require('path');
const {
  Client,
  StreamableHTTPClientTransport,
} = require('@modelcontextprotocol/client');

const DEFAULT_CLIENT_ID = 'gdevelop-external-client';

const getDefaultDiscoveryPath = env => {
  if (env.GDEVELOP_MCP_DISCOVERY) return env.GDEVELOP_MCP_DISCOVERY;
  if (!env.APPDATA) throw new Error('missing_appdata_for_mcp_discovery');
  return path.join(env.APPDATA, 'GDevelop 5', 'gdevelop-mcp.json');
};

const loadRuntimeConfig = discoveryPath => {
  const discovery = JSON.parse(fs.readFileSync(discoveryPath, 'utf8'));
  if (!discovery || discovery.service !== 'gdevelop-mcp') {
    throw new Error('invalid_gdevelop_mcp_discovery');
  }
  if (!discovery.endpoint || !discovery.protocolVersion) {
    throw new Error('incomplete_gdevelop_mcp_discovery');
  }
  const tokenFile = discovery.auth && discovery.auth.tokenFile;
  if (!tokenFile || typeof tokenFile !== 'string') {
    throw new Error('missing_gdevelop_mcp_token_file');
  }
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  if (!token) throw new Error('empty_gdevelop_mcp_token');
  return {
    endpoint: discovery.endpoint,
    protocolVersion: discovery.protocolVersion,
    token,
  };
};

const sanitizeForReplay = value => {
  if (Array.isArray(value)) return value.map(sanitizeForReplay);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !/authorization|bearer|token/i.test(key))
      .map(([key, child]) => [key, sanitizeForReplay(child)])
  );
};

const makeRequestHeaders = ({ token, clientId, windowId, projectPath }) => ({
  Authorization: `Bearer ${token}`,
  'X-GDevelop-Client-Id': clientId || DEFAULT_CLIENT_ID,
  ...(windowId ? { 'X-GDevelop-Window-Id': String(windowId) } : {}),
  ...(projectPath ? { 'X-GDevelop-Project-Path': projectPath } : {}),
});

const getToolData = response =>
  response && response.structuredContent
    ? response.structuredContent.data != null
      ? response.structuredContent.data
      : response.structuredContent
    : null;

const getToolMeta = response =>
  response &&
  response.structuredContent &&
  response.structuredContent.meta &&
  typeof response.structuredContent.meta === 'object'
    ? response.structuredContent.meta
    : null;

const connectLiveGDevelopMcp = async ({
  discoveryPath,
  windowId,
  projectPath,
  clientId = DEFAULT_CLIENT_ID,
  clientVersion = '1.0.0',
  env = process.env,
} = {}) => {
  const resolvedDiscoveryPath = discoveryPath || getDefaultDiscoveryPath(env);
  const runtime = loadRuntimeConfig(resolvedDiscoveryPath);
  const client = new Client(
    { name: clientId, version: clientVersion },
    { versionNegotiation: { mode: { pin: runtime.protocolVersion } } }
  );
  const transport = new StreamableHTTPClientTransport(
    new URL(runtime.endpoint),
    {
      requestInit: {
        headers: makeRequestHeaders({
          token: runtime.token,
          clientId,
          windowId,
          projectPath,
        }),
      },
    }
  );

  let closed = false;
  try {
    await client.connect(transport);
  } catch (error) {
    try {
      await client.close();
    } catch (_) {}
    throw error;
  }

  return Object.freeze({
    endpoint: runtime.endpoint,
    discoveryPath: resolvedDiscoveryPath,
    protocolVersion: client.getNegotiatedProtocolVersion(),
    target: Object.freeze({
      ...(windowId ? { windowId: String(windowId) } : {}),
      ...(projectPath ? { projectPath } : {}),
    }),
    async listTools() {
      const response = await client.listTools();
      return Array.isArray(response.tools) ? response.tools : [];
    },
    async listPrompts() {
      const response = await client.listPrompts();
      return Array.isArray(response.prompts) ? response.prompts : [];
    },
    async getPrompt(name, args = {}) {
      if (!name || typeof name !== 'string') {
        throw new Error('missing_mcp_prompt_name');
      }
      if (!args || typeof args !== 'object' || Array.isArray(args)) {
        throw new Error('invalid_mcp_prompt_arguments');
      }
      return client.getPrompt({ name, arguments: args });
    },
    async listResources() {
      const response = await client.listResources();
      return Array.isArray(response.resources) ? response.resources : [];
    },
    async readResource(uri) {
      if (!uri || typeof uri !== 'string') {
        throw new Error('missing_mcp_resource_uri');
      }
      return client.readResource({ uri });
    },
    async call(name, args = {}, requestOptions = {}) {
      if (!name || typeof name !== 'string') {
        throw new Error('missing_mcp_tool_name');
      }
      if (!args || typeof args !== 'object' || Array.isArray(args)) {
        throw new Error('invalid_mcp_tool_arguments');
      }
      if (
        !requestOptions ||
        typeof requestOptions !== 'object' ||
        Array.isArray(requestOptions)
      ) {
        throw new Error('invalid_mcp_request_options');
      }
      const response = await client.callTool(
        {
          name,
          arguments: args,
        },
        requestOptions
      );
      return {
        name,
        isError: !!response.isError,
        data: getToolData(response),
        meta: getToolMeta(response),
        structuredContent: response.structuredContent || null,
        content: Array.isArray(response.content) ? response.content : [],
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      await client.close();
    },
  });
};

module.exports = {
  DEFAULT_CLIENT_ID,
  connectLiveGDevelopMcp,
  getDefaultDiscoveryPath,
  getToolData,
  getToolMeta,
  loadRuntimeConfig,
  makeRequestHeaders,
  sanitizeForReplay,
};
