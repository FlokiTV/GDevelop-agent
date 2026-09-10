const fs = require('fs');
const path = require('path');
const {
  Client,
  StreamableHTTPClientTransport,
} = require('@modelcontextprotocol/client');
const {
  getDefaultDiscoveryPath,
  loadRuntimeConfig,
  makeRequestHeaders,
  sanitizeForReplay,
} = require('./McpLiveGate');

const getData = response =>
  response && response.structuredContent
    ? response.structuredContent.data != null
      ? response.structuredContent.data
      : response.structuredContent
    : null;
const wait = delayMs => new Promise(resolve => setTimeout(resolve, delayMs));

const parseArgs = argv => {
  const options = { rollback: true };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--allow-mutate') options.allowMutate = true;
    else if (argument === '--persist') options.rollback = false;
    else if (argument === '--output') options.outputDir = argv[++index];
    else if (argument === '--window-id') options.windowId = argv[++index];
    else if (argument === '--project-path') options.projectPath = argv[++index];
    else if (argument === '--open-project-path')
      options.openProjectPath = argv[++index];
    else if (argument === '--help') options.help = true;
    else throw new Error(`unknown_argument:${argument}`);
  }
  return options;
};

const REQUIRED_TOOLS = [
  'docs.search',
  'docs.read',
  'store.objects.search',
  'store.objects.inspect',
  'store.objects.import',
  'store.resources.search',
  'store.resources.inspect',
  'store.resources.import',
];

const assertRequiredTools = tools => {
  const toolNames = new Set((tools || []).map(tool => tool.name));
  const missing = REQUIRED_TOOLS.filter(name => !toolNames.has(name));
  if (missing.length)
    throw new Error(`docs_store_tools_missing:${missing.join(',')}`);
  return true;
};

const firstResult = result =>
  result && Array.isArray(result.results) && result.results.length
    ? result.results[0]
    : null;

