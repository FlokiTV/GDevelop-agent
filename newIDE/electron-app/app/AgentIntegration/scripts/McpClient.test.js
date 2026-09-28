const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PROTOCOL_VERSION } = require('../protocols/mcp/McpServerFactory');
const { startMcpHttpServer } = require('../protocols/mcp/McpHttpServer');
const {
  connectLiveGDevelopMcp,
  getToolEnvelope,
  requireToolEnvelope,
  getCanonicalToolData,
  makeDestructiveConfirmationHandler,
  makeRequestHeaders,
  sanitizeForReplay,
} = require('./McpClient');

const makeDescriptor = (name, metadata = {}) => ({
  name,
  description: `Tool ${name}`,
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {},
  },
  outputSchema: {
    type: 'object',
    additionalProperties: true,
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

test('connectLiveGDevelopMcp discovers, pins, calls once and closes without exposing credentials', async () => {
  const calls = [];
  const descriptors = [makeDescriptor('project.status')];
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
      if (options.command === 'project.status') {
        return {
          command: 'project.status',
          data: {
            projectOpen: true,
            projectName: 'DX-6 Test',
            projectRevision: 7,
          },
          meta: {
            traceId: options.traceId || null,
            readOnly: true,
            modifiesProject: false,
            projectRevision: 7,
          },
        };
      }
      throw new Error(`unexpected_command:${options.command}`);
    },
  };
  const token = 'dx6-secret-token';
  const host = await startMcpHttpServer({
    rendererBridge,
    token,
    port: 0,
  });
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-mcp-client-'));
  const tokenPath = path.join(tempDir, 'token');
  const discoveryPath = path.join(tempDir, 'gdevelop-mcp.json');
  fs.writeFileSync(tokenPath, `${token}\n`);
  fs.writeFileSync(
    discoveryPath,
    JSON.stringify({
      service: 'gdevelop-mcp',
      endpoint: host.url,
      protocolVersion: PROTOCOL_VERSION,
      auth: { type: 'bearer', tokenFile: tokenPath },
    })
  );

  let session;
  try {
    session = await connectLiveGDevelopMcp({
      discoveryPath,
      clientId: 'dx6-test-client',
    });

    assert.equal(session.protocolVersion, PROTOCOL_VERSION);
    assert.equal(session.endpoint, host.url);
    assert.deepEqual(session.identity, {
      clientId: 'dx6-test-client',
      agentId: 'dx6-test-client',
      sessionId: 'dx6-test-client',
    });
    assert.deepEqual(session.target, {});
    assert.equal('token' in session, false);
    assert.equal(
      JSON.stringify(session).includes(token),
      false,
      'session result must not expose bearer credentials'
    );

    const tools = await session.listTools();
    assert.deepEqual(tools.map(tool => tool.name), [
      'agent.jobs.cancel',
      'agent.jobs.capabilities',
      'agent.jobs.result',
      'agent.jobs.start',
      'agent.jobs.status',
      'project.status',
    ]);

    const prompts = await session.listPrompts();
    assert.ok(
      prompts.some(prompt => prompt.name === 'gdevelop.events-authoring')
    );
    const authoringPrompt = await session.getPrompt(
      'gdevelop.events-authoring'
    );
    assert.match(
      authoringPrompt.messages[0].content.text,
      /events\.read\.data\.eventsJson/
    );

    const resources = await session.listResources();
    assert.ok(
      resources.some(
        resource => resource.uri === 'gdevelop://guides/native-event-authoring'
      )
    );
    const authoringGuide = await session.readResource(
      'gdevelop://guides/native-event-authoring'
    );
    assert.match(
      authoringGuide.contents[0].text,
      /events\.instructions\.search/
    );

    const beforeCallCount = calls.filter(
      call => call.command === 'project.status'
    ).length;
    const result = await session.call('project.status', {});
    const afterCallCount = calls.filter(
      call => call.command === 'project.status'
    ).length;

    assert.equal(afterCallCount - beforeCallCount, 1);
    assert.equal(result.isError, false);
    assert.equal(result.envelope.contractVersion, 1);
    assert.equal(result.envelope.command, 'project.status');
    assert.deepEqual(result.data, {
      projectOpen: true,
      projectName: 'DX-6 Test',
      projectRevision: 7,
    });
    assert.equal(result.meta.projectRevision, 7);
    assert.equal(result.structuredContent.command, 'project.status');

    await session.close();
    await session.close();
  } finally {
    if (session) {
      try {
        await session.close();
      } catch (_) {}
    }
    await host.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('strict envelope helpers reject legacy/ambiguous shapes and return canonical data', () => {
  const response = {
    structuredContent: {
      contractVersion: 1,
      command: 'project.status',
      data: { projectOpen: true },
      meta: {
        traceId: null,
        readOnly: true,
        modifiesProject: false,
        projectRevision: 4,
        semanticRevisions: [],
        durationMs: 1,
        idempotencyReplayed: false,
      },
    },
  };
  assert.equal(getToolEnvelope(response).command, 'project.status');
  assert.deepEqual(getCanonicalToolData(response), { projectOpen: true });
  assert.throws(
    () =>
      requireToolEnvelope({
        structuredContent: { data: { projectOpen: true } },
      }),
    /invalid_gdevelop_mcp_response_envelope/
  );
});

test('destructive confirmation helper only accepts boolean confirm forms', async () => {
  const handler = makeDestructiveConfirmationHandler();
  assert.deepEqual(
    await handler({
      params: {
        requestedSchema: {
          type: 'object',
          properties: { confirm: { type: 'boolean' } },
        },
      },
    }),
    { action: 'accept', content: { confirm: true } }
  );
  assert.deepEqual(
    await handler({
      params: {
        requestedSchema: {
          type: 'object',
          properties: { value: { type: 'string' } },
        },
      },
    }),
    { action: 'decline', content: {} }
  );
});

test('request targeting headers and replay sanitization keep transport credentials separate', () => {
  assert.deepEqual(
    makeRequestHeaders({
      token: 'secret',
      clientId: 'dx6-client',
      agentId: 'agent-a',
      sessionId: 'session-a',
      taskId: 'task-a',
      windowId: 17,
      projectPath: 'C:/game/game.json',
    }),
    {
      Authorization: 'Bearer secret',
      'X-GDevelop-Client-Id': 'dx6-client',
      'X-GDevelop-Agent-Id': 'agent-a',
      'X-GDevelop-Session-Id': 'session-a',
      'X-GDevelop-Task-Id': 'task-a',
      'X-GDevelop-Window-Id': '17',
      'X-GDevelop-Project-Path': 'C:/game/game.json',
    }
  );

  assert.deepEqual(
    sanitizeForReplay({
      command: 'project.status',
      authorization: 'Bearer secret',
      nested: {
        token: 'secret',
        safe: true,
      },
    }),
    {
      command: 'project.status',
      nested: { safe: true },
    }
  );
});
