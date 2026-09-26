const test = require('node:test');
const assert = require('node:assert/strict');
const {
  Client,
  StreamableHTTPClientTransport,
} = require('@modelcontextprotocol/client');
const { PROTOCOL_VERSION } = require('./McpServerFactory');
const { startMcpHttpServer } = require('./McpHttpServer');
const { preflightEventMutationInput } = require('./McpEventMutationValidation');

const commentSchema = {
  type: 'object',
  additionalProperties: true,
  required: ['type'],
  properties: {
    type: { type: 'string' },
    comment: { type: 'string' },
    color: {
      type: 'object',
      additionalProperties: true,
      properties: {
        r: { type: 'integer', minimum: 0, maximum: 255 },
        g: { type: 'integer', minimum: 0, maximum: 255 },
        b: { type: 'integer', minimum: 0, maximum: 255 },
      },
    },
  },
};

test('preflight validates known fields recursively and allows unknown future types', async () => {
  const calls = [];
  const rendererBridge = {
    executeCommand: async options => {
      calls.push(options);
      if (options.command !== 'events.nodes.describe') {
        throw new Error(`unexpected_command:${options.command}`);
      }
      if (options.input.type === 'FutureExtension::FutureEvent') {
        const error = new Error('not found');
        error.code = 'metadata_event_node_not_found';
        throw error;
      }
      return {
        data: {
          item: {
            schemaAvailable: true,
            schema: commentSchema,
          },
        },
      };
    },
  };

  await assert.rejects(
    preflightEventMutationInput({
      command: 'events.insert',
      input: {
        eventsJson: [
          {
            type: 'BuiltinCommonInstructions::Comment',
            color: { r: 256, g: 1, b: 2 },
            comment: 'Bad',
          },
        ],
      },
      rendererBridge,
    }),
    error =>
      error &&
      error.code === 'invalid_event_node_field' &&
      error.details.path === 'color.r' &&
      error.details.maximum === 255
  );

  const unknown = await preflightEventMutationInput({
    command: 'events.apply',
    input: {
      eventsJson: [
        {
          type: 'FutureExtension::FutureEvent',
          futureField: { nested: true },
        },
      ],
    },
    rendererBridge,
  });
  assert.deepEqual(unknown.unknownTypes, ['FutureExtension::FutureEvent']);
  assert.equal(unknown.validatedNodes, 0);
  assert.equal(
    calls.filter(call => call.input.type === 'FutureExtension::FutureEvent')
      .length,
    1
  );
});

test('granular patch preflight validates revision and stable handles before mutation dispatch', async () => {
  const calls = [];
  const rendererBridge = {
    executeCommand: async options => {
      calls.push(options);
      assert.equal(options.command, 'events.read');
      return {
        data: {
          eventsRevision: 'events:current',
          events: [
            {
              handle: 'event:fp:root',
              path: [0],
              conditions: [],
              whileConditions: [],
              actions: [
                {
                  handle: 'action:fp:first',
                  path: [0],
                  instructionKind: 'action',
                  children: [],
                },
                {
                  handle: 'action:fp:second',
                  path: [1],
                  instructionKind: 'action',
                  children: [],
                },
              ],
              children: [],
            },
          ],
        },
      };
    },
  };

  const valid = await preflightEventMutationInput({
    command: 'events.patch',
    input: {
      sceneName: 'Scene',
      expectedEventsRevision: 'events:current',
      operation: {
        kind: 'instruction.move',
        instructionHandle: 'action:fp:second',
        beforeHandle: 'action:fp:first',
      },
    },
    rendererBridge,
  });
  assert.equal(valid.validatedPatch, true);
  assert.equal(valid.instructionHandleCount, 2);

  await assert.rejects(
    preflightEventMutationInput({
      command: 'events.patch',
      input: {
        sceneName: 'Scene',
        expectedEventsRevision: 'events:stale',
        operation: {
          kind: 'instruction.delete',
          instructionHandle: 'action:fp:first',
        },
      },
      rendererBridge,
    }),
    error =>
      error &&
      error.code === 'events_revision_conflict' &&
      error.details.conflictScope === 'events' &&
      error.details.actualEventsRevision === 'events:current'
  );

  await assert.rejects(
    preflightEventMutationInput({
      command: 'events.patch',
      input: {
        sceneName: 'Scene',
        expectedEventsRevision: 'events:current',
        operation: {
          kind: 'instruction.parameter.update',
          instructionHandle: 'action:fp:missing',
          parameterIndex: 0,
          value: '42',
        },
      },
      rendererBridge,
    }),
    error =>
      error &&
      error.code === 'instruction_handle_not_found' &&
      error.details.handle === 'action:fp:missing'
  );
  assert.equal(calls.length, 3);
});

const descriptor = (name, metadata = {}) => ({
  name,
  description: `Tool ${name}`,
  inputSchema: {
    type: 'object',
    additionalProperties: true,
    properties: {},
  },
  outputSchema: {
    type: 'object',
    additionalProperties: true,
  },
  metadata: {
    readOnly: false,
    destructive: false,
    idempotent: false,
    longRunning: false,
    requiresProject: true,
    modifiesProject: name === 'events.insert',
    ...metadata,
  },
});

const connectClient = async ({ url, token }) => {
  const client = new Client(
    { name: 'dx7-preflight-test', version: '1.0.0' },
    { versionNegotiation: { mode: { pin: PROTOCOL_VERSION } } }
  );
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: {
      headers: { Authorization: `Bearer ${token}` },
    },
  });
  await client.connect(transport);
  return client;
};

