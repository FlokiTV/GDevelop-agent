const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  Client,
  StreamableHTTPClientTransport,
} = require('@modelcontextprotocol/client');
const {
  getDefaultDiscoveryPath,
  loadRuntimeConfig,
  makeRequestHeaders,
} = require('./McpLiveGate');

const REQUIRED_TOOLS = [
  'project.status',
  'project.create',
  'project.save-as',
  'project.close',
  'editor.functions.create-scene',
  'preview.start',
  'preview.close-all',
  'desktop.windows.list',
  'preview.multiplayer.capabilities',
  'preview.multiplayer.clients.assign',
  'preview.multiplayer.runtime-status',
  'preview.multiplayer.batch',
  'preview.network.capabilities',
  'preview.network.capture.start',
  'preview.network.capture.status',
  'preview.network.capture.read',
  'preview.network.capture.stop',
  'safety.transactions.begin',
  'safety.transactions.rollback',
];
const getData = response =>
  response && response.structuredContent
    ? response.structuredContent.data != null
      ? response.structuredContent.data
      : response.structuredContent
    : null;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const findPreviewWindows = windows =>
  (windows || []).filter(
    window => window && window.previewWindow && window.visible
  );
const assertRequiredTools = tools => {
  const names = new Set((tools || []).map(tool => tool.name));
  const missing = REQUIRED_TOOLS.filter(name => !names.has(name));
  if (missing.length)
    throw new Error(`multiplayer_network_tools_missing:${missing.join(',')}`);
};

