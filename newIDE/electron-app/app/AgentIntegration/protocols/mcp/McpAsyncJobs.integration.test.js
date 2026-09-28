const test = require('node:test');
const assert = require('node:assert/strict');
const {
  Client,
  StreamableHTTPClientTransport,
} = require('@modelcontextprotocol/client');
const { PROTOCOL_VERSION } = require('./McpServerFactory');
const { startMcpHttpServer } = require('./McpHttpServer');

const metadata = (overrides = {}) => ({
  readOnly: true,
  destructive: false,
  idempotent: true,
  longRunning: false,
  requiresProject: false,
  modifiesProject: false,
  ...overrides,
});

const descriptor = (name, inputSchema, metadataOverrides = {}) => ({
  name,
  description: `Test tool ${name}`,
  inputSchema,
  outputSchema: { type: 'object', additionalProperties: true },
  metadata: metadata(metadataOverrides),
});

const objectSchema = (properties = {}, required = []) => ({
  type: 'object',
  additionalProperties: false,
  ...(required.length ? { required } : {}),
  properties,
});

const makeDesktopHarness = ({ slowInteract = false } = {}) => {
  const state = {
    viewport: { width: 800, height: 600 },
    language: 'en',
    captureActive: false,
    recordingActive: false,
    cleanupCalls: [],
    calls: [],
  };
  const previewWindowId = {
    type: 'integer',
    minimum: 1,
  };
  const descriptors = [
    descriptor('desktop.windows.list', objectSchema()),
    descriptor(
      'desktop.window.capture',
      objectSchema({ windowId: { type: 'integer', minimum: 1 } }, ['windowId'])
    ),
    descriptor(
      'preview.viewport.status',
      objectSchema({ previewWindowId }, ['previewWindowId'])
    ),
    descriptor(
      'preview.viewport.set',
      objectSchema(
        {
          previewWindowId,
          width: { type: 'integer', minimum: 1 },
          height: { type: 'integer', minimum: 1 },
        },
        ['previewWindowId', 'width', 'height']
      )
    ),
    descriptor(
      'preview.input.interact',
      objectSchema(
        {
          previewWindowId,
          language: { type: 'string' },
          delayMs: { type: 'integer', minimum: 0 },
        },
        ['previewWindowId']
      )
    ),
    descriptor(
      'preview.input.reset',
      objectSchema({ previewWindowId }, ['previewWindowId'])
    ),
    descriptor(
      'preview.input.record.start',
      objectSchema(
        {
          previewWindowId,
          recordingId: { type: 'string' },
        },
        ['previewWindowId', 'recordingId']
      )
    ),
    descriptor(
      'preview.input.record.stop',
      objectSchema({ recordingId: { type: 'string' } })
    ),
    descriptor(
      'preview.network.capture.start',
      objectSchema({ alias: { type: 'string' } }, ['alias'])
    ),
    descriptor(
      'preview.network.capture.stop',
      objectSchema({ alias: { type: 'string' } }, ['alias'])
    ),
  ];
  const byName = new Map(descriptors.map(item => [item.name, item]));

  const execute = async ({ command, input = {}, requestContext = {} }) => {
    state.calls.push({ command, input });
    if (command === 'desktop.windows.list') {
      return {
        command,
        data: [{ windowId: 8, previewWindow: true, editorWindow: false }],
        meta: { readOnly: true, modifiesProject: false },
      };
    }
    if (command === 'preview.viewport.status') {
      return {
        command,
        data: {
          previewWindowId: input.previewWindowId,
          actualViewport: { ...state.viewport },
          exact: true,
        },
        meta: { readOnly: true, modifiesProject: false },
      };
    }
    if (command === 'preview.viewport.set') {
      state.viewport = { width: input.width, height: input.height };
      if (input.width === 800 && input.height === 600) {
        state.cleanupCalls.push('viewport-restore');
      }
      return {
        command,
        data: {
          previewWindowId: input.previewWindowId,
          actualViewport: { ...state.viewport },
          exact: true,
        },
        meta: { readOnly: true, modifiesProject: false },
      };
    }
    if (command === 'preview.input.interact') {
      if (input.language) state.language = input.language;
      if (slowInteract && input.delayMs) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, input.delayMs);
          const signal = requestContext.signal;
          if (!signal) return;
          const onAbort = () => {
            clearTimeout(timer);
            const error = new Error('interact aborted');
            error.name = 'AbortError';
            error.code = 'ABORT_ERR';
            reject(error);
          };
          if (signal.aborted) {
            onAbort();
            return;
          }
          signal.addEventListener('abort', onAbort, { once: true });
        });
      } else {
        await new Promise(resolve => setTimeout(resolve, 3));
      }
      return {
        command,
        data: {
          previewWindowId: input.previewWindowId,
          language: state.language,
        },
        meta: { readOnly: true, modifiesProject: false },
      };
    }
    if (command === 'desktop.window.capture') {
      const imageBuffer = Buffer.from(
        `${state.viewport.width}x${state.viewport.height}:${state.language}`
      );
      return {
        command,
        data: {
          windowId: input.windowId,
          mimeType: 'image/png',
          imageBuffer,
        },
        meta: { readOnly: true, modifiesProject: false },
      };
    }
    if (command === 'preview.input.reset') {
      state.cleanupCalls.push('input-reset');
      return {
        command,
        data: { reset: true, previewWindowId: input.previewWindowId },
        meta: { readOnly: true, modifiesProject: false },
      };
    }
    if (command === 'preview.input.record.start') {
      state.recordingActive = true;
      return {
        command,
        data: { recordingId: input.recordingId },
        meta: { readOnly: true, modifiesProject: false },
      };
    }
    if (command === 'preview.input.record.stop') {
      state.recordingActive = false;
      state.cleanupCalls.push('recording-stop');
      return {
        command,
        data: { recordingId: input.recordingId, stopped: true },
        meta: { readOnly: true, modifiesProject: false },
      };
    }
    if (command === 'preview.network.capture.start') {
      state.captureActive = true;
      return {
        command,
        data: { alias: input.alias, active: true },
        meta: { readOnly: true, modifiesProject: false },
      };
    }
    if (command === 'preview.network.capture.stop') {
      state.captureActive = false;
      state.cleanupCalls.push('capture-stop');
      return {
        command,
        data: { alias: input.alias, active: false },
        meta: { readOnly: true, modifiesProject: false },
      };
    }
    throw new Error(`unexpected_desktop_command:${command}`);
  };

  return {
    state,
    registry: {
      listDescriptors: () => descriptors.slice(),
      has: command => byName.has(command),
      execute,
    },
  };
};

