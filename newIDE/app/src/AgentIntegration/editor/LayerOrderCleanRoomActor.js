const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const findTool = (tools, name) => {
  const tool = tools.find(candidate => candidate.name === name);
  assert(tool, 'clean_room_missing_tool:' + name);
  return tool;
};

const findInstance = (snapshot, objectName) =>
  (snapshot.instances || []).find(
    instance => instance.objectName === objectName
  );

const runLayerOrderCleanRoomActor = async ({ client, sceneName }) => {
  const tools = await client.listTools();
  const listTool = findTool(tools, 'scene.layers.list');
  const compareTool = findTool(tools, 'scene.render.compare');
  const reorderTool = findTool(tools, 'scene.layers.reorder');
  const zTool = findTool(tools, 'scene.instances.set-render-order');

  assert(
    listTool.annotations && listTool.annotations.readOnlyHint === true,
    'clean_room_layer_list_not_read_only'
  );
  assert(
    compareTool.annotations && compareTool.annotations.readOnlyHint === true,
    'clean_room_compare_not_read_only'
  );
  assert(
    reorderTool.annotations && reorderTool.annotations.readOnlyHint === false,
    'clean_room_reorder_not_mutating'
  );
  assert(
    zTool.inputSchema &&
      zTool.inputSchema.properties &&
      zTool.inputSchema.properties.beforeInstanceId &&
      zTool.inputSchema.properties.expectedZOrder,
    'clean_room_relative_z_schema_missing'
  );

  let snapshot = await client.call('scene.layers.list', { sceneName });
  assert(!snapshot.isError, 'clean_room_layer_list_failed');
  let revision = snapshot.meta.projectRevision;
  let board = findInstance(snapshot.data, 'Board');
  let coin = findInstance(snapshot.data, 'Coin');
  let worker = findInstance(snapshot.data, 'Worker');
  let hud = findInstance(snapshot.data, 'HUD');
  assert(board && coin && worker && hud, 'clean_room_instances_not_discovered');

  let boardVsCoin = await client.call('scene.render.compare', {
    sceneName,
    aInstanceId: board.instanceId,
    bInstanceId: coin.instanceId,
  });
  assert(!boardVsCoin.isError, 'clean_room_board_compare_failed');
  if (boardVsCoin.data.result.relation !== 'below') {
    const changed = await client.call('scene.instances.set-render-order', {
      sceneName,
      instanceId: board.instanceId,
      beforeInstanceId: coin.instanceId,
      expectedLayerId: board.layerId,
      expectedZOrder: board.zOrder,
      expectedRevision: revision,
      idempotencyKey: 'dx26-clean-room-board-below-coin',
    });
    assert(!changed.isError, 'clean_room_board_reorder_failed');
    revision = changed.meta.projectRevision;
  }

  snapshot = await client.call('scene.layers.list', { sceneName });
  revision = snapshot.meta.projectRevision;
  board = findInstance(snapshot.data, 'Board');
  coin = findInstance(snapshot.data, 'Coin');
  worker = findInstance(snapshot.data, 'Worker');
  hud = findInstance(snapshot.data, 'HUD');

  let hudVsWorker = await client.call('scene.render.compare', {
    sceneName,
    aInstanceId: hud.instanceId,
    bInstanceId: worker.instanceId,
  });
  assert(!hudVsWorker.isError, 'clean_room_hud_compare_failed');
  if (hudVsWorker.data.result.relation !== 'above') {
    if (hud.layerId !== worker.layerId) {
      const hudLayer = snapshot.data.layers.find(
        layer => layer.layerId === hud.layerId
      );
      assert(hudLayer, 'clean_room_hud_layer_not_discovered');
      const changed = await client.call('scene.layers.reorder', {
        sceneName,
        layerId: hudLayer.layerId,
        expectedIndex: hudLayer.index,
        expectedName: hudLayer.name,
        position: snapshot.data.layers.length - 1,
        expectedRevision: revision,
        idempotencyKey: 'dx26-clean-room-ui-above-gameplay',
      });
      assert(!changed.isError, 'clean_room_ui_layer_reorder_failed');
      revision = changed.meta.projectRevision;
    } else {
      const changed = await client.call('scene.instances.set-render-order', {
        sceneName,
        instanceId: hud.instanceId,
        afterInstanceId: worker.instanceId,
        expectedLayerId: hud.layerId,
        expectedZOrder: hud.zOrder,
        expectedRevision: revision,
        idempotencyKey: 'dx26-clean-room-hud-above-worker',
      });
      assert(!changed.isError, 'clean_room_hud_z_reorder_failed');
      revision = changed.meta.projectRevision;
    }
  }

  const finalSnapshot = await client.call('scene.layers.list', { sceneName });
  const finalBoard = findInstance(finalSnapshot.data, 'Board');
  const finalCoin = findInstance(finalSnapshot.data, 'Coin');
  const finalWorker = findInstance(finalSnapshot.data, 'Worker');
  const finalHud = findInstance(finalSnapshot.data, 'HUD');

  boardVsCoin = await client.call('scene.render.compare', {
    sceneName,
    aInstanceId: finalBoard.instanceId,
    bInstanceId: finalCoin.instanceId,
  });
  const boardVsWorker = await client.call('scene.render.compare', {
    sceneName,
    aInstanceId: finalBoard.instanceId,
    bInstanceId: finalWorker.instanceId,
  });
  hudVsWorker = await client.call('scene.render.compare', {
    sceneName,
    aInstanceId: finalHud.instanceId,
    bInstanceId: finalWorker.instanceId,
  });

  assert(
    boardVsCoin.data.result.relation === 'below',
    'clean_room_board_not_below_coin'
  );
  assert(
    boardVsWorker.data.result.relation === 'below',
    'clean_room_board_not_below_worker'
  );
  assert(
    hudVsWorker.data.result.relation === 'above',
    'clean_room_hud_not_above_gameplay'
  );

  return {
    projectRevision: finalSnapshot.meta.projectRevision,
    boardBelowCoin: boardVsCoin.data.result,
    boardBelowWorker: boardVsWorker.data.result,
    hudAboveWorker: hudVsWorker.data.result,
    layers: finalSnapshot.data.layers.map(layer => ({
      layerId: layer.layerId,
      name: layer.name,
      index: layer.index,
    })),
  };
};

module.exports = { runLayerOrderCleanRoomActor };
