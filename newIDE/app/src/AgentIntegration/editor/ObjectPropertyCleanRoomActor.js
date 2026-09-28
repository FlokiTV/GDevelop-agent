const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const findTool = (tools, name) => {
  const tool = tools.find(candidate => candidate.name === name);
  assert(tool, 'clean_room_missing_tool:' + name);
  return tool;
};

const errorOf = result =>
  result && result.structuredContent && result.structuredContent.error
    ? result.structuredContent.error
    : null;

const runObjectPropertyCleanRoomActor = async ({
  client,
  sceneName,
  instanceId,
  resizableObjectName,
  sentinel = 'DX24 clean-room value',
}) => {
  const tools = await client.listTools();
  const describeTool = findTool(tools, 'objects.properties.describe');
  const setTool = findTool(tools, 'objects.properties.set');
  const changes =
    setTool.inputSchema &&
    setTool.inputSchema.properties &&
    setTool.inputSchema.properties.changes;
  assert(
    changes &&
      changes.items &&
      changes.items.properties &&
      changes.items.properties.path &&
      changes.items.properties.value,
    'clean_room_typed_mutation_schema_missing'
  );
  assert(
    !setTool.annotations || setTool.annotations.readOnlyHint === false,
    'clean_room_set_not_marked_mutating'
  );
  assert(
    !describeTool.annotations || describeTool.annotations.readOnlyHint === true,
    'clean_room_describe_not_marked_read_only'
  );

  let described = await client.call('objects.properties.describe', {
    targetKind: 'scene-instance',
    sceneName,
    instanceId,
  });
  assert(!described.isError, 'clean_room_instance_describe_failed');
  const properties = described.data.properties || [];
  const property = properties.find(
    candidate =>
      candidate &&
      candidate.writable === true &&
      candidate.valueType === 'string' &&
      candidate.path &&
      candidate.path.startsWith('instance.custom.')
  );
  assert(property, 'clean_room_custom_string_property_not_discovered');
  assert(
    property.mutation && property.mutation.command === 'objects.properties.set',
    'clean_room_property_authoritative_mutation_missing'
  );

  let revision = described.meta.projectRevision;
  const changed = await client.call('objects.properties.set', {
    targetKind: 'scene-instance',
    sceneName,
    instanceId,
    changes: [{ path: property.path, value: sentinel }],
    expectedRevision: revision,
    idempotencyKey: 'dx24-clean-room-set',
  });
  assert(!changed.isError, 'clean_room_typed_mutation_failed');
  assert(
    changed.meta &&
      Number.isInteger(changed.meta.projectRevision) &&
      changed.meta.projectRevision > revision,
    'clean_room_revision_not_advanced'
  );
  assert(changed.meta.transactionId, 'clean_room_transaction_metadata_missing');
  revision = changed.meta.projectRevision;

  described = await client.call('objects.properties.describe', {
    targetKind: 'scene-instance',
    sceneName,
    instanceId,
  });
  const after = (described.data.properties || []).find(
    candidate => candidate.path === property.path
  );
  assert(
    after && after.currentValue === sentinel,
    'clean_room_discovered_property_not_persisted'
  );

  const invalidType = await client.call('objects.properties.set', {
    targetKind: 'scene-instance',
    sceneName,
    instanceId,
    changes: [{ path: property.path, value: 24 }],
    expectedRevision: revision,
    idempotencyKey: 'dx24-clean-room-invalid-type',
  });
  const invalidTypeError = errorOf(invalidType);
  assert(
    invalidType.isError === true &&
      invalidTypeError &&
      invalidTypeError.code === 'invalid_property_type' &&
      invalidTypeError.field === 'changes[0].value' &&
      invalidTypeError.path === property.path,
    'clean_room_invalid_type_diagnostics_missing'
  );

  const unknownPath = 'instance.custom.__dx24_unknown__';
  const invalidPath = await client.call('objects.properties.set', {
    targetKind: 'scene-instance',
    sceneName,
    instanceId,
    changes: [{ path: unknownPath, value: 'x' }],
    expectedRevision: revision,
    idempotencyKey: 'dx24-clean-room-invalid-path',
  });
  const invalidPathError = errorOf(invalidPath);
  assert(
    invalidPath.isError === true &&
      invalidPathError &&
      invalidPathError.code === 'unknown_property_path' &&
      invalidPathError.field === 'changes[0].path' &&
      invalidPathError.path === unknownPath,
    'clean_room_invalid_path_diagnostics_missing'
  );

  const resizable = await client.call('objects.properties.describe', {
    targetKind: 'object-definition',
    sceneName,
    objectName: resizableObjectName,
  });
  assert(!resizable.isError, 'clean_room_resizable_describe_failed');
  const runtimeOnly = resizable.data.runtimeOnlyProperties || [];
  const width = runtimeOnly.find(candidate => candidate.name === 'width');
  const height = runtimeOnly.find(candidate => candidate.name === 'height');
  assert(width && height, 'clean_room_width_height_not_discovered');

  const capabilityEvidence = [];
  for (const runtimeProperty of [width, height]) {
    const authoritative = runtimeProperty.authoritativeMutation;
    assert(
      runtimeProperty.writable === false &&
        runtimeProperty.readOnlyReason === 'runtime-capability-backed' &&
        authoritative &&
        authoritative.kind === 'behavior-capability-action' &&
        authoritative.action &&
        authoritative.action.id &&
        authoritative.action.authoring &&
        authoritative.action.authoring.command === 'events.patch',
      'clean_room_capability_path_missing:' + runtimeProperty.name
    );
    const genericAttempt = await client.call('objects.properties.set', {
      targetKind: 'object-definition',
      sceneName,
      objectName: resizableObjectName,
      changes: [{ path: runtimeProperty.path, value: 320 }],
      expectedRevision: revision,
      idempotencyKey: 'dx24-clean-room-' + runtimeProperty.name,
    });
    const error = errorOf(genericAttempt);
    assert(
      genericAttempt.isError === true &&
        error &&
        error.code === 'unsupported_property_mutation' &&
        error.field === 'changes[0].path' &&
        error.path === runtimeProperty.path &&
        error.details &&
        error.details.authoritativeMutation &&
        error.details.authoritativeMutation.action &&
        error.details.authoritativeMutation.action.id ===
          authoritative.action.id,
      'clean_room_capability_guidance_mismatch:' + runtimeProperty.name
    );
    capabilityEvidence.push({
      property: runtimeProperty.name,
      path: runtimeProperty.path,
      actionId: authoritative.action.id,
      authoringCommand: authoritative.action.authoring.command,
    });
  }

  return {
    discoveredProperty: {
      path: property.path,
      valueType: property.valueType,
      mutationCommand: property.mutation.command,
    },
    mutation: {
      value: sentinel,
      projectRevision: revision,
      transactionId: changed.meta.transactionId,
    },
    diagnostics: {
      invalidType: {
        code: invalidTypeError.code,
        field: invalidTypeError.field,
        path: invalidTypeError.path,
      },
      invalidPath: {
        code: invalidPathError.code,
        field: invalidPathError.field,
        path: invalidPathError.path,
      },
    },
    capabilities: capabilityEvidence,
  };
};

module.exports = { runObjectPropertyCleanRoomActor };
