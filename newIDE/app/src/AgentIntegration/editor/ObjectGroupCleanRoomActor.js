const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const findTool = (tools, name) => {
  const tool = tools.find(candidate => candidate.name === name);
  assert(tool, 'dx31_clean_room_missing_tool:' + name);
  return tool;
};

const revisionOf = result =>
  result && result.meta && Number.isInteger(result.meta.projectRevision)
    ? result.meta.projectRevision
    : null;

const errorOf = result =>
  result && result.structuredContent && result.structuredContent.error
    ? result.structuredContent.error
    : result && result.data && result.data.error
    ? result.data.error
    : null;

const runObjectGroupCleanRoomActor = async ({
  client,
  sceneName,
  sceneObjectName,
  globalObjectName,
}) => {
  const tools = await client.listTools();
  [
    'objects.groups.list',
    'objects.groups.get',
    'objects.groups.for-object',
    'objects.groups.usages',
    'objects.groups.create',
    'objects.groups.rename',
    'objects.groups.delete',
    'objects.groups.members.add',
    'objects.groups.members.remove',
    'objects.groups.members.move',
    'events.read',
    'events.insert',
    'events.delete',
    'events.instructions.search',
    'events.instructions.describe',
  ].forEach(name => findTool(tools, name));

  const deleteTool = findTool(tools, 'objects.groups.delete');
  assert(
    deleteTool.inputSchema.properties.dryRun.default === true,
    'dx31_group_delete_not_dry_run_default'
  );

  let initial = await client.call('events.read', { sceneName });
  assert(!initial.isError, 'dx31_initial_events_read_failed');
  let revision = revisionOf(initial);

  const created = await client.call('objects.groups.create', {
    groupName: 'DX31Actors',
    groupScope: 'scene',
    sceneName,
    expectedRevision: revision,
    idempotencyKey: 'dx31-create-group',
  });
  assert(!created.isError && created.data.created, 'dx31_group_create_failed');
  revision = revisionOf(created);

  for (const [index, objectName] of [
    sceneObjectName,
    globalObjectName,
  ].entries()) {
    const added = await client.call('objects.groups.members.add', {
      groupName: 'DX31Actors',
      groupScope: 'scene',
      sceneName,
      objectName,
      expectedRevision: revision,
      idempotencyKey: 'dx31-add-member-' + index,
    });
    assert(!added.isError && added.data.added, 'dx31_member_add_failed');
    revision = revisionOf(added);
  }

  const group = await client.call('objects.groups.get', {
    groupName: 'DX31Actors',
    groupScope: 'scene',
    sceneName,
  });
  assert(
    !group.isError &&
      group.data.group.members.length === 2 &&
      group.data.group.members.some(
        member =>
          member.objectName === sceneObjectName &&
          member.objectScope === 'scene'
      ) &&
      group.data.group.members.some(
        member =>
          member.objectName === globalObjectName &&
          member.objectScope === 'global'
      ),
    'dx31_group_member_introspection_failed'
  );

  const reverse = await client.call('objects.groups.for-object', {
    objectName: globalObjectName,
    sceneName,
    groupScope: 'scene',
  });
  assert(
    !reverse.isError &&
      reverse.data.items.some(item => item.name === 'DX31Actors'),
    'dx31_reverse_lookup_failed'
  );

  const search = await client.call('events.instructions.search', {
    kind: 'action',
    query: 'SetX',
    deprecated: 'include',
    includeHidden: true,
    limit: 100,
  });
  assert(!search.isError, 'dx31_instruction_search_failed');
  const setX = (search.data.items || []).find(
    item =>
      item.id === 'SetX' &&
      (item.parameters || []).some(
        parameter => parameter.valueType && parameter.valueType.object
      )
  );
  assert(setX, 'dx31_object_action_not_discovered');

  const described = await client.call('events.instructions.describe', {
    id: setX.id,
    kind: 'action',
    extension: setX.extension.name,
  });
  assert(!described.isError, 'dx31_instruction_describe_failed');
  const objectParameter = described.data.item.parameters.find(
    parameter => parameter.valueType && parameter.valueType.object
  );
  assert(
    objectParameter &&
      objectParameter.referenceSemantics &&
      objectParameter.referenceSemantics.entityKinds.includes('object-group') &&
      objectParameter.referenceSemantics.groupUsageCommand ===
        'objects.groups.usages',
    'dx31_object_group_parameter_semantics_missing'
  );

  const beforeInsert = await client.call('events.read', { sceneName });
  const standardEvent = {
    type: 'BuiltinCommonInstructions::Standard',
    conditions: [],
    actions: [
      {
        type: { value: setX.id },
        parameters: ['DX31Actors', '=', '10'],
        subInstructions: [],
      },
    ],
    events: [],
  };
  const inserted = await client.call('events.insert', {
    sceneName,
    expectedEventsRevision: beforeInsert.data.eventsRevision,
    eventsJson: [standardEvent],
    expectedRevision: revision,
    idempotencyKey: 'dx31-insert-group-event',
  });
  assert(!inserted.isError, 'dx31_group_event_insert_failed');
  revision = revisionOf(inserted);

  const used = await client.call('objects.groups.usages', {
    groupName: 'DX31Actors',
    groupScope: 'scene',
    sceneName,
  });
  assert(
    !used.isError &&
      used.data.usages.authoritativeReferenceCount === 1 &&
      used.data.usages.authoritativeReferences[0].parameterIndex === 0 &&
      used.data.usages.authoritativeReferences[0].groupEntityKind ===
        'object-group',
    'dx31_group_usage_not_mapped'
  );

  const renamed = await client.call('objects.groups.rename', {
    groupName: 'DX31Actors',
    groupScope: 'scene',
    sceneName,
    newGroupName: 'DX31Units',
    expectedRevision: revision,
    idempotencyKey: 'dx31-rename-group',
  });
  assert(
    !renamed.isError &&
      renamed.data.renamed === true &&
      renamed.data.nativeRefactor === true,
    'dx31_group_rename_failed'
  );
  revision = revisionOf(renamed);

  const afterRename = await client.call('events.read', { sceneName });
  const authoredEvent = (afterRename.data.events || []).find(
    event =>
      event.actions && event.actions.some(action => action.type === setX.id)
  );
  assert(authoredEvent, 'dx31_authored_event_missing_after_rename');
  const authoredAction = authoredEvent.actions.find(
    action => action.type === setX.id
  );
  assert(
    authoredAction.parameters[0] === 'DX31Units',
    'dx31_group_reference_not_refactored'
  );

  const deletePlan = await client.call('objects.groups.delete', {
    groupName: 'DX31Units',
    groupScope: 'scene',
    sceneName,
  });
  assert(
    !deletePlan.isError &&
      deletePlan.data.deleted === false &&
      deletePlan.data.plan.blockers.some(
        blocker => blocker.code === 'object_group_in_use'
      ),
    'dx31_group_delete_plan_missing_blocker'
  );
  assert(
    revisionOf(deletePlan) === revision,
    'dx31_delete_dry_run_changed_revision'
  );

  const blocked = await client.call('objects.groups.delete', {
    groupName: 'DX31Units',
    groupScope: 'scene',
    sceneName,
    dryRun: false,
    expectedRevision: revision,
    idempotencyKey: 'dx31-delete-blocked',
  });
  assert(
    blocked.isError &&
      errorOf(blocked) &&
      errorOf(blocked).code === 'object_group_delete_blocked',
    'dx31_in_use_group_delete_not_blocked'
  );

  const latestEvents = await client.call('events.read', { sceneName });
  const eventToDelete = (latestEvents.data.events || []).find(
    event =>
      event.actions && event.actions.some(action => action.type === setX.id)
  );
  assert(eventToDelete, 'dx31_event_handle_missing_for_cleanup');

  const deletedEvent = await client.call('events.delete', {
    sceneName,
    expectedEventsRevision: latestEvents.data.eventsRevision,
    handle: eventToDelete.handle,
    expectedRevision: revision,
    idempotencyKey: 'dx31-delete-event',
  });
  assert(!deletedEvent.isError, 'dx31_event_cleanup_failed');
  revision = revisionOf(deletedEvent);

  const deleted = await client.call('objects.groups.delete', {
    groupName: 'DX31Units',
    groupScope: 'scene',
    sceneName,
    dryRun: false,
    expectedRevision: revision,
    idempotencyKey: 'dx31-delete-group',
  });
  assert(!deleted.isError && deleted.data.deleted, 'dx31_group_delete_failed');
  revision = revisionOf(deleted);

  const finalList = await client.call('objects.groups.list', {
    groupScope: 'scene',
    sceneName,
  });
  assert(
    !(finalList.data.items || []).some(item => item.name === 'DX31Units'),
    'dx31_group_still_present_after_delete'
  );

  return {
    createdGroup: 'DX31Actors',
    renamedGroup: 'DX31Units',
    members: [sceneObjectName, globalObjectName],
    objectParameterSemantics: true,
    eventAuthored: true,
    usageMapped: true,
    nativeRenameRefactor: true,
    deleteDryRunBlocked: true,
    removed: true,
    projectRevision: revision,
  };
};

module.exports = { runObjectGroupCleanRoomActor };
