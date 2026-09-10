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
  longRunning: true,
  requiresProject: false,
  modifiesProject: false,
  cacheScope: 'process',
  ttlMs: 300000,
};
const writeMetadata = {
  readOnly: false,
  destructive: false,
  idempotent: false,
  longRunning: true,
  requiresProject: true,
  modifiesProject: true,
};

const descriptor = (name, inputSchema, metadata = readMetadata) => ({
  name,
  description: `CAP-06/07 ${name}`,
  inputSchema,
  metadata,
});

const descriptors = [
  descriptor('docs.search', {
    type: 'object',
    additionalProperties: false,
    required: ['query'],
    properties: {
      query: { type: 'string', minLength: 1, maxLength: 500 },
      limit: { type: 'integer', minimum: 1, maximum: 20 },
    },
  }),
  descriptor('docs.read', {
    type: 'object',
    additionalProperties: false,
    required: ['url'],
    properties: {
      url: { type: 'string', minLength: 1, maxLength: 2048 },
      maxChars: { type: 'integer', minimum: 1000, maximum: 50000 },
    },
  }),
  descriptor('store.objects.search', {
    type: 'object',
    additionalProperties: false,
    required: ['query'],
    properties: {
      query: { type: 'string', minLength: 1, maxLength: 500 },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
    },
  }),
  descriptor('store.objects.inspect', {
    type: 'object',
    additionalProperties: false,
    required: ['assetId'],
    properties: { assetId: { type: 'string', minLength: 1 } },
  }),
  descriptor(
    'store.objects.import',
    {
      type: 'object',
      additionalProperties: false,
      required: ['assetId', 'sceneName', 'objectName'],
      properties: {
        assetId: { type: 'string', minLength: 1 },
        sceneName: { type: 'string', minLength: 1 },
        objectName: { type: 'string', minLength: 1 },
      },
    },
    writeMetadata
  ),
  descriptor('store.resources.search', {
    type: 'object',
    additionalProperties: false,
    required: ['query'],
    properties: {
      query: { type: 'string', minLength: 1, maxLength: 500 },
      kind: { type: 'string', minLength: 1, maxLength: 100 },
    },
  }),
  descriptor('store.resources.inspect', {
    type: 'object',
    additionalProperties: false,
    required: ['resourceUrl'],
    properties: { resourceUrl: { type: 'string', minLength: 1 } },
  }),
  descriptor(
    'store.resources.import',
    {
      type: 'object',
      additionalProperties: false,
      required: ['resourceUrl'],
      properties: {
        resourceUrl: { type: 'string', minLength: 1 },
        resourceName: { type: 'string', minLength: 1 },
      },
    },
    writeMetadata
  ),
];

const connectClient = async ({ url, token }) => {
  const client = new Client(
    { name: 'gdevelop-docs-store-test', version: '1.0.0' },
    { versionNegotiation: { mode: { pin: PROTOCOL_VERSION } } }
  );
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-GDevelop-Client-Id': 'docs-store-test',
        'X-GDevelop-Window-Id': '41',
      },
    },
  });
  await client.connect(transport);
  return client;
};

const resultFor = options => {
  const baseMeta = {
    projectRevision: options.command.includes('.import') ? 8 : 7,
    readOnly: !options.command.includes('.import'),
    modifiesProject: options.command.includes('.import'),
  };
  switch (options.command) {
    case 'docs.search':
      return {
        command: options.command,
        data: {
          source: { id: 'gdevelop-docs', version: 'current' },
          total: 1,
          items: [
            {
              title: 'Platformer behavior',
              url: 'https://wiki.gdevelop.io/gdevelop5/behaviors/platformer/',
            },
          ],
        },
        meta: baseMeta,
      };
    case 'docs.read':
      return {
        command: options.command,
        data: {
          source: { id: 'gdevelop-docs', version: 'current' },
          url: options.input.url,
          text:
            'Platformer behavior lets an object act as a platformer character.',
        },
        meta: baseMeta,
      };
    case 'store.objects.search':
      return {
        command: options.command,
        data: {
          total: 1,
          items: [
            {
              id: 'asset-hero',
              name: 'Hero',
              objectType: 'Sprite',
              provenance: { source: 'gdevelop-asset-store' },
              license: { name: 'CC0' },
            },
          ],
        },
        meta: baseMeta,
      };
    case 'store.objects.inspect':
      return {
        command: options.command,
        data: {
          item: {
            id: options.input.assetId,
            authors: [{ name: 'Asset Author' }],
            license: { name: 'CC0' },
          },
        },
        meta: baseMeta,
      };
    case 'store.objects.import':
      return {
        command: options.command,
        data: { imported: true, objectName: options.input.objectName },
        meta: baseMeta,
      };
    case 'store.resources.search':
      return {
        command: options.command,
        data: {
          total: 1,
          items: [
            {
              url: 'https://resources.gdevelop-app.com/sfx/jump.ogg',
              name: 'jump.ogg',
              kind: 'audio',
              provenance: { source: 'gdevelop-asset-store' },
            },
          ],
        },
        meta: baseMeta,
      };
    case 'store.resources.inspect':
      return {
        command: options.command,
        data: {
          item: {
            url: options.input.resourceUrl,
            authors: [{ name: 'Resource Author' }],
            license: { name: 'CC0' },
          },
        },
        meta: baseMeta,
      };
    case 'store.resources.import':
      return {
        command: options.command,
        data: { imported: true, resourceName: options.input.resourceName },
        meta: baseMeta,
      };
    default:
      throw new Error(`Unexpected command ${options.command}`);
  }
};

