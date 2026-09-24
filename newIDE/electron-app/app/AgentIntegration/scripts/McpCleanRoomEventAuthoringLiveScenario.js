const fs = require('fs');
const os = require('os');
const path = require('path');
const { connectLiveGDevelopMcp, sanitizeForReplay } = require('./McpClient');

const GUIDE_URI = 'gdevelop://guides/native-event-authoring';
const GUIDE_PROMPT = 'gdevelop.events-authoring';
const SCENE_NAME = 'DX9CleanRoom';
const PROJECT_NAME = 'DX9 Clean Room Acceptance';

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const clone = value => JSON.parse(JSON.stringify(value));

const getProjectRevision = result =>
  result && result.meta && Number.isInteger(result.meta.projectRevision)
    ? result.meta.projectRevision
    : result && result.data && Number.isInteger(result.data.projectRevision)
    ? result.data.projectRevision
    : null;

const callOk = async (session, name, args = {}) => {
  const result = await session.call(name, args);
  if (result.isError) {
    const error = new Error(
      `${name} failed: ${JSON.stringify(
        result.structuredContent || result.content || result.data
      )}`
    );
    error.result = result;
    throw error;
  }
  return result;
};

const findTool = (tools, name) => {
  const tool = tools.find(candidate => candidate.name === name);
  assert(tool, `missing_tool:${name}`);
  return tool;
};

const visibleParameters = item =>
  Array.isArray(item.parameters)
    ? item.parameters.filter(parameter => !parameter.codeOnly)
    : [];

const getPromptText = prompt => {
  const messages =
    prompt && Array.isArray(prompt.messages) ? prompt.messages : [];
  const content = messages[0] && messages[0].content;
  return content && typeof content.text === 'string' ? content.text : '';
};

const getResourceText = resource => {
  const contents =
    resource && Array.isArray(resource.contents) ? resource.contents : [];
  const content = contents[0];
  return content && typeof content.text === 'string' ? content.text : '';
};

const selectInstruction = async ({ session, kind, query, predicate }) => {
  const searched = await callOk(session, 'events.instructions.search', {
    kind,
    query,
    deprecated: 'exclude',
    limit: 100,
  });
  const items =
    searched.data && Array.isArray(searched.data.items)
      ? searched.data.items
      : [];
  const selected = items.find(predicate);
  assert(selected, `clean_room_instruction_not_found:${kind}:${query}`);
  const described = await callOk(session, 'events.instructions.describe', {
    id: selected.id,
    kind,
    extension: selected.extension && selected.extension.name,
  });
  assert(
    described.data && described.data.item,
    `clean_room_instruction_describe_failed:${selected.id}`
  );
  return described.data.item;
};

const selectNode = async ({ session, query, predicate }) => {
  const listed = await callOk(session, 'events.nodes.list', {
    query,
    limit: 100,
  });
  const items =
    listed.data && Array.isArray(listed.data.items) ? listed.data.items : [];
  for (const item of items) {
    const described = await callOk(session, 'events.nodes.describe', {
      type: item.type,
    });
    const node = described.data && described.data.item;
    if (node && predicate(node)) return node;
  }
  throw new Error(`clean_room_event_node_not_found:${query}`);
};

const findEventHandle = (eventsRead, type) => {
  const nodes =
    eventsRead && eventsRead.data && Array.isArray(eventsRead.data.events)
      ? eventsRead.data.events
      : [];
  const node = nodes.find(candidate => candidate.type === type);
  assert(node && typeof node.handle === 'string', `missing_handle:${type}`);
  return node.handle;
};

