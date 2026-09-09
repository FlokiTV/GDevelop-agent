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

const REQUIRED_TOOLS = [
  'project.status',
  'extensions.project.list',
  'extensions.project.inspect',
  'extensions.project.create',
  'extensions.functions.create',
  'extensions.functions.parameters.create',
  'extensions.functions.parameters.rename',
  'extensions.behaviors.create',
  'extensions.objects.create',
  'extensions.objects.variants.create',
  'extensions.objects.variants.update',
  'extensions.objects.variants.rename',
  'extensions.objects.variants.move',
  'events.read',
  'events.insert',
  'events.instructions.search',
  'editor.types.objects.list',
  'editor.types.behaviors.list',
  'editor.functions.call',
  'scene.open',
  'validation.run',
  'safety.checkpoints.create',
  'safety.checkpoints.diff',
  'safety.checkpoints.delete',
  'safety.transactions.begin',
  'safety.transactions.commit',
  'safety.transactions.rollback',
  'preview.status',
  'preview.start',
  'preview.hot-reload',
  'preview.close-all',
  'runtime.snapshot',
];

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
    else if (argument === '--help') options.help = true;
    else throw new Error(`unknown_argument:${argument}`);
  }
  return options;
};

const assertRequiredTools = tools => {
  const names = new Set((tools || []).map(tool => tool.name));
  const missing = REQUIRED_TOOLS.filter(name => !names.has(name));
  if (missing.length > 0) {
    throw new Error(`extension_authoring_tools_missing:${missing.join(',')}`);
  }
  return true;
};

const findCustomType = (items, extensionName, localName) =>
  (items || []).find(item => {
    if (!item || !item.extension) return false;
    const extensionMatches =
      item.extension.name === extensionName ||
      item.extension.namespace === extensionName;
    return (
      extensionMatches &&
      (item.type === localName ||
        String(item.type || '').endsWith(`::${localName}`) ||
        String(item.name || '') === localName)
    );
  }) || null;

