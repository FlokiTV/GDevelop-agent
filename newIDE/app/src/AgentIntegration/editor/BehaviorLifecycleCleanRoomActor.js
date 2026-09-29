const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const findTool = (tools, name) => {
  const tool = tools.find(candidate => candidate.name === name);
  assert(tool, 'dx29_clean_room_missing_tool:' + name);
  return tool;
};

const errorOf = result =>
  result && result.structuredContent && result.structuredContent.error
    ? result.structuredContent.error
    : result && result.data && result.data.error
    ? result.data.error
    : null;

const revisionOf = result =>
  result && result.meta && Number.isInteger(result.meta.projectRevision)
    ? result.meta.projectRevision
    : null;

const chooseSimpleWritableProperty = properties =>
  (properties || []).find(
    property =>
      property &&
      property.writable === true &&
      property.path &&
      ['boolean', 'number', 'string'].includes(property.valueType) &&
      (!property.constraints ||
        !Array.isArray(property.constraints.choices) ||
        property.constraints.choices.length === 0)
  ) || null;

const changedValueFor = property => {
  if (property.valueType === 'boolean') return !property.currentValue;
  if (property.valueType === 'number') {
    const current = Number(property.currentValue);
    return Number.isFinite(current) ? current + 1 : 1;
  }
  return String(property.currentValue || '') + '-dx29';
};