const findEventJson = (eventsRead, type) => {
  const eventsJson =
    eventsRead && eventsRead.data && Array.isArray(eventsRead.data.eventsJson)
      ? eventsRead.data.eventsJson
      : [];
  const eventJson = eventsJson.find(candidate => {
    const candidateType =
      candidate && candidate.type && typeof candidate.type === 'object'
        ? candidate.type.value
        : candidate && candidate.type;
    return candidateType === type;
  });
  assert(eventJson, `missing_event_json:${type}`);
  return eventJson;
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const waitForPreview = async session => {
  const deadline = Date.now() + 30000;
  let lastStatus = null;
  while (Date.now() < deadline) {
    const status = await session.call('preview.status', {});
    lastStatus = status;
    if (
      !status.isError &&
      status.data &&
      (status.data.running === true ||
        status.data.serverState === 'running' ||
        status.data.state === 'running')
    ) {
      return status;
    }
    await sleep(500);
  }
  throw new Error(
    `preview_not_ready:${JSON.stringify(
      lastStatus &&
        (lastStatus.structuredContent || lastStatus.data || lastStatus.content)
    )}`
  );
};

const waitForRuntimeLogs = async session => {
  const deadline = Date.now() + 30000;
  let last = null;
  while (Date.now() < deadline) {
    const logs = await session.call('runtime.logs', { limit: 50 });
    last = logs;
    if (!logs.isError && logs.data) return logs;
    await sleep(500);
  }
  throw new Error(
    `runtime_logs_not_ready:${JSON.stringify(
      last && (last.structuredContent || last.data || last.content)
    )}`
  );
};

const installRepositoryReadGuard = () => {
  const repositoryRoot = path.resolve(__dirname, '..', '..', '..', '..', '..');
  const originalReadFileSync = fs.readFileSync.bind(fs);
  const originalReadFile = fs.readFile.bind(fs);

  const assertAllowed = filePath => {
    if (typeof filePath !== 'string') return;
    const resolved = path.resolve(filePath);
    const relative = path.relative(repositoryRoot, resolved);
    const insideRepository =
      relative === '' ||
      (!relative.startsWith('..') && !path.isAbsolute(relative));
    if (insideRepository) {
      throw new Error(
        `clean_room_repository_read_forbidden:${path.basename(resolved)}`
      );
    }
  };

  fs.readFileSync = (filePath, ...args) => {
    assertAllowed(filePath);
    return originalReadFileSync(filePath, ...args);
  };
  fs.readFile = (filePath, ...args) => {
    assertAllowed(filePath);
    return originalReadFile(filePath, ...args);
  };

  return () => {
    fs.readFileSync = originalReadFileSync;
    fs.readFile = originalReadFile;
  };
};

const run = async ({
  evidencePath = path.resolve(
    __dirname,
    '..',
    'docs',
    'evidence',
    'DX9_CLEAN_ROOM_ACCEPTANCE.json'
  ),
} = {}) => {
  // Everything required from this point onward must be learned through MCP.
  // Repository source/tests are deliberately unreadable during the scenario.
  const restoreRepositoryReads = installRepositoryReadGuard();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gdevelop-dx9-'));
  const savePath = path.join(tempDir, 'DX9CleanRoom.json');
  let session = null;
  let previewStarted = false;

  try {
    session = await connectLiveGDevelopMcp({
      clientId: 'gdevelop-dx9-clean-room',
    });

    const initialTools = await session.listTools();
    [
      'project.create',
      'project.status',
      'editor.functions.create-scene',
      'events.read',
      'events.insert',
      'events.style.update',
      'events.instructions.search',
      'events.instructions.describe',
      'events.nodes.list',
      'events.nodes.describe',
      'validation.run',
      'preview.start',
      'preview.status',
      'runtime.logs',
      'project.save-as',
    ].forEach(name => findTool(initialTools, name));

    const prompts = await session.listPrompts();
    assert(
      prompts.some(prompt => prompt.name === GUIDE_PROMPT),
      'native_event_authoring_prompt_missing'
    );
    const prompt = await session.getPrompt(GUIDE_PROMPT);
    const promptText = getPromptText(prompt);

    const resources = await session.listResources();
    const guideResource = resources.find(
      resource => resource.uri === GUIDE_URI
    );
    assert(guideResource, 'native_event_authoring_resource_missing');
    const guide = await session.readResource(GUIDE_URI);
    const guideText = getResourceText(guide);

    [
      'events.read.data.eventsJson',
      'events.instructions.search',
      'kind="expression"',
      'events.nodes.describe',
      'events.style.update',
      'expectedEventsRevision',
      'validation.run',
      'preview.',
      'project.save',
      'sanitized',
      'subInstructions',
    ].forEach(fragment => {
      assert(
        promptText.includes(fragment) || guideText.includes(fragment),
        `authoring_guide_missing:${fragment}`
      );
    });

    const before = await callOk(session, 'project.status', {});
    assert(
      !before.data || before.data.projectOpen === false,
      'clean_room_requires_fresh_editor_without_open_project'
    );

    await callOk(session, 'project.create', {
      name: PROJECT_NAME,
      idempotencyKey: 'dx9-create-project',
    });
    await callOk(session, 'editor.functions.create-scene', {
      scene_name: SCENE_NAME,
      is_first_scene: true,
      idempotencyKey: 'dx9-create-scene',
    });

    // Reconnect so tools/list is rebuilt from the now-open project and exposes
    // connected-build event mutation schema projection.
    await session.close();
    session = await connectLiveGDevelopMcp({
      clientId: 'gdevelop-dx9-clean-room',
    });

    const tools = await session.listTools();
    const insertTool = findTool(tools, 'events.insert');
    const eventItemSchema =
      insertTool.inputSchema &&
      insertTool.inputSchema.properties &&
      insertTool.inputSchema.properties.eventsJson &&
      insertTool.inputSchema.properties.eventsJson.items;
    assert(
      eventItemSchema &&
        Array.isArray(eventItemSchema.oneOf) &&
        eventItemSchema['x-gdevelop-schema-reference'],
      'connected_build_event_mutation_schema_missing'
    );

    const projectStatus = await callOk(session, 'project.status', {});
    const initialProjectRevision = getProjectRevision(projectStatus);
    assert(
      Number.isInteger(initialProjectRevision),
      'missing_project_revision_after_create'
    );

    const condition = await selectInstruction({
      session,
      kind: 'condition',
      query: 'scene begins',
      predicate: item =>
        item.scope &&
        item.scope.kind === 'free' &&
        item.eventContexts &&
        item.eventContexts.scene === true &&
        item.extension &&
        item.extension.name === 'BuiltinScene' &&
        visibleParameters(item).length === 0,
    });
    assert(
      visibleParameters(condition).length === 0,
      'selected_condition_requires_visible_parameters'
    );

    const action = await selectInstruction({
      session,
      kind: 'action',
      query: 'wait',
      predicate: item =>
        item.scope &&
        item.scope.kind === 'free' &&
        item.eventContexts &&
        item.eventContexts.scene === true &&
        item.extension &&
        item.extension.name === 'BuiltinTime' &&
        visibleParameters(item).length === 1 &&
        visibleParameters(item)[0].valueType &&
        visibleParameters(item)[0].valueType.number === true,
    });

    const expression = await selectInstruction({
      session,
      kind: 'expression',
      query: 'random in range',
      predicate: item =>
        item.scope &&
        item.scope.kind === 'free' &&
        item.returnType === 'number' &&
        visibleParameters(item).length === 2 &&
        visibleParameters(item).every(
          parameter =>
            parameter.valueType && parameter.valueType.number === true
        ),
    });

    const groupNode = await selectNode({
      session,
      query: 'group',
      predicate: node =>
        node.schemaAvailable === true &&
        node.canHaveSubEvents === true &&
        node.canonicalExample &&
        typeof node.canonicalExample.name === 'string' &&
        Number.isInteger(node.canonicalExample.colorR),
    });
    const commentNode = await selectNode({
      session,
      query: 'comment',
      predicate: node =>
        node.schemaAvailable === true &&
        node.canHaveSubEvents === false &&
        node.canonicalExample &&
        typeof node.canonicalExample.comment === 'string' &&
        node.canonicalExample.color &&
        Number.isInteger(node.canonicalExample.color.r),
    });
    const standardNode = await selectNode({
      session,
      query: 'standard',
      predicate: node =>
        node.schemaAvailable === true &&
        node.canonicalExample &&
        Array.isArray(node.canonicalExample.conditions) &&
        Array.isArray(node.canonicalExample.actions),
    });

    const initialEvents = await callOk(session, 'events.read', {
      sceneName: SCENE_NAME,
    });
    const eventsRevision =
      initialEvents.data && initialEvents.data.eventsRevision;
    assert(
      typeof eventsRevision === 'string' && eventsRevision,
      'missing_initial_events_revision'
    );

    const groupJson = clone(groupNode.canonicalExample);
    groupJson.name = 'DX9 Clean Room Group';

    const commentJson = clone(commentNode.canonicalExample);
    commentJson.comment =
      'Authored from MCP-discovered node and instruction contracts only.';

    const expressionSource = `${expression.id}(0, 0)`;
    const standardJson = clone(standardNode.canonicalExample);
    standardJson.conditions = [
      {
        type: { value: condition.id },
        parameters: [],
        subInstructions: [],
      },
    ];
    standardJson.actions = [
      {
        type: { value: action.id },
        parameters: [expressionSource],
        subInstructions: [],
      },
    ];

    await callOk(session, 'events.insert', {
      sceneName: SCENE_NAME,
      expectedEventsRevision: eventsRevision,
      eventsJson: [groupJson, commentJson, standardJson],
      expectedRevision: initialProjectRevision,
      idempotencyKey: 'dx9-insert-native-events',
    });

    let authored = await callOk(session, 'events.read', {
      sceneName: SCENE_NAME,
    });
    const groupHandle = findEventHandle(authored, groupNode.type);
    const commentHandle = findEventHandle(authored, commentNode.type);

    const groupStyle = { background: { r: 24, g: 68, b: 108 } };
    await callOk(session, 'events.style.update', {
      sceneName: SCENE_NAME,
      expectedEventsRevision: authored.data.eventsRevision,
      handle: groupHandle,
      style: groupStyle,
      expectedRevision: getProjectRevision(authored),
      idempotencyKey: 'dx9-style-group',
    });

    authored = await callOk(session, 'events.read', {
      sceneName: SCENE_NAME,
    });
    const refreshedCommentHandle = findEventHandle(authored, commentNode.type);
    const commentStyle = {
      background: { r: 248, g: 222, b: 126 },
      text: { r: 20, g: 30, b: 40 },
    };
    await callOk(session, 'events.style.update', {
      sceneName: SCENE_NAME,
      expectedEventsRevision: authored.data.eventsRevision,
      handle: refreshedCommentHandle,
      style: commentStyle,
      expectedRevision: getProjectRevision(authored),
      idempotencyKey: 'dx9-style-comment',
    });

    authored = await callOk(session, 'events.read', {
      sceneName: SCENE_NAME,
    });
    const finalGroup = findEventJson(authored, groupNode.type);
    const finalComment = findEventJson(authored, commentNode.type);
    const finalStandard = findEventJson(authored, standardNode.type);
    assert(
      finalGroup.colorR === groupStyle.background.r &&
        finalGroup.colorG === groupStyle.background.g &&
        finalGroup.colorB === groupStyle.background.b,
      'group_style_not_persisted'
    );
    assert(
      finalComment.color &&
        finalComment.color.r === commentStyle.background.r &&
        finalComment.color.g === commentStyle.background.g &&
        finalComment.color.b === commentStyle.background.b &&
        finalComment.color.textR === commentStyle.text.r &&
        finalComment.color.textG === commentStyle.text.g &&
        finalComment.color.textB === commentStyle.text.b,
      'comment_style_not_persisted'
    );
    assert(
      finalStandard.conditions &&
        finalStandard.conditions[0] &&
        finalStandard.conditions[0].type &&
        finalStandard.conditions[0].type.value === condition.id &&
        finalStandard.actions &&
        finalStandard.actions[0] &&
        finalStandard.actions[0].type &&
        finalStandard.actions[0].type.value === action.id &&
        finalStandard.actions[0].parameters[0] === expressionSource,
      'native_standard_instruction_payload_not_persisted'
    );

    const validation = await callOk(session, 'validation.run', {
      includeNativeReport: true,
      includeAssets: true,
      includeRuntimeLogs: false,
    });
    const validationErrors =
      validation.data &&
      validation.data.summary &&
      Number.isInteger(validation.data.summary.errors)
        ? validation.data.summary.errors
        : validation.data && Array.isArray(validation.data.errors)
        ? validation.data.errors.length
        : 0;
    assert(validationErrors === 0, 'clean_room_validation_has_errors');

    await callOk(session, 'preview.start', { numberOfWindows: 1 });
    previewStarted = true;
    const previewStatus = await waitForPreview(session);
    const runtimeLogs = await waitForRuntimeLogs(session);

    const save = await callOk(session, 'project.save-as', {
      filePath: savePath,
      name: PROJECT_NAME,
    });
    const savedStatus = await callOk(session, 'project.status', {});
    assert(
      savedStatus.data && savedStatus.data.hasUnsavedChanges === false,
      'project_not_clean_after_explicit_save'
    );
    assert(fs.existsSync(savePath), 'explicit_save_file_missing');

    const evidence = sanitizeForReplay({
      kind: 'dx9-clean-room-event-authoring-acceptance',
      generatedAt: new Date().toISOString(),
      cleanRoom: {
        repositoryImplementationOrTestsReadDuringScenario: false,
        repositoryReadGuard: true,
        connectionSource: 'gdevelop-mcp.json + tokenFile',
        authoringInputSource: 'live raw MCP responses',
        sanitizedEvidenceUsedAsAuthoringInput: false,
      },
      protocolVersion: session.protocolVersion,
      discovery: {
        toolCount: tools.length,
        prompt: GUIDE_PROMPT,
        resource: GUIDE_URI,
        promptVersion:
          prompts.find(candidate => candidate.name === GUIDE_PROMPT)?._meta?.[
            'gdevelop/promptVersion'
          ] || null,
        guideVersion:
          guideResource &&
          guideResource._meta &&
          guideResource._meta['gdevelop/guideVersion'] != null
            ? guideResource._meta['gdevelop/guideVersion']
            : null,
        dynamicEventSchemaKnownTypeCount:
          eventItemSchema['x-gdevelop-schema-reference'].knownTypeCount,
      },
      discoveredAuthoringContracts: {
        condition: {
          id: condition.id,
          extension: condition.extension.name,
          visibleParameterCount: visibleParameters(condition).length,
        },
        action: {
          id: action.id,
          extension: action.extension.name,
          visibleParameters: visibleParameters(action).map(parameter => ({
            index: parameter.index,
            type: parameter.type,
          })),
        },
        expression: {
          id: expression.id,
          returnType: expression.returnType,
          visibleParameters: visibleParameters(expression).map(parameter => ({
            index: parameter.index,
            type: parameter.type,
          })),
        },
        eventNodes: {
          group: groupNode.type,
          comment: commentNode.type,
          standard: standardNode.type,
        },
      },
      authored: {
        sceneName: SCENE_NAME,
        topLevelEventCount: authored.data.eventsJson.length,
        conditionId: condition.id,
        actionId: action.id,
        expressionSource,
        groupStyle,
        commentStyle,
      },
      validation: {
        errors: validationErrors,
        summary:
          validation.data && validation.data.summary
            ? validation.data.summary
            : null,
      },
      preview: {
        running: true,
        status: previewStatus.data,
      },
      runtime: {
        logsReadable: true,
        debuggerId:
          runtimeLogs.data && runtimeLogs.data.debuggerId
            ? runtimeLogs.data.debuggerId
            : null,
        errorCount:
          runtimeLogs.data && Array.isArray(runtimeLogs.data.errors)
            ? runtimeLogs.data.errors.length
            : null,
      },
      save: {
        explicit: true,
        operation: 'project.save-as',
        cleanAfterSave: true,
        saved: !!(save.data && save.data.saved),
        fileIdentifierReturned: !!(
          save.data &&
          save.data.fileMetadata &&
          save.data.fileMetadata.fileIdentifier
        ),
      },
    });

    fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
    fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);

    if (previewStarted) {
      await session.call('preview.close-all', {});
      previewStarted = false;
    }

    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          evidencePath,
          protocolVersion: session.protocolVersion,
          toolCount: tools.length,
          conditionId: condition.id,
          actionId: action.id,
          expressionId: expression.id,
          eventNodeTypes: evidence.discoveredAuthoringContracts.eventNodes,
          validationErrors,
          previewRunning: true,
          runtimeLogsReadable: true,
          explicitSave: true,
        },
        null,
        2
      )}\n`
    );
    return evidence;
  } finally {
    if (session) {
      if (previewStarted) {
        try {
          await session.call('preview.close-all', {});
        } catch (_) {}
      }
      try {
        await session.close();
      } catch (_) {}
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
    restoreRepositoryReads();
  }
};

if (require.main === module) {
  run().catch(error => {
    console.error(error && error.stack ? error.stack : String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  GUIDE_PROMPT,
  GUIDE_URI,
  PROJECT_NAME,
  SCENE_NAME,
  run,
};
