const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const findTool = (tools, name) => {
  const tool = tools.find(candidate => candidate.name === name);
  assert(tool, 'clean_room_missing_tool:' + name);
  return tool;
};

const runSceneInstanceCleanRoomActor = async ({ client, sceneName }) => {
  const tools = await client.listTools();
  const listTool = findTool(tools, 'scene.instances.list');
  const updateTool = findTool(tools, 'scene.instances.update');
  const diagnoseTool = findTool(tools, 'scene.instances.diagnose-duplicates');
  const bulkDeleteTool = findTool(tools, 'scene.instances.bulk-delete');

  assert(
    listTool.annotations && listTool.annotations.readOnlyHint === true,
    'clean_room_instance_list_not_read_only'
  );
  assert(
    diagnoseTool.annotations && diagnoseTool.annotations.readOnlyHint === true,
    'clean_room_duplicate_diagnostics_not_read_only'
  );
  assert(
    updateTool.annotations && updateTool.annotations.readOnlyHint === false,
    'clean_room_update_not_mutating'
  );
  assert(
    updateTool.inputSchema &&
      updateTool.inputSchema.properties &&
      updateTool.inputSchema.properties.instanceId &&
      updateTool.inputSchema.properties.expectedInstanceRevision &&
      !updateTool.inputSchema.properties.position &&
      !updateTool.inputSchema.properties.point &&
      !updateTool.inputSchema.properties.brush,
    'clean_room_identity_update_schema_missing'
  );
  assert(
    bulkDeleteTool.inputSchema &&
      bulkDeleteTool.inputSchema.properties &&
      bulkDeleteTool.inputSchema.properties.dryRun &&
      bulkDeleteTool.inputSchema.properties.expectedSelectionRevision,
    'clean_room_bulk_delete_guard_schema_missing'
  );

  const before = await client.call('scene.instances.list', { sceneName });
  assert(!before.isError, 'clean_room_initial_list_failed');
  const initialCount = before.data.total;
  const worker = before.data.items.find(
    instance => instance.objectName === 'Worker'
  );
  assert(worker, 'clean_room_unique_worker_not_found');

  const updated = await client.call('scene.instances.update', {
    sceneName,
    instanceId: worker.instanceId,
    expectedInstanceRevision: worker.instanceRevision,
    changes: [{ path: 'instance.opacity', value: 137 }],
    expectedRevision: before.meta.projectRevision,
    idempotencyKey: 'dx27-clean-room-update-existing-worker',
  });
  assert(!updated.isError, 'clean_room_update_failed');
  assert(updated.data.created === false, 'clean_room_update_created_instance');
  assert(
    updated.data.identityPreserved === true,
    'clean_room_update_replaced_identity'
  );
  assert(
    updated.data.instanceCountUnchanged === true,
    'clean_room_update_changed_count'
  );

  const afterUpdate = await client.call('scene.instances.list', {
    sceneName,
  });
  assert(!afterUpdate.isError, 'clean_room_after_update_list_failed');
  assert(
    afterUpdate.data.total === initialCount,
    'clean_room_update_created_second_instance'
  );
  const workerAfter = afterUpdate.data.items.find(
    instance => instance.instanceId === worker.instanceId
  );
  assert(workerAfter, 'clean_room_worker_identity_missing_after_update');
  assert(
    workerAfter.visibility.opacity === 137,
    'clean_room_worker_update_not_applied'
  );

  const diagnostics = await client.call('scene.instances.diagnose-duplicates', {
    sceneName,
    selection: { objectNames: ['Coin'] },
    positionTolerance: 0,
    zTolerance: 0,
    angleTolerance: 0,
  });
  assert(!diagnostics.isError, 'clean_room_duplicate_diagnostics_failed');
  assert(
    diagnostics.data.autoDelete === false,
    'clean_room_diagnostics_auto_deleted'
  );
  assert(
    diagnostics.data.likelyDuplicateGroups.length === 1,
    'clean_room_expected_one_duplicate_group'
  );
  const group = diagnostics.data.likelyDuplicateGroups[0];
  assert(
    group.duplicateInstanceIds.length === 2,
    'clean_room_expected_two_duplicate_ids'
  );

  const revisionBeforeDryRun = diagnostics.meta.projectRevision;
  const dryRun = await client.call('scene.instances.bulk-delete', {
    sceneName,
    selection: { instanceIds: group.duplicateInstanceIds },
    dryRun: true,
    expectedRevision: revisionBeforeDryRun,
  });
  assert(!dryRun.isError, 'clean_room_bulk_delete_dry_run_failed');
  assert(dryRun.data.dryRun === true, 'clean_room_bulk_delete_not_dry_run');
  assert(
    dryRun.data.wouldDelete === 2,
    'clean_room_bulk_delete_wrong_target_count'
  );
  assert(
    dryRun.meta.projectRevision === revisionBeforeDryRun,
    'clean_room_dry_run_changed_project_revision'
  );
  assert(
    dryRun.meta.modifiesProject === false,
    'clean_room_dry_run_reported_project_mutation'
  );

  const applied = await client.call('scene.instances.bulk-delete', {
    sceneName,
    selection: { instanceIds: group.duplicateInstanceIds },
    dryRun: false,
    expectedSelectionRevision: dryRun.data.selectionRevision,
    expectedRevision: dryRun.meta.projectRevision,
    idempotencyKey: 'dx27-clean-room-deterministic-duplicate-cleanup',
  });
  assert(!applied.isError, 'clean_room_bulk_delete_apply_failed');
  assert(
    applied.data.deletedCount === 2,
    'clean_room_bulk_delete_wrong_deleted_count'
  );

  const finalList = await client.call('scene.instances.list', {
    sceneName,
  });
  assert(!finalList.isError, 'clean_room_final_list_failed');
  const finalCoins = finalList.data.items.filter(
    instance => instance.objectName === 'Coin'
  );
  assert(
    finalCoins.length === 1,
    'clean_room_duplicate_cleanup_did_not_leave_one'
  );
  assert(
    finalCoins[0].instanceId === group.canonicalInstanceId,
    'clean_room_cleanup_kept_noncanonical_identity'
  );

  return {
    updateDidNotCreate: true,
    updateInstanceId: worker.instanceId,
    countBeforeUpdate: initialCount,
    countAfterUpdate: afterUpdate.data.total,
    duplicateGroupId: group.groupId,
    canonicalInstanceId: group.canonicalInstanceId,
    deletedDuplicateInstanceIds: group.duplicateInstanceIds,
    dryRunSelectionRevision: dryRun.data.selectionRevision,
    dryRunProjectRevision: dryRun.meta.projectRevision,
    finalProjectRevision: finalList.meta.projectRevision,
    finalCoinCount: finalCoins.length,
    rawProjectJsonUsed: false,
  };
};

module.exports = { runSceneInstanceCleanRoomActor };