const runExtensionAuthoringLiveScenario = async ({
  allowMutate,
  rollback = true,
  outputDir = path.resolve(
    process.cwd(),
    'artifacts',
    'mcp-extension-authoring-live-e2e'
  ),
  windowId,
  projectPath,
  env = process.env,
}) => {
  if (!allowMutate) throw new Error('mutation_requires_--allow-mutate');
  fs.mkdirSync(outputDir, { recursive: true });

  const runtime = loadRuntimeConfig(getDefaultDiscoveryPath(env));
  const client = new Client(
    { name: 'gdevelop-extension-authoring-live-e2e', version: '1.0.0' },
    { versionNegotiation: { mode: { pin: runtime.protocolVersion } } }
  );
  const transport = new StreamableHTTPClientTransport(
    new URL(runtime.endpoint),
    {
      requestInit: {
        headers: makeRequestHeaders({
          token: runtime.token,
          clientId: 'gdevelop-extension-authoring-live-e2e',
          windowId,
          projectPath,
        }),
      },
    }
  );

  const replay = [];
  let transactionId = null;
  let checkpointId = null;
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

  const getRevision = async () => {
    const status = await call('project.status');
    if (!status.data || !Number.isInteger(status.data.projectRevision)) {
      throw new Error('project_revision_missing');
    }
    return status.data.projectRevision;
  };

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assertRequiredTools(tools.tools);

    const initial = await call('project.status');
    if (!initial.data || !initial.data.projectOpen) {
      throw new Error('no_project_open');
    }
    const originalRevision = initial.data.projectRevision;
    const originalSceneNames = Array.isArray(initial.data.sceneNames)
      ? initial.data.sceneNames.slice()
      : [];
    const originalScene = originalSceneNames[0] || null;

    const checkpoint = await call('safety.checkpoints.create', {
      label: 'Extension authoring live E2E baseline',
    });
    checkpointId =
      checkpoint.data && checkpoint.data.checkpoint
        ? checkpoint.data.checkpoint.id
        : null;
    if (!checkpointId) throw new Error('checkpoint_id_missing');

    const transaction = await call('safety.transactions.begin', {
      label: 'Extension authoring live E2E reversible transaction',
    });
    transactionId = transaction.data && transaction.data.transactionId;
    if (!transactionId) throw new Error('transaction_id_missing');

    const suffix = Date.now().toString(36);
    const extensionName = `McpExtension${suffix}`;
    const freeFunctionName = 'DoThing';
    const behaviorName = 'Mover';
    const behaviorFunctionName = 'Pulse';
    const customObjectName = 'Widget';
    const objectFunctionName = 'Refresh';
    const sceneName = `MCP Extension ${suffix}`;
    const sceneObjectName = `McpWidget${suffix}`;
    let revision = originalRevision;

    const mutate = async (name, args) => {
      const result = await call(name, {
        ...args,
        expectedRevision: revision,
        idempotencyKey: `extension-live-${suffix}-${replay.length}`,
      });
      revision = await getRevision();
      return result;
    };

    await mutate('extensions.project.create', {
      name: extensionName,
      fullName: `MCP Extension ${suffix}`,
      description: 'Temporary extension authored end-to-end through MCP',
      version: '1.0.0',
    });

    await mutate('extensions.functions.create', {
      extensionName,
      name: freeFunctionName,
      type: 'action',
      fullName: 'Do thing',
      description: 'Temporary free function authored through MCP',
    });
    await mutate('extensions.functions.parameters.create', {
      extensionName,
      name: freeFunctionName,
      parameterName: 'Value',
      type: 'expression',
      description: 'Temporary numeric value',
      defaultValue: '0',
    });
    await mutate('extensions.functions.parameters.rename', {
      extensionName,
      name: freeFunctionName,
      parameterName: 'Value',
      newName: 'Amount',
    });

    const freeTarget = {
      kind: 'extension-function',
      extensionName,
      functionName: freeFunctionName,
    };
    const freeEventsBefore = await call('events.read', { target: freeTarget });
    await mutate('events.insert', {
      target: freeTarget,
      expectedEventsRevision: freeEventsBefore.data.eventsRevision,
      eventsJson: [{ type: 'BuiltinCommonInstructions::Comment' }],
    });

    await mutate('extensions.behaviors.create', {
      extensionName,
      name: behaviorName,
      fullName: 'Mover behavior',
      description: 'Temporary events-based behavior authored through MCP',
    });
    await mutate('extensions.functions.create', {
      extensionName,
      ownerKind: 'behavior',
      ownerName: behaviorName,
      name: behaviorFunctionName,
      type: 'action',
    });
    const behaviorTarget = {
      kind: 'extension-function',
      extensionName,
      ownerKind: 'behavior',
      ownerName: behaviorName,
      functionName: behaviorFunctionName,
    };
    const behaviorEventsBefore = await call('events.read', {
      target: behaviorTarget,
    });
    await mutate('events.insert', {
      target: behaviorTarget,
      expectedEventsRevision: behaviorEventsBefore.data.eventsRevision,
      eventsJson: [{ type: 'BuiltinCommonInstructions::Comment' }],
    });

    await mutate('extensions.objects.create', {
      extensionName,
      name: customObjectName,
      fullName: 'Widget object',
      description: 'Temporary events-based object authored through MCP',
      defaultName: 'Widget',
      renderedIn3D: false,
    });
    await mutate('extensions.functions.create', {
      extensionName,
      ownerKind: 'object',
      ownerName: customObjectName,
      name: objectFunctionName,
      type: 'action',
    });
    const objectTarget = {
      kind: 'extension-function',
      extensionName,
      ownerKind: 'object',
      ownerName: customObjectName,
      functionName: objectFunctionName,
    };
    const objectEventsBefore = await call('events.read', {
      target: objectTarget,
    });
    await mutate('events.insert', {
      target: objectTarget,
      expectedEventsRevision: objectEventsBefore.data.eventsRevision,
      eventsJson: [{ type: 'BuiltinCommonInstructions::Comment' }],
    });

    await mutate('extensions.objects.variants.create', {
      extensionName,
      name: customObjectName,
      variantName: 'Compact',
      area: { minX: 0, minY: 0, maxX: 64, maxY: 64 },
    });
    await mutate('extensions.objects.variants.create', {
      extensionName,
      name: customObjectName,
      variantName: 'Wide',
      area: { minX: 0, minY: 0, maxX: 128, maxY: 64 },
    });
    await mutate('extensions.objects.variants.update', {
      extensionName,
      name: customObjectName,
      variantName: 'Compact',
      area: { minZ: 0, maxZ: 1 },
    });
    await mutate('extensions.objects.variants.rename', {
      extensionName,
      name: customObjectName,
      variantName: 'Compact',
      newName: 'Small',
      allowReferenced: true,
    });
    await mutate('extensions.objects.variants.move', {
      extensionName,
      name: customObjectName,
      oldIndex: 1,
      newIndex: 0,
    });

    const inspection = await call('extensions.project.inspect', {
      name: extensionName,
    });
    const authoredExtension = inspection.data && inspection.data.extension;
    if (!authoredExtension)
      throw new Error('authored_extension_inspect_missing');
    if (
      !Array.isArray(authoredExtension.functions) ||
      !authoredExtension.functions.some(item => item.name === freeFunctionName)
    ) {
      throw new Error('authored_free_function_missing');
    }
    if (
      !Array.isArray(authoredExtension.behaviors) ||
      !authoredExtension.behaviors.some(item => item.name === behaviorName)
    ) {
      throw new Error('authored_behavior_missing');
    }
    const authoredObject = Array.isArray(authoredExtension.objects)
      ? authoredExtension.objects.find(item => item.name === customObjectName)
      : null;
    if (!authoredObject) throw new Error('authored_custom_object_missing');
    const variantNames = Array.isArray(authoredObject.variants)
      ? authoredObject.variants.map(item => item.name)
      : [];
    if (!variantNames.includes('Small') || !variantNames.includes('Wide')) {
      throw new Error('authored_variants_missing');
    }

    const objectTypes = await call('editor.types.objects.list', {
      extension: extensionName,
      query: customObjectName,
      includeHidden: true,
      deprecated: 'include',
      limit: 100,
    });
    const customObjectType = findCustomType(
      objectTypes.data && objectTypes.data.items,
      extensionName,
      customObjectName
    );
    if (!customObjectType)
      throw new Error('generated_custom_object_type_missing');

    const behaviorTypes = await call('editor.types.behaviors.list', {
      extension: extensionName,
      query: behaviorName,
      includeHidden: true,
      deprecated: 'include',
      limit: 100,
    });
    const customBehaviorType = findCustomType(
      behaviorTypes.data && behaviorTypes.data.items,
      extensionName,
      behaviorName
    );
    if (!customBehaviorType)
      throw new Error('generated_custom_behavior_type_missing');

    const instructions = await call('events.instructions.search', {
      extension: extensionName,
      query: freeFunctionName,
      kind: 'action',
      includeHidden: true,
      deprecated: 'include',
      limit: 100,
    });
    const customAction = (instructions.data.items || []).find(item =>
      String(item.id || '').includes(freeFunctionName)
    );
    if (!customAction) throw new Error('generated_custom_action_missing');

    await mutate('editor.functions.call', {
      name: 'create_scene',
      arguments: { scene_name: sceneName },
    });
    await call('scene.open', { sceneName, mode: 'scene' });
    await wait(400);
    await mutate('editor.functions.call', {
      name: 'create_object',
      arguments: {
        scene_name: sceneName,
        object_name: sceneObjectName,
        object_type: customObjectType.type,
        description: 'Temporary runtime instance of MCP-authored custom object',
      },
    });
    await mutate('editor.functions.call', {
      name: 'put_2d_instances',
      arguments: {
        scene_name: sceneName,
        layer_name: '',
        brush_kind: 'point',
        brush_position: '320,240',
        object_name: sceneObjectName,
        new_instances_count: 1,
      },
    });

    const validation = await call('validation.run', {
      includeNativeReport: false,
      includeAssets: false,
    });
    if (!validation.data || validation.data.ok !== true) {
      throw new Error('extension_authoring_validation_failed');
    }

    const checkpointDiff = await call('safety.checkpoints.diff', {
      checkpointId,
    });
    if (
      !checkpointDiff.data ||
      !checkpointDiff.data.diff ||
      checkpointDiff.data.diff.changed !== true
    ) {
      throw new Error('checkpoint_did_not_observe_extension_mutation');
    }

    const previewBefore = await call('preview.status');
    if (previewBefore.data && previewBefore.data.running) {
      await call('preview.close-all');
      await wait(300);
    }
    await call('scene.open', { sceneName, mode: 'scene' });
    await wait(300);
    await call('preview.start', { numberOfWindows: 1 });
    previewStartedByScenario = true;

    const waitForRuntimeInstance = async phase => {
      let lastError = null;
      for (let attempt = 0; attempt < 25; attempt++) {
        await wait(attempt === 0 ? 1000 : 350);
        try {
          const snapshot = await call('runtime.snapshot', {
            objectNames: [sceneObjectName],
            maxInstances: 5,
          });
          const objectSnapshot =
            snapshot.data && snapshot.data.objects
              ? snapshot.data.objects[sceneObjectName]
              : null;
          if (
            snapshot.data &&
            snapshot.data.scene &&
            snapshot.data.scene.name === sceneName &&
            objectSnapshot &&
            objectSnapshot.count >= 1
          ) {
            return snapshot.data;
          }
        } catch (error) {
          lastError = error;
        }
      }
      throw new Error(
        `runtime_custom_object_evidence_missing:${phase}:${
          lastError && lastError.message ? lastError.message : 'not_ready'
        }`
      );
    };

    const runtimeBeforeHotReload = await waitForRuntimeInstance(
      'before-hot-reload'
    );

    const freeEventsForHotReload = await call('events.read', {
      target: freeTarget,
    });
    await mutate('events.insert', {
      target: freeTarget,
      expectedEventsRevision: freeEventsForHotReload.data.eventsRevision,
      eventsJson: [{ type: 'BuiltinCommonInstructions::Comment' }],
    });
    const hotReload = await call('preview.hot-reload');
    await wait(500);
    const previewAfterHotReload = await call('preview.status');
    const runtimeAfterHotReload = await waitForRuntimeInstance(
      'after-hot-reload'
    );
    if (!previewAfterHotReload.data || !previewAfterHotReload.data.running) {
      throw new Error('preview_not_running_after_hot_reload');
    }

    await call('preview.close-all');
    previewStartedByScenario = false;

    let transactionResult;
    if (rollback) {
      transactionResult = await call('safety.transactions.rollback', {
        transactionId,
      });
      transactionId = null;
      if (originalScene) {
        await call('scene.open', { sceneName: originalScene, mode: 'scene' });
      }
    } else {
      transactionResult = await call('safety.transactions.commit', {
        transactionId,
      });
      transactionId = null;
    }

    const finalStatus = await call('project.status');
    const finalExtensions = await call('extensions.project.list');
    if (rollback) {
      if (
        Array.isArray(finalStatus.data.sceneNames) &&
        finalStatus.data.sceneNames.includes(sceneName)
      ) {
        throw new Error('rollback_left_temporary_scene');
      }
      if (
        finalExtensions.data &&
        Array.isArray(finalExtensions.data.items) &&
        finalExtensions.data.items.some(item => item.name === extensionName)
      ) {
        throw new Error('rollback_left_temporary_extension');
      }
    }

    const postRollbackCheckpointDiff = await call('safety.checkpoints.diff', {
      checkpointId,
    });
    if (
      rollback &&
      (!postRollbackCheckpointDiff.data ||
        !postRollbackCheckpointDiff.data.diff ||
        postRollbackCheckpointDiff.data.diff.changed !== false)
    ) {
      throw new Error('rollback_did_not_restore_checkpoint_baseline');
    }
    await call('safety.checkpoints.delete', { checkpointId });
    checkpointId = null;

    const result = {
      ok: true,
      rollback,
      protocolVersion: client.getNegotiatedProtocolVersion(),
      authored: {
        extensionName,
        freeFunctionName,
        behaviorName,
        behaviorFunctionName,
        customObjectName,
        objectFunctionName,
        variantNames,
        generatedCustomObjectType: customObjectType.type,
        generatedCustomBehaviorType: customBehaviorType.type,
        generatedCustomAction: customAction.id,
      },
      mutation: { sceneName, sceneObjectName },
      checkpoint: {
        changedDuringScenario: checkpointDiff.data.diff.changed,
        changedAfterRollback: postRollbackCheckpointDiff.data.diff.changed,
        extensionDiff: checkpointDiff.data.diff.extensions,
        sceneDiff: checkpointDiff.data.diff.scenes,
      },
      hotReload: {
        response: hotReload.data,
        previewRunningAfter: previewAfterHotReload.data.running,
        beforeObjectCount:
          runtimeBeforeHotReload.objects &&
          runtimeBeforeHotReload.objects[sceneObjectName]
            ? runtimeBeforeHotReload.objects[sceneObjectName].count
            : 0,
        afterObjectCount:
          runtimeAfterHotReload.objects &&
          runtimeAfterHotReload.objects[sceneObjectName]
            ? runtimeAfterHotReload.objects[sceneObjectName].count
            : 0,
      },
      transaction: transactionResult.data,
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
        transactionId = null;
      } catch (_) {}
    }
    if (checkpointId) {
      try {
        await call('safety.checkpoints.delete', { checkpointId });
        checkpointId = null;
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
      'Usage: node AgentIntegration/scripts/McpExtensionAuthoringLiveScenario.js --allow-mutate [options]',
      '',
      'Authors a temporary project extension from scratch through the public MCP surface, edits free/behavior/object event sheets, verifies generated metadata and a custom-object runtime instance, hot reloads after an extension event mutation, validates checkpoint diff, then rolls back by default.',
      '',
      'Options:',
      '  --allow-mutate          Required explicit opt-in.',
      '  --persist               Commit instead of rolling back.',
      '  --output <dir>          Sanitized replay directory.',
      '  --window-id <id>        Optional editor targeting header.',
      '  --project-path <path>   Optional project targeting header.',
      '  --help                  Show help.',
      '',
    ].join('\n')
  );
};

if (require.main === module) {
  (async () => {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) return printHelp();
    const result = await runExtensionAuthoringLiveScenario(options);
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: result.ok,
          rollback: result.rollback,
          protocolVersion: result.protocolVersion,
          authored: result.authored,
          mutation: result.mutation,
          checkpoint: {
            changedDuringScenario: result.checkpoint.changedDuringScenario,
            changedAfterRollback: result.checkpoint.changedAfterRollback,
          },
          hotReload: result.hotReload,
          originalRevision: result.originalRevision,
          finalRevision: result.finalRevision,
        },
        null,
        2
      )}\n`
    );
  })().catch(error => {
    process.stderr.write(
      `MCP extension authoring live scenario failed: ${
        error && error.message ? error.message : String(error)
      }\n`
    );
    process.exitCode = 1;
  });
}

module.exports = {
  REQUIRED_TOOLS,
  assertRequiredTools,
  findCustomType,
  parseArgs,
  runExtensionAuthoringLiveScenario,
};
