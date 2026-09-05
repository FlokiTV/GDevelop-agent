const test = require('node:test');
const assert = require('node:assert/strict');
const {
  Client,
  StreamableHTTPClientTransport,
} = require('@modelcontextprotocol/client');
const { PROTOCOL_VERSION } = require('./McpServerFactory');
const { startMcpHttpServer } = require('./McpHttpServer');

const metadata = overrides => ({
  readOnly: true,
  destructive: false,
  idempotent: true,
  longRunning: false,
  requiresProject: false,
  modifiesProject: false,
  ...(overrides || {}),
});

const descriptor = ({ name, inputSchema, metadata: commandMetadata }) => ({
  name,
  description: `Stress tool ${name}`,
  inputSchema,
  outputSchema: { type: 'object', additionalProperties: true },
  metadata: metadata(commandMetadata),
});

const connectClient = async ({ url, token }) => {
  const client = new Client(
    { name: 'gdevelop-mcp-stress', version: '1.0.0' },
    { versionNegotiation: { mode: { pin: PROTOCOL_VERSION } } }
  );
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-GDevelop-Client-Id': 'stress-client',
        'X-GDevelop-Window-Id': '17',
      },
    },
  });
  await client.connect(transport);
  return client;
};

test('runs 50 mutate hot-reload snapshot cycles over one MCP server without restart', async () => {
  let projectRevision = 0;
  let hotReloadCount = 0;
  let snapshotCount = 0;
  const calls = [];
  const descriptors = [
    descriptor({
      name: 'events.update',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['sceneName', 'handle', 'eventJson'],
        properties: {
          sceneName: { type: 'string' },
          handle: { type: 'string' },
          eventJson: { type: 'object' },
        },
      },
      metadata: {
        readOnly: false,
        idempotent: false,
        requiresProject: true,
        modifiesProject: true,
      },
    }),
    descriptor({
      name: 'preview.hot-reload',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
      metadata: {
        readOnly: true,
        idempotent: false,
        requiresProject: true,
      },
    }),
    descriptor({
      name: 'runtime.snapshot',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
    }),
  ];

  const rendererBridge = {
    executeCommand: async options => {
      calls.push(options);
      if (options.command === 'agent.commands.list') {
        return {
          command: options.command,
          data: { commands: descriptors },
          meta: { traceId: null, readOnly: true, modifiesProject: false },
        };
      }
      if (options.command === 'events.update') {
        assert.equal(options.expectedRevision, projectRevision);
        projectRevision++;
        return {
          command: options.command,
          data: { updated: true },
          meta: {
            traceId: options.traceId || null,
            readOnly: false,
            modifiesProject: true,
            projectRevision,
          },
        };
      }
      if (options.command === 'preview.hot-reload') {
        hotReloadCount++;
        return {
          command: options.command,
          data: {
            reloaded: true,
            running: true,
            debuggerIds: ['preview-stress-1'],
          },
          meta: {
            traceId: options.traceId || null,
            readOnly: true,
            modifiesProject: false,
            projectRevision,
          },
        };
      }
      if (options.command === 'runtime.snapshot') {
        snapshotCount++;
        return {
          command: options.command,
          data: {
            debuggerId: 'preview-stress-1',
            frame: snapshotCount,
          },
          meta: {
            traceId: options.traceId || null,
            readOnly: true,
            modifiesProject: false,
            projectRevision,
          },
        };
      }
      throw new Error(`unexpected_command:${options.command}`);
    },
  };

  const token = 'stress-token';
  const host = await startMcpHttpServer({
    rendererBridge,
    token,
    port: 0,
  });
  const client = await connectClient({ url: host.url, token });
  const startedAt = Date.now();
  const baselineHeapUsed = process.memoryUsage().heapUsed;
  const baselineRequestListeners = host.server.listenerCount('request');
  const baselineConnectionListeners = host.server.listenerCount('connection');

  try {
    for (let index = 0; index < 50; index++) {
      const mutation = await client.callTool({
        name: 'events.update',
        arguments: {
          sceneName: 'Game',
          handle: 'event:id:stress-loop',
          eventJson: {
            type: 'BuiltinCommonInstructions::Standard',
            disabled: index % 2 === 1,
          },
          expectedRevision: index,
          idempotencyKey: `stress-edit-${index}`,
        },
      });
      assert.equal(mutation.structuredContent.meta.projectRevision, index + 1);

      const hotReload = await client.callTool({
        name: 'preview.hot-reload',
        arguments: {},
      });
      assert.equal(hotReload.structuredContent.data.running, true);
      assert.deepEqual(hotReload.structuredContent.data.debuggerIds, [
        'preview-stress-1',
      ]);

      const snapshot = await client.callTool({
        name: 'runtime.snapshot',
        arguments: {},
      });
      assert.equal(
        snapshot.structuredContent.data.debuggerId,
        'preview-stress-1'
      );
      assert.equal(snapshot.structuredContent.data.frame, index + 1);
    }

    const executedCommands = calls.filter(
      call => call.command !== 'agent.commands.list'
    );
    assert.equal(executedCommands.length, 150);
    assert.equal(projectRevision, 50);
    assert.equal(hotReloadCount, 50);
    assert.equal(snapshotCount, 50);
    assert.equal(
      executedCommands.some(
        call =>
          call.command === 'project.open' ||
          call.command === 'project.close' ||
          call.command === 'preview.start' ||
          call.command === 'preview.close-all'
      ),
      false
    );
    const heapGrowthBytes = Math.max(
      0,
      process.memoryUsage().heapUsed - baselineHeapUsed
    );
    assert.ok(
      heapGrowthBytes < 64 * 1024 * 1024,
      `heap growth exceeded 64 MiB: ${heapGrowthBytes}`
    );
    assert.equal(
      host.server.listenerCount('request'),
      baselineRequestListeners
    );
    assert.equal(
      host.server.listenerCount('connection'),
      baselineConnectionListeners
    );
    assert.ok(Date.now() - startedAt < 15000);
  } finally {
    await client.close();
    await host.stop();
  }
});

