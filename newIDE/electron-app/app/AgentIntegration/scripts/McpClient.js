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

const makeRequestHeaders = ({
  token,
  clientId,
  agentId,
  sessionId,
  taskId,
  windowId,
  projectPath,
}) => ({
  Authorization: `Bearer ${token}`,
  'X-GDevelop-Client-Id': clientId || DEFAULT_CLIENT_ID,
  ...(agentId ? { 'X-GDevelop-Agent-Id': String(agentId) } : {}),
  ...(sessionId ? { 'X-GDevelop-Session-Id': String(sessionId) } : {}),
  ...(taskId ? { 'X-GDevelop-Task-Id': String(taskId) } : {}),
  ...(windowId ? { 'X-GDevelop-Window-Id': String(windowId) } : {}),
  ...(projectPath ? { 'X-GDevelop-Project-Path': projectPath } : {}),
});

const getToolEnvelope = response => {
  const envelope = response && response.structuredContent;
  if (
    !envelope ||
    typeof envelope !== 'object' ||
    envelope.contractVersion !== 1
  ) {
    return null;
  }
  if (
    typeof envelope.command === 'string' &&
    envelope.command &&
    Object.prototype.hasOwnProperty.call(envelope, 'data') &&
    envelope.meta &&
    typeof envelope.meta === 'object'
  ) {
    return envelope;
  }
  if (
    envelope.error &&
    typeof envelope.error === 'object' &&
    typeof envelope.error.code === 'string'
  ) {
    return envelope;
  }
  return null;
};

const requireToolEnvelope = response => {
  const envelope = getToolEnvelope(response);
  if (!envelope) {
    const error = new Error('invalid_gdevelop_mcp_response_envelope');
    error.code = 'invalid_gdevelop_mcp_response_envelope';
    throw error;
  }
  return envelope;
};

const getCanonicalToolData = response => {
  const envelope = requireToolEnvelope(response);
  return Object.prototype.hasOwnProperty.call(envelope, 'data')
    ? envelope.data
    : null;
};

const getToolData = response => {
  const envelope = getToolEnvelope(response);
  if (envelope && Object.prototype.hasOwnProperty.call(envelope, 'data')) {
    return envelope.data;
  }
  return response && response.structuredContent
    ? response.structuredContent.data != null
      ? response.structuredContent.data
      : response.structuredContent
    : null;
};

const getToolMeta = response => {
  const envelope = getToolEnvelope(response);
  if (envelope && envelope.meta && typeof envelope.meta === 'object') {
    return envelope.meta;
  }
  return response &&
    response.structuredContent &&
    response.structuredContent.meta &&
    typeof response.structuredContent.meta === 'object'
    ? response.structuredContent.meta
    : null;
};

const getToolError = response => {
  const envelope = getToolEnvelope(response);
  return envelope && envelope.error && typeof envelope.error === 'object'
    ? envelope.error
    : null;
};

const makeDestructiveConfirmationHandler = () => async request => {
  const params = request && request.params;
  const schema = params && params.requestedSchema;
  const confirmSchema =
    schema && schema.properties && schema.properties.confirm;
  if (!confirmSchema || confirmSchema.type !== 'boolean') {
    return { action: 'decline', content: {} };
  }
  return { action: 'accept', content: { confirm: true } };
};

const connectLiveGDevelopMcp = async ({
  discoveryPath,
  windowId,
  projectPath,
  clientId = DEFAULT_CLIENT_ID,
  agentId,
  sessionId,
  taskId,
  clientVersion = '1.0.0',
  confirmDestructiveOperations = false,
  env = process.env,
} = {}) => {
  const resolvedDiscoveryPath = discoveryPath || getDefaultDiscoveryPath(env);
  const runtime = loadRuntimeConfig(resolvedDiscoveryPath);
  const client = new Client(
    { name: clientId, version: clientVersion },
    {
      ...(confirmDestructiveOperations
        ? { capabilities: { elicitation: { form: {} } } }
        : {}),
      versionNegotiation: { mode: { pin: runtime.protocolVersion } },
    }
  );
  if (confirmDestructiveOperations) {
    client.setRequestHandler(
      'elicitation/create',
      makeDestructiveConfirmationHandler()
    );
  }
  const transport = new StreamableHTTPClientTransport(
    new URL(runtime.endpoint),
    {
      requestInit: {
        headers: makeRequestHeaders({
          token: runtime.token,
          clientId,
          agentId,
          sessionId,
          taskId,
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
    identity: Object.freeze({
      clientId,
      agentId: agentId || clientId,
      sessionId: sessionId || clientId,
      ...(taskId ? { taskId } : {}),
    }),
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
        envelope: getToolEnvelope(response),
        error: getToolError(response),
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
  getToolEnvelope,
  requireToolEnvelope,
  getCanonicalToolData,
  getToolData,
  getToolMeta,
  getToolError,
  makeDestructiveConfirmationHandler,
  loadRuntimeConfig,
  makeRequestHeaders,
  sanitizeForReplay,
};
