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

const STANDARD_EVENT_TYPE = 'BuiltinCommonInstructions::Standard';
const LINK_EVENT_TYPE = 'BuiltinCommonInstructions::Link';

const REQUIRED_TOOLS = [
  'agent.capabilities',
  'project.status',
  'project.create',
  'project.save-as',
  'project.save',
  'project.close',
  'docs.search',
  'docs.read',
  'store.resources.search',
  'store.resources.inspect',
  'store.resources.import',
  'editor.types.objects.list',
  'editor.types.objects.describe',
  'events.instructions.search',
  'events.instructions.describe',
  'editor.functions.create-scene',
  'editor.functions.create-object',
  'editor.functions.put-2d-instances',
  'objects.structure.capabilities',
  'objects.structure.inspect',
  'objects.structure.apply',
  'extensions.project.create',
  'extensions.project.inspect',
  'extensions.functions.create',
  'external-events.create',
  'external-events.inspect',
  'external-layouts.create',
  'external-layouts.inspect',
  'external-layouts.instances.create',
  'external-layouts.instances.list',
  'events.read',
  'events.insert',
  'scene.open',
  'validation.run',
  'diagnostics.inspect',
  'preview.start',
  'preview.status',
  'preview.close-all',
  'preview.visual.baseline.capture',
  'preview.visual.baseline.compare',
  'desktop.windows.list',
  'desktop.window.capture',
  'runtime.snapshot',
  'runtime.assert',
  'runtime.debugger.capabilities',
  'runtime.profile.run',
  'safety.transactions.begin',
  'safety.transactions.commit',
  'safety.transactions.rollback',
  'export.html5',
  'build.targets.list',
  'build.start',
  'build.status',
  'build.result',
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

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const parseArgs = argv => {
  const options = {
    cleanupProject: true,
    allowRemoteBuild: false,
    requireAdditionalBuild: true,
    objectQuery: 'sprite',
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--allow-mutate') options.allowMutate = true;
    else if (argument === '--allow-remote-build')
      options.allowRemoteBuild = true;
    else if (argument === '--allow-no-additional-build')
      options.requireAdditionalBuild = false;
    else if (argument === '--keep-project') options.cleanupProject = false;
    else if (argument === '--output')
      options.outputDir = path.resolve(argv[++index]);
    else if (argument === '--object-query') options.objectQuery = argv[++index];
    else if (argument === '--help') options.help = true;
    else throw new Error(`unknown_argument:${argument}`);
  }
  return options;
};

const assertRequiredTools = tools => {
  const byName = new Map((tools || []).map(tool => [tool.name, tool]));
  const missing = REQUIRED_TOOLS.filter(name => !byName.has(name));
  if (missing.length) {
    throw new Error(`cap25_tools_missing:${missing.join(',')}`);
  }
  for (const name of [
    'docs.search',
    'editor.types.objects.list',
    'events.instructions.search',
    'objects.structure.inspect',
    'runtime.snapshot',
    'build.targets.list',
  ]) {
    const tool = byName.get(name);
    if (!tool.annotations || tool.annotations.readOnlyHint !== true) {
      throw new Error(`cap25_readonly_annotation_invalid:${name}`);
    }
  }
  return byName;
};

const firstResult = data =>
  data && Array.isArray(data.results) && data.results.length
    ? data.results[0]
    : null;

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

const selectAdditionalBuildTarget = targets => {
  const available = (targets || []).filter(
    target =>
      target &&
      target.id !== 'html5-local' &&
      target.availability &&
      target.availability.state === 'available'
  );
  return (
    available.find(target => target.id === 'web-online') ||
    available.find(target => target.deliveryKind === 'remote-build') ||
    available[0] ||
    null
  );
};

const selectImageResource = async call => {
  for (const query of ['player', 'platform', 'icon', 'button', 'background']) {
    const search = await call('store.resources.search', {
      query,
      kind: 'image',
      limit: 20,
      timeoutMs: 30000,
    });
    const candidates =
      search.data && Array.isArray(search.data.results)
        ? search.data.results
        : [];
    const resource = candidates.find(
      item => item && item.kind === 'image' && item.url
    );
    if (resource) return { query, resource };
  }
  throw new Error('cap25_public_image_resource_not_found');
};

const selectStructuralObjectType = async (call, query) => {
  const search = await call('editor.types.objects.list', {
    query,
    deprecated: 'exclude',
    renderingMode: '2d',
    limit: 100,
  });
  const candidates =
    search.data && Array.isArray(search.data.items) ? search.data.items : [];
  for (const candidate of candidates) {
    if (!candidate || !candidate.type) continue;
    const capability = await call('objects.structure.capabilities', {
      objectType: candidate.type,
    });
    if (
      capability.data &&
      capability.data.capability &&
      capability.data.capability.structural === true
    ) {
      const description = await call('editor.types.objects.describe', {
        type: candidate.type,
        extension: candidate.extension && candidate.extension.name,
      });
      return {
        candidate,
        capability: capability.data,
        description: description.data,
      };
    }
  }
  throw new Error(`cap25_structural_object_type_not_found:${query}`);
};

const buildStructuredMutation = ({ inspectedStructure, resourceName }) => {
  if (!inspectedStructure || inspectedStructure.kind !== 'sprite') {
    throw new Error(
      `cap25_structural_handler_not_supported:${
        inspectedStructure && inspectedStructure.kind
          ? inspectedStructure.kind
          : 'unknown'
      }`
    );
  }
  return {
    kind: inspectedStructure.kind,
    objectType: inspectedStructure.objectType,
    adaptCollisionMaskAutomatically: false,
    updateIfNotVisible:
      typeof inspectedStructure.updateIfNotVisible === 'boolean'
        ? inspectedStructure.updateIfNotVisible
        : true,
    preScale:
      typeof inspectedStructure.preScale === 'number'
        ? inspectedStructure.preScale
        : 1,
    animations: [
      {
        name: 'BenchmarkAnimation',
        useMultipleDirections: false,
        directions: [
          {
            loop: true,
            timeBetweenFrames: 0.12,
            metadata: 'cap25-discovered-structure',
            frames: [
              {
                image: resourceName,
                origin: { x: 0, y: 0 },
                center: { default: true },
                points: [{ name: 'BenchmarkPoint', x: 16, y: 16 }],
                collisionMask: { kind: 'full-image' },
              },
            ],
          },
        ],
      },
    ],
  };
};

const findGeneratedZeroParameterAction = async ({
  call,
  extensionName,
  functionName,
}) => {
  const search = await call('events.instructions.search', {
    extension: extensionName,
    query: functionName,
    kind: 'action',
    includeHidden: true,
    deprecated: 'include',
    limit: 100,
  });
  const candidates =
    search.data && Array.isArray(search.data.items) ? search.data.items : [];
  for (const candidate of candidates) {
    if (!candidate || !candidate.id) continue;
    const described = await call('events.instructions.describe', {
      id: candidate.id,
    });
    const item = described.data && described.data.item;
    if (!item || item.kind !== 'action') continue;
    const visibleParameters = Array.isArray(item.parameters)
      ? item.parameters.filter(parameter => parameter && !parameter.codeOnly)
      : [];
    if (visibleParameters.length === 0) {
      return { searchItem: candidate, described: item };
    }
  }
  throw new Error('cap25_generated_zero_parameter_action_not_found');
};

const findZeroParameterSceneCondition = async call => {
  for (const query of ['trigger once', 'once']) {
    const search = await call('events.instructions.search', {
      kind: 'condition',
      query,
      deprecated: 'exclude',
      limit: 100,
    });
    const candidates =
      search.data && Array.isArray(search.data.items) ? search.data.items : [];
    for (const candidate of candidates) {
      if (!candidate || !candidate.id) continue;
      const described = await call('events.instructions.describe', {
        id: candidate.id,
        kind: 'condition',
      });
      const item = described.data && described.data.item;
      if (!item || item.kind !== 'condition') continue;
      if (!item.eventContexts || item.eventContexts.scene !== true) continue;
      if (
        item.scope &&
        (item.scope.kind === 'object' || item.scope.kind === 'behavior')
      ) {
        continue;
      }
      const visibleParameters = Array.isArray(item.parameters)
        ? item.parameters.filter(parameter => parameter && !parameter.codeOnly)
        : [];
      if (visibleParameters.length === 0) {
        return { searchItem: candidate, described: item };
      }
    }
  }
  throw new Error('cap25_zero_parameter_scene_condition_not_found');
};

const findPreviewWindow = windows =>
  (windows || []).find(
    window => window && window.previewWindow && window.visible
  ) || null;

const runAutonomousBenchmarkLiveScenario = async ({
  allowMutate,
  allowRemoteBuild = false,
  requireAdditionalBuild = true,
  cleanupProject = true,
  outputDir = path.resolve(
    process.cwd(),
    'artifacts',
    'mcp-cap25-autonomous-benchmark'
  ),
  objectQuery = 'sprite',
  env = process.env,
}) => {
  if (!allowMutate) throw new Error('mutation_requires_--allow-mutate');
  fs.mkdirSync(outputDir, { recursive: true });
  const projectRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gdevelop-cap25-benchmark-')
  );
  const projectFile = path.join(projectRoot, 'game.json');
  const html5Dir = path.join(outputDir, 'html5-export');
  fs.rmSync(html5Dir, { recursive: true, force: true });

  const runtime = loadRuntimeConfig(getDefaultDiscoveryPath(env));
  let client = null;
  let clientGeneration = 0;
  let revision = null;
  let mainTransactionId = null;
  let rollbackProbeTransactionId = null;
  let previewStarted = false;
  let createdProject = false;
  let phase = 'benchmark';
  const normalAuthoringLifecycleCalls = [];
  const replay = [];
  const markStage = name => {
    process.stdout.write(`[cap25] ${name}\n`);
  };

  const createClient = async clientId => {
    const next = new Client(
      { name: clientId, version: '1.0.0' },
      {
        capabilities: { elicitation: { form: {} } },
        versionNegotiation: { mode: { pin: runtime.protocolVersion } },
      }
    );
    next.setRequestHandler('elicitation/create', async request => {
      const message = String((request.params && request.params.message) || '');
      if (/build|remote|quota|credit|discard|close|rollback/i.test(message)) {
        return { action: 'accept', content: { confirm: true } };
      }
      return { action: 'decline' };
    });
    const transport = new StreamableHTTPClientTransport(
      new URL(runtime.endpoint),
      {
        requestInit: {
          headers: makeRequestHeaders({
            token: runtime.token,
            clientId,
          }),
        },
      }
    );
    await next.connect(transport);
    return next;
  };

  const connect = async label => {
    clientGeneration++;
    client = await createClient(`gdevelop-cap25-${label}-${clientGeneration}`);
    replay.push({
      kind: 'client-connect',
      generation: clientGeneration,
      label,
    });
  };

  const call = async (
    name,
    args = {},
    { allowError = false, timeout = 120000 } = {}
  ) => {
    if (!client) throw new Error('cap25_client_not_connected');
    if (
      phase === 'benchmark' &&
      (name === 'project.open' || name === 'project.close')
    ) {
      normalAuthoringLifecycleCalls.push(name);
    }
    const response = await client.callTool(
      { name, arguments: args },
      { timeout }
    );
    const data = sanitizeForReplay(getData(response));
    const meta = sanitizeForReplay(getMeta(response));
    replay.push({
      kind: 'tool',
      generation: clientGeneration,
      name,
      args: sanitizeForReplay(args),
      data,
      meta,
    });
    if (response.isError && !allowError) {
      const toolError = data && data.error;
      throw new Error(
        `tool_failed:${name}:${
          toolError && toolError.code ? toolError.code : 'unknown'
        }:${toolError && toolError.message ? toolError.message : 'no_message'}`
      );
    }
    return { response, data, meta };
  };

  const refreshRevision = async () => {
    const status = await call('project.status');
    if (!status.data || !Number.isInteger(status.data.projectRevision)) {
      throw new Error('cap25_project_revision_missing');
    }
    revision = status.data.projectRevision;
    return status.data;
  };

  const mutate = async (name, args) => {
    const result = await call(name, {
      ...args,
      ...(Number.isInteger(revision) ? { expectedRevision: revision } : {}),
      idempotencyKey: `cap25-${Date.now().toString(36)}-${replay.length}`,
    });
    if (result.meta && Number.isInteger(result.meta.projectRevision)) {
      revision = result.meta.projectRevision;
    } else {
      await refreshRevision();
    }
    return result;
  };

  try {
    await connect('author');
    const listedTools = await client.listTools();
    assertRequiredTools(listedTools.tools);

    const initial = await call('project.status');
    if (initial.data && initial.data.projectOpen) {
      throw new Error('cap25_requires_fresh_editor_without_open_project');
    }

    await call('project.create', {
      name: `MCP Autonomous Benchmark ${Date.now().toString(36)}`,
    });
    createdProject = true;
    await wait(1600);
    const created = await call('project.status');
    await wait(500);
    const stable = await call('project.status');
    if (
      !created.data ||
      !stable.data ||
      !stable.data.projectOpen ||
      stable.data.projectUuid !== created.data.projectUuid
    ) {
      throw new Error('cap25_project_renderer_not_stable_after_create');
    }
    await call('project.save-as', { filePath: projectFile });
    // Saving-as updates the editor file identity and can replace the renderer
    // integration while file watchers settle. Keep the project open and prove
    // the replacement host is stable before starting long-running network reads.
    await wait(1200);
    const savedProject = await refreshRevision();
    await wait(500);
    const cleanProject = await refreshRevision();
    const projectUuid = cleanProject.projectUuid;
    if (
      !projectUuid ||
      cleanProject.hasUnsavedChanges ||
      savedProject.projectUuid !== projectUuid
    ) {
      throw new Error('cap25_clean_saved_project_not_established');
    }
    markStage('project-ready');

    const capabilities = await call('agent.capabilities');
    if (!capabilities.data || capabilities.data.commandCount < 1) {
      throw new Error('cap25_agent_capabilities_invalid');
    }

    const structuralType = await selectStructuralObjectType(call, objectQuery);
    const objectType = structuralType.candidate.type;
    const objectTypeLabel =
      (structuralType.description &&
        structuralType.description.item &&
        structuralType.description.item.fullName) ||
      structuralType.candidate.fullName ||
      structuralType.candidate.name ||
      objectQuery;

    const docsSearch = await call('docs.search', {
      query: `${objectTypeLabel} object animations`,
      limit: 5,
      timeoutMs: 20000,
    });
    const docResult = firstResult(docsSearch.data);
    if (!docResult || !docResult.url) {
      throw new Error('cap25_documentation_search_empty');
    }
    const docsRead = await call('docs.read', {
      url: docResult.url,
      maxChars: 7000,
      timeoutMs: 20000,
    });
    if (
      !docsRead.data ||
      typeof docsRead.data.text !== 'string' ||
      docsRead.data.text.length < 100
    ) {
      throw new Error('cap25_documentation_read_too_short');
    }

    const selectedResource = await selectImageResource(call);
    const resourceInspection = await call('store.resources.inspect', {
      resourceUrl: selectedResource.resource.url,
      timeoutMs: 30000,
    });
    if (!resourceInspection.data || !resourceInspection.data.provenance) {
      throw new Error('cap25_resource_provenance_missing');
    }

    const transaction = await call('safety.transactions.begin', {
      label: 'CAP-25 autonomous benchmark authoring',
    });
    mainTransactionId = transaction.data && transaction.data.transactionId;
    if (!mainTransactionId) throw new Error('cap25_transaction_id_missing');

    const suffix = Date.now().toString(36);
    const sceneName = `BenchmarkScene${suffix}`;
    const objectName = `BenchmarkObject${suffix}`;
    const extensionName = `BenchmarkExtension${suffix}`;
    const functionName = 'BenchmarkAction';
    const externalEventsName = `BenchmarkExternalEvents${suffix}`;
    const externalLayoutName = `BenchmarkExternalLayout${suffix}`;
    const resourceName = `benchmark-${suffix}-${selectedResource.resource
      .name || 'image.png'}`;

    await mutate('editor.functions.create-scene', {
      scene_name: sceneName,
    });
    await call('scene.open', { sceneName, mode: 'scene' });
    await wait(350);

    await mutate('store.resources.import', {
      resourceUrl: selectedResource.resource.url,
      resourceName,
      timeoutMs: 30000,
    });

    await mutate('editor.functions.create-object', {
      scene_name: sceneName,
      object_name: objectName,
      object_type: objectType,
      description:
        'CAP-25 object type selected from live installed metadata discovery',
    });

    const initialStructure = await call('objects.structure.inspect', {
      sceneName,
      objectName,
    });
    if (!initialStructure.data || !initialStructure.data.structure) {
      throw new Error('cap25_initial_object_structure_missing');
    }
    const replacementStructure = buildStructuredMutation({
      inspectedStructure: initialStructure.data.structure,
      resourceName,
    });
    const appliedStructure = await mutate('objects.structure.apply', {
      sceneName,
      objectName,
      mode: 'replace',
      structure: replacementStructure,
    });
    if (
      !appliedStructure.data ||
      !appliedStructure.data.applied ||
      !appliedStructure.data.structure ||
      !Array.isArray(appliedStructure.data.structure.animations) ||
      appliedStructure.data.structure.animations.length !== 1
    ) {
      throw new Error('cap25_structured_object_apply_failed');
    }

    await mutate('editor.functions.put-2d-instances', {
      scene_name: sceneName,
      layer_name: '',
      brush_kind: 'point',
      brush_position: '480,320',
      object_name: objectName,
      new_instances_count: 1,
    });

    await mutate('extensions.project.create', {
      name: extensionName,
      fullName: `CAP-25 Extension ${suffix}`,
      description:
        'Temporary custom extension authored and discovered through public MCP',
      version: '1.0.0',
    });
    await mutate('extensions.functions.create', {
      extensionName,
      name: functionName,
      type: 'action',
      fullName: 'Benchmark action',
      description:
        'Zero-parameter custom action used by the autonomous benchmark',
    });
    const extensionInspection = await call('extensions.project.inspect', {
      name: extensionName,
    });
    if (
      !extensionInspection.data ||
      !extensionInspection.data.extension ||
      !Array.isArray(extensionInspection.data.extension.functions) ||
      !extensionInspection.data.extension.functions.some(
        item => item && item.name === functionName
      )
    ) {
      throw new Error('cap25_custom_extension_function_missing');
    }

    const extensionFunctionTarget = {
      kind: 'extension-function',
      extensionName,
      functionName,
    };
    const extensionFunctionEvents = await call('events.read', {
      target: extensionFunctionTarget,
    });
    await mutate('events.insert', {
      target: extensionFunctionTarget,
      expectedEventsRevision: extensionFunctionEvents.data.eventsRevision,
      eventsJson: [
        {
          type: STANDARD_EVENT_TYPE,
          conditions: [],
          actions: [],
        },
      ],
    });

    const generatedAction = await findGeneratedZeroParameterAction({
      call,
      extensionName,
      functionName,
    });
    const discoveredSceneCondition = await findZeroParameterSceneCondition(
      call
    );

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
          type: STANDARD_EVENT_TYPE,
          conditions: [
            {
              type: { value: discoveredSceneCondition.described.id },
              parameters: [],
            },
          ],
          actions: [],
        },
      ],
    });
    const externalEventsInspection = await call('external-events.inspect', {
      name: externalEventsName,
    });
    if (
      !externalEventsInspection.data ||
      !externalEventsInspection.data.externalEvents ||
      externalEventsInspection.data.externalEvents.name !== externalEventsName
    ) {
      throw new Error('cap25_external_events_inspect_failed');
    }

    await mutate('external-layouts.create', {
      name: externalLayoutName,
      associatedLayout: sceneName,
    });
    await mutate('external-layouts.instances.create', {
      name: externalLayoutName,
      objectName,
      x: 180,
      y: 180,
      zOrder: 2,
    });
    const externalLayoutInstances = await call(
      'external-layouts.instances.list',
      { name: externalLayoutName }
    );
    if (
      !externalLayoutInstances.data ||
      externalLayoutInstances.data.total !== 1 ||
      externalLayoutInstances.data.items[0].objectName !== objectName
    ) {
      throw new Error('cap25_external_layout_instance_missing');
    }
    const externalLayoutInspection = await call('external-layouts.inspect', {
      name: externalLayoutName,
    });
    if (
      !externalLayoutInspection.data ||
      !externalLayoutInspection.data.externalLayout ||
      externalLayoutInspection.data.externalLayout.name !== externalLayoutName
    ) {
      throw new Error('cap25_external_layout_inspect_failed');
    }

    markStage('authoring-structures-ready');

    const sceneEventsBefore = await call('events.read', { sceneName });
    await mutate('events.insert', {
      sceneName,
      expectedEventsRevision: sceneEventsBefore.data.eventsRevision,
      eventsJson: [
        {
          type: LINK_EVENT_TYPE,
          target: externalEventsName,
          include: { includeConfig: 0 },
        },
      ],
    });

    const validation = await call('validation.run', {
      includeNativeReport: false,
      includeAssets: true,
    });
    if (!validation.data || validation.data.ok !== true) {
      throw new Error('cap25_validation_failed');
    }
    const diagnostics = await call('diagnostics.inspect');
    if (
      diagnostics.data &&
      diagnostics.data.summary &&
      diagnostics.data.summary.errors > 0
    ) {
      throw new Error('cap25_diagnostics_reported_errors');
    }

    await call('scene.open', { sceneName, mode: 'scene' });
    await wait(300);
    await call('preview.start', { numberOfWindows: 1 });
    previewStarted = true;
    markStage('preview-started');

    let snapshot = null;
    let previewWindow = null;
    for (let attempt = 0; attempt < 30; attempt++) {
      await wait(attempt === 0 ? 1400 : 300);
      const windows = await call('desktop.windows.list');
      previewWindow = findPreviewWindow(windows.data) || previewWindow;
      const candidate = await call(
        'runtime.snapshot',
        {
          objectNames: [objectName],
          maxInstances: 5,
        },
        { allowError: true }
      );
      const objectSnapshot =
        candidate.data && candidate.data.objects
          ? candidate.data.objects[objectName]
          : null;
      if (
        previewWindow &&
        candidate.data &&
        candidate.data.scene &&
        candidate.data.scene.name === sceneName &&
        objectSnapshot &&
        objectSnapshot.count === 1
      ) {
        snapshot = candidate.data;
        break;
      }
    }
    if (!snapshot || !previewWindow) {
      throw new Error('cap25_runtime_or_preview_evidence_missing');
    }
    markStage('runtime-evidence-ready');

    const runtimeAssertion = await call('runtime.assert', {
      condition: {
        path: ['objects', objectName, 'count'],
        operator: 'equals',
        value: 1,
      },
    });
    if (!runtimeAssertion.data || runtimeAssertion.data.passed !== true) {
      throw new Error('cap25_runtime_assertion_failed');
    }

    await wait(700);
    const baseline = await call('preview.visual.baseline.capture', {
      previewWindowId: previewWindow.windowId,
      baselineId: 'cap25-stable',
      maxWidth: 960,
      maxHeight: 640,
    });
    const comparison = await call('preview.visual.baseline.compare', {
      previewWindowId: previewWindow.windowId,
      baselineId: 'cap25-stable',
      maxWidth: 960,
      maxHeight: 640,
    });
    if (
      !baseline.data ||
      !/^[a-f0-9]{64}$/.test(baseline.data.sha256) ||
      !comparison.data ||
      comparison.data.passed !== true
    ) {
      throw new Error('cap25_visual_regression_failed');
    }
    const capture = await call('desktop.window.capture', {
      windowId: previewWindow.windowId,
      maxWidth: 1280,
      maxHeight: 800,
    });
    const previewCapturePath = saveCapture({
      response: capture.response,
      outputDir,
      fileName: 'preview.png',
    });

    markStage('visual-qa-ready');

    const debuggerCapabilities = await call('runtime.debugger.capabilities');
    if (!debuggerCapabilities.data) {
      throw new Error('cap25_debugger_capabilities_missing');
    }

    await call('preview.close-all');
    previewStarted = false;

    const profile = await call('runtime.profile.run', {
      sceneName,
      frames: 12,
      hitchThresholdMs: 33.3333333333,
      timeoutMs: 30000,
    });
    if (
      !profile.data ||
      profile.data.status !== 'passed' ||
      profile.data.projectModified !== false
    ) {
      throw new Error('cap25_runtime_profile_failed');
    }
    markStage('profile-ready');

    await call('safety.transactions.commit', {
      transactionId: mainTransactionId,
    });
    mainTransactionId = null;
    await refreshRevision();

    const save = await call('project.save', {});
    if (!save.data || save.data.saved !== true) {
      throw new Error('cap25_project_save_failed');
    }
    const savedStatus = await refreshRevision();
    if (savedStatus.hasUnsavedChanges) {
      throw new Error('cap25_project_still_unsaved_after_save');
    }
    markStage('project-saved');

    const beforeReconnect = {
      projectUuid: savedStatus.projectUuid,
      projectRevision: savedStatus.projectRevision,
      sceneNames: Array.isArray(savedStatus.sceneNames)
        ? savedStatus.sceneNames.slice()
        : [],
    };

    await client.close();
    client = null;
    replay.push({
      kind: 'client-disconnect',
      generation: clientGeneration,
      reason: 'cap25-reconnect-resilience-probe',
    });
    await wait(250);
    await connect('reconnect');
    const reconnectedStatus = await call('project.status');
    if (
      !reconnectedStatus.data ||
      !reconnectedStatus.data.projectOpen ||
      reconnectedStatus.data.projectUuid !== beforeReconnect.projectUuid ||
      reconnectedStatus.data.projectRevision !==
        beforeReconnect.projectRevision ||
      !Array.isArray(reconnectedStatus.data.sceneNames) ||
      !reconnectedStatus.data.sceneNames.includes(sceneName)
    ) {
      throw new Error('cap25_reconnect_did_not_preserve_live_project');
    }
    revision = reconnectedStatus.data.projectRevision;
    markStage('client-reconnected');

    const html5 = await call('export.html5', { outputDir: html5Dir });
    if (
      !html5.data ||
      path.resolve(html5.data.outputDir || '') !== path.resolve(html5Dir) ||
      !fs.existsSync(html5Dir)
    ) {
      throw new Error('cap25_html5_export_failed');
    }
    markStage('html5-exported');

    const targetsResult = await call('build.targets.list');
    const targets =
      targetsResult.data && Array.isArray(targetsResult.data.targets)
        ? targetsResult.data.targets
        : [];
    const additionalTarget = selectAdditionalBuildTarget(targets);
    let additionalBuild = {
      attempted: false,
      available: !!additionalTarget,
      targetId: additionalTarget ? additionalTarget.id : null,
      availability: additionalTarget
        ? additionalTarget.availability
        : { state: 'unavailable', code: 'no_additional_target' },
    };

    if (additionalTarget) {
      if (!allowRemoteBuild) {
        if (requireAdditionalBuild) {
          throw new Error(
            `cap25_additional_build_requires_--allow-remote-build:${
              additionalTarget.id
            }`
          );
        }
      } else {
        markStage(`additional-build-start:${additionalTarget.id}`);
        const started = await call('build.start', {
          targetId: additionalTarget.id,
          payWithCredits: false,
        });
        const buildId =
          started.data && started.data.build && started.data.build.buildId;
        if (!buildId) throw new Error('cap25_additional_build_id_missing');
        let buildStatus = started.data.build;
        for (let attempt = 0; attempt < 120; attempt++) {
          if (buildStatus.status !== 'pending') break;
          await wait(5000);
          const polled = await call('build.status', { buildId });
          buildStatus = polled.data && polled.data.build;
          if (!buildStatus) break;
        }
        if (!buildStatus || buildStatus.status === 'pending') {
          throw new Error('cap25_additional_build_timeout');
        }
        const buildResult = await call('build.result', { buildId });
        if (
          buildStatus.status !== 'complete' ||
          !buildResult.data ||
          buildResult.data.ready !== true ||
          buildResult.data.succeeded !== true ||
          !Array.isArray(buildResult.data.artifacts) ||
          buildResult.data.artifacts.length < 1
        ) {
          throw new Error(
            `cap25_additional_build_failed:${JSON.stringify(
              (buildStatus && buildStatus.detectedErrors) || []
            )}`
          );
        }
        markStage(`additional-build-complete:${additionalTarget.id}`);
        additionalBuild = {
          attempted: true,
          available: true,
          targetId: additionalTarget.id,
          buildId,
          status: buildStatus.status,
          artifacts: buildResult.data.artifacts.map(artifact => ({
            targetId: artifact.targetId,
            kind: artifact.kind || null,
            installable: !!artifact.installable,
            hasUrl:
              typeof artifact.url === 'string' &&
              /^https:\/\//.test(artifact.url),
          })),
        };
      }
    } else if (requireAdditionalBuild) {
      throw new Error('cap25_no_additional_build_target_available');
    }

    const rollbackBaseline = await refreshRevision();
    const rollbackProbe = await call('safety.transactions.begin', {
      label: 'CAP-25 rollback resilience probe after reconnect',
    });
    rollbackProbeTransactionId =
      rollbackProbe.data && rollbackProbe.data.transactionId;
    if (!rollbackProbeTransactionId) {
      throw new Error('cap25_rollback_probe_transaction_missing');
    }
    const rollbackSceneName = `RollbackProbe${suffix}`;
    await mutate('editor.functions.create-scene', {
      scene_name: rollbackSceneName,
    });
    const mutatedStatus = await call('project.status');
    if (
      !mutatedStatus.data ||
      !Array.isArray(mutatedStatus.data.sceneNames) ||
      !mutatedStatus.data.sceneNames.includes(rollbackSceneName)
    ) {
      throw new Error('cap25_rollback_probe_mutation_missing');
    }
    await call('safety.transactions.rollback', {
      transactionId: rollbackProbeTransactionId,
    });
    rollbackProbeTransactionId = null;
    const rollbackRestored = await call('project.status');
    if (
      !rollbackRestored.data ||
      rollbackRestored.data.projectUuid !== rollbackBaseline.projectUuid ||
      (Array.isArray(rollbackRestored.data.sceneNames) &&
        rollbackRestored.data.sceneNames.includes(rollbackSceneName))
    ) {
      throw new Error('cap25_rollback_probe_not_restored');
    }
    revision = rollbackRestored.data.projectRevision;
    markStage('rollback-probe-restored');

    if (normalAuthoringLifecycleCalls.length !== 0) {
      throw new Error(
        `cap25_project_reopen_detected:${normalAuthoringLifecycleCalls.join(
          ','
        )}`
      );
    }

    const result = {
      ok: true,
      protocolVersion: client.getNegotiatedProtocolVersion(),
      toolCount: listedTools.tools.length,
      project: {
        projectUuid,
        filePath: projectFile,
        sceneName,
        noCloseOrReopenDuringAuthoring:
          normalAuthoringLifecycleCalls.length === 0,
      },
      discovery: {
        objectQuery,
        objectType,
        objectTypeLabel,
        structuralCapability: structuralType.capability.capability,
        generatedActionId: generatedAction.described.id,
        generatedActionParameterCount: Array.isArray(
          generatedAction.described.parameters
        )
          ? generatedAction.described.parameters.filter(
              parameter => parameter && !parameter.codeOnly
            ).length
          : 0,
        sceneConditionId: discoveredSceneCondition.described.id,
      },
      documentation: {
        title: docResult.title,
        url: docResult.url,
        readCharacters: docsRead.data.text.length,
        source: docsRead.data.source,
      },
      asset: {
        query: selectedResource.query,
        name: selectedResource.resource.name,
        url: selectedResource.resource.url,
        importedAs: resourceName,
        provenance: resourceInspection.data.provenance,
      },
      authoring: {
        extensionName,
        functionName,
        externalEventsName,
        externalLayoutName,
        objectName,
        structuredAnimation: appliedStructure.data.structure.animations[0].name,
      },
      qa: {
        runtimeObjectCount:
          snapshot.objects && snapshot.objects[objectName]
            ? snapshot.objects[objectName].count
            : 0,
        runtimeAssertionPassed: runtimeAssertion.data.passed,
        visualBaselineSha256: baseline.data.sha256,
        visualComparison: comparison.data.comparison,
        visualPassed: comparison.data.passed,
        previewCapturePath,
        profileStatus: profile.data.status,
        debuggerCapabilities: debuggerCapabilities.data,
      },
      delivery: {
        saved: save.data.saved,
        html5OutputDir: html5Dir,
        additionalBuild,
      },
      resilience: {
        reconnectPreservedProject: true,
        reconnectGeneration: clientGeneration,
        rollbackRestoredRevision: rollbackRestored.data.projectRevision,
        rollbackBaselineRevision: rollbackBaseline.projectRevision,
        rollbackTemporarySceneRemoved: true,
      },
      validation: validation.data,
      replay,
    };

    fs.writeFileSync(
      path.join(outputDir, 'replay.json'),
      `${JSON.stringify(result, null, 2)}\n`
    );
    fs.writeFileSync(
      path.join(outputDir, 'summary.json'),
      `${JSON.stringify(
        {
          ok: result.ok,
          protocolVersion: result.protocolVersion,
          toolCount: result.toolCount,
          project: result.project,
          discovery: result.discovery,
          documentation: result.documentation,
          authoring: result.authoring,
          qa: {
            runtimeObjectCount: result.qa.runtimeObjectCount,
            runtimeAssertionPassed: result.qa.runtimeAssertionPassed,
            visualBaselineSha256: result.qa.visualBaselineSha256,
            visualComparison: result.qa.visualComparison,
            visualPassed: result.qa.visualPassed,
            previewCapturePath: result.qa.previewCapturePath,
            profileStatus: result.qa.profileStatus,
          },
          delivery: result.delivery,
          resilience: result.resilience,
        },
        null,
        2
      )}\n`
    );

    phase = 'cleanup';
    if (createdProject) {
      await call('project.close', { discardUnsavedChanges: true });
      createdProject = false;
    }
    if (cleanupProject) {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
    return result;
  } catch (error) {
    if (previewStarted) {
      try {
        await call('preview.close-all');
      } catch (_) {}
    }
    if (rollbackProbeTransactionId) {
      try {
        await call('safety.transactions.rollback', {
          transactionId: rollbackProbeTransactionId,
        });
      } catch (_) {}
    }
    if (mainTransactionId) {
      try {
        await call('safety.transactions.rollback', {
          transactionId: mainTransactionId,
        });
      } catch (_) {}
    }
    phase = 'cleanup';
    if (createdProject && client) {
      try {
        await call('project.close', { discardUnsavedChanges: true });
        createdProject = false;
      } catch (_) {}
    }
    if (cleanupProject) {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
    throw error;
  } finally {
    if (client) {
      try {
        await client.close();
      } catch (_) {}
    }
  }
};

