const test = require('node:test');
const assert = require('node:assert/strict');
const {
  Client,
  StreamableHTTPClientTransport,
} = require('@modelcontextprotocol/client');
const { startMcpHttpServer } = require('./McpHttpServer');

const descriptor = {
  name: 'project.status',
  description: 'Read the current project status.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {},
  },
  outputSchema: { type: 'object', additionalProperties: true },
  metadata: {
    readOnly: true,
    destructive: false,
    idempotent: true,
    longRunning: false,
    requiresProject: false,
    modifiesProject: false,
  },
};

test('official MCP 2025 client uses the same stateless HTTP boundary for read-only tools', async () => {
  const calls = [];
  const rendererBridge = {
    executeCommand: async options => {
      calls.push(options);
      if (options.command === 'agent.commands.list') {
        return {
          command: options.command,
          data: { commands: [descriptor] },
          meta: { readOnly: true, modifiesProject: false },
        };
      }
      if (options.command === 'project.status') {
        return {
          command: options.command,
          data: {
            projectOpen: true,
            projectName: 'Legacy Compatibility',
            projectRevision: 3,
          },
          meta: {
            readOnly: true,
            modifiesProject: false,
            projectRevision: 3,
          },
        };
      }
      throw new Error(`unexpected_command:${options.command}`);
    },
  };
  const token = 'legacy-stateless-token';
  const host = await startMcpHttpServer({ rendererBridge, token, port: 0 });
  const client = new Client({ name: 'legacy-client', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(host.url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });

  try {
    await client.connect(transport);
    assert.equal(client.getProtocolEra(), 'legacy');
    assert.equal(client.getNegotiatedProtocolVersion(), '2025-11-25');

    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map(tool => tool.name), ['project.status']);

    const result = await client.callTool({
      name: 'project.status',
      arguments: {},
    });
    assert.equal(result.structuredContent.command, 'project.status');
    assert.equal(result.structuredContent.data.projectRevision, 3);
    assert.equal(
      calls.some(call => call.request || call.type),
      false,
      'legacy compatibility still dispatches through AgentIntegration commands only'
    );
  } finally {
    await client.close();
    await host.stop();
  }
});
