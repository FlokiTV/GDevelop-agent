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

const TYPED_TOOLS = [
  'editor.functions.create-scene',
  'editor.functions.create-object',
  'editor.functions.put-2d-instances',
  'editor.functions.describe-instances',
  'editor.functions.inspect-scene-properties-layers-effects',
  'editor.functions.read-scene-events',
];

const getData = response =>
  response && response.structuredContent
    ? response.structuredContent.data != null
      ? response.structuredContent.data
      : response.structuredContent
    : null;

const getMeta = response =>
  response && response.structuredContent && response.structuredContent.meta
    ? response.structuredContent.meta
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

const assertRequiredTools = tools => {
  const byName = new Map(tools.map(tool => [tool.name, tool]));
  [
    ...TYPED_TOOLS,
    'editor.functions.call',
    'editor.types.objects.list',
  ].forEach(name => {
    if (!byName.has(name)) throw new Error(`typed_tool_missing:${name}`);
  });

  const createScene = byName.get('editor.functions.create-scene');
  if (
    !createScene.inputSchema ||
    !Array.isArray(createScene.inputSchema.required) ||
    !createScene.inputSchema.required.includes('scene_name') ||
    !createScene.inputSchema.properties ||
    !createScene.inputSchema.properties.scene_name ||
    createScene.inputSchema.properties.scene_name.type !== 'string' ||
    createScene.inputSchema.properties.arguments
  ) {
    throw new Error('typed_create_scene_schema_invalid');
  }
  if (
    !createScene.annotations ||
    createScene.annotations.readOnlyHint !== false
  ) {
    throw new Error('typed_create_scene_metadata_invalid');
  }

  const describeInstances = byName.get('editor.functions.describe-instances');
  if (
    !describeInstances.annotations ||
    describeInstances.annotations.readOnlyHint !== true
  ) {
    throw new Error('typed_describe_instances_metadata_invalid');
  }
  return byName;
};

