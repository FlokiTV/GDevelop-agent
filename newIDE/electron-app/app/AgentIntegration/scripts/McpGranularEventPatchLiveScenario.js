const fs = require('fs');
const os = require('os');
const path = require('path');
const { connectLiveGDevelopMcp, sanitizeForReplay } = require('./McpClient');

const SCENE_NAME = 'DX20Granular';
const PROJECT_NAME = 'DX20 Granular Event Patch Acceptance';

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const clone = value => JSON.parse(JSON.stringify(value));

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

const getProjectRevision = result =>
  result && result.meta && Number.isInteger(result.meta.projectRevision)
    ? result.meta.projectRevision
    : result && result.data && Number.isInteger(result.data.projectRevision)
    ? result.data.projectRevision
    : null;

const findTool = (tools, name) => {
  const tool = tools.find(candidate => candidate.name === name);
  assert(tool, `missing_tool:${name}`);
  return tool;
};

const visibleParameters = item =>
  Array.isArray(item.parameters)
    ? item.parameters.filter(parameter => !parameter.codeOnly)
    : [];

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
  assert(selected, `instruction_not_found:${kind}:${query}`);
  const described = await callOk(session, 'events.instructions.describe', {
    id: selected.id,
    kind,
    extension: selected.extension && selected.extension.name,
  });
  assert(
    described.data && described.data.item,
    `instruction_describe_failed:${selected.id}`
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
  throw new Error(`event_node_not_found:${query}`);
};

const getType = value =>
  value && value.type && typeof value.type === 'object'
    ? value.type.value
    : value && value.type;

const getEventNodeAtPath = (events, eventPath) => {
  let list = events;
  let node = null;
  for (const index of eventPath) {
    node = Array.isArray(list) ? list[index] : null;
    if (!node) return null;
    list = node.children;
  }
  return node;
};

const findEventJsonPath = (eventsJson, predicate, parentPath = []) => {
  for (let index = 0; index < eventsJson.length; index++) {
    const eventJson = eventsJson[index];
    const eventPath = [...parentPath, index];
    if (predicate(eventJson, eventPath)) return eventPath;
    if (eventJson && Array.isArray(eventJson.events)) {
      const nested = findEventJsonPath(eventJson.events, predicate, eventPath);
      if (nested) return nested;
    }
  }
  return null;
};

const requireEventNode = (read, predicate, label) => {
  const eventsJson =
    read && read.data && Array.isArray(read.data.eventsJson)
      ? read.data.eventsJson
      : [];
  const eventPath = findEventJsonPath(eventsJson, predicate);
  assert(eventPath, `event_json_not_found:${label}`);
  const node = getEventNodeAtPath(read.data.events || [], eventPath);
  assert(node && node.handle, `event_handle_not_found:${label}`);
  return { eventPath, node };
};

const requireTopLevelByType = (read, type) =>
  requireEventNode(read, eventJson => getType(eventJson) === type, type);

const getInstruction = (eventNode, kind, index) => {
  const list =
    kind === 'action'
      ? eventNode.actions
      : kind === 'whileCondition'
      ? eventNode.whileConditions
      : eventNode.conditions;
  const instruction = Array.isArray(list) ? list[index] : null;
  assert(
    instruction && instruction.handle,
    `instruction_handle_missing:${kind}:${index}`
  );
  return instruction;
};

