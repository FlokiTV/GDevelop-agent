const test = require('node:test');
const assert = require('node:assert/strict');
const {
  Client,
  StreamableHTTPClientTransport,
} = require('@modelcontextprotocol/client');
const { PROTOCOL_VERSION } = require('./McpServerFactory');
const { startMcpHttpServer } = require('./McpHttpServer');

const readMetadata = {
  readOnly: true,
  destructive: false,
  idempotent: true,
  longRunning: false,
  requiresProject: true,
  modifiesProject: false,
  cacheScope: 'project-revision',
  ttlMs: 30000,
};
const writeMetadata = {
  readOnly: false,
  destructive: false,
  idempotent: false,
  longRunning: false,
  requiresProject: true,
  modifiesProject: true,
};
const longWriteMetadata = {
  ...writeMetadata,
  destructive: true,
  longRunning: true,
  defaultTimeoutMs: 180000,
};

const descriptors = [
  {
    name: 'editor.functions.inspect-variables',
    description: "Execute EditorFunction 'inspect_variables' directly.",
    inputSchema: {
      type: 'object',
      additionalProperties: true,
      required: ['variable_scope'],
      properties: {
        variable_scope: { type: 'string' },
        scene_name: { type: 'string' },
      },
    },
    metadata: readMetadata,
  },
  {
    name: 'editor.functions.create-scene',
    description: "Execute EditorFunction 'create_scene' directly.",
    inputSchema: {
      type: 'object',
      additionalProperties: true,
      required: ['scene_name'],
      properties: {
        scene_name: { type: 'string' },
        include_ui_layer: { type: 'boolean' },
      },
    },
    metadata: writeMetadata,
  },
  {
    name: 'editor.functions.run-gameplay-test',
    description: "Execute EditorFunction 'run_gameplay_test' directly.",
    inputSchema: {
      type: 'object',
      additionalProperties: true,
      required: ['scope', 'test_name'],
      properties: {
        scope: { type: 'object' },
        test_name: { type: 'string' },
        persist: { type: 'boolean' },
      },
    },
    metadata: longWriteMetadata,
  },
  {
    name: 'editor.functions.call',
    description: 'Generic compatibility command.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: {
        name: { type: 'string' },
        arguments: { type: 'object' },
      },
    },
    metadata: { ...longWriteMetadata, destructive: false },
  },
];

const connectClient = async ({ url, token }) => {
  const client = new Client(
    { name: 'gdevelop-typed-editor-functions-test', version: '1.0.0' },
    { versionNegotiation: { mode: { pin: PROTOCOL_VERSION } } }
  );
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-GDevelop-Client-Id': 'typed-editor-functions-test',
        'X-GDevelop-Window-Id': '51',
      },
    },
  });
  await client.connect(transport);
  return client;
};

test('official MCP client exposes typed EditorFunctions and validates before renderer dispatch', async () => {
  const calls = [];
  const rendererBridge = {
    executeCommand: async options => {
      if (options.command === 'agent.commands.list') {
        return {
          command: options.command,
          data: { commands: descriptors },
          meta: { projectRevision: 12, readOnly: true, modifiesProject: false },
        };
      }
      calls.push(options);
      return {
        command: options.command,
        data: { ok: true, input: options.input },
        meta: {
          projectRevision:
            options.command === 'editor.functions.inspect-variables' ? 12 : 13,
          readOnly: options.command === 'editor.functions.inspect-variables',
          modifiesProject:
            options.command !== 'editor.functions.inspect-variables',
        },
      };
    },
  };

  const token = 'typed-editor-functions-token';
  const host = await startMcpHttpServer({ rendererBridge, token, port: 0 });
  let client = null;
  try {
    client = await connectClient({ url: host.url, token });
    const tools = await client.listTools();
    const byName = new Map(tools.tools.map(tool => [tool.name, tool]));

    descriptors.forEach(descriptor =>
      assert.equal(
        byName.has(descriptor.name),
        true,
        `missing ${descriptor.name}`
      )
    );
    assert.deepEqual(
      byName.get('editor.functions.create-scene').inputSchema.required,
      ['scene_name']
    );
    assert.equal(
      byName.get('editor.functions.create-scene').inputSchema.properties
        .scene_name.type,
      'string'
    );
    assert.equal(
      byName.get('editor.functions.create-scene').inputSchema.properties
        .expectedRevision.type,
      'integer'
    );
    assert.equal(
      byName.get('editor.functions.inspect-variables').annotations.readOnlyHint,
      true
    );
    assert.equal(
      byName.get('editor.functions.run-gameplay-test').annotations.readOnlyHint,
      false
    );
    assert.equal(
      byName.get('editor.functions.run-gameplay-test').annotations
        .destructiveHint,
      true
    );
    assert.equal(
      byName.get('editor.functions.run-gameplay-test')._meta[
        'gdevelop/defaultTimeoutMs'
      ],
      180000
    );

    const inspected = await client.callTool({
      name: 'editor.functions.inspect-variables',
      arguments: { variable_scope: 'global' },
    });
    assert.equal(inspected.structuredContent.data.ok, true);

    const created = await client.callTool({
      name: 'editor.functions.create-scene',
      arguments: { scene_name: 'TypedScene', expectedRevision: 12 },
    });
    assert.equal(created.structuredContent.data.input.scene_name, 'TypedScene');
    assert.equal(calls[1].expectedRevision, 12);

    const callsBeforeInvalid = calls.length;
    const invalid = await client.callTool({
      name: 'editor.functions.create-scene',
      arguments: { scene_name: 42 },
    });
    assert.equal(invalid.isError, true);
    assert.equal(
      calls.length,
      callsBeforeInvalid,
      'invalid typed input must not reach RendererBridge'
    );

    const generic = await client.callTool({
      name: 'editor.functions.call',
      arguments: {
        name: 'inspect_variables',
        arguments: { variable_scope: 'global' },
      },
    });
    assert.equal(generic.structuredContent.data.ok, true);

    assert.deepEqual(calls.map(call => call.command), [
      'editor.functions.inspect-variables',
      'editor.functions.create-scene',
      'editor.functions.call',
    ]);
    calls.forEach(call => assert.equal(call.windowId, '51'));
  } finally {
    if (client) await client.close();
    await host.stop();
  }
});
