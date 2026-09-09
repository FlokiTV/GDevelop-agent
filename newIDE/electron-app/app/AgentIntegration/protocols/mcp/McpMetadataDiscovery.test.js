const test = require('node:test');
const assert = require('node:assert/strict');
const {
  Client,
  StreamableHTTPClientTransport,
} = require('@modelcontextprotocol/client');
const { PROTOCOL_VERSION } = require('./McpServerFactory');
const { startMcpHttpServer } = require('./McpHttpServer');

const metadata = {
  readOnly: true,
  destructive: false,
  idempotent: true,
  longRunning: false,
  requiresProject: true,
  modifiesProject: false,
  cacheScope: 'project-revision',
  ttlMs: 30000,
};

const descriptor = (name, inputSchema) => ({
  name,
  description: `Metadata discovery ${name}`,
  inputSchema,
  metadata,
});

const descriptors = [
  descriptor('events.instructions.search', {
    type: 'object',
    additionalProperties: false,
    properties: {
      query: { type: 'string' },
      kind: {
        type: 'string',
        enum: ['any', 'action', 'condition', 'expression'],
      },
      behaviorType: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
    },
  }),
  descriptor('events.instructions.describe', {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    properties: {
      id: { type: 'string' },
      kind: { type: 'string' },
      behaviorType: { type: 'string' },
    },
  }),
  ...['objects', 'behaviors', 'effects'].flatMap(kind => [
    descriptor(`editor.types.${kind}.list`, {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
    }),
    descriptor(`editor.types.${kind}.describe`, {
      type: 'object',
      additionalProperties: false,
      required: ['type'],
      properties: { type: { type: 'string' } },
    }),
  ]),
];

const connectClient = async ({ url, token }) => {
  const client = new Client(
    { name: 'gdevelop-metadata-discovery-test', version: '1.0.0' },
    { versionNegotiation: { mode: { pin: PROTOCOL_VERSION } } }
  );
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-GDevelop-Client-Id': 'metadata-discovery-test',
        'X-GDevelop-Window-Id': '31',
      },
    },
  });
  await client.connect(transport);
  return client;
};

test('official MCP client discovers and calls the CAP-01/02 metadata surface', async () => {
  const calls = [];
  const rendererBridge = {
    executeCommand: async options => {
      if (options.command === 'agent.commands.list') {
        return {
          command: options.command,
          data: { commands: descriptors },
          meta: { projectRevision: 4, readOnly: true, modifiesProject: false },
        };
      }
      calls.push(options);
      if (options.command === 'events.instructions.search') {
        return {
          command: options.command,
          data: {
            total: 1,
            items: [
              {
                kind: 'condition',
                id: 'ExampleBehavior::IsReady',
                scope: {
                  kind: 'behavior',
                  behaviorType: 'ExampleBehavior::Behavior',
                },
                parameters: [
                  { index: 0, type: 'object', optional: false },
                  { index: 1, type: 'behavior', optional: false },
                ],
              },
            ],
          },
          meta: { projectRevision: 4, readOnly: true, modifiesProject: false },
        };
      }
      if (options.command === 'events.instructions.describe') {
        return {
          command: options.command,
          data: {
            item: {
              kind: 'condition',
              id: options.input.id,
              parameters: [{ index: 0, type: 'object', optional: false }],
              eventContexts: { scene: true },
            },
          },
          meta: { projectRevision: 4, readOnly: true, modifiesProject: false },
        };
      }
      if (options.command === 'editor.types.objects.list') {
        return {
          command: options.command,
          data: {
            total: 1,
            items: [
              {
                kind: 'object',
                type: 'Example::Object',
                renderingMode: '2d',
                extension: { name: 'Example' },
              },
            ],
          },
          meta: { projectRevision: 4, readOnly: true, modifiesProject: false },
        };
      }
      if (options.command === 'editor.types.objects.describe') {
        return {
          command: options.command,
          data: {
            item: {
              kind: 'object',
              type: options.input.type,
              propertySchemaAvailable: true,
              properties: [{ name: 'texture', type: 'resource' }],
            },
          },
          meta: { projectRevision: 4, readOnly: true, modifiesProject: false },
        };
      }
      return {
        command: options.command,
        data: { items: [], total: 0 },
        meta: { projectRevision: 4, readOnly: true, modifiesProject: false },
      };
    },
  };

  const token = 'metadata-discovery-token';
  const host = await startMcpHttpServer({
    rendererBridge,
    token,
    port: 0,
  });
  let client = null;

  try {
    client = await connectClient({ url: host.url, token });
    const tools = await client.listTools();
    const byName = new Map(tools.tools.map(tool => [tool.name, tool]));
    descriptors.forEach(command => {
      assert.equal(byName.has(command.name), true, `missing ${command.name}`);
    });
    assert.equal(
      byName.get('events.instructions.search').inputSchema.additionalProperties,
      false
    );
    assert.equal(
      byName.get('events.instructions.search').inputSchema.properties.limit
        .maximum,
      100
    );

    const found = await client.callTool({
      name: 'events.instructions.search',
      arguments: {
        kind: 'condition',
        behaviorType: 'ExampleBehavior::Behavior',
        limit: 5,
      },
    });
    const discoveredCondition = found.structuredContent.data.items[0];
    assert.equal(discoveredCondition.id, 'ExampleBehavior::IsReady');

    const described = await client.callTool({
      name: 'events.instructions.describe',
      arguments: {
        id: discoveredCondition.id,
        kind: discoveredCondition.kind,
        behaviorType: discoveredCondition.scope.behaviorType,
      },
    });
    assert.equal(
      described.structuredContent.data.item.id,
      discoveredCondition.id
    );
    assert.equal(
      described.structuredContent.data.item.eventContexts.scene,
      true
    );

    const objectTypes = await client.callTool({
      name: 'editor.types.objects.list',
      arguments: { query: 'example', limit: 5 },
    });
    const objectType = objectTypes.structuredContent.data.items[0].type;
    const objectDescription = await client.callTool({
      name: 'editor.types.objects.describe',
      arguments: { type: objectType },
    });
    assert.equal(
      objectDescription.structuredContent.data.item.type,
      objectType
    );
    assert.equal(
      objectDescription.structuredContent.data.item.propertySchemaAvailable,
      true
    );

    assert.deepEqual(calls.map(call => call.command), [
      'events.instructions.search',
      'events.instructions.describe',
      'editor.types.objects.list',
      'editor.types.objects.describe',
    ]);
    calls.forEach(call => assert.equal(call.windowId, '31'));
  } finally {
    if (client) await client.close();
    await host.stop();
  }
});
