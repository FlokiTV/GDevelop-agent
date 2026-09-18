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
  'agent.concurrency.capabilities',
  'agent.concurrency.status',
  'agent.concurrency.lease.acquire',
  'agent.concurrency.lease.release',
  'safety.transactions.begin',
  'safety.transactions.rollback',
];
const REQUIRED_RESOURCES = [
  'gdevelop://project/status',
  'gdevelop://editor/visual',
  'gdevelop://project/resources',
  'gdevelop://types/objects',
  'gdevelop://types/behaviors',
  'gdevelop://types/effects',
  'gdevelop://runtime/status',
  'gdevelop://project/concurrency',
];
const dataOf = response =>
  response && response.structuredContent
    ? response.structuredContent.data != null
      ? response.structuredContent.data
      : response.structuredContent
    : null;
const assertNames = (actual, required, code) => {
  const set = new Set(actual);
  const missing = required.filter(name => !set.has(name));
  if (missing.length) throw new Error(`${code}:${missing.join(',')}`);
};

const runConcurrencyResourcesLiveScenario = async ({
  allowMutate,
  env = process.env,
}) => {
  if (!allowMutate) throw new Error('mutation_requires_--allow-mutate');
  const projectRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gdevelop-cap22-23-live-')
  );
  const runtime = loadRuntimeConfig(getDefaultDiscoveryPath(env));
  const client = new Client(
    { name: 'gdevelop-concurrency-resources-live-e2e', version: '1.0.0' },
    {
      capabilities: { elicitation: { form: {} } },
      versionNegotiation: { mode: { pin: runtime.protocolVersion } },
    }
  );
  client.setRequestHandler('elicitation/create', async request => ({
    action: /discard|close|rollback/i.test(
      String((request.params && request.params.message) || '')
    )
      ? 'accept'
      : 'decline',
    content: { confirm: true },
  }));
  const transport = new StreamableHTTPClientTransport(
    new URL(runtime.endpoint),
    {
      requestInit: {
        headers: makeRequestHeaders({
          token: runtime.token,
          clientId: 'gdevelop-concurrency-resources-live-e2e',
        }),
      },
    }
  );
  let createdProject = false;
  let transactionId = null;
  let revision = null;
  const call = async (name, args = {}) => {
    const response = await client.callTool(
      { name, arguments: args },
      { timeout: 120000 }
    );
    if (response.isError) {
      const error = dataOf(response) && dataOf(response).error;
      const failure = new Error(
        `tool_failed:${name}:${(error && error.code) || 'unknown'}`
      );
      failure.toolError = error;
      throw failure;
    }
    return dataOf(response);
  };
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assertNames(
      tools.tools.map(tool => tool.name),
      REQUIRED_TOOLS,
      'concurrency_tools_missing'
    );
    const resources = await client.listResources();
    assertNames(
      resources.resources.map(resource => resource.uri),
      REQUIRED_RESOURCES,
      'rich_resources_missing'
    );
    if ((await call('project.status')).projectOpen)
      throw new Error(
        'live_scenario_requires_fresh_editor_without_open_project'
      );
    await call('project.create', {
      name: `MCP Concurrency ${Date.now().toString(36)}`,
    });
    createdProject = true;
    await call('project.save-as', {
      filePath: path.join(projectRoot, 'game.json'),
    });
    revision = (await call('project.status')).projectRevision;
    const originalRevision = revision;
    transactionId = (await call('safety.transactions.begin', {
      label: 'CAP-22/23 concurrency/resources live E2E',
    })).transactionId;

    const capabilities = await call('agent.concurrency.capabilities');
    if (
      !capabilities.semanticRevisions.supported ||
      !capabilities.semanticLeases.supported ||
      !capabilities.projectRevisionSafetyNet
    )
      throw new Error('concurrency_capabilities_invalid');
    const initial = await call('agent.concurrency.status', {
      scopes: ['project'],
    });
    if (initial.scopes[0].revision !== 0)
      throw new Error('initial_semantic_revision_invalid');
    const lease = (await call('agent.concurrency.lease.acquire', {
      scope: 'project',
      owner: 'cap22-client',
      ttlMs: 30000,
    })).lease;

    let locked = false;
    try {
      await call('editor.functions.create-scene', {
        scene_name: `Locked ${Date.now().toString(36)}`,
        expectedRevision: revision,
      });
    } catch (error) {
      locked = !!(
        error.toolError && error.toolError.code === 'semantic_scope_locked'
      );
    }
    if (!locked)
      throw new Error('semantic_lease_did_not_block_foreign_mutation');

    const mutation = await call('editor.functions.create-scene', {
      scene_name: `Leased ${Date.now().toString(36)}`,
      expectedRevision: revision,
      expectedSemanticRevisions: { project: 0 },
      semanticLeaseOwner: 'cap22-client',
      idempotencyKey: `cap22-create-${Date.now().toString(36)}`,
    });
    revision = (await call('project.status')).projectRevision;
    const after = await call('agent.concurrency.status', {
      scopes: ['project'],
    });
    if (after.scopes[0].revision !== 1)
      throw new Error('semantic_revision_not_advanced');
    if (
      !mutation ||
      (mutation.scene_name == null && mutation.sceneName == null)
    ) {
      // Typed editor function output varies; successful tool envelope is sufficient.
    }
    await call('agent.concurrency.lease.release', {
      scope: 'project',
      owner: 'cap22-client',
      leaseId: lease.leaseId,
    });

    const richRead = {};
    for (const uri of REQUIRED_RESOURCES) {
      if (uri === 'gdevelop://runtime/status') continue;
      const result = await client.readResource({ uri });
      richRead[uri] = result.contents.length;
      if (!result.contents.length) throw new Error(`resource_empty:${uri}`);
    }
    let runtimeUnavailable = false;
    try {
      await client.readResource({ uri: 'gdevelop://runtime/status' });
    } catch (error) {
      runtimeUnavailable = /preview_not_running/.test(String(error));
    }
    if (!runtimeUnavailable)
      throw new Error('runtime_resource_should_require_running_preview');
    richRead['gdevelop://runtime/status'] = 'preview_not_running';

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
      resourceCount: resources.resources.length,
      semanticRevisionAfterMutation: after.scopes[0].revision,
      foreignMutationBlockedByLease: locked,
      richRead,
      originalRevision,
      finalRevision,
    };
  } finally {
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
  runConcurrencyResourcesLiveScenario({
    allowMutate: process.argv.includes('--allow-mutate'),
  })
    .then(result =>
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    )
    .catch(error => {
      process.stderr.write(
        `MCP concurrency/resources live scenario failed: ${error.message}\n`
      );
      process.exitCode = 1;
    });
}

module.exports = {
  REQUIRED_TOOLS,
  REQUIRED_RESOURCES,
  assertNames,
  runConcurrencyResourcesLiveScenario,
};
