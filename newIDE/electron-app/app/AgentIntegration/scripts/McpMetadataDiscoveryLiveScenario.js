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
  const options = {
    rollback: true,
    objectQuery: 'sprite',
    behaviorQuery: 'movement',
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--allow-mutate') options.allowMutate = true;
    else if (argument === '--persist') options.rollback = false;
    else if (argument === '--output') options.outputDir = argv[++index];
    else if (argument === '--window-id') options.windowId = argv[++index];
    else if (argument === '--project-path') options.projectPath = argv[++index];
    else if (argument === '--object-query') options.objectQuery = argv[++index];
    else if (argument === '--behavior-query')
      options.behaviorQuery = argv[++index];
    else if (argument === '--help') options.help = true;
    else throw new Error(`unknown_argument:${argument}`);
  }
  return options;
};

const isSimpleBehaviorCondition = condition => {
  if (!condition || condition.kind !== 'condition') return false;
  if (!condition.eventContexts || !condition.eventContexts.scene) return false;
  if (!condition.scope || condition.scope.kind !== 'behavior') return false;
  const parameters = Array.isArray(condition.parameters)
    ? condition.parameters.filter(parameter => !parameter.codeOnly)
    : [];
  return (
    parameters.length === 2 &&
    parameters[0].valueType &&
    parameters[0].valueType.object &&
    parameters[1].valueType &&
    parameters[1].valueType.behavior
  );
};