const expectErrorCode = (result, code) => {
  assert(result && result.isError === true, `expected_error:${code}`);
  const serialized = JSON.stringify(
    result.structuredContent || result.content || result.data || result
  );
  assert(serialized.includes(code), `missing_error_code:${code}:${serialized}`);
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

const parseLabel = argv => {
  const index = argv.indexOf('--label');
  return index >= 0 && argv[index + 1] ? argv[index + 1] : 'live';
};

const run = async ({ label = parseLabel(process.argv.slice(2)) } = {}) => {
  const restoreRepositoryReads = installRepositoryReadGuard();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gdevelop-dx20-'));
  const savePath = path.join(tempDir, 'DX20Granular.json');
  const evidencePath = path.join(
    os.tmpdir(),
    `gdevelop-dx20-granular-${label}-${process.pid}.json`
  );
  let session = null;

  try {
    session = await connectLiveGDevelopMcp({
      clientId: `gdevelop-dx20-${label}`,
      agentId: 'dx20-granular-agent',
      sessionId: `dx20-${label}`,
      taskId: 'dx20-granular-event-patch',
    });

    const before = await callOk(session, 'project.status', {});
    assert(
      !before.data || before.data.projectOpen === false,
      'dx20_requires_fresh_editor_without_open_project'
    );

    await callOk(session, 'project.create', {
      name: PROJECT_NAME,
      idempotencyKey: `dx20-create-project-${label}`,
    });
    await callOk(session, 'editor.functions.create-scene', {
      scene_name: SCENE_NAME,
      is_first_scene: true,
      idempotencyKey: `dx20-create-scene-${label}`,
    });

    await session.close();
    session = await connectLiveGDevelopMcp({
      clientId: `gdevelop-dx20-${label}`,
      agentId: 'dx20-granular-agent',
      sessionId: `dx20-${label}`,
      taskId: 'dx20-granular-event-patch',
    });

    const tools = await session.listTools();
    [
      'events.read',
      'events.patch',
      'events.insert',
      'events.move',
      'events.delete',
      'events.instructions.search',
      'events.instructions.describe',
      'editor.functions.create-extension',
      'editor.functions.create-custom-function',
      'events.nodes.list',
      'events.nodes.describe',
      'validation.run',
      'project.save-as',
    ].forEach(name => findTool(tools, name));

    const patchTool = findTool(tools, 'events.patch');
    const patchOperationSchema =
      patchTool.inputSchema &&
      patchTool.inputSchema.properties &&
      patchTool.inputSchema.properties.operation;
    const patchBranches =
      patchOperationSchema && Array.isArray(patchOperationSchema.anyOf)
        ? patchOperationSchema.anyOf
        : [];
    const parameterBranch = patchBranches.find(
      branch =>
        branch &&
        branch.properties &&
        branch.properties.kind &&
        Array.isArray(branch.properties.kind.enum) &&
        branch.properties.kind.enum[0] === 'instruction.parameter.update'
    );
    assert(parameterBranch, 'events_patch_parameter_branch_missing');
    assert(
      parameterBranch.properties &&
        parameterBranch.properties.parameterName &&
        !parameterBranch.properties.eventJson,
      'events_patch_requires_full_event_json'
    );

    const insertTool = findTool(tools, 'events.insert');
    const moveTool = findTool(tools, 'events.move');
    assert(
      insertTool.inputSchema.properties.index &&
        moveTool.inputSchema.properties.index,
      'event_structural_index_schema_missing'
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
    await callOk(session, 'editor.functions.create-extension', {
      extension_name: 'DX20PatchFunctions',
      full_name: 'DX20 Patch Functions',
      description: 'DX20 granular Event Sheet acceptance extension',
      short_description: 'DX20 granular acceptance',
      idempotencyKey: `dx20-extension-${label}`,
    });
    await callOk(session, 'editor.functions.create-custom-function', {
      function_name: 'PatchAction',
      scope: {
        type: 'extension',
        extension_name: 'DX20PatchFunctions',
      },
      function_type: 'Action',
      full_name: 'DX20 Patch Action',
      description: 'DX20 parameter-name patch acceptance',
      sentence: 'Patch value _PARAM0_',
      parameters: [
        {
          name: 'Value',
          type: 'expression',
          label: 'Value',
        },
      ],
      idempotencyKey: `dx20-function-${label}`,
    });
    const action = await selectInstruction({
      session,
      kind: 'action',
      query: 'PatchAction',
      predicate: item => {
        const parameters = visibleParameters(item);
        return (
          item.id === 'DX20PatchFunctions::PatchAction' &&
          item.scope &&
          item.scope.kind === 'free' &&
          item.eventContexts &&
          item.eventContexts.scene === true &&
          item.extension &&
          item.extension.name === 'DX20PatchFunctions' &&
          parameters.length === 1 &&
          parameters[0].name === 'Value' &&
          parameters[0].valueType &&
          parameters[0].valueType.number === true
        );
      },
    });
    const actionParameter = visibleParameters(action)[0];
    const makeActionParameters = value => {
      const parameters = Array.from(
        { length: actionParameter.index + 1 },
        () => ''
      );
      parameters[actionParameter.index] = value;
      return parameters;
    };

    const standardNode = await selectNode({
      session,
      query: 'standard',
      predicate: node =>
        node.schemaAvailable === true &&
        node.canonicalExample &&
        Array.isArray(node.canonicalExample.conditions) &&
        Array.isArray(node.canonicalExample.actions),
    });
    const commentNode = await selectNode({
      session,
      query: 'comment',
      predicate: node =>
        node.schemaAvailable === true &&
        node.canonicalExample &&
        typeof node.canonicalExample.comment === 'string',
    });
    const groupNode = await selectNode({
      session,
      query: 'group',
      predicate: node =>
        node.schemaAvailable === true &&
        node.canHaveSubEvents === true &&
        node.canonicalExample &&
        typeof node.canonicalExample.name === 'string',
    });

    let read = await callOk(session, 'events.read', { sceneName: SCENE_NAME });
    let projectRevision = getProjectRevision(read);
    if (!Number.isInteger(projectRevision)) {
      const status = await callOk(session, 'project.status', {});
      projectRevision = getProjectRevision(status);
    }

    const standardJson = clone(standardNode.canonicalExample);
    standardJson.conditions = [
      {
        type: { value: condition.id, inverted: false },
        parameters: [],
        subInstructions: [],
      },
    ];
    standardJson.actions = [
      {
        type: { value: action.id, inverted: false },
        parameters: makeActionParameters('0.10'),
        subInstructions: [],
      },
      {
        type: { value: action.id, inverted: false },
        parameters: makeActionParameters('0.20'),
        subInstructions: [],
      },
    ];

    const commentJson = clone(commentNode.canonicalExample);
    commentJson.comment = 'DX20 comment before granular patch';

    const groupJson = clone(groupNode.canonicalExample);
    groupJson.name = 'DX20 Structural Group';
    if (Array.isArray(groupJson.events)) groupJson.events = [];

    const seeded = await callOk(session, 'events.insert', {
      sceneName: SCENE_NAME,
      expectedEventsRevision: read.data.eventsRevision,
      eventsJson: [standardJson, commentJson, groupJson],
      expectedRevision: projectRevision,
      idempotencyKey: `dx20-seed-${label}`,
    });
    projectRevision = getProjectRevision(seeded);

    read = await callOk(session, 'events.read', { sceneName: SCENE_NAME });
    let standard = requireTopLevelByType(read, standardNode.type);
    let firstAction = getInstruction(standard.node, 'action', 0);
    const secondActionHandle = getInstruction(standard.node, 'action', 1)
      .handle;

    const firstParameterPatch = await callOk(session, 'events.patch', {
      sceneName: SCENE_NAME,
      expectedEventsRevision: read.data.eventsRevision,
      operation: {
        kind: 'instruction.parameter.update',
        instructionHandle: firstAction.handle,
        parameterName: actionParameter.name,
        value: '0.11',
      },
      expectedRevision: projectRevision,
      idempotencyKey: `dx20-param-name-${label}`,
    });
    projectRevision = getProjectRevision(firstParameterPatch);
    assert(
      firstParameterPatch.data &&
        firstParameterPatch.data.parameter &&
        firstParameterPatch.data.parameter.name === actionParameter.name &&
        firstParameterPatch.data.parameter.value === '0.11',
      'parameter_name_patch_result_invalid'
    );

    const secondParameterPatch = await callOk(session, 'events.patch', {
      sceneName: SCENE_NAME,
      expectedEventsRevision: firstParameterPatch.data.eventsRevision,
      operation: {
        kind: 'instruction.parameter.update',
        instructionHandle: secondActionHandle,
        parameterIndex: actionParameter.index,
        value: '0.22',
      },
      expectedRevision: projectRevision,
      idempotencyKey: `dx20-param-index-${label}`,
    });
    projectRevision = getProjectRevision(secondParameterPatch);

    read = await callOk(session, 'events.read', { sceneName: SCENE_NAME });
    standard = requireTopLevelByType(read, standardNode.type);
    const standardAfterParameters = read.data.eventsJson[standard.eventPath[0]];
    assert(
      standardAfterParameters.actions[0].parameters[actionParameter.index] ===
        '0.11' &&
        standardAfterParameters.actions[1].parameters[actionParameter.index] ===
          '0.22',
      'unrelated_parameter_patch_overwrote_sibling'
    );

    const insertedAction = await callOk(session, 'events.patch', {
      sceneName: SCENE_NAME,
      expectedEventsRevision: read.data.eventsRevision,
      operation: {
        kind: 'instruction.insert',
        eventHandle: standard.node.handle,
        instructionKind: 'action',
        index: 1,
        instructionJson: {
          type: { value: action.id, inverted: false },
          parameters: makeActionParameters('0.33'),
          subInstructions: [],
        },
      },
      expectedRevision: projectRevision,
      idempotencyKey: `dx20-instruction-insert-${label}`,
    });
    projectRevision = getProjectRevision(insertedAction);
    assert(
      insertedAction.data &&
        insertedAction.data.instruction &&
        insertedAction.data.instruction.path[0] === 1,
      'instruction_insert_index_not_deterministic'
    );

    read = await callOk(session, 'events.read', { sceneName: SCENE_NAME });
    standard = requireTopLevelByType(read, standardNode.type);
    const insertedHandle = getInstruction(standard.node, 'action', 1).handle;
    const lastHandle = getInstruction(standard.node, 'action', 2).handle;
    const movedAction = await callOk(session, 'events.patch', {
      sceneName: SCENE_NAME,
      expectedEventsRevision: read.data.eventsRevision,
      operation: {
        kind: 'instruction.move',
        instructionHandle: insertedHandle,
        afterHandle: lastHandle,
      },
      expectedRevision: projectRevision,
      idempotencyKey: `dx20-instruction-move-${label}`,
    });
    projectRevision = getProjectRevision(movedAction);
    assert(
      movedAction.data &&
        movedAction.data.instruction &&
        movedAction.data.instruction.path[0] === 2,
      'instruction_move_after_not_deterministic'
    );

    const deletedAction = await callOk(session, 'events.patch', {
      sceneName: SCENE_NAME,
      expectedEventsRevision: movedAction.data.eventsRevision,
      operation: {
        kind: 'instruction.delete',
        instructionHandle: movedAction.data.instruction.handle,
      },
      expectedRevision: projectRevision,
      idempotencyKey: `dx20-instruction-delete-${label}`,
    });
    projectRevision = getProjectRevision(deletedAction);
    assert(deletedAction.data.deleted === true, 'instruction_delete_failed');

    read = await callOk(session, 'events.read', { sceneName: SCENE_NAME });
    standard = requireTopLevelByType(read, standardNode.type);
    const conditionHandle = getInstruction(standard.node, 'condition', 0)
      .handle;
    const inverted = await callOk(session, 'events.patch', {
      sceneName: SCENE_NAME,
      expectedEventsRevision: read.data.eventsRevision,
      operation: {
        kind: 'instruction.flags.update',
        instructionHandle: conditionHandle,
        inverted: true,
      },
      expectedRevision: projectRevision,
      idempotencyKey: `dx20-condition-invert-${label}`,
    });
    projectRevision = getProjectRevision(inverted);

    read = await callOk(session, 'events.read', { sceneName: SCENE_NAME });
    standard = requireTopLevelByType(read, standardNode.type);
    const disabled = await callOk(session, 'events.patch', {
      sceneName: SCENE_NAME,
      expectedEventsRevision: read.data.eventsRevision,
      operation: {
        kind: 'event.flags.update',
        eventHandle: standard.node.handle,
        enabled: false,
      },
      expectedRevision: projectRevision,
      idempotencyKey: `dx20-event-disable-${label}`,
    });
    projectRevision = getProjectRevision(disabled);

    read = await callOk(session, 'events.read', { sceneName: SCENE_NAME });
    standard = requireTopLevelByType(read, standardNode.type);
    const standardFlagsJson = read.data.eventsJson[standard.eventPath[0]];
    assert(
      standardFlagsJson.disabled === true &&
        standardFlagsJson.conditions[0].type.inverted === true,
      'flag_patches_not_persisted'
    );

    const staleRevision = read.data.eventsRevision;
    const reenabled = await callOk(session, 'events.patch', {
      sceneName: SCENE_NAME,
      expectedEventsRevision: staleRevision,
      operation: {
        kind: 'event.flags.update',
        eventHandle: standard.node.handle,
        enabled: true,
      },
      expectedRevision: projectRevision,
      idempotencyKey: `dx20-event-enable-${label}`,
    });
    projectRevision = getProjectRevision(reenabled);

    const stale = await session.call('events.patch', {
      sceneName: SCENE_NAME,
      expectedEventsRevision: staleRevision,
      operation: {
        kind: 'event.flags.update',
        eventHandle: standard.node.handle,
        enabled: false,
      },
      expectedRevision: projectRevision,
      idempotencyKey: `dx20-stale-${label}`,
    });
    expectErrorCode(stale, 'events_revision_conflict');

    read = await callOk(session, 'events.read', { sceneName: SCENE_NAME });
    const comment = requireTopLevelByType(read, commentNode.type);
    const commentPatched = await callOk(session, 'events.patch', {
      sceneName: SCENE_NAME,
      expectedEventsRevision: read.data.eventsRevision,
      operation: {
        kind: 'event.fields.update',
        eventHandle: comment.node.handle,
        fields: { comment: 'DX20 comment after granular patch' },
      },
      expectedRevision: projectRevision,
      idempotencyKey: `dx20-comment-field-${label}`,
    });
    projectRevision = getProjectRevision(commentPatched);

    read = await callOk(session, 'events.read', { sceneName: SCENE_NAME });
    const commentAfter = requireTopLevelByType(read, commentNode.type);
    assert(
      read.data.eventsJson[commentAfter.eventPath[0]].comment ===
        'DX20 comment after granular patch',
      'small_event_field_patch_not_persisted'
    );

    let group = requireEventNode(
      read,
      eventJson =>
        getType(eventJson) === groupNode.type &&
        eventJson.name === 'DX20 Structural Group',
      'structural-group'
    );
    const childAJson = clone(commentNode.canonicalExample);
    childAJson.comment = 'DX20 child A';
    const childBJson = clone(commentNode.canonicalExample);
    childBJson.comment = 'DX20 child B';

    const childAInserted = await callOk(session, 'events.insert', {
      sceneName: SCENE_NAME,
      expectedEventsRevision: read.data.eventsRevision,
      eventsJson: [childAJson],
      parentHandle: group.node.handle,
      index: 0,
      expectedRevision: projectRevision,
      idempotencyKey: `dx20-subevent-a-${label}`,
    });
    projectRevision = getProjectRevision(childAInserted);

    read = await callOk(session, 'events.read', { sceneName: SCENE_NAME });
    group = requireEventNode(
      read,
      eventJson =>
        getType(eventJson) === groupNode.type &&
        eventJson.name === 'DX20 Structural Group',
      'structural-group-after-a'
    );
    const childBInserted = await callOk(session, 'events.insert', {
      sceneName: SCENE_NAME,
      expectedEventsRevision: read.data.eventsRevision,
      eventsJson: [childBJson],
      parentHandle: group.node.handle,
      index: 1,
      expectedRevision: projectRevision,
      idempotencyKey: `dx20-subevent-b-${label}`,
    });
    projectRevision = getProjectRevision(childBInserted);

    read = await callOk(session, 'events.read', { sceneName: SCENE_NAME });
    group = requireEventNode(
      read,
      eventJson =>
        getType(eventJson) === groupNode.type &&
        eventJson.name === 'DX20 Structural Group',
      'structural-group-after-b'
    );
    const childA = requireEventNode(
      read,
      eventJson =>
        getType(eventJson) === commentNode.type &&
        eventJson.comment === 'DX20 child A',
      'child-a'
    );
    const childB = requireEventNode(
      read,
      eventJson =>
        getType(eventJson) === commentNode.type &&
        eventJson.comment === 'DX20 child B',
      'child-b'
    );
    assert(
      childA.eventPath[childA.eventPath.length - 1] === 0 &&
        childB.eventPath[childB.eventPath.length - 1] === 1,
      'subevent_insert_index_not_deterministic'
    );

    const childMoved = await callOk(session, 'events.move', {
      sceneName: SCENE_NAME,
      expectedEventsRevision: read.data.eventsRevision,
      handle: childB.node.handle,
      beforeHandle: childA.node.handle,
      expectedRevision: projectRevision,
      idempotencyKey: `dx20-subevent-move-${label}`,
    });
    projectRevision = getProjectRevision(childMoved);

    read = await callOk(session, 'events.read', { sceneName: SCENE_NAME });
    const movedChildB = requireEventNode(
      read,
      eventJson =>
        getType(eventJson) === commentNode.type &&
        eventJson.comment === 'DX20 child B',
      'child-b-moved'
    );
    assert(
      movedChildB.eventPath[movedChildB.eventPath.length - 1] === 0,
      'subevent_move_before_not_deterministic'
    );

    const childDeleted = await callOk(session, 'events.delete', {
      sceneName: SCENE_NAME,
      expectedEventsRevision: read.data.eventsRevision,
      handle: movedChildB.node.handle,
      expectedRevision: projectRevision,
      idempotencyKey: `dx20-subevent-delete-${label}`,
    });
    projectRevision = getProjectRevision(childDeleted);
    assert(childDeleted.data.deleted === true, 'subevent_delete_failed');

    read = await callOk(session, 'events.read', { sceneName: SCENE_NAME });
    standard = requireTopLevelByType(read, standardNode.type);
    const finalStandardJson = read.data.eventsJson[standard.eventPath[0]];
    assert(
      finalStandardJson.actions.length === 2 &&
        finalStandardJson.actions[0].parameters[actionParameter.index] ===
          '0.11' &&
        finalStandardJson.actions[1].parameters[actionParameter.index] ===
          '0.22',
      'final_instruction_state_invalid'
    );
    assert(
      finalStandardJson.disabled === false &&
        finalStandardJson.conditions[0].type.inverted === true,
      'final_flag_state_invalid'
    );
    assert(
      !findEventJsonPath(
        read.data.eventsJson,
        eventJson =>
          getType(eventJson) === commentNode.type &&
          eventJson.comment === 'DX20 child B'
      ),
      'deleted_subevent_still_present'
    );
    assert(
      !!findEventJsonPath(
        read.data.eventsJson,
        eventJson =>
          getType(eventJson) === commentNode.type &&
          eventJson.comment === 'DX20 child A'
      ),
      'untouched_subevent_missing'
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
    assert(validationErrors === 0, 'dx20_validation_has_errors');

    const save = await callOk(session, 'project.save-as', {
      filePath: savePath,
      name: PROJECT_NAME,
    });
    const savedStatus = await callOk(session, 'project.status', {});
    assert(
      savedStatus.data && savedStatus.data.hasUnsavedChanges === false,
      'project_not_clean_after_save'
    );
    assert(fs.existsSync(savePath), 'save_file_missing');

    const evidence = sanitizeForReplay({
      kind: 'dx20-granular-event-patch-acceptance',
      label,
      generatedAt: new Date().toISOString(),
      protocolVersion: session.protocolVersion,
      cleanRoom: {
        repositoryImplementationOrTestsReadDuringScenario: false,
        repositoryReadGuard: true,
        authoringInputSource: 'live MCP discovery and reads',
      },
      discovery: {
        toolCount: tools.length,
        eventsPatchPublished: true,
        parameterPatchRequiresParentEventJson: false,
        eventInsertIndexPublished: true,
        eventMoveIndexPublished: true,
        actionId: action.id,
        actionParameter: {
          index: actionParameter.index,
          name: actionParameter.name,
        },
        conditionId: condition.id,
        nodes: {
          standard: standardNode.type,
          comment: commentNode.type,
          group: groupNode.type,
        },
      },
      granular: {
        parameterByName: {
          before: '0.10',
          after: '0.11',
          preservedSiblingAfterSecondEdit: '0.22',
        },
        instructionInsert: {
          insertedPath: insertedAction.data.instruction.path,
        },
        instructionMove: {
          fromPath: movedAction.data.fromPath,
          toPath: movedAction.data.instruction.path,
        },
        instructionDelete: deletedAction.data.deleted,
        conditionInverted: true,
        eventEnabledRoundTrip: true,
        commentFieldUpdated: true,
        staleRevisionRejected: true,
      },
      structuralSubevents: {
        insertedByIndex: true,
        movedBeforeSibling: true,
        deletedSingleSubevent: true,
        untouchedSiblingPreserved: true,
      },
      validation: {
        errors: validationErrors,
        summary: validation.data && validation.data.summary,
      },
      save: {
        explicit: true,
        saved: !!(save.data && save.data.saved),
        cleanAfterSave: true,
      },
    });

    fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          label,
          evidencePath,
          protocolVersion: session.protocolVersion,
          toolCount: tools.length,
          parameterName: actionParameter.name,
          validationErrors,
          explicitSave: true,
        },
        null,
        2
      )}\n`
    );
    return evidence;
  } finally {
    if (session) {
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
  findEventJsonPath,
  getEventNodeAtPath,
  getType,
  parseLabel,
  run,
};
