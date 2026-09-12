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
  'project.create',
  'scene.open',
  'safety.transactions.begin',
  'safety.transactions.commit',
  'safety.transactions.rollback',
  'store.resources.search',
  'store.resources.inspect',
  'store.resources.import',
  'editor.functions.create-scene',
  'editor.functions.create-object',
  'editor.functions.put-2d-instances',
  'objects.structure.capabilities',
  'objects.structure.inspect',
  'objects.structure.apply',
  'extensions.installed.list',
  'extensions.installed.inspect',
  'extensions.catalog.search',
  'extensions.catalog.describe',
  'extensions.install',
  'extensions.update',
  'extensions.remove',
  'validation.run',
  'preview.status',
  'preview.start',
  'preview.close-all',
  'runtime.snapshot',
  'desktop.windows.list',
  'desktop.window.capture',
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
    else if (argument === '--skip-extension-install')
      options.skipExtensionInstall = true;
    else if (argument === '--help') options.help = true;
    else throw new Error(`unknown_argument:${argument}`);
  }
  return options;
};

const assertRequiredTools = tools => {
  const byName = new Map((tools || []).map(tool => [tool.name, tool]));
  const missing = REQUIRED_TOOLS.filter(name => !byName.has(name));
  if (missing.length)
    throw new Error(
      `object_structure_extension_tools_missing:${missing.join(',')}`
    );

  const apply = byName.get('objects.structure.apply');
  if (
    !apply.inputSchema ||
    !apply.inputSchema.properties ||
    !apply.inputSchema.properties.structure ||
    !apply.annotations ||
    apply.annotations.readOnlyHint !== false
  ) {
    throw new Error('object_structure_apply_schema_or_annotations_invalid');
  }

  const installedList = byName.get('extensions.installed.list');
  if (
    !installedList.annotations ||
    installedList.annotations.readOnlyHint !== true
  ) {
    throw new Error('extensions_installed_list_annotations_invalid');
  }
  return byName;
};

const saveCapture = ({ response, outputDir, fileName }) => {
  const image =
    response &&
    Array.isArray(response.content) &&
    response.content.find(item => item && item.type === 'image');
  if (!image || !image.data)
    throw new Error(`capture_missing_image:${fileName}`);
  const filePath = path.join(outputDir, fileName);
  fs.writeFileSync(filePath, Buffer.from(image.data, 'base64'));
  return filePath;
};

const firstResult = result => {
  if (!result) return null;
  if (Array.isArray(result.results) && result.results.length)
    return result.results[0];
  if (Array.isArray(result.items) && result.items.length)
    return result.items[0];
  return null;
};