test('official MCP client discovers and calls CAP-06/07 docs/store tools', async () => {
  const calls = [];
  const rendererBridge = {
    executeCommand: async options => {
      if (options.command === 'agent.commands.list') {
        return {
          command: options.command,
          data: { commands: descriptors },
          meta: { projectRevision: 7, readOnly: true, modifiesProject: false },
        };
      }
      calls.push(options);
      return resultFor(options);
    },
  };

  const token = 'docs-store-token';
  const host = await startMcpHttpServer({ rendererBridge, token, port: 0 });
  let client = null;
  try {
    client = await connectClient({ url: host.url, token });
    const tools = await client.listTools();
    const byName = new Map(tools.tools.map(tool => [tool.name, tool]));
    descriptors.forEach(command =>
      assert.equal(byName.has(command.name), true, `missing ${command.name}`)
    );
    assert.equal(
      byName.get('docs.search').inputSchema.properties.limit.maximum,
      20
    );
    assert.equal(
      byName.get('store.objects.import').annotations.readOnlyHint,
      false
    );

    const docs = await client.callTool({
      name: 'docs.search',
      arguments: { query: 'platformer', limit: 5 },
    });
    const docUrl = docs.structuredContent.data.items[0].url;
    const page = await client.callTool({
      name: 'docs.read',
      arguments: { url: docUrl, maxChars: 5000 },
    });
    assert.match(page.structuredContent.data.text, /Platformer behavior/);

    const objects = await client.callTool({
      name: 'store.objects.search',
      arguments: { query: 'hero', limit: 5 },
    });
    const asset = objects.structuredContent.data.items[0];
    const inspectedObject = await client.callTool({
      name: 'store.objects.inspect',
      arguments: { assetId: asset.id },
    });
    assert.equal(
      inspectedObject.structuredContent.data.item.license.name,
      'CC0'
    );
    const importedObject = await client.callTool({
      name: 'store.objects.import',
      arguments: {
        assetId: asset.id,
        sceneName: 'Scene',
        objectName: 'Hero',
      },
    });
    assert.equal(importedObject.structuredContent.data.imported, true);

    const resources = await client.callTool({
      name: 'store.resources.search',
      arguments: { query: 'jump', kind: 'image' },
    });
    const resource = resources.structuredContent.data.items[0];
    const inspectedResource = await client.callTool({
      name: 'store.resources.inspect',
      arguments: { resourceUrl: resource.url },
    });
    assert.equal(
      inspectedResource.structuredContent.data.item.authors[0].name,
      'Resource Author'
    );
    const importedResource = await client.callTool({
      name: 'store.resources.import',
      arguments: { resourceUrl: resource.url, resourceName: 'jump.ogg' },
    });
    assert.equal(importedResource.structuredContent.data.imported, true);

    assert.deepEqual(calls.map(call => call.command), [
      'docs.search',
      'docs.read',
      'store.objects.search',
      'store.objects.inspect',
      'store.objects.import',
      'store.resources.search',
      'store.resources.inspect',
      'store.resources.import',
    ]);
    calls.forEach(call => assert.equal(call.windowId, '41'));
    assert.equal(
      calls.find(call => call.command === 'store.resources.search').input.kind,
      'image'
    );
  } finally {
    if (client) await client.close();
    await host.stop();
  }
});
