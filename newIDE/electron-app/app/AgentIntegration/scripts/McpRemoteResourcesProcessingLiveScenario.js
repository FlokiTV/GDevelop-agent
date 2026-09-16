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
  sanitizeForReplay,
} = require('./McpLiveGate');

const REQUIRED_TOOLS = [
  'project.status',
  'project.create',
  'project.save-as',
  'project.close',
  'scene.open',
  'safety.transactions.begin',
  'safety.transactions.rollback',
  'store.resources.search',
  'resources.import-url',
  'resources.import-local',
  'resources.inspect',
  'resources.processing.capabilities',
  'resources.image.transform',
  'resources.audio.transform',
  'editor.functions.create-scene',
  'editor.functions.create-object',
  'editor.functions.put-2d-instances',
  'objects.structure.apply',
  'validation.run',
  'preview.status',
  'preview.start',
  'preview.close-all',
  'runtime.snapshot',
  'export.html5',
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
  const options = { rollback: true, cleanupProject: true };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--allow-mutate') options.allowMutate = true;
    else if (argument === '--persist') options.rollback = false;
    else if (argument === '--keep-project') options.cleanupProject = false;
    else if (argument === '--output') options.outputDir = argv[++index];
    else if (argument === '--window-id') options.windowId = argv[++index];
    else if (argument === '--project-path') options.projectPath = argv[++index];
    else if (argument === '--help') options.help = true;
    else throw new Error(`unknown_argument:${argument}`);
  }
  return options;
};

const assertRequiredTools = tools => {
  const byName = new Map((tools || []).map(tool => [tool.name, tool]));
  const missing = REQUIRED_TOOLS.filter(name => !byName.has(name));
  if (missing.length)
    throw new Error(`remote_processing_tools_missing:${missing.join(',')}`);

  for (const name of [
    'resources.import-url',
    'resources.image.transform',
    'resources.audio.transform',
  ]) {
    const tool = byName.get(name);
    if (!tool.annotations || tool.annotations.readOnlyHint !== false) {
      throw new Error(`remote_processing_mutation_annotations_invalid:${name}`);
    }
  }
  const capabilities = byName.get('resources.processing.capabilities');
  if (
    !capabilities.annotations ||
    capabilities.annotations.readOnlyHint !== true
  ) {
    throw new Error('processing_capabilities_annotations_invalid');
  }
  return byName;
};

const createPcm16Wav = ({ sampleRate = 8000, durationMs = 250 } = {}) => {
  const sampleCount = Math.max(1, Math.round((sampleRate * durationMs) / 1000));
  const dataBytes = sampleCount * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0, 4, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 4, 'ascii');
  buffer.write('fmt ', 12, 4, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 4, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < sampleCount; index++) {
    const value = Math.round(
      Math.sin((index / sampleRate) * Math.PI * 2 * 220) * 6000
    );
    buffer.writeInt16LE(value, 44 + index * 2);
  }
  return buffer;
};

const selectRemoteImage = async call => {
  for (const query of ['player', 'icon', 'platform', 'button', 'background']) {
    const search = await call('store.resources.search', {
      query,
      kind: 'image',
      limit: 20,
      timeoutMs: 30000,
    });
    const candidates = Array.isArray(search.data && search.data.results)
      ? search.data.results
      : [];
    const candidate = candidates.find(
      item => item && item.url && item.kind === 'image'
    );
    if (candidate) return candidate;
  }
  throw new Error('public_remote_image_not_found');
};