const selectImageResource = async call => {
  for (const query of ['player', 'platform', 'icon', 'button', 'background']) {
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
  throw new Error('public_image_resource_not_found');
};

const chooseInstallableExtension = items =>
  (items || []).find(
    item =>
      item &&
      item.name &&
      !item.installed &&
      item.tier !== 'experimental' &&
      (!Array.isArray(item.requiredExtensions) ||
        item.requiredExtensions.length <= 4)
  ) ||
  (items || []).find(item => item && item.name && !item.installed) ||
  null;

const runObjectStructureExtensionsLiveScenario = async ({
  allowMutate,
  rollback = true,
  outputDir = path.resolve(
    process.cwd(),
    'artifacts',
    'mcp-object-structure-extensions-live-e2e'
  ),
  windowId,
  projectPath,
  openProjectPath,
  skipExtensionInstall = false,
  env = process.env,
}) => {
  if (!allowMutate) throw new Error('mutation_requires_--allow-mutate');
  fs.mkdirSync(outputDir, { recursive: true });

  const runtime = loadRuntimeConfig(getDefaultDiscoveryPath(env));
  const client = new Client(
    { name: 'gdevelop-object-structure-extensions-live-e2e', version: '1.0.0' },
    { versionNegotiation: { mode: { pin: runtime.protocolVersion } } }
  );
  const transport = new StreamableHTTPClientTransport(
    new URL(runtime.endpoint),
    {
      requestInit: {
        headers: makeRequestHeaders({
          token: runtime.token,
          clientId: 'gdevelop-object-structure-extensions-live-e2e',
          windowId,
          projectPath,
        }),
      },
    }
  );

  const replay = [];
  let transactionId = null;
  let previewStartedByScenario = false;
  let revision = null;

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
      const toolError =
        result.data && result.data.error ? result.data.error : null;
      const error = new Error(
        `tool_failed:${name}:${
          toolError && toolError.code ? toolError.code : 'unknown'
        }:${toolError && toolError.message ? toolError.message : 'no_message'}`
      );
      error.response = response;
      throw error;
    }
    return result;
  };

  const mutate = async (name, args) => {
    const result = await call(name, {
      ...args,
      ...(Number.isInteger(revision) ? { expectedRevision: revision } : {}),
      idempotencyKey: `cap09-10-${Date.now().toString(36)}-${replay.length}`,
    });
    if (result.meta && Number.isInteger(result.meta.projectRevision)) {
      revision = result.meta.projectRevision;
    } else {
      const status = await call('project.status');
      revision = status.data.projectRevision;
    }
    return result;
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
        name: `MCP Object Structure Acceptance ${Date.now().toString(36)}`,
      });
      // Creating a project swaps the live renderer integration. Wait for the
      // replacement host to remain registered before starting a long-running
      // store request, otherwise the old bridge can legitimately cancel it.
      await wait(1600);
      initial = await call('project.status');
      await wait(500);
      const stabilized = await call('project.status');
      if (
        !stabilized.data ||
        !stabilized.data.projectOpen ||
        stabilized.data.projectUuid !== initial.data.projectUuid
      ) {
        throw new Error('project_renderer_not_stable_after_create');
      }
      initial = stabilized;
      createdProjectByScenario = true;
    }
    if (!initial.data || !initial.data.projectOpen)
      throw new Error('no_project_open');

    const originalRevision = initial.data.projectRevision;
    const originalScene =
      Array.isArray(initial.data.sceneNames) && initial.data.sceneNames.length
        ? initial.data.sceneNames[0]
        : null;
    revision = originalRevision;

    const windowsBefore = await call('desktop.windows.list');
    const editorWindow = (windowsBefore.data || []).find(
      item => item.editorWindow
    );
    if (!editorWindow) throw new Error('editor_window_not_found');

    const resource = await selectImageResource(call);
    const resourceInspection = await call('store.resources.inspect', {
      resourceUrl: resource.url,
      timeoutMs: 30000,
    });
    if (!resourceInspection.data || !resourceInspection.data.provenance)
      throw new Error('resource_provenance_missing');

    const spriteCapability = await call('objects.structure.capabilities', {
      objectType: 'Sprite',
    });
    if (
      !spriteCapability.data ||
      !spriteCapability.data.capability ||
      spriteCapability.data.capability.id !== 'sprite' ||
      spriteCapability.data.capability.structural !== true
    ) {
      throw new Error('sprite_structural_capability_missing');
    }

    const installedBefore = await call('extensions.installed.list');
    if (
      !installedBefore.data ||
      !installedBefore.data.counts ||
      installedBefore.data.counts.builtIn < 1
    ) {
      throw new Error('installed_extension_inventory_invalid');
    }

    const catalog = await call('extensions.catalog.search', {
      tier: 'reviewed',
      limit: 100,
      refresh: true,
    });
    if (!catalog.data || !Array.isArray(catalog.data.items))
      throw new Error('extension_catalog_invalid');

    const transaction = await call('safety.transactions.begin', {
      label: 'CAP-09/10 structural objects and extension lifecycle live E2E',
    });
    transactionId = transaction.data.transactionId;
    if (!transactionId) throw new Error('transaction_id_missing');

    const suffix = Date.now().toString(36);
    const sceneName = `MCP Structures ${suffix}`;
    const objectName = `McpStructuredSprite${suffix}`;
    const resourceName = `mcp-structure-${suffix}-${resource.name ||
      'sprite.png'}`;

    await mutate('editor.functions.create-scene', { scene_name: sceneName });
    await call('scene.open', { sceneName, mode: 'scene' });
    await wait(500);

    await mutate('store.resources.import', {
      resourceUrl: resource.url,
      resourceName,
      timeoutMs: 30000,
    });

    await mutate('editor.functions.create-object', {
      scene_name: sceneName,
      object_name: objectName,
      object_type: 'Sprite',
      description:
        'Temporary raw-resource Sprite built by CAP-09/10 live acceptance',
    });

    const structure = {
      kind: 'sprite',
      adaptCollisionMaskAutomatically: false,
      updateIfNotVisible: true,
      preScale: 1,
      animations: [
        {
          name: 'AgentBuilt',
          useMultipleDirections: false,
          directions: [
            {
              loop: true,
              timeBetweenFrames: 0.12,
              metadata: 'cap-09-live',
              frames: [
                {
                  image: resourceName,
                  origin: { x: 0, y: 0 },
                  center: { default: true },
                  points: [{ name: 'AgentPoint', x: 16, y: 16 }],
                  collisionMask: {
                    kind: 'polygons',
                    polygons: [
                      [
                        { x: 0, y: 0 },
                        { x: 64, y: 0 },
                        { x: 64, y: 64 },
                        { x: 0, y: 64 },
                      ],
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    };

    const applied = await mutate('objects.structure.apply', {
      sceneName,
      objectName,
      mode: 'replace',
      structure,
    });
    if (
      !applied.data ||
      !applied.data.applied ||
      !applied.data.structure ||
      applied.data.structure.animations[0].name !== 'AgentBuilt'
    ) {
      throw new Error('sprite_structure_apply_invalid');
    }

    const inspected = await call('objects.structure.inspect', {
      sceneName,
      objectName,
    });
    const inspectedFrame =
      inspected.data &&
      inspected.data.structure &&
      inspected.data.structure.animations &&
      inspected.data.structure.animations[0] &&
      inspected.data.structure.animations[0].directions[0] &&
      inspected.data.structure.animations[0].directions[0].frames[0];
    if (
      !inspectedFrame ||
      inspectedFrame.image !== resourceName ||
      !Array.isArray(inspectedFrame.points) ||
      !inspectedFrame.points.some(point => point.name === 'AgentPoint') ||
      !inspectedFrame.collisionMask ||
      inspectedFrame.collisionMask.kind !== 'polygons'
    ) {
      throw new Error('sprite_structure_roundtrip_invalid');
    }

    await mutate('editor.functions.put-2d-instances', {
      scene_name: sceneName,
      layer_name: '',
      brush_kind: 'point',
      brush_position: '420,280',
      object_name: objectName,
      new_instances_count: 1,
    });

    let extensionEvidence = { skipped: true };
    if (!skipExtensionInstall) {
      const candidates = catalog.data.items.filter(
        item => item && !item.installed
      );
      let installedCandidate = null;
      let lastInstallError = null;
      const preferred = chooseInstallableExtension(candidates);
      const orderedCandidates = preferred
        ? [
            preferred,
            ...candidates.filter(item => item.name !== preferred.name),
          ]
        : candidates;
      for (const candidate of orderedCandidates.slice(0, 12)) {
        const described = await call('extensions.catalog.describe', {
          name: candidate.name,
        });
        if (!described.data || !described.data.extension) continue;
        const install = await call(
          'extensions.install',
          {
            name: candidate.name,
            expectedRevision: revision,
            idempotencyKey: `cap09-10-extension-install-${suffix}-${
              candidate.name
            }`,
          },
          { allowError: true }
        );
        if (install.response.isError) {
          lastInstallError = install.data && install.data.error;
          continue;
        }
        const statusAfterInstall = await call('project.status');
        revision = statusAfterInstall.data.projectRevision;
        if (!install.data || install.data.changed !== true) continue;
        installedCandidate = candidate;
        break;
      }
      if (!installedCandidate) {
        throw new Error(
          `no_catalog_extension_installable:${
            lastInstallError && lastInstallError.code
              ? lastInstallError.code
              : 'unknown'
          }`
        );
      }

      const installed = await call('extensions.installed.inspect', {
        name: installedCandidate.name,
      });
      if (
        !installed.data ||
        !installed.data.extension ||
        installed.data.extension.source !== 'store'
      ) {
        throw new Error('installed_extension_not_classified_as_store');
      }

      const update = await mutate('extensions.update', {
        name: installedCandidate.name,
      });
      if (!update.data || update.data.changed !== false) {
        throw new Error('same_version_extension_update_should_be_noop');
      }

      const removed = await mutate('extensions.remove', {
        name: installedCandidate.name,
        allowReferenced: false,
      });
      if (!removed.data || removed.data.removed !== true) {
        throw new Error('extension_remove_failed');
      }

      extensionEvidence = {
        skipped: false,
        name: installedCandidate.name,
        catalogVersion: catalog.data.registryVersion || null,
        sourceAfterInstall: installed.data.extension.source,
        updateChanged: update.data.changed,
        removed: removed.data.removed,
      };
    }

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
    previewStartedByScenario = true;

    let snapshot = null;
    let lastSnapshotError = null;
    for (let attempt = 0; attempt < 24; attempt++) {
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
        `runtime_structured_sprite_evidence_missing:${
          lastSnapshotError && lastSnapshotError.message
            ? lastSnapshotError.message
            : 'preview_snapshot_not_ready'
        }`
      );
    }

    let previewCapturePath = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      const windows = await call('desktop.windows.list');
      const previewWindow = (windows.data || []).find(
        item => item.previewWindow
      );
      if (previewWindow) {
        const capture = await call('desktop.window.capture', {
          windowId: previewWindow.windowId,
          maxWidth: 1280,
          maxHeight: 800,
        });
        previewCapturePath = saveCapture({
          response: capture.response,
          outputDir,
          fileName: 'preview-structured-sprite.png',
        });
        break;
      }
      await wait(250);
    }
    if (!previewCapturePath) throw new Error('preview_window_capture_missing');

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

    const result = {
      ok: true,
      rollback,
      createdProjectByScenario,
      protocolVersion: client.getNegotiatedProtocolVersion(),
      toolCount: tools.tools.length,
      resource: {
        name: resource.name,
        url: resource.url,
        importedAs: resourceName,
        provenance: resourceInspection.data.provenance,
      },
      objectStructure: {
        sceneName,
        objectName,
        handler: spriteCapability.data.capability.id,
        animationName: inspected.data.structure.animations[0].name,
        pointName: inspectedFrame.points[0].name,
        collisionMaskKind: inspectedFrame.collisionMask.kind,
      },
      extensionLifecycle: extensionEvidence,
      runtimeEvidence: {
        sceneName: snapshot.scene && snapshot.scene.name,
        objectCount:
          snapshot.objects && snapshot.objects[objectName]
            ? snapshot.objects[objectName].count
            : 0,
      },
      visualEvidence: { previewCapturePath },
      validation: validation.data,
      originalRevision,
      finalRevision: finalStatus.data.projectRevision,
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
      'Usage: node AgentIntegration/scripts/McpObjectStructureExtensionsLiveScenario.js --allow-mutate [options]',
      '',
      'Exercises CAP-09/10 against a running GDevelop desktop editor: imports a public raw image resource, builds a Sprite nested structure, previews/captures it, exercises Extension Store lifecycle, and rolls all mutations back by default.',
      '',
      'Options:',
      '  --allow-mutate             Required explicit opt-in.',
      '  --persist                  Commit instead of rolling back.',
      '  --output <dir>             Sanitized replay/evidence directory.',
      '  --window-id <id>           Optional editor targeting header.',
      '  --project-path <path>      Optional project targeting header.',
      '  --open-project-path <p>    Open this local project through MCP before running.',
      '  --skip-extension-install   Skip live network install/remove while still testing catalog/inventory.',
      '  --help                     Show help.',
      '',
    ].join('\n')
  );
};

if (require.main === module) {
  (async () => {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) return printHelp();
    const result = await runObjectStructureExtensionsLiveScenario(options);
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: result.ok,
          rollback: result.rollback,
          createdProjectByScenario: result.createdProjectByScenario,
          protocolVersion: result.protocolVersion,
          toolCount: result.toolCount,
          objectStructure: result.objectStructure,
          extensionLifecycle: result.extensionLifecycle,
          runtimeEvidence: result.runtimeEvidence,
          visualEvidence: result.visualEvidence,
          originalRevision: result.originalRevision,
          finalRevision: result.finalRevision,
        },
        null,
        2
      )}\n`
    );
  })().catch(error => {
    process.stderr.write(
      `MCP object-structure/extensions live scenario failed: ${
        error && error.message ? error.message : String(error)
      }\n`
    );
    process.exitCode = 1;
  });
}

module.exports = {
  REQUIRED_TOOLS,
  assertRequiredTools,
  chooseInstallableExtension,
  parseArgs,
  runObjectStructureExtensionsLiveScenario,
  saveCapture,
};