const makeRendererBridge = () => ({
  executeCommand: async options => {
    if (options.command === 'agent.commands.list') {
      return {
        command: options.command,
        data: { commands: [] },
        meta: { readOnly: true, modifiesProject: false },
      };
    }
    throw new Error(`unexpected_renderer_command:${options.command}`);
  },
});

const connectClient = async ({
  url,
  token,
  agentId = 'async-agent',
  sessionId = 'async-session',
  taskId = 'dx25-task',
}) => {
  const client = new Client(
    { name: 'gdevelop-async-job-test', version: '1.0.0' },
    { versionNegotiation: { mode: { pin: PROTOCOL_VERSION } } }
  );
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-GDevelop-Client-Id': `${agentId}-client`,
        'X-GDevelop-Agent-Id': agentId,
        'X-GDevelop-Session-Id': sessionId,
        'X-GDevelop-Task-Id': taskId,
      },
    },
  });
  await client.connect(transport);
  return client;
};

const callData = async (client, name, args) => {
  const response = await client.callTool({ name, arguments: args });
  assert.equal(response.isError, undefined);
  return response.structuredContent.data;
};

const waitForTerminal = async (client, jobId) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const data = await callData(client, 'agent.jobs.status', {
      jobId,
      afterSequence: 0,
      limit: 500,
    });
    if (
      ['succeeded', 'failed', 'cancelled', 'timed_out'].includes(
        data.job.status
      )
    ) {
      return data;
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('official_mcp_async_job_test_timeout');
};