const runBehaviorLifecycleCleanRoomActor = async ({
  client,
  sceneName,
  configurableObjectName,
  incompatibleObjectName,
  resizableObjectName,
  behaviorQuery = 'fake behavior with two properties',
  incompatibleQuery = 'fake behavior for text objects only',
}) => {
  const tools = await client.listTools();
  [
    'objects.behaviors.list',
    'objects.behaviors.available',
    'objects.behaviors.describe',
    'objects.behaviors.add',
    'objects.behaviors.update',
    'objects.behaviors.remove',
    'objects.properties.describe',
    'objects.properties.set',
  ].forEach(name => findTool(tools, name));

  const addTool = findTool(tools, 'objects.behaviors.add');
  const updateTool = findTool(tools, 'objects.behaviors.update');
  const removeTool = findTool(tools, 'objects.behaviors.remove');
  assert(
    addTool.inputSchema &&
      addTool.inputSchema.properties &&
      addTool.inputSchema.properties.behaviorType &&
      addTool.inputSchema.properties.behaviorName,
    'dx29_clean_room_add_schema_missing'
  );
  assert(
    updateTool.inputSchema &&
      updateTool.inputSchema.properties &&
      updateTool.inputSchema.properties.changes &&
      updateTool.inputSchema.properties.changes.items &&
      updateTool.inputSchema.properties.changes.items.properties.path &&
      updateTool.inputSchema.properties.changes.items.properties.value,
    'dx29_clean_room_update_schema_missing'
  );
  assert(
    removeTool.inputSchema &&
      removeTool.inputSchema.properties &&
      removeTool.inputSchema.properties.dryRun &&
      removeTool.inputSchema.properties.dryRun.default === true,
    'dx29_clean_room_remove_not_dry_run_default'
  );

  let revision = null;

  const resizableAvailable = await client.call('objects.behaviors.available', {
    sceneName,
    objectName: resizableObjectName,
    query: 'resizable',
    includeCapabilities: true,
    compatibleOnly: true,
    limit: 100,
  });
  assert(!resizableAvailable.isError, 'dx29_resizable_available_failed');
  revision = revisionOf(resizableAvailable);
  const resizableCandidate = (resizableAvailable.data.items || []).find(
    candidate =>
      candidate &&
      candidate.capabilityInterface &&
      candidate.compatibility &&
      candidate.compatibility.providedByObjectType === true &&
      candidate.attachment &&
      candidate.attachment.addable === true
  );
  assert(resizableCandidate, 'dx29_resizable_missing_default_not_discovered');

  const resizableName =
    resizableCandidate.defaultName ||
    resizableCandidate.name ||
    'DX29Resizable';
  const restoredResizable = await client.call('objects.behaviors.add', {
    sceneName,
    objectName: resizableObjectName,
    behaviorType: resizableCandidate.type,
    behaviorName: resizableName,
    expectedRevision: revision,
    idempotencyKey: 'dx29-clean-room-restore-resizable',
  });
  assert(!restoredResizable.isError, 'dx29_resizable_restore_failed');
  assert(
    restoredResizable.data &&
      restoredResizable.data.added === true &&
      restoredResizable.data.behavior &&
      restoredResizable.data.behavior.capability === true,
    'dx29_resizable_restore_not_applied'
  );
  assert(
    revisionOf(restoredResizable) > revision,
    'dx29_resizable_restore_revision_not_advanced'
  );
  revision = revisionOf(restoredResizable);

  const capabilityDescription = await client.call(
    'objects.behaviors.describe',
    {
      sceneName,
      objectName: resizableObjectName,
      behaviorName: restoredResizable.data.behavior.name,
    }
  );
  assert(!capabilityDescription.isError, 'dx29_resizable_describe_failed');
  const capabilityActions =
    (capabilityDescription.data.behavior &&
      capabilityDescription.data.behavior.operations &&
      capabilityDescription.data.behavior.operations.actions) ||
    [];
  const setWidthAction = capabilityActions.find(action =>
    /SetWidth$/.test(action.id)
  );
  const setHeightAction = capabilityActions.find(action =>
    /SetHeight$/.test(action.id)
  );
  assert(setWidthAction && setHeightAction, 'dx29_resizable_actions_missing');
  assert(
    setWidthAction.authoring &&
      setWidthAction.authoring.command === 'events.patch' &&
      setHeightAction.authoring &&
      setHeightAction.authoring.command === 'events.patch',
    'dx29_resizable_authoring_path_missing'
  );

  let dimensions = await client.call('objects.properties.describe', {
    targetKind: 'object-definition',
    sceneName,
    objectName: resizableObjectName,
  });
  assert(!dimensions.isError, 'dx29_resizable_properties_failed');
  const widthProperty = (dimensions.data.properties || []).find(
    property => property.name === 'width' && property.writable === true
  );
  const heightProperty = (dimensions.data.properties || []).find(
    property => property.name === 'height' && property.writable === true
  );
  assert(widthProperty && heightProperty, 'dx29_width_height_schema_missing');

  const widthValue = 321;
  const heightValue = 181;
  const resized = await client.call('objects.properties.set', {
    targetKind: 'object-definition',
    sceneName,
    objectName: resizableObjectName,
    changes: [
      { path: widthProperty.path, value: widthValue },
      { path: heightProperty.path, value: heightValue },
    ],
    expectedRevision: revision,
    idempotencyKey: 'dx29-clean-room-resize',
  });
  assert(
    !resized.isError,
    'dx29_resizable_size_update_failed:' + JSON.stringify(errorOf(resized))
  );
  assert(
    revisionOf(resized) > revision,
    'dx29_resizable_size_revision_not_advanced'
  );
  revision = revisionOf(resized);

  const appliedDimensions =
    resized.data && Array.isArray(resized.data.applied)
      ? resized.data.applied
      : [];
  const appliedWidth = appliedDimensions.find(
    change => change.path === widthProperty.path
  );
  const appliedHeight = appliedDimensions.find(
    change => change.path === heightProperty.path
  );
  assert(
    appliedWidth &&
      Number(appliedWidth.value) === widthValue &&
      appliedHeight &&
      Number(appliedHeight.value) === heightValue,
    'dx29_width_height_mutation_response_missing'
  );

  const available = await client.call('objects.behaviors.available', {
    sceneName,
    objectName: configurableObjectName,
    query: behaviorQuery,
    includeCapabilities: false,
    compatibleOnly: true,
    limit: 100,
  });
  assert(!available.isError, 'dx29_configurable_available_failed');
  const candidate = (available.data.items || []).find(
    item =>
      item &&
      item.attachment &&
      item.attachment.addable === true &&
      item.parameters &&
      Array.isArray(item.parameters.propertyNames) &&
      item.parameters.propertyNames.length > 0
  );
  assert(candidate, 'dx29_configurable_behavior_not_discovered');

  const behaviorName = 'DX29ConfiguredBehavior';
  const added = await client.call('objects.behaviors.add', {
    sceneName,
    objectName: configurableObjectName,
    behaviorType: candidate.type,
    behaviorName,
    expectedRevision: revision,
    idempotencyKey: 'dx29-clean-room-add-configurable',
  });
  assert(!added.isError, 'dx29_configurable_add_failed');
  assert(
    added.data &&
      added.data.added === true &&
      added.data.behavior &&
      added.data.behavior.name === behaviorName,
    'dx29_configurable_add_not_applied'
  );
  assert(revisionOf(added) > revision, 'dx29_add_revision_not_advanced');
  revision = revisionOf(added);

  let configured = await client.call('objects.behaviors.describe', {
    sceneName,
    objectName: configurableObjectName,
    behaviorName,
  });
  assert(!configured.isError, 'dx29_configurable_describe_failed');
  const property = chooseSimpleWritableProperty(
    configured.data.behavior.properties
  );
  assert(property, 'dx29_configurable_property_not_discovered');
  const nextValue = changedValueFor(property);

  const updated = await client.call('objects.behaviors.update', {
    sceneName,
    objectName: configurableObjectName,
    behaviorName,
    changes: [{ path: property.path, value: nextValue }],
    expectedRevision: revision,
    idempotencyKey: 'dx29-clean-room-update-configurable',
  });
  assert(!updated.isError, 'dx29_configurable_update_failed');
  assert(
    updated.data && updated.data.delegatedTo === 'objects.properties.set',
    'dx29_update_not_delegated_to_dx24'
  );
  assert(revisionOf(updated) > revision, 'dx29_update_revision_not_advanced');
  revision = revisionOf(updated);

  configured = await client.call('objects.behaviors.describe', {
    sceneName,
    objectName: configurableObjectName,
    behaviorName,
  });
  const propertyAfter = (configured.data.behavior.properties || []).find(
    item => item.path === property.path
  );
  assert(
    propertyAfter && propertyAfter.currentValue === nextValue,
    'dx29_configurable_property_not_persisted'
  );

  const removeDryRun = await client.call('objects.behaviors.remove', {
    sceneName,
    objectName: configurableObjectName,
    behaviorName,
  });
  assert(
    !removeDryRun.isError &&
      removeDryRun.data &&
      removeDryRun.data.removed === false &&
      removeDryRun.data.preflight &&
      removeDryRun.data.preflight.dryRun === true,
    'dx29_remove_dry_run_failed'
  );
  assert(
    revisionOf(removeDryRun) === revision,
    'dx29_remove_dry_run_changed_revision'
  );

  const removed = await client.call('objects.behaviors.remove', {
    sceneName,
    objectName: configurableObjectName,
    behaviorName,
    dryRun: false,
    expectedRevision: revision,
    idempotencyKey: 'dx29-clean-room-remove-configurable',
  });
  assert(!removed.isError, 'dx29_remove_apply_failed');
  assert(
    removed.data &&
      removed.data.removed === true &&
      removed.data.removedBehaviorNames.includes(behaviorName),
    'dx29_remove_not_applied'
  );
  assert(revisionOf(removed) > revision, 'dx29_remove_revision_not_advanced');
  revision = revisionOf(removed);

  const beforeIncompatible = await client.call('objects.behaviors.list', {
    sceneName,
    objectName: incompatibleObjectName,
  });
  const incompatibleAvailable = await client.call(
    'objects.behaviors.available',
    {
      sceneName,
      objectName: incompatibleObjectName,
      query: incompatibleQuery,
      includeCapabilities: false,
      compatibleOnly: false,
      limit: 100,
    }
  );
  const incompatible = (incompatibleAvailable.data.items || []).find(
    item =>
      item &&
      item.compatibility &&
      item.compatibility.nativeCompatible === false &&
      item.capabilityInterface === null
  );
  assert(incompatible, 'dx29_incompatible_behavior_not_discovered');

  const incompatibleAttempt = await client.call('objects.behaviors.add', {
    sceneName,
    objectName: incompatibleObjectName,
    behaviorType: incompatible.type,
    behaviorName: 'DX29ShouldNotAttach',
    expectedRevision: revision,
    idempotencyKey: 'dx29-clean-room-incompatible',
  });
  const incompatibleError = errorOf(incompatibleAttempt);
  assert(
    incompatibleAttempt.isError === true &&
      incompatibleError &&
      incompatibleError.code === 'behavior_incompatible_with_object' &&
      incompatibleError.field === 'behaviorType',
    'dx29_incompatible_preflight_diagnostics_missing'
  );

  const afterIncompatible = await client.call('objects.behaviors.list', {
    sceneName,
    objectName: incompatibleObjectName,
  });
  assert(
    JSON.stringify(
      (beforeIncompatible.data.items || []).map(item => [item.name, item.type])
    ) ===
      JSON.stringify(
        (afterIncompatible.data.items || []).map(item => [item.name, item.type])
      ),
    'dx29_incompatible_attempt_mutated_object'
  );
  assert(
    revisionOf(afterIncompatible) === revision,
    'dx29_incompatible_attempt_changed_revision'
  );

  return {
    resizable: {
      behaviorType: resizableCandidate.type,
      behaviorName: restoredResizable.data.behavior.name,
      restored: true,
      width: {
        path: widthProperty.path,
        value: widthValue,
        actionId: setWidthAction.id,
      },
      height: {
        path: heightProperty.path,
        value: heightValue,
        actionId: setHeightAction.id,
      },
    },
    lifecycle: {
      behaviorType: candidate.type,
      behaviorName,
      propertyPath: property.path,
      propertyValue: nextValue,
      removed: true,
    },
    incompatible: {
      behaviorType: incompatible.type,
      errorCode: incompatibleError.code,
      field: incompatibleError.field,
      mutationPrevented: true,
    },
    projectRevision: revision,
  };
};

module.exports = { runBehaviorLifecycleCleanRoomActor };