test('MCP preflight blocks malformed known event before mutation dispatch but forwards unknown type', async () => {
  const calls = [];
  const descriptors = [
    descriptor('events.insert'),
    descriptor('events.nodes.describe', {
      readOnly: true,
      idempotent: true,
      modifiesProject: false,
    }),
  ];
  const rendererBridge = {
    executeCommand: async options => {
      calls.push(options);
      if (options.command === 'agent.commands.list') {
        return {
          command: options.command,
          data: { commands: descriptors },
          meta: { readOnly: true, modifiesProject: false },
        };
      }
      if (options.command === 'events.nodes.describe') {
        if (options.input.type === 'FutureExtension::FutureEvent') {
          const error = new Error('not found');
          error.code = 'metadata_event_node_not_found';
          throw error;
        }
        return {
          command: options.command,
          data: {
            item: {
              schemaAvailable: true,
              schema: commentSchema,
            },
          },
          meta: { readOnly: true, modifiesProject: false },
        };
      }
      if (options.command === 'events.insert') {
        return {
          command: options.command,
          data: { inserted: true },
          meta: {
            readOnly: false,
            modifiesProject: true,
            projectRevision: 2,
          },
        };
      }
      throw new Error(`unexpected_command:${options.command}`);
    },
  };

  const token = 'dx7-preflight-token';
  const host = await startMcpHttpServer({ rendererBridge, token, port: 0 });
  const client = await connectClient({ url: host.url, token });
  try {
    const invalid = await client.callTool({
      name: 'events.insert',
      arguments: {
        eventsJson: [
          {
            type: 'BuiltinCommonInstructions::Comment',
            color: { r: 256, g: 1, b: 2 },
          },
        ],
      },
    });
    assert.equal(invalid.isError, true);
    assert.match(JSON.stringify(invalid), /invalid_event_node_field/);
    assert.match(JSON.stringify(invalid), /color\.r/);
    assert.equal(
      calls.filter(call => call.command === 'events.insert').length,
      0
    );

    const unknown = await client.callTool({
      name: 'events.insert',
      arguments: {
        eventsJson: [
          {
            type: 'FutureExtension::FutureEvent',
            futureField: { nested: true },
          },
        ],
      },
    });
    assert.equal(unknown.isError, undefined);
    assert.equal(unknown.structuredContent.data.inserted, true);
    assert.equal(
      calls.filter(call => call.command === 'events.insert').length,
      1
    );
  } finally {
    await client.close();
    await host.stop();
  }
});

test('MCP events.patch preflight rejects stale/missing handles before mutating and forwards valid patch', async () => {
  const calls = [];
  const descriptors = [
    descriptor('events.patch', {
      readOnly: false,
      idempotent: false,
      modifiesProject: true,
    }),
  ];
  const rendererBridge = {
    executeCommand: async options => {
      calls.push(options);
      if (options.command === 'agent.commands.list') {
        return {
          command: options.command,
          data: { commands: descriptors },
          meta: { readOnly: true, modifiesProject: false },
        };
      }
      if (options.command === 'events.read') {
        return {
          command: options.command,
          data: {
            eventsRevision: 'events:current',
            events: [
              {
                handle: 'event:fp:root',
                path: [0],
                conditions: [],
                whileConditions: [],
                actions: [
                  {
                    handle: 'action:fp:target',
                    path: [0],
                    instructionKind: 'action',
                    children: [],
                  },
                ],
                children: [],
              },
            ],
          },
          meta: { readOnly: true, modifiesProject: false },
        };
      }
      if (options.command === 'events.patch') {
        return {
          command: options.command,
          data: { updated: true, eventsRevision: 'events:next' },
          meta: {
            readOnly: false,
            modifiesProject: true,
            projectRevision: 3,
          },
        };
      }
      throw new Error(`unexpected_command:${options.command}`);
    },
  };

  const token = 'dx20-patch-preflight-token';
  const host = await startMcpHttpServer({ rendererBridge, token, port: 0 });
  const client = await connectClient({ url: host.url, token });
  try {
    const stale = await client.callTool({
      name: 'events.patch',
      arguments: {
        sceneName: 'Scene',
        expectedEventsRevision: 'events:stale',
        operation: {
          kind: 'instruction.delete',
          instructionHandle: 'action:fp:target',
        },
      },
    });
    assert.equal(stale.isError, true);
    assert.match(JSON.stringify(stale), /events_revision_conflict/);
    assert.equal(
      calls.filter(call => call.command === 'events.patch').length,
      0
    );

    const missing = await client.callTool({
      name: 'events.patch',
      arguments: {
        sceneName: 'Scene',
        expectedEventsRevision: 'events:current',
        operation: {
          kind: 'instruction.delete',
          instructionHandle: 'action:fp:missing',
        },
      },
    });
    assert.equal(missing.isError, true);
    assert.match(JSON.stringify(missing), /instruction_handle_not_found/);
    assert.equal(
      calls.filter(call => call.command === 'events.patch').length,
      0
    );

    const valid = await client.callTool({
      name: 'events.patch',
      arguments: {
        sceneName: 'Scene',
        expectedEventsRevision: 'events:current',
        operation: {
          kind: 'instruction.parameter.update',
          instructionHandle: 'action:fp:target',
          parameterIndex: 0,
          value: '42',
        },
      },
    });
    assert.equal(valid.isError, undefined);
    assert.equal(valid.structuredContent.data.updated, true);
    assert.equal(
      calls.filter(call => call.command === 'events.patch').length,
      1
    );
    assert.equal(
      calls.filter(call => call.command === 'events.read').length,
      3
    );
  } finally {
    await client.close();
    await host.stop();
  }
});
