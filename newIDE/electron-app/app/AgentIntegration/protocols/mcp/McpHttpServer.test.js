const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {
  Client,
  StreamableHTTPClientTransport,
} = require('@modelcontextprotocol/client');
const { PROTOCOL_VERSION } = require('./McpServerFactory');
const { startMcpHttpServer } = require('./McpHttpServer');
const {
  createDesktopCommandRegistry,
} = require('../../DesktopCommandRegistry');

const makeDescriptor = (name, metadata = {}) => ({
  name,
  description: `Tool ${name}`,
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {},
    examples: [{}],
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
    assert.deepEqual(tools.tools.map(tool => tool.name), [
      'project.save',
      'project.status',
    ]);
    const saveTool = tools.tools.find(tool => tool.name === 'project.save');
    assert.equal(saveTool.annotations.readOnlyHint, false);
    assert.equal(saveTool.annotations.idempotentHint, false);
    assert.equal(saveTool._meta['gdevelop/defaultTimeoutMs'], 90000);
    assert.deepEqual(saveTool.inputSchema.examples, [{}]);
    assert.equal(saveTool.outputSchema.type, 'object');
    assert.deepEqual(saveTool.outputSchema.required, [
      'command',
      'data',
      'meta',
    ]);

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

test('isolates renderer targeting across concurrent MCP clients', async () => {
  const rendererBridge = makeBridge();
  const token = 'multi-client-token';
  const host = await startMcpHttpServer({
    rendererBridge,
    token,
    port: 0,
  });
  const clientA = await connectClient({ url: host.url, token, windowId: 17 });
  const clientB = await connectClient({ url: host.url, token, windowId: 23 });

  try {
    await Promise.all([
      clientA.callTool({ name: 'project.status', arguments: {} }),
      clientB.callTool({ name: 'project.status', arguments: {} }),
    ]);

    const directCalls = rendererBridge.calls.filter(
      call => call.command === 'project.status'
    );
    assert.equal(directCalls.length, 2);
    assert.deepEqual(directCalls.map(call => call.windowId).sort(), [
      '17',
      '23',
    ]);
  } finally {
    await clientA.close();
    await clientB.close();
    await host.stop();
  }
});

test('allows a fresh MCP client to reconnect after the previous client closes', async () => {
  const rendererBridge = makeBridge();
  const token = 'reconnect-token';
  const host = await startMcpHttpServer({
    rendererBridge,
    token,
    port: 0,
  });

  try {
    const firstClient = await connectClient({
      url: host.url,
      token,
      windowId: 21,
    });
    const firstResult = await firstClient.callTool({
      name: 'project.status',
      arguments: {},
    });
    assert.equal(firstResult.structuredContent.command, 'project.status');
    await firstClient.close();

    const secondClient = await connectClient({
      url: host.url,
      token,
      windowId: 22,
    });
    try {
      const secondResult = await secondClient.callTool({
        name: 'project.status',
        arguments: {},
      });
      assert.equal(secondResult.structuredContent.command, 'project.status');
    } finally {
      await secondClient.close();
    }

    const statusCalls = rendererBridge.calls.filter(
      call => call.command === 'project.status'
    );
    assert.deepEqual(statusCalls.map(call => call.windowId), ['21', '22']);
  } finally {
    await host.stop();
  }
});

test('rejects missing auth, forged Host and non-local origins before MCP dispatch', async () => {
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

    const target = new URL(host.url);
    const badHostStatus = await new Promise((resolve, reject) => {
      const request = http.request(
        {
          hostname: target.hostname,
          port: target.port,
          path: target.pathname,
          method: 'POST',
          headers: {
            Host: 'evil.example',
            Authorization: 'Bearer secret',
            'Content-Type': 'application/json',
            'Content-Length': '2',
          },
        },
        response => {
          response.resume();
          response.on('end', () => resolve(response.statusCode));
        }
      );
      request.on('error', reject);
      request.end('{}');
    });
    assert.equal(badHostStatus, 403);

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

test('rejects malformed and oversized authenticated POST bodies before MCP dispatch', async () => {
  const rendererBridge = makeBridge();
  const host = await startMcpHttpServer({
    rendererBridge,
    token: 'security-token',
    port: 0,
    maxBodyBytes: 128,
    maxJsonDepth: 4,
  });
  try {
    const malformed = await fetch(host.url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer security-token',
        'Content-Type': 'application/json',
      },
      body: '{not-json',
    });
    assert.equal(malformed.status, 400);
    const malformedBody = await malformed.json();
    assert.equal(malformedBody.error.code, -32700);

    const oversized = await fetch(host.url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer security-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ payload: 'x'.repeat(256) }),
    });
    assert.equal(oversized.status, 413);
    const oversizedBody = await oversized.json();
    assert.equal(oversizedBody.error.code, -32003);

    const tooDeep = await fetch(host.url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer security-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ a: { b: { c: { d: { e: true } } } } }),
    });
    assert.equal(tooDeep.status, 400);
    const tooDeepBody = await tooDeep.json();
    assert.equal(tooDeepBody.error.code, -32600);
    assert.equal(rendererBridge.calls.length, 0);
  } finally {
    await host.stop();
  }
});

