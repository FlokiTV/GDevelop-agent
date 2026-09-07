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
  description: `Integration tool ${name}`,
  inputSchema: inputSchema || {
    type: 'object',
    additionalProperties: false,
    properties: {},
  },
  outputSchema: { type: 'object', additionalProperties: true },
  metadata: metadata(commandMetadata),
});

const makeTransport = ({ url, token }) =>
  new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });

const connectClient = async ({ url, token, capabilities }) => {
  const client = new Client(
    { name: 'gdevelop-long-running-integration', version: '1.0.0' },
    {
      capabilities,
      versionNegotiation: { mode: { pin: PROTOCOL_VERSION } },
    }
  );
  await client.connect(makeTransport({ url, token }));
  return client;
};

test('official MCP client auto-fulfils destructive input_required before execution', async () => {
  const closeDescriptor = descriptor({
    name: 'project.close',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { discardUnsavedChanges: { type: 'boolean' } },
    },
    metadata: {
      readOnly: false,
      destructive: true,
      idempotent: true,
      modifiesProject: true,
    },
  });
  let executions = 0;
  const rendererBridge = {
    executeCommand: async options => {
      if (options.command === 'agent.commands.list') {
        return {
          command: options.command,
          data: { commands: [closeDescriptor] },
          meta: { readOnly: true, modifiesProject: false },
        };
      }
      if (options.command === 'project.close') {
        executions++;
        return {
          command: options.command,
          data: { closed: true },
          meta: { readOnly: false, modifiesProject: true },
        };
      }
      throw new Error(`unexpected_command:${options.command}`);
    },
  };
  const token = 'input-required-token';
  const host = await startMcpHttpServer({ rendererBridge, token, port: 0 });
  const client = new Client(
    { name: 'gdevelop-input-required-test', version: '1.0.0' },
    {
      capabilities: { elicitation: { form: {} } },
      versionNegotiation: { mode: { pin: PROTOCOL_VERSION } },
    }
  );
  client.setRequestHandler('elicitation/create', async request => {
    assert.match(request.params.message, /discard unsaved project changes/i);
    return { action: 'accept', content: { confirm: true } };
  });

  try {
    await client.connect(makeTransport({ url: host.url, token }));
    const result = await client.callTool({
      name: 'project.close',
      arguments: { discardUnsavedChanges: true },
    });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.data.closed, true);
    assert.equal(executions, 1);
  } finally {
    await client.close();
    await host.stop();
  }
});

test('official MCP client cancellation reaches renderer and records cancelled operation state', async () => {
  const validationDescriptor = descriptor({
    name: 'validation.run',
    metadata: {
      longRunning: true,
      requiresProject: true,
      idempotent: false,
      defaultTimeoutMs: 600000,
    },
  });
  let receivedSignal = null;
  const rendererBridge = {
    executeCommand: async options => {
      if (options.command === 'agent.commands.list') {
        return {
          command: options.command,
          data: { commands: [validationDescriptor] },
          meta: { readOnly: true, modifiesProject: false },
        };
      }
      if (options.command === 'validation.run') {
        receivedSignal = options.signal;
        await new Promise((resolve, reject) => {
          const onAbort = () => {
            const error = new Error('cancelled');
            error.code = 'request_cancelled';
            reject(error);
          };
          if (options.signal && options.signal.aborted) return onAbort();
          options.signal.addEventListener('abort', onAbort, { once: true });
        });
        return null;
      }
      throw new Error(`unexpected_command:${options.command}`);
    },
  };
  const token = 'cancel-token';
  const host = await startMcpHttpServer({ rendererBridge, token, port: 0 });
  const client = await connectClient({ url: host.url, token });
  const controller = new AbortController();

  try {
    const pending = client.callTool(
      { name: 'validation.run', arguments: {} },
      { signal: controller.signal }
    );
    await new Promise(resolve => setTimeout(resolve, 20));
    controller.abort();
    await assert.rejects(pending);
    assert.ok(receivedSignal);
    if (!receivedSignal.aborted) {
      await Promise.race([
        new Promise(resolve =>
          receivedSignal.addEventListener('abort', resolve, { once: true })
        ),
        new Promise(resolve => setTimeout(resolve, 250)),
      ]);
    }
    assert.equal(receivedSignal.aborted, true);

    await new Promise(resolve => setTimeout(resolve, 10));
    const operations = host.operationRegistry.snapshot().operations;
    assert.equal(operations.length, 1);
    assert.equal(operations[0].command, 'validation.run');
    assert.equal(operations[0].status, 'cancelled');
  } finally {
    await client.close();
    await host.stop();
  }
});

test('long-running operation status remains readable after MCP reconnect', async () => {
  const exportDescriptor = descriptor({
    name: 'export.html5',
    metadata: {
      longRunning: true,
      requiresProject: true,
      idempotent: false,
      defaultTimeoutMs: 600000,
    },
  });
  const rendererBridge = {
    executeCommand: async options => {
      if (options.command === 'agent.commands.list') {
        return {
          command: options.command,
          data: { commands: [exportDescriptor] },
          meta: { readOnly: true, modifiesProject: false },
        };
      }
      if (options.command === 'export.html5') {
        return {
          command: options.command,
          data: { exported: true },
          meta: { readOnly: true, modifiesProject: false },
        };
      }
      throw new Error(`unexpected_command:${options.command}`);
    },
  };
  const token = 'operation-reconnect-token';
  const host = await startMcpHttpServer({ rendererBridge, token, port: 0 });

  try {
    const firstClient = await connectClient({ url: host.url, token });
    const result = await firstClient.callTool({
      name: 'export.html5',
      arguments: {},
    });
    const operationId = result._meta['gdevelop/operationId'];
    assert.equal(typeof operationId, 'string');
    await firstClient.close();

    const secondClient = await connectClient({ url: host.url, token });
    try {
      const resource = await secondClient.readResource({
        uri: 'gdevelop://mcp/operations',
      });
      const snapshot = JSON.parse(resource.contents[0].text);
      const operation = snapshot.operations.find(
        candidate => candidate.operationId === operationId
      );
      assert.ok(operation);
      assert.equal(operation.status, 'succeeded');
      assert.equal(operation.command, 'export.html5');
    } finally {
      await secondClient.close();
    }
  } finally {
    await host.stop();
  }
});