test('official MCP lifecycle runs a 5x2 viewport/language matrix across disconnect and cleans preview resources', async () => {
  const { registry: desktopCommandRegistry, state } = makeDesktopHarness();
  const token = 'async-job-integration-token';
  const host = await startMcpHttpServer({
    rendererBridge: makeRendererBridge(),
    desktopCommandRegistry,
    token,
    port: 0,
  });
  let client = await connectClient({ url: host.url, token });
  try {
    const tools = await client.listTools();
    const jobTools = tools.tools
      .map(tool => tool.name)
      .filter(name => name.startsWith('agent.jobs.'));
    assert.deepEqual(jobTools, [
      'agent.jobs.cancel',
      'agent.jobs.capabilities',
      'agent.jobs.result',
      'agent.jobs.start',
      'agent.jobs.status',
    ]);

    const capabilities = await callData(client, 'agent.jobs.capabilities', {});
    assert.equal(capabilities.timeouts.separateFromTransportRequest, true);
    assert.equal(
      capabilities.executionModel,
      'host-event-loop-no-unmanaged-processes'
    );

    const steps = [
      {
        stepId: 'capture-session',
        phase: 'setup:capture',
        command: 'preview.network.capture.start',
        input: { alias: 'host' },
      },
      {
        stepId: 'record-session',
        phase: 'setup:record',
        command: 'preview.input.record.start',
        input: { previewWindowId: 8, recordingId: 'matrix-recording' },
      },
    ];
    const viewports = [
      [320, 568],
      [390, 844],
      [768, 1024],
      [1280, 720],
      [1920, 1080],
    ];
    for (const [width, height] of viewports) {
      for (const language of ['en', 'pt-BR']) {
        const key = `${width}x${height}-${language}`;
        steps.push(
          {
            stepId: `${key}-viewport`,
            phase: `viewport:${width}x${height}`,
            command: 'preview.viewport.set',
            input: { previewWindowId: 8, width, height },
          },
          {
            stepId: `${key}-language`,
            phase: `language:${language}`,
            command: 'preview.input.interact',
            input: { previewWindowId: 8, language },
          },
          {
            stepId: `${key}-capture`,
            phase: `capture:${key}`,
            command: 'desktop.window.capture',
            input: { windowId: 8 },
          }
        );
      }
    }

    const started = await callData(client, 'agent.jobs.start', {
      label: 'official-mcp-5x2',
      policy: 'continue-on-error',
      jobTimeoutMs: 5000,
      steps,
    });
    assert.equal(started.accepted, true);
    assert.match(started.job.jobId, /^job-/);
    assert.equal(started.job.requestDetached, true);
    assert.equal(started.job.progress.total, 32);
    assert.ok(started.job.progress.completed < 32);

    const jobId = started.job.jobId;
    await client.close();
    client = await connectClient({ url: host.url, token });

    const terminal = await waitForTerminal(client, jobId);
    assert.equal(terminal.job.status, 'succeeded');
    assert.deepEqual(terminal.job.progress, {
      completed: 32,
      total: 32,
      phase: 'succeeded',
    });
    assert.equal(terminal.job.cleanup.ok, true);
    assert.deepEqual(state.viewport, { width: 800, height: 600 });
    assert.equal(state.captureActive, false);
    assert.equal(state.recordingActive, false);
    assert.ok(state.cleanupCalls.includes('capture-stop'));
    assert.ok(state.cleanupCalls.includes('recording-stop'));
    assert.ok(state.cleanupCalls.includes('input-reset'));
    assert.ok(state.cleanupCalls.includes('viewport-restore'));

    let afterSequence = 0;
    const resultEvents = [];
    const diagnosticEvents = [];
    for (let page = 0; page < 100; page++) {
      const result = await callData(client, 'agent.jobs.result', {
        jobId,
        afterSequence,
        limit: 7,
      });
      resultEvents.push(...result.results);
      diagnosticEvents.push(...result.diagnostics);
      afterSequence = result.cursor.nextSequence;
      if (!result.cursor.hasMore && result.complete) break;
    }
    assert.equal(resultEvents.length, 32);
    assert.equal(diagnosticEvents.length, 0);
    const captures = resultEvents.filter(
      event => event.step.command === 'desktop.window.capture'
    );
    assert.equal(captures.length, 10);
    for (const capture of captures) {
      const artifact = capture.result.envelope.data.imageArtifact;
      assert.equal(artifact.mimeType, 'image/png');
      assert.ok(artifact.byteLength > 0);
      assert.match(artifact.sha256, /^[0-9a-f]{64}$/);
      assert.equal(artifact.payloadRetained, false);
    }

    const foreignClient = await connectClient({
      url: host.url,
      token,
      agentId: 'other-agent',
      sessionId: 'other-session',
    });
    try {
      const foreignStatus = await foreignClient.callTool({
        name: 'agent.jobs.status',
        arguments: { jobId },
      });
      assert.equal(foreignStatus.isError, true);
      assert.equal(
        foreignStatus.structuredContent.error.code,
        'async_job_owner_mismatch'
      );
    } finally {
      await foreignClient.close();
    }
  } finally {
    if (client) await client.close().catch(() => {});
    await host.stop();
  }
});

