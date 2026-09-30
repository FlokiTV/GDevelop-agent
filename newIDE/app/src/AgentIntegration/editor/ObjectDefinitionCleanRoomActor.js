const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const findTool = (tools, name) => {
  const tool = tools.find(candidate => candidate.name === name);
  assert(tool, 'dx34_clean_room_missing_tool:' + name);
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

const runObjectDefinitionCleanRoomActor = async ({ client, sceneName }) => {
  const tools = await client.listTools();
  [
    'editor.types.objects.list',
    'editor.types.objects.describe',
    'objects.definitions.list',
    'objects.definitions.get',
    'objects.definitions.usages',
    'objects.definitions.create',
    'objects.definitions.duplicate',
    'objects.definitions.rename',
    'objects.definitions.delete',
    'objects.definitions.move-scope',
    'objects.groups.create',
    'objects.groups.get',
    'objects.groups.members.add',
    'objects.groups.members.remove',
    'objects.groups.delete',
    'scene.instances.create',
    'scene.instances.get',
    'scene.instances.delete',
    'events.read',
    'events.insert',
    'events.delete',
    'events.instructions.search',
    'events.instructions.describe',
  ].forEach(name => findTool(tools, name));

  const deleteTool = findTool(tools, 'objects.definitions.delete');
  assert(
    deleteTool.inputSchema.properties.dryRun.default === true,
    'dx34_delete_not_dry_run_default'
  );
  const moveTool = findTool(tools, 'objects.definitions.move-scope');
  assert(
    moveTool.inputSchema.properties.dryRun.default === true,
    'dx34_move_not_dry_run_default'
  );

  const types = await client.call('editor.types.objects.list', {
    query: 'sprite',
    deprecated: 'include',
    renderingMode: '2d',
    limit: 100,
  });
  assert(!types.isError, 'dx34_object_type_list_failed');
  const spriteType = (types.data.items || []).find(
    item => item.type === 'Sprite'
  );
  assert(spriteType, 'dx34_sprite_type_not_discovered');

  const typeDescription = await client.call('editor.types.objects.describe', {
    type: spriteType.type,
  });
  assert(!typeDescription.isError, 'dx34_object_type_describe_failed');
  const typeItem = typeDescription.data.item;
  assert(
    typeItem.creationSchema &&
      typeItem.creationSchema.requiredFields.includes('objectName') &&
      Array.isArray(typeItem.supportedBehaviors) &&
      Array.isArray(typeItem.supportedCapabilities),
    'dx34_creation_schema_missing'
  );

  let initial = await client.call('events.read', { sceneName });
  assert(!initial.isError, 'dx34_initial_events_read_failed');
  let revision = revisionOf(initial);

  const created = await client.call('objects.definitions.create', {
    objectName: 'DX34Hero',
    objectType: spriteType.type,
    objectScope: 'scene',
    sceneName,
    expectedRevision: revision,
    idempotencyKey: 'dx34-create-object',
  });
  assert(!created.isError && created.data.created, 'dx34_create_failed');
  const objectId = created.data.object.identity.objectId;
  assert(objectId, 'dx34_object_identity_missing');
  revision = revisionOf(created);

  const duplicated = await client.call('objects.definitions.duplicate', {
    objectId,
    newObjectName: 'DX34HeroCopy',
    expectedRevision: revision,
    idempotencyKey: 'dx34-duplicate-object',
  });
  assert(
    !duplicated.isError &&
      duplicated.data.duplicated &&
      duplicated.data.object.identity.objectId !== objectId,
    'dx34_duplicate_failed'
  );
  const duplicateId = duplicated.data.object.identity.objectId;
  revision = revisionOf(duplicated);

  const duplicateDelete = await client.call('objects.definitions.delete', {
    objectId: duplicateId,
    dryRun: false,
    expectedRevision: revision,
    idempotencyKey: 'dx34-delete-unused-copy',
  });
  assert(
    !duplicateDelete.isError && duplicateDelete.data.deleted,
    'dx34_unused_duplicate_delete_failed'
  );
  revision = revisionOf(duplicateDelete);

  const group = await client.call('objects.groups.create', {
    groupName: 'DX34Actors',
    groupScope: 'scene',
    sceneName,
    expectedRevision: revision,
    idempotencyKey: 'dx34-create-group',
  });
  assert(!group.isError && group.data.created, 'dx34_group_create_failed');
  revision = revisionOf(group);

  const member = await client.call('objects.groups.members.add', {
    groupName: 'DX34Actors',
    groupScope: 'scene',
    sceneName,
    objectName: 'DX34Hero',
    expectedRevision: revision,
    idempotencyKey: 'dx34-add-group-member',
  });
  assert(!member.isError && member.data.added, 'dx34_group_member_failed');
  revision = revisionOf(member);

  const instance = await client.call('scene.instances.create', {
    sceneName,
    objectName: 'DX34Hero',
    position: { x: 64, y: 96 },
    expectedRevision: revision,
    idempotencyKey: 'dx34-create-instance',
  });
  assert(
    !instance.isError && instance.data.created,
    'dx34_instance_create_failed'
  );
  const instanceId =
    instance.data.instance &&
    (instance.data.instance.instanceId ||
      (instance.data.instance.identity &&
        instance.data.instance.identity.instanceId));
  assert(instanceId, 'dx34_instance_id_missing');
  revision = revisionOf(instance);

  const search = await client.call('events.instructions.search', {
    kind: 'action',
    query: 'SetX',
    deprecated: 'include',
    includeHidden: true,
    limit: 100,
  });
  assert(!search.isError, 'dx34_instruction_search_failed');
  const setX = (search.data.items || []).find(
    item =>
      item.id === 'SetX' &&
      (item.parameters || []).some(
        parameter => parameter.valueType && parameter.valueType.object
      )
  );
  assert(setX, 'dx34_object_action_not_discovered');

  const beforeInsert = await client.call('events.read', { sceneName });
  const inserted = await client.call('events.insert', {
    sceneName,
    expectedEventsRevision: beforeInsert.data.eventsRevision,
    eventsJson: [
      {
        type: 'BuiltinCommonInstructions::Standard',
        conditions: [],
        actions: [
          {
            type: { value: setX.id },
            parameters: ['DX34Hero', '=', '10'],
            subInstructions: [],
          },
        ],
        events: [],
      },
    ],
    expectedRevision: revision,
    idempotencyKey: 'dx34-insert-event',
  });
  assert(!inserted.isError, 'dx34_event_insert_failed');
  revision = revisionOf(inserted);

  const usages = await client.call('objects.definitions.usages', { objectId });
  assert(
    !usages.isError &&
      usages.data.counts.instances === 1 &&
      usages.data.counts.groups === 1 &&
      usages.data.counts.authoritativeEventReferences === 1,
    'dx34_usage_mapping_failed'
  );

  const renamed = await client.call('objects.definitions.rename', {
    objectId,
    newObjectName: 'DX34HeroRenamed',
    expectedRevision: revision,
    idempotencyKey: 'dx34-rename-object',
  });
  assert(
    !renamed.isError &&
      renamed.data.renamed &&
      renamed.data.objectId === objectId &&
      renamed.data.nativeRefactor,
    'dx34_rename_failed'
  );
  revision = revisionOf(renamed);

  const groupAfterRename = await client.call('objects.groups.get', {
    groupName: 'DX34Actors',
    groupScope: 'scene',
    sceneName,
  });
  assert(
    !groupAfterRename.isError &&
      groupAfterRename.data.group.members.some(
        candidate => candidate.objectName === 'DX34HeroRenamed'
      ),
    'dx34_group_reference_not_refactored'
  );

  const instanceAfterRename = await client.call('scene.instances.get', {
    sceneName,
    instanceId,
  });
  assert(
    !instanceAfterRename.isError &&
      instanceAfterRename.data.instance.objectName === 'DX34HeroRenamed',
    'dx34_instance_reference_not_refactored'
  );

  const eventsAfterRename = await client.call('events.read', { sceneName });
  const authoredEvent = (eventsAfterRename.data.events || []).find(
    event =>
      event.actions && event.actions.some(action => action.type === setX.id)
  );
  assert(authoredEvent, 'dx34_authored_event_missing');
  const authoredAction = authoredEvent.actions.find(
    action => action.type === setX.id
  );
  assert(
    authoredAction.parameters[0] === 'DX34HeroRenamed',
    'dx34_event_reference_not_refactored'
  );

  const deletePlan = await client.call('objects.definitions.delete', {
    objectId,
  });
  assert(
    !deletePlan.isError &&
      deletePlan.data.plan.blockers.some(
        blocker => blocker.code === 'object_definition_has_instances'
      ) &&
      deletePlan.data.plan.blockers.some(
        blocker => blocker.code === 'object_definition_in_groups'
      ) &&
      deletePlan.data.plan.blockers.some(
        blocker => blocker.code === 'object_definition_referenced_by_events'
      ),
    'dx34_delete_plan_missing_blockers'
  );
  assert(
    revisionOf(deletePlan) === revision,
    'dx34_delete_dry_run_changed_revision'
  );

  const blockedDelete = await client.call('objects.definitions.delete', {
    objectId,
    dryRun: false,
    expectedRevision: revision,
    idempotencyKey: 'dx34-delete-blocked',
  });
  assert(
    blockedDelete.isError &&
      errorOf(blockedDelete) &&
      errorOf(blockedDelete).code === 'object_definition_delete_blocked',
    'dx34_in_use_delete_not_blocked'
  );

  const listed = await client.call('objects.definitions.list', {
    objectScope: 'scene',
    sceneName,
  });
  assert(
    !listed.isError &&
      listed.data.items.some(
        candidate =>
          candidate.identity.objectId === objectId &&
          candidate.name === 'DX34HeroRenamed'
      ),
    'dx34_definition_list_missing_renamed_object'
  );

  return {
    objectType: spriteType.type,
    objectId,
    instanceId,
    creationSchemaDiscovered: true,
    duplicateFreshIdentity: true,
    usageMapped: true,
    nativeRenameRefactor: true,
    deleteDryRunBlocked: true,
    projectRevision: revision,
  };
};

module.exports = { runObjectDefinitionCleanRoomActor };