const runDocsStoreLiveScenario = async ({
  allowMutate,
  rollback = true,
  outputDir = path.resolve(
    process.cwd(),
    'artifacts',
    'mcp-docs-store-live-e2e'
  ),
  windowId,
  projectPath,
  openProjectPath,
  env = process.env,
}) => {
  if (!allowMutate) throw new Error('mutation_requires_--allow-mutate');
  fs.mkdirSync(outputDir, { recursive: true });

  const runtime = loadRuntimeConfig(getDefaultDiscoveryPath(env));
  const client = new Client(
    { name: 'gdevelop-docs-store-live-e2e', version: '1.0.0' },
    { versionNegotiation: { mode: { pin: runtime.protocolVersion } } }
  );
  const transport = new StreamableHTTPClientTransport(
    new URL(runtime.endpoint),
    {
      requestInit: {
        headers: makeRequestHeaders({
          token: runtime.token,
          clientId: 'gdevelop-docs-store-live-e2e',
          windowId,
          projectPath,
        }),
      },
    }
  );

  const replay = [];
  let transactionId = null;
  let previewStartedByScenario = false;
  const call = async (name, args = {}) => {
    const response = await client.callTool({ name, arguments: args });
    const data = sanitizeForReplay(getData(response));
    replay.push({ name, args: sanitizeForReplay(args), data });
    if (response.isError) {
      const toolError = data && data.error ? data.error : null;
      const error = new Error(
        `tool_failed:${name}:${
          toolError && toolError.code ? toolError.code : 'unknown'
        }:${toolError && toolError.message ? toolError.message : 'no_message'}`
      );
      error.response = response;
      throw error;
    }
    if (
      name === 'editor.functions.call' &&
      data &&
      Array.isArray(data.results) &&
      data.results.some(result => result && result.success === false)
    ) {
      const failure = data.results.find(
        result => result && result.success === false
      );
      throw new Error(
        `editor_function_failed:${
          failure && failure.output && failure.output.message
            ? failure.output.message
            : 'unknown'
        }`
      );
    }
    return { response, data };
  };

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assertRequiredTools(tools.tools);

    if (openProjectPath) {
      await call('project.open', { filePath: openProjectPath });
      await wait(800);
    }

    let initial = await call('project.status');
    let createdProjectByScenario = false;
    if (!initial.data || !initial.data.projectOpen) {
      await call('project.create', {
        name: `MCP Docs Store Acceptance ${Date.now().toString(36)}`,
      });
      await wait(800);
      initial = await call('project.status');
      createdProjectByScenario = true;
    }
    if (!initial.data || !initial.data.projectOpen)
      throw new Error('no_project_open');
    const originalRevision = initial.data.projectRevision;
    const originalScene =
      Array.isArray(initial.data.sceneNames) && initial.data.sceneNames.length
        ? initial.data.sceneNames[0]
        : null;

    const docsSearch = await call('docs.search', {
      query: 'Sprite object animations',
      limit: 5,
      timeoutMs: 20000,
    });
    const docResult = firstResult(docsSearch.data);
    if (!docResult || !docResult.url)
      throw new Error('documentation_search_empty');
    const docsRead = await call('docs.read', {
      url: docResult.url,
      maxChars: 7000,
      timeoutMs: 20000,
    });
    if (
      !docsRead.data ||
      !docsRead.data.text ||
      docsRead.data.text.length < 100
    ) {
      throw new Error('documentation_read_too_short');
    }

    const objectSearch = await call('store.objects.search', {
      query: 'player',
      objectType: 'sprite',
      limit: 10,
      timeoutMs: 30000,
    });
    const asset = firstResult(objectSearch.data);
    if (!asset || !asset.assetId) throw new Error('object_store_search_empty');
    const objectInspect = await call('store.objects.inspect', {
      assetId: asset.assetId,
      timeoutMs: 30000,
    });
    if (
      !objectInspect.data ||
      !objectInspect.data.asset ||
      objectInspect.data.asset.assetId !== asset.assetId ||
      !objectInspect.data.provenance
    ) {
      throw new Error('object_store_inspect_invalid');
    }

    let resource = null;
    let resourceSearch = null;
    for (const query of ['music', 'sound', 'click', 'jump']) {
      resourceSearch = await call('store.resources.search', {
        query,
        limit: 10,
        timeoutMs: 30000,
      });
      resource = firstResult(resourceSearch.data);
      if (resource && resource.url) break;
    }
    if (!resource || !resource.url)
      throw new Error('resource_store_search_empty');
    const resourceInspect = await call('store.resources.inspect', {
      resourceUrl: resource.url,
      timeoutMs: 30000,
    });
    if (
      !resourceInspect.data ||
      !resourceInspect.data.resource ||
      resourceInspect.data.resource.url !== resource.url ||
      !resourceInspect.data.provenance
    ) {
      throw new Error('resource_store_inspect_invalid');
    }

    const transaction = await call('safety.transactions.begin', {
      label: 'Docs and store live E2E reversible scenario',
    });
    transactionId = transaction.data.transactionId;
    if (!transactionId) throw new Error('transaction_id_missing');

    const suffix = Date.now().toString(36);
    const sceneName = `MCP Store ${suffix}`;
    const objectName = `McpStoreObject${suffix}`;
    const resourceName = `mcp-store-${suffix}-${resource.name || 'resource'}`;
    let revision = originalRevision;

    const mutate = async (name, args) => {
      const result = await call(name, {
        ...args,
        expectedRevision: revision,
        idempotencyKey: `docs-store-${suffix}-${replay.length}`,
      });
      if (
        result.response &&
        result.response.structuredContent &&
        result.response.structuredContent.meta &&
        Number.isInteger(result.response.structuredContent.meta.projectRevision)
      ) {
        revision = result.response.structuredContent.meta.projectRevision;
      } else {
        const status = await call('project.status');
        revision = status.data.projectRevision;
      }
      return result;
    };

    await mutate('editor.functions.call', {
      name: 'create_scene',
      arguments: { scene_name: sceneName },
    });
    await call('scene.open', { sceneName, mode: 'scene' });
    await wait(500);

    const importedObject = await mutate('store.objects.import', {
      assetId: asset.assetId,
      sceneName,
      objectName,
      targetScope: 'scene',
      timeoutMs: 30000,
    });
    if (
      !importedObject.data ||
      !importedObject.data.importedAsset ||
      importedObject.data.importedAsset.assetId !== asset.assetId
    ) {
      throw new Error('object_store_import_invalid');
    }

    const importedResource = await mutate('store.resources.import', {
      resourceUrl: resource.url,
      resourceName,
      timeoutMs: 30000,
    });
    if (
      !importedResource.data ||
      !importedResource.data.imported ||
      !importedResource.data.provenance
    ) {
      throw new Error('resource_store_import_invalid');
    }

    await mutate('editor.functions.call', {
      name: 'put_2d_instances',
      arguments: {
        scene_name: sceneName,
        layer_name: '',
        brush_kind: 'point',
        brush_position: '480,320',
        object_name: objectName,
        new_instances_count: 1,
      },
    });

    const validation = await call('validation.run', {
      includeNativeReport: false,
      includeAssets: true,
    });
    if (!validation.data || validation.data.ok !== true) {
      throw new Error('project_validation_failed_after_store_import');
    }

    const previewBefore = await call('preview.status');
    if (previewBefore.data && previewBefore.data.running) {
      await call('preview.close-all');
      await wait(300);
    }
    await call('preview.start', { numberOfWindows: 1 });
    previewStartedByScenario = true;

    let snapshot = null;
    let lastSnapshotError = null;
    for (let attempt = 0; attempt < 20; attempt++) {
      await wait(attempt === 0 ? 1400 : 400);
      try {
        const candidate = await call('runtime.snapshot', {
          objectNames: [objectName],
          maxInstances: 5,
        });
        const objectSnapshot =
          candidate.data && candidate.data.objects
            ? candidate.data.objects[objectName]
            : null;
        if (
          candidate.data &&
          candidate.data.scene &&
          candidate.data.scene.name === sceneName &&
          objectSnapshot &&
          objectSnapshot.count >= 1
        ) {
          snapshot = candidate.data;
          break;
        }
      } catch (error) {
        lastSnapshotError = error;
      }
    }
    if (!snapshot) {
      throw new Error(
        `runtime_store_asset_evidence_missing:${
          lastSnapshotError && lastSnapshotError.message
            ? lastSnapshotError.message
            : 'preview_snapshot_not_ready'
        }`
      );
    }

    await call('preview.close-all');
    previewStartedByScenario = false;

    if (rollback) {
      await call('safety.transactions.rollback', { transactionId });
      transactionId = null;
      if (originalScene)
        await call('scene.open', { sceneName: originalScene, mode: 'scene' });
    } else {
      await call('safety.transactions.commit', { transactionId });
      transactionId = null;
    }

    const finalStatus = await call('project.status');
    if (
      rollback &&
      Array.isArray(finalStatus.data.sceneNames) &&
      finalStatus.data.sceneNames.includes(sceneName)
    ) {
      throw new Error('rollback_left_temporary_scene');
    }

    const result = {
      ok: true,
      rollback,
      createdProjectByScenario,
      protocolVersion: client.getNegotiatedProtocolVersion(),
      documentation: {
        query: docsSearch.data.query,
        title: docResult.title,
        url: docResult.url,
        readCharacters: docsRead.data.text.length,
        source: docsRead.data.source,
      },
      objectStore: {
        assetId: asset.assetId,
        name: asset.name,
        objectType: asset.objectType,
        license: objectInspect.data.asset.licenseDetails || asset.license,
        provenance: objectInspect.data.provenance,
      },
      resourceStore: {
        name: resource.name,
        url: resource.url,
        kind: resource.kind,
        importedAs: resourceName,
        provenance: resourceInspect.data.provenance,
      },
      mutation: { sceneName, objectName, resourceName },
      runtimeEvidence: {
        sceneName: snapshot.scene && snapshot.scene.name,
        objectCount:
          snapshot.objects && snapshot.objects[objectName]
            ? snapshot.objects[objectName].count
            : 0,
      },
      originalRevision,
      finalRevision: finalStatus.data.projectRevision,
      validation: validation.data,
      replay,
    };
    fs.writeFileSync(
      path.join(outputDir, 'replay.json'),
      `${JSON.stringify(result, null, 2)}\n`
    );
    return result;
  } catch (error) {
    if (previewStartedByScenario) {
      try {
        await call('preview.close-all');
      } catch (_) {}
    }
    if (transactionId) {
      try {
        await call('safety.transactions.rollback', { transactionId });
      } catch (_) {}
    }
    throw error;
  } finally {
    await client.close();
  }
};