test('observational capture jobs do not reset unrelated preview input state', async () => {
  const { registry: desktopCommandRegistry, state } = makeDesktopHarness();
  const token = 'async-job-observational-cleanup-token';
  const host = await startMcpHttpServer({
    rendererBridge: makeRendererBridge(),
    desktopCommandRegistry,
    token,
    port: 0,
  });
  const client = await connectClient({
    url: host.url,
    token,
    taskId: 'dx25-observational-cleanup',
  });
  try {
    const started = await callData(client, 'agent.jobs.start', {
      steps: [
        {
          stepId: 'capture-only',
          command: 'desktop.window.capture',
          input: { windowId: 8 },
        },
      ],
    });
    const terminal = await waitForTerminal(client, started.job.jobId);
    assert.equal(terminal.job.status, 'succeeded');
    assert.equal(state.cleanupCalls.includes('input-reset'), false);
  } finally {
    await client.close();
    await host.stop();
  }
});

test('official MCP reconnect preserves partial results when aggregate job timeout aborts a later step', async () => {
  const { registry: desktopCommandRegistry } = makeDesktopHarness({
    slowInteract: true,
  });
  const token = 'async-job-timeout-token';
  const host = await startMcpHttpServer({
    rendererBridge: makeRendererBridge(),
    desktopCommandRegistry,
    token,
    port: 0,
  });
  let client = await connectClient({
    url: host.url,
    token,
    taskId: 'dx25-timeout',
  });
  try {
    const started = await callData(client, 'agent.jobs.start', {
      jobTimeoutMs: 80,
      policy: 'fail-fast',
      steps: [
        {
          stepId: 'partial',
          command: 'preview.input.interact',
          input: { previewWindowId: 8, language: 'pt-BR' },
        },
        {
          stepId: 'timeout',
          command: 'preview.input.interact',
          input: { previewWindowId: 8, delayMs: 1000 },
        },
        {
          stepId: 'never',
          command: 'preview.input.interact',
          input: { previewWindowId: 8, language: 'en' },
        },
      ],
    });
    const jobId = started.job.jobId;
    await client.close();
    client = await connectClient({
      url: host.url,
      token,
      taskId: 'dx25-timeout',
    });

    const terminal = await waitForTerminal(client, jobId);
    assert.equal(terminal.job.status, 'timed_out');
    assert.equal(terminal.job.progress.completed, 1);
    assert.equal(terminal.job.counts.skipped, 2);
    assert.equal(terminal.job.cleanup.ok, true);

    const result = await callData(client, 'agent.jobs.result', {
      jobId,
      afterSequence: 0,
      limit: 500,
    });
    assert.equal(result.complete, true);
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].step.stepId, 'partial');
    assert.ok(
      result.diagnostics.some(
        event => event.diagnostic.code === 'async_job_timeout'
      )
    );
  } finally {
    if (client) await client.close().catch(() => {});
    await host.stop();
  }
});
