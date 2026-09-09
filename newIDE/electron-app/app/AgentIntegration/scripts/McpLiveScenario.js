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

const parseArgs = argv => {
  const options = { rollback: true };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--allow-mutate') options.allowMutate = true;
    else if (argument === '--persist') options.rollback = false;
    else if (argument === '--output') options.outputDir = argv[++index];
    else if (argument === '--window-id') options.windowId = argv[++index];
    else if (argument === '--project-path') options.projectPath = argv[++index];
    else if (argument === '--duplicate-scene') options.duplicateScene = argv[++index];
    else if (argument === '--duplicate-object') options.duplicateObject = argv[++index];
    else if (argument === '--skip-resource') options.skipResource = true;
    else if (argument === '--help') options.help = true;
    else throw new Error(`unknown_argument:${argument}`);
  }
  return options;
};

const saveCapture = ({ response, outputDir, fileName }) => {
  const image = response && response.content && response.content.find(item => item.type === 'image');
  if (!image || !image.data) throw new Error(`capture_missing_image:${fileName}`);
  const filePath = path.join(outputDir, fileName);
  fs.writeFileSync(filePath, Buffer.from(image.data, 'base64'));
  return filePath;
};

const runLiveScenario = async ({
  allowMutate,
  rollback = true,
  outputDir = path.resolve(process.cwd(), 'artifacts', 'mcp-live-e2e'),
  windowId,
  projectPath,
  duplicateScene,
  duplicateObject,
  skipResource = false,
  env = process.env,
}) => {
  if (!allowMutate) throw new Error('mutation_requires_--allow-mutate');
  fs.mkdirSync(outputDir, { recursive: true });

  const runtime = loadRuntimeConfig(getDefaultDiscoveryPath(env));
  const client = new Client(
    { name: 'gdevelop-live-scenario', version: '1.0.0' },
    { versionNegotiation: { mode: { pin: runtime.protocolVersion } } }
  );
  const transport = new StreamableHTTPClientTransport(new URL(runtime.endpoint), {
    requestInit: {
      headers: makeRequestHeaders({
        token: runtime.token,
        clientId: 'gdevelop-live-scenario',
        windowId,
        projectPath,
      }),
    },
  });

  const replay = [];
  let transactionId = null;
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
        `editor_function_failed:${failure && failure.output && failure.output.message ? failure.output.message : 'unknown'}`
      );
    }
    return { response, data };
  };

  try {
    await client.connect(transport);
    const initial = await call('project.status');
    if (!initial.data || !initial.data.projectOpen) throw new Error('no_project_open');
    const originalRevision = initial.data.projectRevision;
    const originalScene = initial.data.sceneNames && initial.data.sceneNames[0];
    const windows = await call('desktop.windows.list');
    const editorWindow = (windows.data || []).find(item => item.editorWindow);
    if (!editorWindow) throw new Error('editor_window_not_found');

    const before = await call('desktop.window.capture', {
      windowId: editorWindow.windowId,
      maxWidth: 1600,
      maxHeight: 1000,
    });
    const beforePath = saveCapture({
      response: before.response,
      outputDir,
      fileName: '01-before.png',
    });

    const transaction = await call('safety.transactions.begin', {
      label: 'Canonical live E2E reversible scenario',
    });
    transactionId = transaction.data.transactionId;
    if (!transactionId) throw new Error('transaction_id_missing');

    const suffix = Date.now().toString(36);
    const sceneName = `MCP Live ${suffix}`;
    const objectName = `McpProbe${suffix}`;
    let revision = originalRevision;

    const mutate = async (name, args) => {
      const result = await call(name, {
        ...args,
        expectedRevision: revision,
        idempotencyKey: `live-${suffix}-${replay.length}`,
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
    await call('scene.open', { sceneName, mode: 'both' });
    await mutate('editor.functions.call', {
      name: 'create_object',
      arguments: duplicateObject
        ? {
            scene_name: sceneName,
            object_name: objectName,
            duplicated_object_name: duplicateObject,
            duplicated_object_scene: duplicateScene || originalScene,
            description: 'Temporary object duplicated by MCP live E2E gate',
          }
        : {
            scene_name: sceneName,
            object_name: objectName,
            object_type: 'Sprite',
            description: 'Temporary object created by MCP live E2E gate',
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
    await call('editor.instances.select', {
      sceneName,
      objectName,
      focusMode: 'fit',
    });

    const events = await call('events.read', { sceneName });
    const eventInsert = await call('events.insert', {
      sceneName,
      expectedEventsRevision: events.data.eventsRevision,
      eventsJson: [
        {
          type: 'BuiltinCommonInstructions::Comment',
          comment: 'MCP live E2E temporary event',
        },
      ],
      expectedRevision: revision,
      idempotencyKey: `live-${suffix}-event`,
    });
    const postEventStatus = await call('project.status');
    revision = postEventStatus.data.projectRevision;

    const resources = await call('resources.list');
    const imageResources = (resources.data.resources || []).filter(
      resource => resource.kind === 'image' && resource.usedInProject && resource.fileExists
    );
    if (!skipResource && imageResources.length >= 2) {
      const target = imageResources[0];
      const replacement = imageResources[1];
      await call('resources.replace-local', {
        resourceName: target.name,
        filePath: replacement.localFilePath,
        kind: 'image',
        copyToProject: false,
        preserveOrigin: true,
        deletePreviousFile: false,
        expectedRevision: revision,
        idempotencyKey: `live-${suffix}-resource`,
      });
      const postResourceStatus = await call('project.status');
      revision = postResourceStatus.data.projectRevision;
      await call('resources.inspect', { resourceName: target.name });
    }

    await call('scene.open', { sceneName, mode: 'scene' });
    await call('editor.instances.select', {
      sceneName,
      objectName,
      focusMode: 'fit',
    });
    const afterScene = await call('desktop.window.capture', {
      windowId: editorWindow.windowId,
      maxWidth: 1600,
      maxHeight: 1000,
    });
    const scenePath = saveCapture({
      response: afterScene.response,
      outputDir,
      fileName: '02-scene-object.png',
    });

    await call('scene.open', { sceneName, mode: 'events' });
    const afterEvents = await call('desktop.window.capture', {
      windowId: editorWindow.windowId,
      maxWidth: 1600,
      maxHeight: 1000,
    });
    const eventsPath = saveCapture({
      response: afterEvents.response,
      outputDir,
      fileName: '03-events.png',
    });

    const validation = await call('validation.run', {
      includeNativeReport: false,
      includeAssets: true,
    });

    if (rollback) {
      await call('safety.transactions.rollback', { transactionId });
      transactionId = null;
      if (originalScene) await call('scene.open', { sceneName: originalScene, mode: 'scene' });
    } else {
      await call('safety.transactions.commit', { transactionId });
      transactionId = null;
    }

    const finalStatus = await call('project.status');
    const result = {
      ok: true,
      rollback,
      protocolVersion: client.getNegotiatedProtocolVersion(),
      sceneName,
      objectName,
      originalRevision,
      finalRevision: finalStatus.data.projectRevision,
      validation: validation.data,
      evidence: { beforePath, scenePath, eventsPath },
      replay,
    };
    fs.writeFileSync(path.join(outputDir, 'replay.json'), `${JSON.stringify(result, null, 2)}\n`);
    return result;
  } catch (error) {
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
  process.stdout.write([
    'Usage: node AgentIntegration/scripts/McpLiveScenario.js --allow-mutate [options]',
    '',
    'Runs a reversible MCP-only live authoring scenario against a running GDevelop desktop editor.',
    'By default it rolls back all project mutations and writes sanitized visual evidence.',
    '',
    'Options:',
    '  --allow-mutate       Required explicit opt-in.',
    '  --persist            Commit the transaction instead of rolling back.',
    '  --output <dir>       Evidence/replay directory.',
    '  --window-id <id>     Optional editor targeting header.',
    '  --project-path <p>   Optional project targeting header.',
    '  --help               Show help.',
    '',
  ].join('\n'));
};

if (require.main === module) {
  (async () => {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) return printHelp();
    const result = await runLiveScenario(options);
    process.stdout.write(`${JSON.stringify({
      ok: result.ok,
      rollback: result.rollback,
      sceneName: result.sceneName,
      objectName: result.objectName,
      originalRevision: result.originalRevision,
      finalRevision: result.finalRevision,
      evidence: result.evidence,
    }, null, 2)}\n`);
  })().catch(error => {
    process.stderr.write(`MCP live scenario failed: ${error && error.message ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, runLiveScenario, saveCapture };