const runMetadataDiscoveryLiveScenario = async ({
  allowMutate,
  rollback = true,
  outputDir = path.resolve(
    process.cwd(),
    'artifacts',
    'mcp-metadata-discovery-live-e2e'
  ),
  windowId,
  projectPath,
  objectQuery = 'sprite',
  behaviorQuery = 'movement',
  env = process.env,
}) => {
  if (!allowMutate) throw new Error('mutation_requires_--allow-mutate');
  fs.mkdirSync(outputDir, { recursive: true });

  const runtime = loadRuntimeConfig(getDefaultDiscoveryPath(env));
  const client = new Client(
    { name: 'gdevelop-metadata-discovery-live-e2e', version: '1.0.0' },
    { versionNegotiation: { mode: { pin: runtime.protocolVersion } } }
  );
  const transport = new StreamableHTTPClientTransport(
    new URL(runtime.endpoint),
    {
      requestInit: {
        headers: makeRequestHeaders({
          token: runtime.token,
          clientId: 'gdevelop-metadata-discovery-live-e2e',
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
      const error = new Error(`tool_failed:${name}`);
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
    const toolNames = new Set(tools.tools.map(tool => tool.name));
    [
      'events.instructions.search',
      'events.instructions.describe',
      'editor.types.objects.list',
      'editor.types.objects.describe',
      'editor.types.behaviors.list',
      'editor.types.behaviors.describe',
      'editor.types.effects.list',
      'editor.types.effects.describe',
    ].forEach(name => {
      if (!toolNames.has(name))
        throw new Error(`metadata_tool_missing:${name}`);
    });

    const initial = await call('project.status');
    if (!initial.data || !initial.data.projectOpen)
      throw new Error('no_project_open');
    const originalRevision = initial.data.projectRevision;
    const originalSceneNames = Array.isArray(initial.data.sceneNames)
      ? initial.data.sceneNames.slice()
      : [];
    const originalScene = originalSceneNames[0] || null;

    const objectSearch = await call('editor.types.objects.list', {
      query: objectQuery,
      deprecated: 'exclude',
      renderingMode: '2d',
      limit: 100,
    });
    let objectType = (objectSearch.data.items || []).find(
      item => item && item.kind === 'object' && item.renderingMode === '2d'
    );
    if (!objectType) {
      const fallbackObjects = await call('editor.types.objects.list', {
        deprecated: 'exclude',
        renderingMode: '2d',
        limit: 100,
      });
      objectType = (fallbackObjects.data.items || []).find(
        item => item && item.kind === 'object' && item.renderingMode === '2d'
      );
    }
    if (!objectType) throw new Error('discoverable_2d_object_type_not_found');
    const objectDescription = await call('editor.types.objects.describe', {
      type: objectType.type,
      extension: objectType.extension && objectType.extension.name,
    });
    if (!objectDescription.data || !objectDescription.data.item) {
      throw new Error('object_type_description_missing');
    }

    const findBehaviorAndCondition = async query => {
      const behaviorSearch = await call('editor.types.behaviors.list', {
        ...(query ? { query } : {}),
        deprecated: 'exclude',
        objectType: objectType.type,
        limit: 100,
      });
      const candidates = (behaviorSearch.data.items || []).filter(
        behavior =>
          behavior &&
          behavior.kind === 'behavior' &&
          behavior.instructionCounts &&
          behavior.instructionCounts.conditions > 0 &&
          !String(behavior.type || '').includes('Capability::') &&
          (!behavior.objectType || behavior.objectType === objectType.type) &&
          (!Array.isArray(behavior.requiredBehaviorTypes) ||
            behavior.requiredBehaviorTypes.length === 0)
      );
      for (const behavior of candidates) {
        const conditions = await call('events.instructions.search', {
          kind: 'condition',
          behaviorType: behavior.type,
          deprecated: 'exclude',
          limit: 100,
        });
        const condition = (conditions.data.items || []).find(
          item =>
            isSimpleBehaviorCondition(item) &&
            item.scope.behaviorType === behavior.type
        );
        if (condition) return { behavior, condition };
      }
      return null;
    };

    const discovered =
      (await findBehaviorAndCondition(behaviorQuery)) ||
      (await findBehaviorAndCondition(''));
    if (!discovered) throw new Error('simple_behavior_condition_not_found');
    const { behavior, condition } = discovered;

    const behaviorDescription = await call('editor.types.behaviors.describe', {
      type: behavior.type,
      extension: behavior.extension && behavior.extension.name,
    });
    const conditionDescription = await call('events.instructions.describe', {
      id: condition.id,
      kind: 'condition',
      extension: condition.extension && condition.extension.name,
      behaviorType: behavior.type,
    });
    if (!isSimpleBehaviorCondition(conditionDescription.data.item)) {
      throw new Error('described_condition_no_longer_simple');
    }

    const transaction = await call('safety.transactions.begin', {
      label: 'Metadata discovery live E2E reversible scenario',
    });
    transactionId = transaction.data.transactionId;
    if (!transactionId) throw new Error('transaction_id_missing');

    const suffix = Date.now().toString(36);
    const sceneName = `MCP Metadata ${suffix}`;
    const objectName = `McpDiscoveredObject${suffix}`;
    const behaviorName = `McpDiscoveredBehavior${suffix}`;
    let revision = originalRevision;

    const mutate = async (name, args) => {
      const result = await call(name, {
        ...args,
        expectedRevision: revision,
        idempotencyKey: `metadata-live-${suffix}-${replay.length}`,
      });
      if (result.data && Number.isInteger(result.data.projectRevision)) {
        revision = result.data.projectRevision;
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
    await mutate('editor.functions.call', {
      name: 'create_object',
      arguments: {
        scene_name: sceneName,
        object_name: objectName,
        object_type: objectType.type,
        description:
          'Temporary object created from MCP-discovered type metadata',
      },
    });
    await mutate('editor.functions.call', {
      name: 'add_behavior',
      arguments: {
        scene_name: sceneName,
        object_name: objectName,
        behavior_type: behavior.type,
        behavior_name: behaviorName,
      },
    });
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

    await call('scene.open', { sceneName, mode: 'events' });
    await wait(700);
    const events = await call('events.read', { sceneName });
    const eventInsert = await call('events.insert', {
      sceneName,
      expectedEventsRevision: events.data.eventsRevision,
      eventsJson: [
        {
          type: 'BuiltinCommonInstructions::Standard',
          conditions: [
            {
              type: { value: condition.id },
              parameters: [objectName, behaviorName],
              subInstructions: [],
            },
          ],
          actions: [],
        },
      ],
      expectedRevision: revision,
      idempotencyKey: `metadata-live-${suffix}-event`,
    });
    const postEventStatus = await call('project.status');
    revision = postEventStatus.data.projectRevision;
    if (
      !eventInsert.data.validation ||
      eventInsert.data.validation.ok !== true
    ) {
      throw new Error('discovered_condition_event_validation_failed');
    }

    const validation = await call('validation.run', {
      includeNativeReport: false,
      includeAssets: false,
    });
    if (!validation.data || validation.data.ok !== true) {
      throw new Error('project_validation_failed_after_discovered_condition');
    }

    await call('scene.open', { sceneName, mode: 'scene' });
    await wait(600);
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
        const instance =
          objectSnapshot && Array.isArray(objectSnapshot.instances)
            ? objectSnapshot.instances[0]
            : null;
        const hasBehavior =
          instance &&
          Array.isArray(instance.behaviors) &&
          instance.behaviors.some(
            runtimeBehavior => runtimeBehavior.name === behaviorName
          );
        if (
          candidate.data &&
          candidate.data.scene &&
          candidate.data.scene.name === sceneName &&
          objectSnapshot &&
          objectSnapshot.count >= 1 &&
          hasBehavior
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
        `runtime_behavior_evidence_missing:${
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

    const result = {
      ok: true,
      rollback,
      protocolVersion: client.getNegotiatedProtocolVersion(),
      discovery: {
        objectQuery,
        behaviorQuery,
        objectType: objectType.type,
        objectExtension: objectType.extension && objectType.extension.name,
        behaviorType: behavior.type,
        behaviorExtension: behavior.extension && behavior.extension.name,
        conditionId: condition.id,
        conditionExtension: condition.extension && condition.extension.name,
        conditionParameters: conditionDescription.data.item.parameters,
        objectPropertySchemaAvailable:
          objectDescription.data.item.propertySchemaAvailable,
        behaviorProperties: behaviorDescription.data.item.properties,
      },
      mutation: { sceneName, objectName, behaviorName },
      runtimeEvidence: {
        sceneName: snapshot.scene && snapshot.scene.name,
        objectCount:
          snapshot.objects && snapshot.objects[objectName]
            ? snapshot.objects[objectName].count
            : 0,
        behaviors:
          snapshot.objects &&
          snapshot.objects[objectName] &&
          snapshot.objects[objectName].instances &&
          snapshot.objects[objectName].instances[0]
            ? snapshot.objects[objectName].instances[0].behaviors
            : [],
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
      'Usage: node AgentIntegration/scripts/McpMetadataDiscoveryLiveScenario.js --allow-mutate [options]',
      '',
      'Discovers canonical object/behavior/condition identifiers from the connected GDevelop metadata catalog, uses them to author a temporary scene, starts preview, verifies the discovered behavior at runtime, then rolls back by default.',
      '',
      'Options:',
      '  --allow-mutate            Required explicit opt-in.',
      '  --persist                 Commit instead of rolling back.',
      '  --output <dir>            Sanitized replay directory.',
      '  --window-id <id>          Optional editor targeting header.',
      '  --project-path <path>     Optional project targeting header.',
      '  --object-query <text>     Natural search text; default: sprite.',
      '  --behavior-query <text>   Natural search text; default: movement.',
      '  --help                    Show help.',
      '',
    ].join('\n')
  );
};

if (require.main === module) {
  (async () => {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) return printHelp();
    const result = await runMetadataDiscoveryLiveScenario(options);
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: result.ok,
          rollback: result.rollback,
          protocolVersion: result.protocolVersion,
          discovery: {
            objectType: result.discovery.objectType,
            behaviorType: result.discovery.behaviorType,
            conditionId: result.discovery.conditionId,
          },
          mutation: result.mutation,
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
      `MCP metadata discovery live scenario failed: ${
        error && error.message ? error.message : String(error)
      }\n`
    );
    process.exitCode = 1;
  });
}

module.exports = {
  isSimpleBehaviorCondition,
  parseArgs,
  runMetadataDiscoveryLiveScenario,
};
