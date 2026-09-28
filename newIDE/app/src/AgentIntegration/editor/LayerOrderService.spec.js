// @flow
import { createLayerOrderService } from './LayerOrderService';

const gd: libGDevelop = global.gd;

describe('DX-26 LayerOrderService', () => {
  let project: gdProject;
  let scene: gdLayout;
  let service: any;
  let triggerUnsavedChanges: jest.Mock<any, any>;
  let forceUpdate: jest.Mock<any, any>;
  let onInstancesModifiedOutsideEditor: jest.Mock<any, any>;

  const addInstance = (name, layer, zOrder, x = 0) => {
    const instance = scene.getInitialInstances().insertNewInitialInstance();
    instance.setObjectName(name);
    instance.setLayer(layer);
    instance.setZOrder(zOrder);
    instance.setX(x);
    instance.setY(x + 1);
    instance.setAngle(17);
    return instance;
  };

  beforeEach(() => {
    // $FlowFixMe[invalid-constructor]
    project = new gd.ProjectHelper.createNewGDJSProject();
    project.resetProjectUuid();
    project.setName('DX26 Layer Order Test');
    scene = project.insertNewLayout('Game', 0);
    scene.getLayers().insertNewLayer('Gameplay', 1);
    scene.getLayers().insertNewLayer('UI', 2);
    triggerUnsavedChanges = jest.fn();
    forceUpdate = jest.fn();
    onInstancesModifiedOutsideEditor = jest.fn();
    service = createLayerOrderService({
      project,
      triggerUnsavedChanges,
      forceUpdate,
      onInstancesModifiedOutsideEditor,
    });
  });

  afterEach(() => {
    project.delete();
  });

  it('lists persistent ordered layers, membership and deterministic editor render relations', () => {
    const board = addInstance('Board', 'Gameplay', 1);
    const coin = addInstance('Coin', 'Gameplay', 5);
    const worker = addInstance('Worker', 'Gameplay', 7);
    const hud = addInstance('HUD', 'UI', -100);

    const result = service.list({ sceneName: 'Game' });
    expect(result.authority).toBe('editor-project');
    expect(result.runtimeDynamicStateIncluded).toBe(false);
    expect(result.layers.map(layer => layer.name)).toEqual([
      '',
      'Gameplay',
      'UI',
    ]);
    expect(result.layers.every(layer => !!layer.layerId)).toBe(true);
    expect(
      result.layers.every(layer =>
        ['project-persistent', 'session-fallback'].includes(
          layer.layerIdPersistence
        )
      )
    ).toBe(true);
    expect(
      result.instances.find(
        item => item.instanceId === board.getPersistentUuid()
      )
    ).toMatchObject({
      layerName: 'Gameplay',
      layerIndex: 1,
      zOrder: 1,
      renderOrderDeterministic: true,
    });

    expect(
      service.compare({
        sceneName: 'Game',
        aInstanceId: board.getPersistentUuid(),
        bInstanceId: coin.getPersistentUuid(),
      }).result
    ).toEqual({
      determinable: true,
      relation: 'below',
      reason: 'z-order',
    });
    expect(
      service.compare({
        sceneName: 'Game',
        aInstanceId: board.getPersistentUuid(),
        bInstanceId: worker.getPersistentUuid(),
      }).result.relation
    ).toBe('below');
    expect(
      service.compare({
        sceneName: 'Game',
        aInstanceId: hud.getPersistentUuid(),
        bInstanceId: worker.getPersistentUuid(),
      }).result
    ).toEqual({
      determinable: true,
      relation: 'above',
      reason: 'layer-order',
    });
  });

  it('reports equal project Z-order on the same layer as indeterminate', () => {
    const a = addInstance('A', 'Gameplay', 4);
    const b = addInstance('B', 'Gameplay', 4);
    const listed = service.list({ sceneName: 'Game' });
    const aInfo = listed.instances.find(
      item => item.instanceId === a.getPersistentUuid()
    );
    expect(aInfo.renderOrderDeterministic).toBe(false);
    expect(aInfo.renderOrderWithinLayer).toBeNull();
    expect(aInfo.zOrderTieCount).toBe(2);
    expect(
      service.compare({
        sceneName: 'Game',
        aInstanceId: a.getPersistentUuid(),
        bInstanceId: b.getPersistentUuid(),
      }).result
    ).toEqual({
      determinable: false,
      relation: 'indeterminate',
      reason: 'equal-z-order-has-no-authoritative-editor-tiebreak',
    });
  });

  it('preserves persistent identity, cameras, effects, visibility and unrelated layer state during reorder and rename', () => {
    const ui = scene.getLayers().getLayer('UI');
    const layerId = service
      .list({ sceneName: 'Game' })
      .layers.find(layer => layer.name === 'UI').layerId;
    ui.setVisibility(false);
    ui.setLocked(true);
    ui.setRenderingType('3d');
    ui.setCameraCount(2);
    ui.getEffects()
      .insertNewEffect('Sepia', 0)
      .setEffectType('FakeSepia');
    const hud = addInstance('HUD', 'UI', 100);

    const reordered = service.reorder({
      sceneName: 'Game',
      layerId,
      expectedIndex: 2,
      expectedName: 'UI',
      position: 1,
    });
    expect(reordered.before.layerId).toBe(layerId);
    expect(reordered.after.layerId).toBe(layerId);
    const movedLayer = scene.getLayers().getLayer('UI');
    expect(
      service
        .list({ sceneName: 'Game' })
        .layers.find(layer => layer.name === 'UI').layerId
    ).toBe(layerId);
    expect(movedLayer.getVisibility()).toBe(false);
    expect(movedLayer.isLocked()).toBe(true);
    expect(movedLayer.getRenderingType()).toBe('3d');
    expect(movedLayer.getCameraCount()).toBe(2);
    expect(movedLayer.getEffects().getEffectsCount()).toBe(1);
    expect(
      movedLayer
        .getEffects()
        .getEffect('Sepia')
        .getEffectType()
    ).toBe('FakeSepia');

    const renamed = service.rename({
      sceneName: 'Game',
      layerId,
      expectedIndex: 1,
      expectedName: 'UI',
      newName: 'HUD',
    });
    expect(renamed.layer.layerId).toBe(layerId);
    expect(renamed.layer.name).toBe('HUD');
    expect(hud.getLayer()).toBe('HUD');
    expect(
      scene
        .getLayers()
        .getLayer('HUD')
        .getEffects()
        .getEffectsCount()
    ).toBe(1);
  });

  it('moves an instance in place and adjusts explicit/relative Z-order with conflict guards', () => {
    const board = addInstance('Board', 'Gameplay', 1, 40);
    const coin = addInstance('Coin', 'Gameplay', 5, 80);
    const beforeId = board.getPersistentUuid();
    const beforeX = board.getX();
    const uiId = service
      .list({ sceneName: 'Game' })
      .layers.find(layer => layer.name === 'UI').layerId;

    const moved = service.moveInstanceToLayer({
      sceneName: 'Game',
      instanceId: beforeId,
      targetLayerId: uiId,
      expectedLayerName: 'Gameplay',
      expectedZOrder: 1,
    });
    expect(moved.instanceRecreated).toBe(false);
    expect(board.getPersistentUuid()).toBe(beforeId);
    expect(board.getLayer()).toBe('UI');
    expect(board.getZOrder()).toBe(1);
    expect(board.getX()).toBe(beforeX);
    expect(board.getY()).toBe(beforeX + 1);
    expect(board.getAngle()).toBe(17);

    service.moveInstanceToLayer({
      sceneName: 'Game',
      instanceId: beforeId,
      targetLayerName: 'Gameplay',
      expectedLayerId: uiId,
    });
    const ordered = service.setInstanceRenderOrder({
      sceneName: 'Game',
      instanceId: beforeId,
      afterInstanceId: coin.getPersistentUuid(),
      expectedLayerName: 'Gameplay',
      expectedZOrder: 1,
    });
    expect(board.getZOrder()).toBe(6);
    expect(ordered.result).toEqual({
      determinable: true,
      relation: 'above',
      reason: 'z-order',
    });

    expect(() =>
      service.setInstanceRenderOrder({
        sceneName: 'Game',
        instanceId: beforeId,
        zOrder: 10,
        expectedZOrder: 1,
      })
    ).toThrow(
      expect.objectContaining({
        code: 'instance_z_order_conflict',
        retryable: true,
      })
    );
  });

  it('safe-deletes only with an explicit replacement and moves instances instead of dropping them', () => {
    const decoration = addInstance('Decoration', 'Gameplay', 3);
    const layers = service.list({ sceneName: 'Game' }).layers;
    const gameplayId = layers.find(layer => layer.name === 'Gameplay').layerId;
    const uiId = layers.find(layer => layer.name === 'UI').layerId;

    const result = service.remove({
      sceneName: 'Game',
      layerId: gameplayId,
      replacementLayerId: uiId,
      expectedIndex: 1,
    });
    expect(result.instancesAndReferencesMoved).toBe(true);
    expect(scene.getLayers().hasLayerNamed('Gameplay')).toBe(false);
    expect(decoration.getLayer()).toBe('UI');
    expect(decoration.getPersistentUuid()).toBeTruthy();
  });

  it('fails with structured stale layer conflicts instead of mutating a changed target', () => {
    const uiId = service
      .list({ sceneName: 'Game' })
      .layers.find(layer => layer.name === 'UI').layerId;
    scene.getLayers().moveLayer(2, 1);
    expect(() =>
      service.rename({
        sceneName: 'Game',
        layerId: uiId,
        expectedIndex: 2,
        expectedName: 'UI',
        newName: 'HUD',
      })
    ).toThrow(
      expect.objectContaining({
        code: 'layer_order_conflict',
        retryable: true,
      })
    );
    expect(scene.getLayers().hasLayerNamed('UI')).toBe(true);
  });
});