const runRemoteResourcesProcessingLiveScenario = async ({
  allowMutate,
  rollback = true,
  cleanupProject = true,
  outputDir = path.resolve(
    process.cwd(),
    'artifacts',
    'mcp-remote-resources-processing-live-e2e'
  ),
  windowId,
  projectPath,
  env = process.env,
}) => {
  if (!allowMutate) throw new Error('mutation_requires_--allow-mutate');
  fs.mkdirSync(outputDir, { recursive: true });
  const projectRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gdevelop-cap11-12-live-')
  );
  const projectFile = path.join(projectRoot, 'game.json');
  const wavFixture = path.join(projectRoot, 'source.wav');
  const exportDir = path.join(outputDir, 'html5-export');
  fs.writeFileSync(wavFixture, createPcm16Wav());

  const runtime = loadRuntimeConfig(getDefaultDiscoveryPath(env));
  const client = new Client(
    { name: 'gdevelop-remote-resources-processing-live-e2e', version: '1.0.0' },
    {
      capabilities: { elicitation: { form: {} } },
      versionNegotiation: { mode: { pin: runtime.protocolVersion } },
    }
  );
  client.setRequestHandler('elicitation/create', async () => ({
    action: 'accept',
    content: { confirm: true },
  }));
  const transport = new StreamableHTTPClientTransport(
    new URL(runtime.endpoint),
    {
      requestInit: {
        headers: makeRequestHeaders({
          token: runtime.token,
          clientId: 'gdevelop-remote-resources-processing-live-e2e',
          windowId,
          projectPath,
        }),
      },
    }
  );

  const replay = [];
  let transactionId = null;
  let revision = null;
  let previewStarted = false;
  let createdProject = false;

  const record = (name, args, response) => {
    const data = sanitizeForReplay(getData(response));
    const meta = sanitizeForReplay(getMeta(response));
    replay.push({ name, args: sanitizeForReplay(args), data, meta });
    return { response, data, meta };
  };

  const call = async (name, args = {}, { allowError = false } = {}) => {
    const response = await client.callTool({ name, arguments: args });
    const result = record(name, args, response);
    if (response.isError && !allowError) {
      const toolError = result.data && result.data.error;
      throw new Error(
        `tool_failed:${name}:${
          toolError && toolError.code ? toolError.code : 'unknown'
        }`
      );
    }
    return result;
  };

  const mutate = async (name, args) => {
    const result = await call(name, {
      ...args,
      ...(Number.isInteger(revision) ? { expectedRevision: revision } : {}),
      idempotencyKey: `cap11-12-${Date.now().toString(36)}-${replay.length}`,
    });
    if (result.meta && Number.isInteger(result.meta.projectRevision)) {
      revision = result.meta.projectRevision;
    } else {
      revision = (await call('project.status')).data.projectRevision;
    }
    return result;
  };

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assertRequiredTools(tools.tools);

    const initial = await call('project.status');
    if (initial.data && initial.data.projectOpen) {
      throw new Error(
        'live_scenario_requires_fresh_editor_without_open_project'
      );
    }

    await call('project.create', {
      name: `MCP Remote Processing ${Date.now().toString(36)}`,
    });
    createdProject = true;
    await wait(1600);
    await call('project.save-as', { filePath: projectFile });
    await wait(1000);
    const savedStatus = await call('project.status');
    if (!savedStatus.data || !savedStatus.data.projectOpen)
      throw new Error('temporary_project_not_open_after_save');
    revision = savedStatus.data.projectRevision;
    const originalRevision = revision;

    const capabilities = await call('resources.processing.capabilities');
    if (
      !capabilities.data ||
      !capabilities.data.image ||
      capabilities.data.image.supported !== true ||
      !capabilities.data.audio ||
      capabilities.data.audio.supported !== true ||
      capabilities.data.video.supported !== false ||
      capabilities.data.model3D.supported !== false
    ) {
      throw new Error('processing_capabilities_invalid');
    }

    const remoteImage = await selectRemoteImage(call);
    const transaction = await call('safety.transactions.begin', {
      label: 'CAP-11/12 remote resources and asset processing live E2E',
    });
    transactionId = transaction.data.transactionId;
    if (!transactionId) throw new Error('transaction_id_missing');

    const suffix = Date.now().toString(36);
    const sourceImageName = `remote-${suffix}.png`;
    const processedImageName = `processed-${suffix}.png`;
    const sourceAudioName = `source-${suffix}.wav`;
    const processedAudioName = `processed-${suffix}.wav`;
    const sceneName = `MCP Processing ${suffix}`;
    const objectName = `ProcessedSprite${suffix}`;

    const importedRemote = await mutate('resources.import-url', {
      url: remoteImage.url,
      resourceName: sourceImageName,
      kind: 'image',
      maxBytes: 16 * 1024 * 1024,
      timeoutMs: 30000,
      maxRedirects: 5,
      attribution: 'CAP-11/12 live acceptance resource',
    });
    if (!importedRemote.data || !importedRemote.data.provenance)
      throw new Error('remote_import_provenance_missing');

    const remoteInspection = await call('resources.inspect', {
      resourceName: sourceImageName,
    });
    if (
      !remoteInspection.data ||
      !remoteInspection.data.provenance ||
      remoteInspection.data.provenance.source !== 'remote-url' ||
      String(remoteInspection.data.provenance.sourceUrl || '').includes('?')
    ) {
      throw new Error('remote_import_inspection_provenance_invalid');
    }

    const imageTransform = await mutate('resources.image.transform', {
      sourceResourceName: sourceImageName,
      outputResourceName: processedImageName,
      resize: { width: 64 },
      pad: { top: 2, right: 2, bottom: 2, left: 2 },
      outputFormat: 'png',
    });
    if (!imageTransform.data || imageTransform.data.transformed !== true)
      throw new Error('image_transform_failed');
    const imageInspection = await call('resources.inspect', {
      resourceName: processedImageName,
    });
    if (
      !imageInspection.data ||
      !imageInspection.data.provenance ||
      imageInspection.data.provenance.source !== 'agent-transform' ||
      !/^[a-f0-9]{64}$/.test(imageInspection.data.provenance.sha256 || '')
    ) {
      throw new Error('image_transform_provenance_invalid');
    }

    await mutate('resources.import-local', {
      filePath: wavFixture,
      resourceName: sourceAudioName,
      kind: 'audio',
      copyToProject: true,
    });
    const audioTransform = await mutate('resources.audio.transform', {
      sourceResourceName: sourceAudioName,
      outputResourceName: processedAudioName,
      trimStartMs: 20,
      trimEndMs: 200,
      normalize: true,
      targetPeakDb: -3,
    });
    if (!audioTransform.data || audioTransform.data.transformed !== true)
      throw new Error('audio_transform_failed');
    const audioInspection = await call('resources.inspect', {
      resourceName: processedAudioName,
    });
    if (
      !audioInspection.data ||
      !audioInspection.data.provenance ||
      audioInspection.data.provenance.source !== 'agent-transform' ||
      !/^[a-f0-9]{64}$/.test(audioInspection.data.provenance.sha256 || '')
    ) {
      throw new Error('audio_transform_provenance_invalid');
    }

    await mutate('editor.functions.create-scene', { scene_name: sceneName });
    await call('scene.open', { sceneName, mode: 'scene' });
    await wait(400);
    await mutate('editor.functions.create-object', {
      scene_name: sceneName,
      object_name: objectName,
      object_type: 'Sprite',
      description: 'Processed CAP-11/12 acceptance image',
    });
    await mutate('objects.structure.apply', {
      sceneName,
      objectName,
      mode: 'replace',
      structure: {
        kind: 'sprite',
        animations: [
          {
            name: 'Processed',
            useMultipleDirections: false,
            directions: [
              {
                loop: false,
                timeBetweenFrames: 0.1,
                frames: [
                  {
                    image: processedImageName,
                    origin: { x: 0, y: 0 },
                    center: { default: true },
                    points: [],
                    collisionMask: { kind: 'full-image' },
                  },
                ],
              },
            ],
          },
        ],
      },
    });
    await mutate('editor.functions.put-2d-instances', {
      scene_name: sceneName,
      layer_name: '',
      brush_kind: 'point',
      brush_position: '320,240',
      object_name: objectName,
      new_instances_count: 1,
    });

    const validation = await call('validation.run', {
      includeNativeReport: false,
      includeAssets: true,
    });
    if (!validation.data || validation.data.ok !== true)
      throw new Error('project_validation_failed');

    const previewBefore = await call('preview.status');
    if (previewBefore.data && previewBefore.data.running) {
      await call('preview.close-all');
      await wait(300);
    }
    await call('preview.start', { numberOfWindows: 1 });
    previewStarted = true;
    let runtimeEvidence = null;
    for (let attempt = 0; attempt < 24; attempt++) {
      await wait(attempt === 0 ? 1400 : 350);
      const snapshot = await call(
        'runtime.snapshot',
        { objectNames: [objectName], maxInstances: 5 },
        { allowError: true }
      );
      const objectSnapshot =
        snapshot.data && snapshot.data.objects
          ? snapshot.data.objects[objectName]
          : null;
      if (
        !snapshot.response.isError &&
        snapshot.data &&
        snapshot.data.scene &&
        snapshot.data.scene.name === sceneName &&
        objectSnapshot &&
        objectSnapshot.count >= 1
      ) {
        runtimeEvidence = {
          sceneName: snapshot.data.scene.name,
          objectCount: objectSnapshot.count,
        };
        break;
      }
    }
    if (!runtimeEvidence)
      throw new Error('processed_image_runtime_evidence_missing');
    await call('preview.close-all');
    previewStarted = false;

    fs.rmSync(exportDir, { recursive: true, force: true });
    const exported = await call('export.html5', { outputDir: exportDir });
    if (
      !exported.data ||
      path.resolve(exported.data.outputDir || '') !== path.resolve(exportDir)
    ) {
      throw new Error('html5_export_failed');
    }
    if (!fs.existsSync(exportDir))
      throw new Error('html5_export_directory_missing');

    if (rollback) {
      await call('safety.transactions.rollback', { transactionId });
      transactionId = null;
    }
    const finalStatus = await call('project.status');
    if (rollback && finalStatus.data.projectRevision !== originalRevision) {
      throw new Error(
        `rollback_revision_mismatch:${originalRevision}:${
          finalStatus.data.projectRevision
        }`
      );
    }

    const result = {
      ok: true,
      rollback,
      protocolVersion: client.getNegotiatedProtocolVersion(),
      toolCount: tools.tools.length,
      remote: {
        url: remoteImage.url,
        resourceName: sourceImageName,
        provenance: remoteInspection.data.provenance,
      },
      image: {
        resourceName: processedImageName,
        width: imageTransform.data.width,
        height: imageTransform.data.height,
        provenance: imageInspection.data.provenance,
      },
      audio: {
        resourceName: processedAudioName,
        durationMs: audioTransform.data.durationMs,
        provenance: audioInspection.data.provenance,
      },
      runtimeEvidence,
      exportDir,
      validation: validation.data,
      originalRevision,
      finalRevision: finalStatus.data.projectRevision,
      replay,
    };
    fs.writeFileSync(
      path.join(outputDir, 'replay.json'),
      `${JSON.stringify(result, null, 2)}\n`
    );

    if (createdProject) {
      await call('project.close', { discardUnsavedChanges: true });
      createdProject = false;
    }
    if (cleanupProject)
      fs.rmSync(projectRoot, { recursive: true, force: true });
    return result;
  } catch (error) {
    if (previewStarted) {
      try {
        await call('preview.close-all');
      } catch (_) {}
    }
    if (transactionId) {
      try {
        await call('safety.transactions.rollback', { transactionId });
      } catch (_) {}
    }
    if (createdProject) {
      try {
        await call('project.close', { discardUnsavedChanges: true });
      } catch (_) {}
    }
    if (cleanupProject)
      fs.rmSync(projectRoot, { recursive: true, force: true });
    throw error;
  } finally {
    await client.close();
  }
};