test('reconnects a fresh MCP client and continues the same project revision without reopening', async () => {
  let projectRevision = 0;
  const calls = [];
  const descriptors = [
    descriptor({
      name: 'events.update',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['sceneName', 'handle', 'eventJson'],
        properties: {
          sceneName: { type: 'string' },
          handle: { type: 'string' },
          eventJson: { type: 'object' },
        },
      },
      metadata: {
        readOnly: false,
        idempotent: false,
        requiresProject: true,
        modifiesProject: true,
      },
    }),
  ];
  const rendererBridge = {
    executeCommand: async options => {
      calls.push(options);
      if (options.command === 'agent.commands.list') {
        return {
          command: options.command,
          data: { commands: descriptors },
          meta: { traceId: null, readOnly: true, modifiesProject: false },
        };
      }
      if (options.command !== 'events.update') {
        throw new Error(`unexpected_command:${options.command}`);
      }
      assert.equal(options.expectedRevision, projectRevision);
      projectRevision++;
      return {
        command: options.command,
        data: { updated: true },
        meta: {
          traceId: options.traceId || null,
          readOnly: false,
          modifiesProject: true,
          projectRevision,
        },
      };
    },
  };
  const token = 'stress-reconnect-token';
  const host = await startMcpHttpServer({ rendererBridge, token, port: 0 });

  try {
    const firstClient = await connectClient({ url: host.url, token });
    try {
      for (let revision = 0; revision < 10; revision++) {
        const result = await firstClient.callTool({
          name: 'events.update',
          arguments: {
            sceneName: 'Game',
            handle: 'event:id:reconnect-loop',
            eventJson: { type: 'BuiltinCommonInstructions::Standard' },
            expectedRevision: revision,
            idempotencyKey: `before-reconnect-${revision}`,
          },
        });
        assert.equal(
          result.structuredContent.meta.projectRevision,
          revision + 1
        );
      }
    } finally {
      await firstClient.close();
    }

    const secondClient = await connectClient({ url: host.url, token });
    try {
      for (let revision = 10; revision < 20; revision++) {
        const result = await secondClient.callTool({
          name: 'events.update',
          arguments: {
            sceneName: 'Game',
            handle: 'event:id:reconnect-loop',
            eventJson: {
              type: 'BuiltinCommonInstructions::Standard',
              disabled: revision % 2 === 0,
            },
            expectedRevision: revision,
            idempotencyKey: `after-reconnect-${revision}`,
          },
        });
        assert.equal(
          result.structuredContent.meta.projectRevision,
          revision + 1
        );
      }
    } finally {
      await secondClient.close();
    }

    assert.equal(projectRevision, 20);
    const executed = calls.filter(
      call => call.command !== 'agent.commands.list'
    );
    assert.equal(executed.length, 20);
    assert.equal(
      executed.some(
        call =>
          call.command === 'project.open' || call.command === 'project.close'
      ),
      false
    );
  } finally {
    await host.stop();
  }
});