const printHelp = () => {
  process.stdout.write(
    [
      'Usage: node AgentIntegration/scripts/McpAutonomousBenchmarkLiveScenario.js --allow-mutate --allow-remote-build [options]',
      '',
      'Runs the CAP-25 product-level autonomous game-creation benchmark using only the public MCP endpoint. It creates and keeps one clean project open through discovery, authoring, preview/QA, save/export/build, client reconnect and rollback resilience; project.close is used only for final cleanup.',
      '',
      'Options:',
      '  --allow-mutate               Required explicit project mutation opt-in.',
      '  --allow-remote-build         Allow one available non-HTML5 remote build target with payWithCredits=false.',
      '  --allow-no-additional-build  Do not fail if no additional build is run (not valid for the CAP-25 completion gate).',
      '  --keep-project               Keep the temporary saved project directory.',
      '  --output <dir>               Sanitized replay/evidence directory.',
      '  --object-query <query>       Natural-language object type discovery query (default: sprite).',
      '  --help                       Show help.',
      '',
    ].join('\n')
  );
};

if (require.main === module) {
  (async () => {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) return printHelp();
    const result = await runAutonomousBenchmarkLiveScenario(options);
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: result.ok,
          protocolVersion: result.protocolVersion,
          toolCount: result.toolCount,
          project: result.project,
          discovery: result.discovery,
          authoring: result.authoring,
          qa: {
            runtimeObjectCount: result.qa.runtimeObjectCount,
            runtimeAssertionPassed: result.qa.runtimeAssertionPassed,
            visualPassed: result.qa.visualPassed,
            profileStatus: result.qa.profileStatus,
          },
          delivery: result.delivery,
          resilience: result.resilience,
        },
        null,
        2
      )}\n`
    );
  })().catch(error => {
    process.stderr.write(
      `MCP autonomous benchmark failed: ${
        error && error.message ? error.message : String(error)
      }\n`
    );
    process.exitCode = 1;
  });
}

module.exports = {
  REQUIRED_TOOLS,
  assertRequiredTools,
  buildStructuredMutation,
  findGeneratedZeroParameterAction,
  findZeroParameterSceneCondition,
  parseArgs,
  runAutonomousBenchmarkLiveScenario,
  selectAdditionalBuildTarget,
  selectImageResource,
  selectStructuralObjectType,
};