test('applies backpressure before dispatch when the authenticated request limit is saturated', async () => {
  const rendererBridge = makeBridge();
  const host = await startMcpHttpServer({
    rendererBridge,
    token: 'backpressure-token',
    port: 0,
    maxConcurrentRequests: 1,
  });
  const target = new URL(host.url);
  const heldRequest = http.request({
    hostname: target.hostname,
    port: target.port,
    path: target.pathname,
    method: 'POST',
    headers: {
      Authorization: 'Bearer backpressure-token',
      'Content-Type': 'application/json',
      'Content-Length': '64',
    },
  });
  heldRequest.on('error', () => {});
  heldRequest.write('{');

  try {
    await new Promise(resolve => setTimeout(resolve, 20));
    const saturated = await fetch(host.url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer backpressure-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    assert.equal(saturated.status, 429);
    assert.equal(saturated.headers.get('retry-after'), '1');
    const saturatedBody = await saturated.json();
    assert.equal(saturatedBody.error.code, -32002);
    assert.equal(rendererBridge.calls.length, 0);
  } finally {
    heldRequest.destroy();
    await host.stop();
  }
});

test('official MCP client calls desktop capture and preview input without renderer dispatch', async () => {
  const rendererBridge = makeBridge();
  const desktopCalls = [];
  const desktopCommandRegistry = createDesktopCommandRegistry({
    windowCaptureService: {
      listWindows: () => [{ windowId: 8, previewWindow: true }],
      capture: async input => {
        desktopCalls.push(['capture', input]);
        return {
          windowId: Number(input.windowId),
          mimeType: 'image/png',
          data: Buffer.from('desktop-png'),
        };
      },
    },
    previewInteractionService: {
      sendInput: input => {
        desktopCalls.push(['sendInput', input]);
        return { sent: true, windowId: input.previewWindowId };
      },
      sendSequence: async input => ({ sent: true, steps: input.steps.length }),
      resetInput: input => ({ reset: true, windowId: input.previewWindowId }),
      sendTouch: input => ({ sent: true, windowId: input.previewWindowId }),
      sendGamepad: input => ({ sent: true, windowId: input.previewWindowId }),
      getRuntimeStatus: input => ({
        installed: true,
        windowId: input.previewWindowId,
      }),
      resetRuntime: input => ({ reset: true, windowId: input.previewWindowId }),
    },
  });
  const token = 'desktop-token';
  const host = await startMcpHttpServer({
    rendererBridge,
    desktopCommandRegistry,
    token,
    port: 0,
  });
  const client = await connectClient({ url: host.url, token });

  try {
    const tools = await client.listTools();
    assert.equal(
      tools.tools.some(tool => tool.name === 'desktop.window.capture'),
      true
    );
    assert.equal(
      tools.tools.some(tool => tool.name === 'preview.input.send'),
      true
    );

    const capture = await client.callTool({
      name: 'desktop.window.capture',
      arguments: { windowId: 8 },
    });
    assert.equal(capture.content[0].type, 'image');
    assert.equal(
      capture.content[0].data,
      Buffer.from('desktop-png').toString('base64')
    );
    assert.equal(capture.content[0].mimeType, 'image/png');
    assert.equal(capture.structuredContent.data.windowId, 8);
    assert.equal(capture.structuredContent.data.byteLength, 11);
    assert.equal('imageBuffer' in capture.structuredContent.data, false);

    const input = await client.callTool({
      name: 'preview.input.send',
      arguments: {
        previewWindowId: 8,
        event: { type: 'keyDown', keyCode: 'W' },
      },
    });
    assert.equal(input.structuredContent.data.sent, true);
    assert.deepEqual(desktopCalls.map(call => call[0]), [
      'capture',
      'sendInput',
    ]);
    assert.equal(
      rendererBridge.calls.some(
        call =>
          call.command === 'desktop.window.capture' ||
          call.command === 'preview.input.send'
      ),
      false
    );
  } finally {
    await client.close();
    await host.stop();
  }
});
