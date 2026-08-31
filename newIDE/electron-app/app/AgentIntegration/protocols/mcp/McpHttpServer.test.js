const test = require('node:test');
const assert = require('node:assert/strict');
const {
  Client,
  StreamableHTTPClientTransport,
} = require('@modelcontextprotocol/client');
const {
  PROTOCOL_VERSION,
} = require('./McpServerFactory');
const { startMcpHttpServer } = require('./McpHttpServer');

const makeDescriptor = (name, metadata = {}) => ({
  name,
  description: `Tool ${name}`,
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {},
  },
  metadata: {
    readOnly: true,
    destructive: false,
    idempotent: true,
    longRunning: false,
    requiresProject: false,
    modifiesProject: false,
    ...metadata,
  },
});

const makeBridge = () => {
  const calls = [];
  const descriptors = [
    makeDescriptor('project.status'),
    makeDescriptor('project.save', {
      readOnly: false,
      idempotent: false,
      requiresProject: true,
      modifiesProject: true,
      defaultTimeoutMs: 90000,
    }),
  ];
  return {
    calls,
    executeCommand: async options => {
      calls.push(options);
      if (options.command === 'agent.commands.list') {
        return {
          command: options.command,
          data: { commands: descriptors },
          meta: { traceId: null, readOnly: true, modifiesProject: false },
        };
      }
      if (options.command === 'project.status') {
        return {
          command: 'project.status',
          data: { projectOpen: true, projectName: 'MCP Test' },
          meta: {
            traceId: options.traceId || null,
            readOnly: true,
            modifiesProject: false,
          },
        };
      }
      if (options.command === 'project.save') {
        return {
          command: 'project.save',
          data: { saved: true },
          meta: {
            traceId: options.traceId || null,
            readOnly: false,
            modifiesProject: true,
          },
        };
      }
      throw new Error(`unexpected_command:${options.command}`);
    },
  };
};

const connectClient = async ({ url, token, windowId }) => {
  const client = new Client(
    { name: 'gdevelop-mcp-test', version: '1.0.0' },
    { versionNegotiation: { mode: { pin: PROTOCOL_VERSION } } }
  );
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${token}`,
        ...(windowId ? { 'X-GDevelop-Window-Id': String(windowId) } : {}),
      },
    },
  });
  try {
    await client.connect(transport);
    return client;
  } catch (error) {
    try {
      await client.close();
    } catch (closeError) {}
    throw error;
  }
};

test('official MCP client initializes, lists registry tools and calls them directly', async () => {
  const rendererBridge = makeBridge();
  const token = 'test-token';
  const host = await startMcpHttpServer({
    rendererBridge,
    token,
    port: 0,
  });
  const client = await connectClient({ url: host.url, token, windowId: 17 });

  try {
    assert.equal(client.getNegotiatedProtocolVersion(), PROTOCOL_VERSION);

    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map(tool => tool.name),
      ['project.save', 'project.status']
    );
    const saveTool = tools.tools.find(tool => tool.name === 'project.save');
    assert.equal(saveTool.annotations.readOnlyHint, false);
    assert.equal(saveTool.annotations.idempotentHint, false);
    assert.equal(saveTool._meta['gdevelop/defaultTimeoutMs'], 90000);

    const result = await client.callTool({
      name: 'project.status',
      arguments: {},
    });
    assert.equal(result.structuredContent.command, 'project.status');
    assert.equal(result.structuredContent.data.projectOpen, true);

    const directCalls = rendererBridge.calls.filter(
      call => call.command === 'project.status'
    );
    assert.equal(directCalls.length, 1);
    assert.equal(directCalls[0].windowId, '17');
    assert.equal(typeof directCalls[0].traceId, 'string');
    assert.ok(directCalls[0].traceId.length > 0);
    assert.equal(
      rendererBridge.calls.some(call => call.request || call.type),
      false,
      'MCP never dispatches a legacy REST request shape'
    );
  } finally {
    await client.close();
    await host.stop();
  }
});

test('rejects missing auth and non-local origins before MCP dispatch', async () => {
  const rendererBridge = makeBridge();
  const host = await startMcpHttpServer({
    rendererBridge,
    token: 'secret',
    port: 0,
  });
  try {
    const unauthorized = await fetch(host.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(unauthorized.status, 401);

    const badOrigin = await fetch(host.url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer secret',
        Origin: 'https://evil.example',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    assert.equal(badOrigin.status, 403);
    assert.equal(rendererBridge.calls.length, 0);
  } finally {
    await host.stop();
  }
});
