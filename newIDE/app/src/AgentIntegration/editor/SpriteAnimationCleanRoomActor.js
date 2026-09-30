const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const findTool = (tools, name) => {
  const tool = tools.find(candidate => candidate.name === name);
  assert(tool, 'dx30_clean_room_missing_tool:' + name);
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

const runSpriteAnimationCleanRoomActor = async ({
  client,
  sceneName,
  objectName,
  imageA,
  imageB,
  replacementImage,
}) => {
  const tools = await client.listTools();
  [
    'objects.sprite.animations.list',
    'objects.sprite.animations.get',
    'objects.sprite.animations.create',
    'objects.sprite.animations.update',
    'objects.sprite.animations.move',
    'objects.sprite.animations.delete',
    'objects.sprite.frames.add',
    'objects.sprite.frames.update',
    'objects.sprite.frames.move',
    'objects.sprite.frames.delete',
    'objects.sprite.points.set',
    'objects.sprite.points.delete',
    'objects.sprite.collision-mask.set',
  ].forEach(name => findTool(tools, name));

  const moveFrameTool = findTool(tools, 'objects.sprite.frames.move');
  const deleteAnimationTool = findTool(
    tools,
    'objects.sprite.animations.delete'
  );
  assert(
    moveFrameTool.inputSchema.properties.dryRun.default === true &&
      moveFrameTool.inputSchema.properties.acknowledgeIndexReferenceRisk,
    'dx30_frame_move_safety_schema_missing'
  );
  assert(
    deleteAnimationTool.inputSchema.properties.dryRun.default === true,
    'dx30_animation_delete_not_dry_run_default'
  );

  let listed = await client.call('objects.sprite.animations.list', {
    sceneName,
    objectName,
  });
  assert(!listed.isError, 'dx30_initial_list_failed');
  let revision = revisionOf(listed);

  const created = await client.call('objects.sprite.animations.create', {
    sceneName,
    objectName,
    animationName: 'DX30Run',
    looping: true,
    timeBetweenFrames: 0.1,
    expectedRevision: revision,
    idempotencyKey: 'dx30-create-animation',
  });
  assert(!created.isError, 'dx30_create_animation_failed');
  assert(
    created.data &&
      created.data.created === true &&
      created.data.animation.animationName === 'DX30Run',
    'dx30_create_animation_not_applied'
  );
  assert(
    revisionOf(created) > revision,
    'dx30_create_animation_revision_not_advanced'
  );
  revision = revisionOf(created);

  const frame0 = await client.call('objects.sprite.frames.add', {
    sceneName,
    objectName,
    animationName: 'DX30Run',
    image: imageA,
    origin: { x: 3, y: 4 },
    center: { default: false, x: 16, y: 8 },
    points: [{ name: 'Hand', x: 20, y: 6 }],
    collisionMask: {
      kind: 'polygons',
      polygons: [
        [{ x: 0, y: 0 }, { x: 32, y: 0 }, { x: 32, y: 16 }, { x: 0, y: 16 }],
      ],
    },
    expectedRevision: revision,
    idempotencyKey: 'dx30-add-frame-a',
  });
  assert(!frame0.isError, 'dx30_add_frame_a_failed');
  assert(frame0.data.frame.frameIndex === 0, 'dx30_frame_a_index_wrong');
  revision = revisionOf(frame0);

  const frame1 = await client.call('objects.sprite.frames.add', {
    sceneName,
    objectName,
    animationName: 'DX30Run',
    image: imageB,
    origin: { x: 3, y: 4 },
    center: { default: false, x: 16, y: 8 },
    points: [{ name: 'Hand', x: 21, y: 7 }],
    collisionMask: {
      kind: 'polygons',
      polygons: [
        [{ x: 0, y: 0 }, { x: 32, y: 0 }, { x: 32, y: 16 }, { x: 0, y: 16 }],
      ],
    },
    expectedRevision: revision,
    idempotencyKey: 'dx30-add-frame-b',
  });
  assert(!frame1.isError, 'dx30_add_frame_b_failed');
  assert(frame1.data.frame.frameIndex === 1, 'dx30_frame_b_index_wrong');
  revision = revisionOf(frame1);

  const inspected = await client.call('objects.sprite.animations.get', {
    sceneName,
    objectName,
    animationName: 'DX30Run',
  });
  assert(!inspected.isError, 'dx30_get_animation_failed');
  const direction = inspected.data.animation.directions[0];
  assert(direction.frameCount === 2, 'dx30_frame_count_wrong');
  assert(
    direction.timingModel === 'uniform-per-direction' &&
      direction.frameDurationSeconds === 0.1,
    'dx30_timing_model_missing'
  );
  assert(
    direction.frames[0].origin.x === 3 &&
      direction.frames[0].center.default === false &&
      direction.frames[0].points.some(point => point.name === 'Hand') &&
      direction.frames[0].collisionMask.kind === 'polygons',
    'dx30_point_or_mask_introspection_missing'
  );
  assert(
    direction.frames[0].resource &&
      direction.frames[0].resource.discovery &&
      direction.frames[0].resource.discovery.command ===
        'resources.visual.inspect',
    'dx30_resource_link_missing'
  );

  const replaced = await client.call('objects.sprite.frames.update', {
    sceneName,
    objectName,
    animationName: 'DX30Run',
    frameIndex: 0,
    image: replacementImage,
    expectedRevision: revision,
    idempotencyKey: 'dx30-replace-frame-resource',
  });
  assert(
    !replaced.isError &&
      replaced.data.preserved.customPoints === true &&
      replaced.data.preserved.collisionMask === true,
    'dx30_frame_replace_preservation_missing'
  );
  assert(
    replaced.data.frame.image === replacementImage &&
      replaced.data.frame.points.some(point => point.name === 'Hand') &&
      replaced.data.frame.collisionMask.kind === 'polygons',
    'dx30_frame_replace_corrupted_metadata'
  );
  revision = revisionOf(replaced);

  const renamed = await client.call('objects.sprite.animations.update', {
    sceneName,
    objectName,
    animationName: 'DX30Run',
    newAnimationName: 'DX30Sprint',
    looping: false,
    timeBetweenFrames: 0.2,
    expectedRevision: revision,
    idempotencyKey: 'dx30-rename-animation',
  });
  assert(
    !renamed.isError &&
      renamed.data.renameRefactor &&
      renamed.data.renameRefactor.nativeRefactor === true,
    'dx30_native_rename_refactor_missing'
  );
  assert(
    renamed.data.animation.animationName === 'DX30Sprint' &&
      renamed.data.animation.directions[0].looping === false &&
      renamed.data.animation.directions[0].timeBetweenFrames === 0.2,
    'dx30_animation_update_not_persisted'
  );
  revision = revisionOf(renamed);

  const movePlan = await client.call('objects.sprite.frames.move', {
    sceneName,
    objectName,
    animationName: 'DX30Sprint',
    fromIndex: 0,
    toIndex: 1,
  });
  assert(
    !movePlan.isError &&
      movePlan.data.moved === false &&
      movePlan.data.plan.referenceRisk.requiresAcknowledgement === true,
    'dx30_frame_move_dry_run_missing'
  );
  assert(
    revisionOf(movePlan) === revision,
    'dx30_frame_move_dry_run_changed_revision'
  );

  const unsafeMove = await client.call('objects.sprite.frames.move', {
    sceneName,
    objectName,
    animationName: 'DX30Sprint',
    fromIndex: 0,
    toIndex: 1,
    dryRun: false,
    expectedRevision: revision,
    idempotencyKey: 'dx30-unsafe-move',
  });
  assert(
    unsafeMove.isError === true &&
      errorOf(unsafeMove) &&
      errorOf(unsafeMove).code === 'sprite_index_reference_risk_ack_required',
    'dx30_index_risk_not_blocked'
  );
  assert(
    revisionOf(movePlan) === revision,
    'dx30_unsafe_move_should_not_advance_revision'
  );

  const moved = await client.call('objects.sprite.frames.move', {
    sceneName,
    objectName,
    animationName: 'DX30Sprint',
    fromIndex: 0,
    toIndex: 1,
    dryRun: false,
    acknowledgeIndexReferenceRisk: true,
    expectedRevision: revision,
    idempotencyKey: 'dx30-safe-move',
  });
  assert(!moved.isError && moved.data.moved === true, 'dx30_frame_move_failed');
  revision = revisionOf(moved);

  const deletePlan = await client.call('objects.sprite.animations.delete', {
    sceneName,
    objectName,
    animationName: 'DX30Sprint',
  });
  assert(
    !deletePlan.isError &&
      deletePlan.data.deleted === false &&
      deletePlan.data.plan.referenceRisk.requiresAcknowledgement === true,
    'dx30_animation_delete_dry_run_missing'
  );
  assert(
    revisionOf(deletePlan) === revision,
    'dx30_animation_delete_dry_run_changed_revision'
  );

  const deleted = await client.call('objects.sprite.animations.delete', {
    sceneName,
    objectName,
    animationName: 'DX30Sprint',
    dryRun: false,
    acknowledgeIndexReferenceRisk: true,
    expectedRevision: revision,
    idempotencyKey: 'dx30-delete-animation',
  });
  assert(
    !deleted.isError && deleted.data.deleted === true,
    'dx30_animation_delete_failed'
  );
  revision = revisionOf(deleted);

  listed = await client.call('objects.sprite.animations.list', {
    sceneName,
    objectName,
  });
  assert(
    !(listed.data.items || []).some(
      animation => animation.animationName === 'DX30Sprint'
    ),
    'dx30_animation_still_present_after_delete'
  );

  return {
    createdAnimation: 'DX30Run',
    renamedAnimation: 'DX30Sprint',
    frameCount: 2,
    frameReplacement: {
      from: imageA,
      to: replacementImage,
      metadataPreserved: true,
    },
    pointAndMask: {
      origin: { x: 3, y: 4 },
      customPoint: 'Hand',
      collisionMask: 'polygons',
    },
    timing: {
      initialSeconds: 0.1,
      finalSeconds: 0.2,
      model: 'uniform-per-direction',
    },
    indexRisk: {
      dryRunVerified: true,
      unsafeApplyBlocked: true,
      acknowledgedApplySucceeded: true,
    },
    nativeRenameRefactor: true,
    removed: true,
    projectRevision: revision,
  };
};

module.exports = { runSpriteAnimationCleanRoomActor };