const printHelp = () => {
  process.stdout.write(
    [
      'Usage: node AgentIntegration/scripts/McpRemoteResourcesProcessingLiveScenario.js --allow-mutate [options]',
      '',
      'Exercises CAP-11/12 against a fresh running GDevelop desktop editor: saves a temporary project, imports a public image URL with provenance, performs deterministic image/WAV transforms, uses the processed image in a Sprite preview, exports HTML5, rolls project mutations back and removes the temporary project by default.',
      '',
      'Options:',
      '  --allow-mutate        Required explicit opt-in.',
      '  --persist             Do not roll back the AgentIntegration transaction.',
      '  --keep-project        Keep the temporary saved project directory.',
      '  --output <dir>        Sanitized replay/export evidence directory.',
      '  --window-id <id>      Optional editor targeting header.',
      '  --project-path <path> Optional project targeting header.',
      '  --help                Show help.',
      '',
    ].join('\n')
  );
};

if (require.main === module) {
  (async () => {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) return printHelp();
    const result = await runRemoteResourcesProcessingLiveScenario(options);
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: result.ok,
          rollback: result.rollback,
          protocolVersion: result.protocolVersion,
          toolCount: result.toolCount,
          remote: {
            resourceName: result.remote.resourceName,
            source: result.remote.provenance.source,
          },
          image: {
            resourceName: result.image.resourceName,
            width: result.image.width,
            height: result.image.height,
            source: result.image.provenance.source,
          },
          audio: {
            resourceName: result.audio.resourceName,
            durationMs: result.audio.durationMs,
            source: result.audio.provenance.source,
          },
          runtimeEvidence: result.runtimeEvidence,
          exportDir: result.exportDir,
          originalRevision: result.originalRevision,
          finalRevision: result.finalRevision,
        },
        null,
        2
      )}\n`
    );
  })().catch(error => {
    process.stderr.write(
      `MCP remote-resources/processing live scenario failed: ${
        error && error.message ? error.message : String(error)
      }\n`
    );
    process.exitCode = 1;
  });
}

module.exports = {
  REQUIRED_TOOLS,
  assertRequiredTools,
  createPcm16Wav,
  parseArgs,
  runRemoteResourcesProcessingLiveScenario,
};