const printHelp = () => {
  process.stdout.write(
    [
      'Usage: node AgentIntegration/scripts/McpDocsStoreLiveScenario.js --allow-mutate [options]',
      '',
      'Uses standalone docs and public store discovery, imports a real object asset and resource into a temporary scene/project state, verifies the object in preview runtime, then rolls back by default.',
      '',
      'Options:',
      '  --allow-mutate            Required explicit opt-in.',
      '  --persist                 Commit instead of rolling back.',
      '  --output <dir>            Sanitized replay directory.',
      '  --window-id <id>          Optional editor targeting header.',
      '  --project-path <path>     Optional project targeting header.',
      '  --open-project-path <p>   Open this local project through MCP before running.',
      '  --help                    Show help.',
      '',
    ].join('\n')
  );
};

if (require.main === module) {
  (async () => {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) return printHelp();
    const result = await runDocsStoreLiveScenario(options);
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: result.ok,
          rollback: result.rollback,
          protocolVersion: result.protocolVersion,
          documentation: result.documentation,
          objectStore: result.objectStore,
          resourceStore: result.resourceStore,
          runtimeEvidence: result.runtimeEvidence,
          originalRevision: result.originalRevision,
          finalRevision: result.finalRevision,
        },
        null,
        2
      )}\n`
    );
  })().catch(error => {
    process.stderr.write(
      `MCP docs/store live scenario failed: ${
        error && error.message ? error.message : String(error)
      }\n`
    );
    process.exitCode = 1;
  });
}

module.exports = {
  REQUIRED_TOOLS,
  assertRequiredTools,
  parseArgs,
  runDocsStoreLiveScenario,
};