const runMultiplayerNetworkLiveScenario = async ({
  allowMutate,
  env = process.env,
}) => {
  if (!allowMutate) throw new Error('mutation_requires_--allow-mutate');
  const projectRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gdevelop-cap20-21-live-')
  );
  const runtime = loadRuntimeConfig(getDefaultDiscoveryPath(env));
  const client = new Client(
    { name: 'gdevelop-multiplayer-network-live-e2e', version: '1.0.0' },
    {
      capabilities: { elicitation: { form: {} } },
      versionNegotiation: { mode: { pin: runtime.protocolVersion } },
    }
  );
  client.setRequestHandler('elicitation/create', async request => {
    const message = String((request.params && request.params.message) || '');
    return /discard|close|rollback/i.test(message)
      ? { action: 'accept', content: { confirm: true } }
      : { action: 'decline' };
  });
  const transport = new StreamableHTTPClientTransport(
    new URL(runtime.endpoint),
    {
      requestInit: {
        headers: makeRequestHeaders({
          token: runtime.token,
          clientId: 'gdevelop-multiplayer-network-live-e2e',
        }),
      },
    }
  );
  let createdProject = false;
  let previewStarted = false;
  let transactionId = null;
  let revision = null;
  const call = async (name, args = {}) => {
    const response = await client.callTool(
      { name, arguments: args },
      { timeout: 120000 }
    );
    const data = getData(response);
    if (response.isError)
      throw new Error(
        `tool_failed:${name}:${(data && data.error && data.error.code) ||
          'unknown'}`
      );
    return data;
  };
  const mutate = async (name, args) => {
    const data = await call(name, {
      ...args,
      ...(Number.isInteger(revision) ? { expectedRevision: revision } : {}),
      idempotencyKey: `cap20-21-${Date.now().toString(36)}`,
    });
    revision = (await call('project.status')).projectRevision;
    return data;
  };

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assertRequiredTools(tools.tools);
    if ((await call('project.status')).projectOpen)
      throw new Error(
        'live_scenario_requires_fresh_editor_without_open_project'
      );
    await call('project.create', {
      name: `MCP Multiplayer ${Date.now().toString(36)}`,
    });
    createdProject = true;
    await wait(1000);
    await call('project.save-as', {
      filePath: path.join(projectRoot, 'game.json'),
    });
    revision = (await call('project.status')).projectRevision;
    const originalRevision = revision;
    transactionId = (await call('safety.transactions.begin', {
      label: 'CAP-20/21 multiplayer/network live E2E',
    })).transactionId;
    await mutate('editor.functions.create-scene', {
      scene_name: `Multiplayer ${Date.now().toString(36)}`,
    });

    const multiplayerCapabilities = await call(
      'preview.multiplayer.capabilities'
    );
    const networkCapabilities = await call('preview.network.capabilities');
    if (
      !multiplayerCapabilities.multiPreview.supported ||
      !multiplayerCapabilities.networkObservability.supported ||
      multiplayerCapabilities.networkShaping.supported !== false
    )
      throw new Error('multiplayer_capabilities_invalid');
    if (
      !networkCapabilities.supported ||
      !networkCapabilities.protocols.http ||
      !networkCapabilities.protocols.webSocket ||
      networkCapabilities.responseBodies !== false ||
      networkCapabilities.networkShaping.supported !== false
    )
      throw new Error('network_capabilities_invalid');

    await call('preview.start', { numberOfWindows: 2 });
    previewStarted = true;
    let previews = [];
    for (let attempt = 0; attempt < 60 && previews.length < 2; attempt++) {
      previews = findPreviewWindows(await call('desktop.windows.list'));
      if (previews.length < 2) await wait(250);
    }
    if (previews.length < 2)
      throw new Error(`preview_clients_timeout:${previews.length}`);
    previews = previews.sort((a, b) => a.windowId - b.windowId).slice(0, 2);
    const assigned = await call('preview.multiplayer.clients.assign', {
      clients: [
        { alias: 'host', previewWindowId: previews[0].windowId },
        { alias: 'guest', previewWindowId: previews[1].windowId },
      ],
    });
    if (assigned.clients.length !== 2)
      throw new Error('multiplayer_alias_assignment_invalid');

    const status = await call('preview.multiplayer.runtime-status', {
      aliases: ['host', 'guest'],
    });
    if (
      status.clients.length !== 2 ||
      status.clients.some(
        item => !item.runtime || item.runtime.installed !== true
      )
    )
      throw new Error('multiplayer_runtime_status_invalid');
    const batch = await call('preview.multiplayer.batch', {
      actions: [
        {
          alias: 'host',
          operation: 'input',
          event: { type: 'keyDown', keyCode: 'A' },
        },
        {
          alias: 'host',
          operation: 'input',
          event: { type: 'keyUp', keyCode: 'A' },
        },
        { alias: 'guest', operation: 'runtime-status' },
      ],
    });
    if (batch.results.length !== 3)
      throw new Error('multiplayer_batch_invalid');

    await call('preview.network.capture.start', {
      alias: 'host',
      maxEvents: 100,
    });
    await call('preview.multiplayer.batch', {
      actions: [{ alias: 'host', operation: 'runtime-status' }],
    });
    await wait(500);
    const captureStatus = await call('preview.network.capture.status', {
      alias: 'host',
    });
    const networkRead = await call('preview.network.capture.read', {
      alias: 'host',
      limit: 100,
    });
    const networkStop = await call('preview.network.capture.stop', {
      alias: 'host',
    });
    if (
      !captureStatus.active ||
      networkRead.active !== true ||
      networkStop.active !== false
    )
      throw new Error('network_capture_lifecycle_invalid');
    if (
      networkRead.events.some(
        event =>
          JSON.stringify(event).includes('Authorization') &&
          !JSON.stringify(event).includes('[REDACTED]')
      )
    )
      throw new Error('network_redaction_invalid');

    await call('preview.close-all');
    previewStarted = false;
    await call('safety.transactions.rollback', { transactionId });
    transactionId = null;
    const finalRevision = (await call('project.status')).projectRevision;
    if (finalRevision !== originalRevision)
      throw new Error(
        `rollback_revision_mismatch:${originalRevision}:${finalRevision}`
      );
    await call('project.close', { discardUnsavedChanges: true });
    createdProject = false;
    return {
      ok: true,
      protocolVersion: client.getNegotiatedProtocolVersion(),
      toolCount: tools.tools.length,
      previewWindowIds: previews.map(preview => preview.windowId),
      aliases: assigned.clients.map(item => item.alias),
      batchResults: batch.results.length,
      networkEvents: networkStop.events.length,
      networkDroppedEvents: networkStop.droppedEvents,
      networkTransport: networkCapabilities.transport,
      networkShapingSupported: networkCapabilities.networkShaping.supported,
      originalRevision,
      finalRevision,
    };
  } finally {
    if (previewStarted)
      try {
        await call('preview.close-all');
      } catch (_) {}
    if (transactionId)
      try {
        await call('safety.transactions.rollback', { transactionId });
      } catch (_) {}
    if (createdProject)
      try {
        await call('project.close', { discardUnsavedChanges: true });
      } catch (_) {}
    fs.rmSync(projectRoot, { recursive: true, force: true });
    await client.close();
  }
};

if (require.main === module) {
  runMultiplayerNetworkLiveScenario({
    allowMutate: process.argv.includes('--allow-mutate'),
  })
    .then(result =>
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    )
    .catch(error => {
      process.stderr.write(
        `MCP multiplayer/network live scenario failed: ${error.message}\n`
      );
      process.exitCode = 1;
    });
}

module.exports = {
  REQUIRED_TOOLS,
  assertRequiredTools,
  findPreviewWindows,
  runMultiplayerNetworkLiveScenario,
};
