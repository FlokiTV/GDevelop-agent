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
  'external-events.list',
  'external-events.create',
  'external-events.rename',
  'external-layouts.list',
  'external-layouts.create',
  'external-layouts.duplicate',
  'external-layouts.rename',
  'external-layouts.delete',
  'external-layouts.instances.list',
  'external-layouts.instances.create',
  'events.read',
  'events.insert',
  'editor.functions.call',
  'scene.open',
  'validation.run',
  'safety.checkpoints.create',
  'safety.checkpoints.diff',
  'safety.checkpoints.delete',
  'safety.transactions.begin',
  'safety.transactions.rollback',
  'preview.status',
  'preview.start',
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
  if (missing.length) {
    throw new Error(`external_project_items_tools_missing:${missing.join(',')}`);
  }
  return true;
};

const runExternalProjectItemsLiveScenario = async ({
  allowMutate,
  rollback = true,
  outputDir = path.resolve(
    process.cwd(),
    'artifacts',
    'mcp-external-project-items-live-e2e'
  ),
  windowId,
  projectPath,
  env = process.env,
}) => {
  if (!allowMutate) throw new Error('mutation_requires_--allow-mutate');
  fs.mkdirSync(outputDir, { recursive: true });

  const runtime = loadRuntimeConfig(getDefaultDiscoveryPath(env));
  const client = new Client(
    { name: 'gdevelop-external-project-items-live-e2e', version: '1.0.0' },
    { versionNegotiation: { mode: { pin: runtime.protocolVersion } } }
  );
  const transport = new StreamableHTTPClientTransport(new URL(runtime.endpoint), {
    requestInit: {
      headers: makeRequestHeaders({
        token: runtime.token,
        clientId: 'gdevelop-external-project-items-live-e2e',
        windowId,
        projectPath,
      }),
    },
  });

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
      const failure = data.results.find(result => result && result.success === false);
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
    if (!initial.data || !initial.data.projectOpen) throw new Error('no_project_open');
    const originalRevision = initial.data.projectRevision;
    const originalScene =
      Array.isArray(initial.data.sceneNames) && initial.data.sceneNames.length
        ? initial.data.sceneNames[0]
        : null;

    const checkpoint = await call('safety.checkpoints.create', {
      label: 'External project items live E2E baseline',
    });
    checkpointId =
      checkpoint.data && checkpoint.data.checkpoint
        ? checkpoint.data.checkpoint.id
        : null;
    if (!checkpointId) throw new Error('checkpoint_id_missing');

    const transaction = await call('safety.transactions.begin', {
      label: 'External project items live E2E reversible transaction',
    });
    transactionId = transaction.data && transaction.data.transactionId;
    if (!transactionId) throw new Error('transaction_id_missing');

    const suffix = Date.now().toString(36);
    const sceneName = `MCP External ${suffix}`;
    const eventMarkerName = `ExternalEventMarker${suffix}`;
    const layoutMarkerName = `ExternalLayoutMarker${suffix}`;
    const externalEventsName = `ExternalEvents${suffix}`;
    const renamedExternalEventsName = `${externalEventsName}Renamed`;
    const externalLayoutName = `ExternalLayout${suffix}`;
    const renamedExternalLayoutName = `${externalLayoutName}Renamed`;
    const duplicateExternalLayoutName = `${externalLayoutName}Copy`;
    let revision = originalRevision;

    const mutate = async (name, args) => {
      const result = await call(name, {
        ...args,
        expectedRevision: revision,
        idempotencyKey: `external-items-live-${suffix}-${replay.length}`,
      });
      revision = await getRevision();
      return result;
    };

    await mutate('editor.functions.call', {
      name: 'create_scene',
      arguments: { scene_name: sceneName },
    });
    await call('scene.open', { sceneName, mode: 'scene' });
    await wait(250);

    for (const objectName of [eventMarkerName, layoutMarkerName]) {
      await mutate('editor.functions.call', {
        name: 'create_object',
        arguments: {
          scene_name: sceneName,
          object_name: objectName,
          object_type: 'TextObject::Text',
          description: 'Temporary CAP-04/05 runtime marker',
        },
      });
    }

    await mutate('external-events.create', {
      name: externalEventsName,
      associatedLayout: sceneName,
    });
    const externalEventsTarget = {
      kind: 'external-events',
      externalEventsName,
    };
    const externalEventsBefore = await call('events.read', {
      target: externalEventsTarget,
    });
    await mutate('events.insert', {
      target: externalEventsTarget,
      expectedEventsRevision: externalEventsBefore.data.eventsRevision,
      eventsJson: [
        {
          type: 'BuiltinCommonInstructions::Standard',
          conditions: [
            {
              type: { value: 'BuiltinCommonInstructions::Once' },
              parameters: [],
            },
          ],
          actions: [
            {
              type: { value: 'Create' },
              parameters: ['', eventMarkerName, '111', '222', ''],
            },
          ],
        },
      ],
    });

    await mutate('external-layouts.create', {
      name: externalLayoutName,
      associatedLayout: sceneName,
    });
    await mutate('external-layouts.instances.create', {
      name: externalLayoutName,
      objectName: layoutMarkerName,
      x: 333,
      y: 444,
      zOrder: 7,
    });
    const externalLayoutInstances = await call(
      'external-layouts.instances.list',
      { name: externalLayoutName }
    );
    if (
      !externalLayoutInstances.data ||
      externalLayoutInstances.data.total !== 1 ||
      externalLayoutInstances.data.items[0].objectName !== layoutMarkerName
    ) {
      throw new Error('external_layout_instance_evidence_missing');
    }

    const sceneEventsBefore = await call('events.read', { sceneName });
    await mutate('events.insert', {
      sceneName,
      expectedEventsRevision: sceneEventsBefore.data.eventsRevision,
      eventsJson: [
        {
          type: 'BuiltinCommonInstructions::Link',
          target: externalEventsName,
          include: { includeConfig: 0 },
        },
        {
          type: 'BuiltinCommonInstructions::Standard',
          conditions: [
            {
              type: { value: 'BuiltinCommonInstructions::Once' },
              parameters: [],
            },
          ],
          actions: [
            {
              type: {
                value: 'BuiltinExternalLayouts::CreateObjectsFromExternalLayout',
              },
              parameters: ['', JSON.stringify(externalLayoutName), '0', '0'],
            },
          ],
        },
      ],
    });

    await mutate('external-events.rename', {
      name: externalEventsName,
      newName: renamedExternalEventsName,
    });
    await mutate('external-layouts.rename', {
      name: externalLayoutName,
      newName: renamedExternalLayoutName,
    });

    const sceneEventsAfterRename = await call('events.read', { sceneName });
    const serializedSceneEvents = JSON.stringify(sceneEventsAfterRename.data.eventsJson);
    if (!serializedSceneEvents.includes(renamedExternalEventsName)) {
      throw new Error('external_events_reference_not_refactored');
    }
    if (!serializedSceneEvents.includes(renamedExternalLayoutName)) {
      throw new Error('external_layout_reference_not_refactored');
    }
    if (
      serializedSceneEvents.includes(`\"target\":\"${externalEventsName}\"`) ||
      serializedSceneEvents.includes(JSON.stringify(externalLayoutName))
    ) {
      throw new Error('old_external_reference_survived_refactor');
    }

    await mutate('external-layouts.duplicate', {
      name: renamedExternalLayoutName,
      newName: duplicateExternalLayoutName,
    });
    const duplicateInstances = await call('external-layouts.instances.list', {
      name: duplicateExternalLayoutName,
    });
    if (!duplicateInstances.data || duplicateInstances.data.total !== 1) {
      throw new Error('external_layout_duplicate_lost_instances');
    }
    await mutate('external-layouts.delete', {
      name: duplicateExternalLayoutName,
      allowReferenced: true,
    });

    const validation = await call('validation.run', {
      includeNativeReport: false,
      includeAssets: false,
    });
    if (!validation.data || validation.data.ok !== true) {
      throw new Error('external_project_items_validation_failed');
    }

    const checkpointDiff = await call('safety.checkpoints.diff', { checkpointId });
    if (
      !checkpointDiff.data ||
      !checkpointDiff.data.diff ||
      checkpointDiff.data.diff.changed !== true
    ) {
      throw new Error('checkpoint_did_not_observe_external_project_item_mutation');
    }

    const previewBefore = await call('preview.status');
    if (previewBefore.data && previewBefore.data.running) {
      await call('preview.close-all');
      await wait(250);
    }
    await call('scene.open', { sceneName, mode: 'scene' });
    await wait(250);
    await call('preview.start', { numberOfWindows: 1 });
    previewStartedByScenario = true;

    let runtimeEvidence = null;
    let lastRuntimeError = null;
    for (let attempt = 0; attempt < 30; attempt++) {
      await wait(attempt === 0 ? 900 : 250);
      try {
        const snapshot = await call('runtime.snapshot', {
          objectNames: [eventMarkerName, layoutMarkerName],
          maxInstances: 10,
        });
        const eventMarker =
          snapshot.data && snapshot.data.objects
            ? snapshot.data.objects[eventMarkerName]
            : null;
        const layoutMarker =
          snapshot.data && snapshot.data.objects
            ? snapshot.data.objects[layoutMarkerName]
            : null;
        if (
          snapshot.data &&
          snapshot.data.scene &&
          snapshot.data.scene.name === sceneName &&
          eventMarker &&
          eventMarker.count >= 1 &&
          layoutMarker &&
          layoutMarker.count >= 1
        ) {
          runtimeEvidence = snapshot.data;
          break;
        }
      } catch (error) {
        lastRuntimeError = error;
      }
    }
    if (!runtimeEvidence) {
      throw new Error(
        `external_project_items_runtime_evidence_missing:${
          lastRuntimeError && lastRuntimeError.message
            ? lastRuntimeError.message
            : 'not_ready'
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
      throw new Error('persist_not_supported_for_acceptance_scenario');
    }

    const finalStatus = await call('project.status');
    const finalExternalEvents = await call('external-events.list');
    const finalExternalLayouts = await call('external-layouts.list');
    if (
      Array.isArray(finalStatus.data.sceneNames) &&
      finalStatus.data.sceneNames.includes(sceneName)
    ) {
      throw new Error('rollback_left_temporary_scene');
    }
    if (
      finalExternalEvents.data.items.some(item =>
        item.name.includes(externalEventsName)
      )
    ) {
      throw new Error('rollback_left_temporary_external_events');
    }
    if (
      finalExternalLayouts.data.items.some(item =>
        item.name.includes(externalLayoutName)
      )
    ) {
      throw new Error('rollback_left_temporary_external_layout');
    }

    const postRollbackCheckpointDiff = await call('safety.checkpoints.diff', {
      checkpointId,
    });
    if (
      !postRollbackCheckpointDiff.data ||
      !postRollbackCheckpointDiff.data.diff ||
      postRollbackCheckpointDiff.data.diff.changed !== false
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
        sceneName,
        eventMarkerName,
        layoutMarkerName,
        externalEventsName: renamedExternalEventsName,
        externalLayoutName: renamedExternalLayoutName,
      },
      refactor: {
        externalEventsUpdated: serializedSceneEvents.includes(
          renamedExternalEventsName
        ),
        externalLayoutUpdated: serializedSceneEvents.includes(
          renamedExternalLayoutName
        ),
      },
      runtime: {
        sceneName: runtimeEvidence.scene.name,
        eventMarkerCount: runtimeEvidence.objects[eventMarkerName].count,
        layoutMarkerCount: runtimeEvidence.objects[layoutMarkerName].count,
        layoutMarkerPosition:
          runtimeEvidence.objects[layoutMarkerName].instances[0] || null,
      },
      checkpoint: {
        changedDuringScenario: checkpointDiff.data.diff.changed,
        changedAfterRollback: postRollbackCheckpointDiff.data.diff.changed,
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
      'Usage: node AgentIntegration/scripts/McpExternalProjectItemsLiveScenario.js --allow-mutate [options]',
      '',
      'Creates External Events and an External Layout through MCP, links/instantiates both in a temporary scene, verifies refactor-safe renames and live preview runtime evidence, then rolls back to the exact checkpoint baseline.',
      '',
      'Options:',
      '  --allow-mutate          Required explicit opt-in.',
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
    const result = await runExternalProjectItemsLiveScenario(options);
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: result.ok,
          rollback: result.rollback,
          protocolVersion: result.protocolVersion,
          authored: result.authored,
          refactor: result.refactor,
          runtime: result.runtime,
          checkpoint: result.checkpoint,
          originalRevision: result.originalRevision,
          finalRevision: result.finalRevision,
        },
        null,
        2
      )}\n`
    );
  })().catch(error => {
    process.stderr.write(
      `MCP external project items live scenario failed: ${
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
  runExternalProjectItemsLiveScenario,
};