const runTypedEditorFunctionsLiveScenario = async ({
  allowMutate,
  rollback = true,
  outputDir = path.resolve(
    process.cwd(),
    'artifacts',
    'mcp-typed-editor-functions-live-e2e'
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
    { name: 'gdevelop-typed-editor-functions-live-e2e', version: '1.0.0' },
    { versionNegotiation: { mode: { pin: runtime.protocolVersion } } }
  );
  const transport = new StreamableHTTPClientTransport(
    new URL(runtime.endpoint),
    {
      requestInit: {
        headers: makeRequestHeaders({
          token: runtime.token,
          clientId: 'gdevelop-typed-editor-functions-live-e2e',
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
    const meta = sanitizeForReplay(getMeta(response));
    replay.push({ name, args: sanitizeForReplay(args), data, meta });
    if (response.isError) {
      const error = new Error(`tool_failed:${name}`);
      error.response = response;
      throw error;
    }
    if (
      name.startsWith('editor.functions.') &&
      name !== 'editor.functions.call' &&
      data &&
      Array.isArray(data.results) &&
      data.results.some(result => result && result.success === false)
    ) {
      const failure = data.results.find(
        result => result && result.success === false
      );
      throw new Error(
        `typed_editor_function_failed:${name}:${
          failure && failure.output && failure.output.message
            ? failure.output.message
            : 'unknown'
        }`
      );
    }
    return { response, data, meta };
  };

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const byName = assertRequiredTools(tools.tools);
    const typedToolCount = tools.tools.filter(tool =>
      /^editor\.functions\.(?!list$|describe$|call$|call-batch$)/.test(
        tool.name
      )
    ).length;
    if (typedToolCount < 30) {
      throw new Error(`typed_tool_count_too_small:${typedToolCount}`);
    }

    if (openProjectPath) {
      await call('project.open', { filePath: openProjectPath });
      await wait(800);
    }

    let initial = await call('project.status');
    let createdProjectByScenario = false;
    if (!initial.data || !initial.data.projectOpen) {
      await call('project.create', {
        name: `MCP Typed Acceptance ${Date.now().toString(36)}`,
      });
      await wait(800);
      initial = await call('project.status');
      createdProjectByScenario = true;
    }
    if (!initial.data || !initial.data.projectOpen)
      throw new Error('no_project_open');
    const originalRevision = initial.data.projectRevision;
    const originalSceneNames = Array.isArray(initial.data.sceneNames)
      ? initial.data.sceneNames.slice()
      : [];
    const originalScene = originalSceneNames[0] || null;

    const objectTypes = await call('editor.types.objects.list', {
      deprecated: 'exclude',
      renderingMode: '2d',
      limit: 100,
    });
    const objectTypeItems = objectTypes.data.items || [];
    const objectType =
      objectTypeItems.find(
        item =>
          item &&
          item.kind === 'object' &&
          item.renderingMode === '2d' &&
          item.type === 'Sprite'
      ) ||
      objectTypeItems.find(
        item => item && item.kind === 'object' && item.renderingMode === '2d'
      );
    if (!objectType || !objectType.type)
      throw new Error('discoverable_2d_object_type_not_found');

    const transaction = await call('safety.transactions.begin', {
      label: 'Typed EditorFunctions CAP-08 live E2E reversible scenario',
    });
    transactionId = transaction.data.transactionId;
    if (!transactionId) throw new Error('transaction_id_missing');

    const suffix = Date.now().toString(36);
    const sceneName = `MCP Typed ${suffix}`;
    const objectName = `McpTypedObject${suffix}`;
    let revision = originalRevision;

    const mutate = async (name, args) => {
      if (!TYPED_TOOLS.includes(name)) {
        throw new Error(`non_typed_mutation_not_allowed:${name}`);
      }
      const result = await call(name, {
        ...args,
        expectedRevision: revision,
        idempotencyKey: `typed-live-${suffix}-${replay.length}`,
      });
      if (result.meta && Number.isInteger(result.meta.projectRevision)) {
        revision = result.meta.projectRevision;
      } else {
        const status = await call('project.status');
        revision = status.data.projectRevision;
      }
      return result;
    };

    await mutate('editor.functions.create-scene', { scene_name: sceneName });
    await call('scene.open', { sceneName, mode: 'scene' });
    await wait(400);

    await mutate('editor.functions.create-object', {
      scene_name: sceneName,
      object_name: objectName,
      object_type: objectType.type,
      description:
        'Temporary object created only through a typed MCP EditorFunction tool',
    });
    await mutate('editor.functions.put-2d-instances', {
      scene_name: sceneName,
      layer_name: '',
      brush_kind: 'point',
      brush_position: '480,320',
      object_name: objectName,
      new_instances_count: 1,
    });

    const instances = await call('editor.functions.describe-instances', {
      scene_name: sceneName,
      filter_by_object_name: objectName,
    });
    const instanceResult = instances.data.results && instances.data.results[0];
    if (!instanceResult || instanceResult.success !== true) {
      throw new Error('typed_describe_instances_failed');
    }

    const sceneInspection = await call(
      'editor.functions.inspect-scene-properties-layers-effects',
      { scene_name: sceneName }
    );
    if (!sceneInspection.data.results || !sceneInspection.data.results.length) {
      throw new Error('typed_scene_inspection_missing');
    }

    const eventRead = await call('editor.functions.read-scene-events', {
      scene_name: sceneName,
    });
    if (!eventRead.data.results || !eventRead.data.results.length) {
      throw new Error('typed_scene_events_missing');
    }

    const validation = await call('validation.run', {
      includeNativeReport: false,
      includeAssets: false,
    });
    if (!validation.data || validation.data.ok !== true) {
      throw new Error('project_validation_failed');
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
      await wait(attempt === 0 ? 1200 : 400);
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
        `runtime_typed_object_evidence_missing:${
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
      if (originalScene) {
        await call('scene.open', { sceneName: originalScene, mode: 'scene' });
      }
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
    if (rollback && finalStatus.data.projectRevision !== originalRevision) {
      throw new Error(
        `rollback_revision_mismatch:${originalRevision}:${
          finalStatus.data.projectRevision
        }`
      );
    }

    const genericCallUsed = replay.some(
      entry => entry.name === 'editor.functions.call'
    );
    if (genericCallUsed) throw new Error('generic_editor_function_call_used');

    const result = {
      ok: true,
      rollback,
      createdProjectByScenario,
      protocolVersion: client.getNegotiatedProtocolVersion(),
      toolCatalog: {
        total: tools.tools.length,
        typedEditorFunctions: typedToolCount,
        createSceneRequired: byName.get('editor.functions.create-scene')
          .inputSchema.required,
      },
      discoveredObjectType: objectType.type,
      mutation: { sceneName, objectName },
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
      typedCalls: replay
        .filter(entry => TYPED_TOOLS.includes(entry.name))
        .map(entry => entry.name),
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
      'Usage: node AgentIntegration/scripts/McpTypedEditorFunctionsLiveScenario.js --allow-mutate [options]',
      '',
      'Exercises CAP-08 typed EditorFunction MCP tools directly against the live editor, previews the temporary scene, verifies runtime state and rolls back by default. The generic editor.functions.call tool is discovered for compatibility but is never used for authoring.',
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
    const result = await runTypedEditorFunctionsLiveScenario(options);
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: result.ok,
          rollback: result.rollback,
          createdProjectByScenario: result.createdProjectByScenario,
          protocolVersion: result.protocolVersion,
          toolCatalog: result.toolCatalog,
          discoveredObjectType: result.discoveredObjectType,
          mutation: result.mutation,
          runtimeEvidence: result.runtimeEvidence,
          typedCalls: result.typedCalls,
          originalRevision: result.originalRevision,
          finalRevision: result.finalRevision,
        },
        null,
        2
      )}\n`
    );
  })().catch(error => {
    process.stderr.write(
      `MCP typed EditorFunctions live scenario failed: ${
        error && error.message ? error.message : String(error)
      }\n`
    );
    process.exitCode = 1;
  });
}

module.exports = {
  TYPED_TOOLS,
  assertRequiredTools,
  parseArgs,
  runTypedEditorFunctionsLiveScenario,
};
