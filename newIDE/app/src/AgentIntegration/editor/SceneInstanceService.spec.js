// @flow
import { createLayerOrderService } from './LayerOrderService';
import { createMetadataDiscoveryService } from './MetadataDiscoveryService';
import { createObjectPropertyService } from './ObjectPropertyService';
import { createSceneInstanceService } from './SceneInstanceService';

const gd: libGDevelop = global.gd;

describe('DX-27 SceneInstanceService', () => {
  let project: gdProject;
  let scene: gdLayout;
  let layerOrderService: any;
  let objectPropertyService: any;
  let service: any;
  let triggerUnsavedChanges: jest.Mock<any, any>;
  let forceUpdate: jest.Mock<any, any>;
  let onInstancesModifiedOutsideEditor: jest.Mock<any, any>;

  const addInstance = ({
    objectName = 'Coin',
    x = 10,
    y = 20,
    z = 0,
    angle = 0,
    layer = 'Gameplay',
    zOrder = 1,
  }: any = {}) => {
    const instance = scene.getInitialInstances().insertNewInitialInstance();
    instance.setObjectName(objectName);
    instance.setX(x);
    instance.setY(y);
    instance.setZ(z);
    instance.setAngle(angle);
    instance.setLayer(layer);
    instance.setZOrder(zOrder);
    return instance;
  };

  beforeEach(() => {
    // $FlowFixMe[invalid-constructor]
    project = new gd.ProjectHelper.createNewGDJSProject();
    project.resetProjectUuid();
    project.setName('DX27 Scene Instance Test');
    scene = project.insertNewLayout('Game', 0);
    scene.getLayers().insertNewLayer('Gameplay', 1);
    scene.getLayers().insertNewLayer('UI', 2);
    scene.getObjects().insertNewObject(project, 'Sprite', 'Coin', 0);
    scene.getObjects().insertNewObject(project, 'Sprite', 'Worker', 1);

    triggerUnsavedChanges = jest.fn();
    forceUpdate = jest.fn();
    onInstancesModifiedOutsideEditor = jest.fn();

    layerOrderService = createLayerOrderService({
      project,
      triggerUnsavedChanges,
      forceUpdate,
      onInstancesModifiedOutsideEditor,
    });
    objectPropertyService = createObjectPropertyService({
      project,
      metadataDiscoveryService: createMetadataDiscoveryService({ project }),
      editorFunctionService: {
        run: jest.fn().mockResolvedValue({
          results: [{ status: 'finished', success: true, output: {} }],
          didModifyProject: true,
        }),
      },
      triggerUnsavedChanges,
      forceUpdate,
      onInstancesModifiedOutsideEditor,
    });
    service = createSceneInstanceService({
      project,
      layerOrderService,
      objectPropertyService,
      triggerUnsavedChanges,
      forceUpdate,
      onInstancesModifiedOutsideEditor,
    });
  });

  afterEach(() => {
    project.delete();
  });

  it('lists/gets stable identity plus placement, render and visibility metadata', () => {
    const instance = addInstance({
      x: 12,
      y: 24,
      z: 3,
      angle: 17,
      zOrder: 8,
    });
    instance.setOpacity(190);
    instance.setHidden(true);

    const result = service.list({ sceneName: 'Game' });
    expect(result.contract.mutationSemantics).toMatchObject({
      updateMayCreate: false,
      brushOrPointUpsertSupported: false,
      coordinates: 'absolute-scene-coordinates',
    });
    expect(result.contract.transformCapabilities).toMatchObject({
      genericScaleFactorsSupported: false,
      customSizeOverrideSupported: true,
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      instanceId: instance.getPersistentUuid(),
      selector: `instance:${instance.getPersistentUuid()}`,
      objectName: 'Coin',
      objectType: 'Sprite',
      layer: {
        name: 'Gameplay',
        index: 1,
      },
      position: { x: 12, y: 24, z: 3 },
      angle: 17,
      zOrder: 8,
      visibility: {
        hidden: true,
        opacity: 190,
        layerVisibleAtStartup: true,
        effectivelyVisibleAtStartup: false,
      },
      renderOrder: {
        deterministic: true,
        authority: 'editor-project',
      },
    });
    expect(result.items[0].instanceRevision).toMatch(/^instance-rev-/);

    const got = service.get({
      sceneName: 'Game',
      selector: result.items[0].selector,
    });
    expect(got.instance.instanceId).toBe(instance.getPersistentUuid());
    expect(got.typedProperties.command).toBe('objects.properties.describe');
    expect(got.layerMutation.command).toBe('scene.instances.move-layer');
    expect(got.zOrderMutation.command).toBe('scene.instances.set-render-order');
  });

  it('creates explicitly, transforms in place and updates without ever creating a second instance', async () => {
    const created = service.create({
      sceneName: 'Game',
      objectName: 'Coin',
      position: { x: 40, y: 50, z: 2 },
      angle: 5,
      layerName: 'Gameplay',
      zOrder: 3,
    });
    const instanceId = created.instance.instanceId;
    expect(scene.getInitialInstances().getInstancesCount()).toBe(1);
    expect(created.instanceCount).toEqual({
      before: 0,
      after: 1,
      delta: 1,
    });

    const transformed = await service.transform({
      sceneName: 'Game',
      instanceId,
      expectedInstanceRevision: created.instance.instanceRevision,
      position: { x: 140, y: 150 },
      angle: 35,
      size: { width: 64, height: 32 },
    });
    expect(transformed.identityPreserved).toBe(true);
    expect(transformed.instanceCountUnchanged).toBe(true);
    expect(transformed.after.instanceId).toBe(instanceId);
    expect(transformed.after.position).toMatchObject({ x: 140, y: 150 });
    expect(transformed.after.angle).toBe(35);
    expect(transformed.after.sizeOverride).toMatchObject({
      hasCustomSize: true,
      width: 64,
      height: 32,
    });
    expect(scene.getInitialInstances().getInstancesCount()).toBe(1);

    const updated = await service.update({
      sceneName: 'Game',
      instanceId,
      expectedInstanceRevision: transformed.after.instanceRevision,
      changes: [
        { path: 'instance.opacity', value: 123 },
        { path: 'instance.hidden', value: true },
      ],
    });
    expect(updated.created).toBe(false);
    expect(updated.identityPreserved).toBe(true);
    expect(updated.instanceCountUnchanged).toBe(true);
    expect(updated.before.instanceId).toBe(instanceId);
    expect(updated.after.instanceId).toBe(instanceId);
    expect(updated.after.visibility).toMatchObject({
      opacity: 123,
      hidden: true,
    });
    expect(scene.getInitialInstances().getInstancesCount()).toBe(1);
  });

  it('never turns update into create and reports no-match, multi-match and stale-instance conflicts', async () => {
    const first = addInstance({ objectName: 'Coin' });
    const beforeCount = scene.getInitialInstances().getInstancesCount();

    await expect(
      service.update({
        sceneName: 'Game',
        instanceId: 'does-not-exist',
        changes: [{ path: 'instance.opacity', value: 100 }],
      })
    ).rejects.toMatchObject({
      code: 'scene_instance_not_found',
      category: 'not-found',
    });
    expect(scene.getInitialInstances().getInstancesCount()).toBe(beforeCount);

    const firstSnapshot = service.get({
      sceneName: 'Game',
      instanceId: first.getPersistentUuid(),
    }).instance;
    first.setOpacity(77);
    await expect(
      service.update({
        sceneName: 'Game',
        instanceId: first.getPersistentUuid(),
        expectedInstanceRevision: firstSnapshot.instanceRevision,
        changes: [{ path: 'instance.hidden', value: true }],
      })
    ).rejects.toMatchObject({
      code: 'stale_scene_instance',
      category: 'conflict',
      retryable: true,
    });

    const instances = [first];
    for (let index = 0; index < 16; index++) {
      instances.push(addInstance({ x: 100 + index, y: 200 + index }));
    }
    const byPrefix = new Map();
    let ambiguousPrefix = null;
    for (const instance of instances) {
      const prefix = instance.getPersistentUuid().slice(0, 1);
      if (byPrefix.has(prefix)) {
        ambiguousPrefix = prefix;
        break;
      }
      byPrefix.set(prefix, instance);
    }
    expect(ambiguousPrefix).not.toBeNull();
    expect(() =>
      service.get({
        sceneName: 'Game',
        instanceId: ambiguousPrefix,
      })
    ).toThrow(
      expect.objectContaining({
        code: 'scene_instance_multi_match_conflict',
        category: 'conflict',
      })
    );
  });

  it('keeps placement paths out of generic update and composes DX-26 for layer/Z-order', async () => {
    const instance = addInstance({ layer: 'Gameplay', zOrder: 2 });
    const initial = service.get({
      sceneName: 'Game',
      instanceId: instance.getPersistentUuid(),
    }).instance;

    await expect(
      service.update({
        sceneName: 'Game',
        instanceId: initial.instanceId,
        changes: [{ path: 'instance.x', value: 200 }],
      })
    ).rejects.toMatchObject({
      code: 'unsupported_scene_instance_update_path',
      details: expect.objectContaining({
        transformCommand: 'scene.instances.transform',
        layerCommand: 'scene.instances.move-layer',
        zOrderCommand: 'scene.instances.set-render-order',
      }),
    });

    const uiLayer = layerOrderService
      .list({ sceneName: 'Game' })
      .layers.find(layer => layer.name === 'UI');
    layerOrderService.moveInstanceToLayer({
      sceneName: 'Game',
      instanceId: initial.instanceId,
      targetLayerId: uiLayer.layerId,
      expectedLayerName: 'Gameplay',
    });
    layerOrderService.setInstanceRenderOrder({
      sceneName: 'Game',
      instanceId: initial.instanceId,
      zOrder: 90,
      expectedLayerName: 'UI',
      expectedZOrder: 2,
    });

    const after = service.get({
      sceneName: 'Game',
      instanceId: initial.instanceId,
    }).instance;
    expect(after.instanceId).toBe(initial.instanceId);
    expect(after.layer.name).toBe('UI');
    expect(after.zOrder).toBe(90);
  });

  it('duplicates with a new identity and guarded delete rejects stale entity revisions', () => {
    const source = addInstance({ x: 5, y: 6, angle: 9 });
    const sourceSnapshot = service.get({
      sceneName: 'Game',
      instanceId: source.getPersistentUuid(),
    }).instance;

    const cloned = service.duplicate({
      sceneName: 'Game',
      instanceId: sourceSnapshot.instanceId,
      expectedInstanceRevision: sourceSnapshot.instanceRevision,
      offset: { x: 10, y: -2 },
      angleOffset: 6,
    });
    expect(cloned.newIdentity).toBe(true);
    expect(cloned.duplicate.instanceId).not.toBe(sourceSnapshot.instanceId);
    expect(cloned.duplicate.position).toMatchObject({ x: 15, y: 4 });
    expect(cloned.duplicate.angle).toBe(15);
    expect(scene.getInitialInstances().getInstancesCount()).toBe(2);

    expect(() =>
      service.remove({
        sceneName: 'Game',
        instanceId: cloned.duplicate.instanceId,
      })
    ).toThrow(
      expect.objectContaining({
        code: 'missing_instance_revision',
      })
    );

    const staleRevision = cloned.duplicate.instanceRevision;
    const cloneInstance = scene.getInitialInstances().getInstancesCount();
    expect(cloneInstance).toBe(2);
    const currentClone = service.get({
      sceneName: 'Game',
      instanceId: cloned.duplicate.instanceId,
    }).instance;
    expect(currentClone.instanceRevision).toBe(staleRevision);

    // Mutate outside the service to emulate another editor/agent write.
    const matching = [];
    const functor = new gd.InitialInstanceJSFunctor();
    // $FlowFixMe[cannot-write]
    functor.invoke = ptr => {
      const candidate = gd.wrapPointer(ptr, gd.InitialInstance);
      if (candidate.getPersistentUuid() === cloned.duplicate.instanceId) {
        matching.push(candidate);
      }
    };
    scene.getInitialInstances().iterateOverInstances(functor);
    functor.delete();
    matching[0].setOpacity(11);

    expect(() =>
      service.remove({
        sceneName: 'Game',
        instanceId: cloned.duplicate.instanceId,
        expectedInstanceRevision: staleRevision,
      })
    ).toThrow(
      expect.objectContaining({
        code: 'stale_scene_instance',
        retryable: true,
      })
    );

    const refreshed = service.get({
      sceneName: 'Game',
      instanceId: cloned.duplicate.instanceId,
    }).instance;
    const deleted = service.remove({
      sceneName: 'Game',
      instanceId: refreshed.instanceId,
      expectedInstanceRevision: refreshed.instanceRevision,
    });
    expect(deleted.deleted).toBe(true);
    expect(scene.getInitialInstances().getInstancesCount()).toBe(1);
  });

  it('diagnoses sidebar-style duplicates and cleans them deterministically through bulk dry-run/apply', () => {
    const canonical = addInstance({ x: 100, y: 200, angle: 10 });
    const source = service.get({
      sceneName: 'Game',
      instanceId: canonical.getPersistentUuid(),
    }).instance;
    service.duplicate({
      sceneName: 'Game',
      instanceId: source.instanceId,
    });
    service.duplicate({
      sceneName: 'Game',
      instanceId: source.instanceId,
    });
    addInstance({ objectName: 'Worker', x: 100, y: 200, angle: 10 });
    expect(scene.getInitialInstances().getInstancesCount()).toBe(4);

    const diagnosed = service.diagnoseDuplicates({
      sceneName: 'Game',
      positionTolerance: 0,
      zTolerance: 0,
      angleTolerance: 0,
    });
    expect(diagnosed.autoDelete).toBe(false);
    expect(diagnosed.groupCount).toBe(1);
    const group = diagnosed.likelyDuplicateGroups[0];
    expect(group.objectName).toBe('Coin');
    expect(group.members).toHaveLength(3);
    expect(group.duplicateInstanceIds).toHaveLength(2);
    expect(group.deterministicCleanupSuggestion).toMatchObject({
      keepInstanceId: group.canonicalInstanceId,
      deleteInstanceIds: group.duplicateInstanceIds,
      command: 'scene.instances.bulk-delete',
      requiresDryRun: true,
    });

    const dryRun = service.bulkDelete({
      sceneName: 'Game',
      selection: { instanceIds: group.duplicateInstanceIds },
      dryRun: true,
    });
    expect(dryRun.dryRun).toBe(true);
    expect(dryRun.wouldDelete).toBe(2);
    expect(scene.getInitialInstances().getInstancesCount()).toBe(4);

    const applied = service.bulkDelete({
      sceneName: 'Game',
      selection: { instanceIds: group.duplicateInstanceIds },
      dryRun: false,
      expectedSelectionRevision: dryRun.selectionRevision,
    });
    expect(applied.deletedCount).toBe(2);
    expect(scene.getInitialInstances().getInstancesCount()).toBe(2);

    const remainingCoins = service.list({
      sceneName: 'Game',
      selection: { objectNames: ['Coin'] },
    });
    expect(remainingCoins.total).toBe(1);
    expect(remainingCoins.items[0].instanceId).toBe(group.canonicalInstanceId);
  });

  it('bulk update preflights every target, applies only with matching selection revision, and rejects target drift', async () => {
    const first = addInstance({ x: 10, y: 10 });
    addInstance({ x: 20, y: 20 });
    addInstance({ objectName: 'Worker', x: 30, y: 30 });

    const dryRun = await service.bulkUpdate({
      sceneName: 'Game',
      selection: { objectNames: ['Coin'] },
      changes: [{ path: 'instance.opacity', value: 111 }],
      dryRun: true,
    });
    expect(dryRun.dryRun).toBe(true);
    expect(dryRun.summary.count).toBe(2);
    expect(dryRun.preflight).toHaveLength(2);

    const applied = await service.bulkUpdate({
      sceneName: 'Game',
      selection: { objectNames: ['Coin'] },
      changes: [{ path: 'instance.opacity', value: 111 }],
      dryRun: false,
      expectedSelectionRevision: dryRun.selectionRevision,
    });
    expect(applied.updatedCount).toBe(2);
    expect(applied.instanceCountUnchanged).toBe(true);
    expect(
      service
        .list({
          sceneName: 'Game',
          selection: { objectNames: ['Coin'] },
        })
        .items.every(item => item.visibility.opacity === 111)
    ).toBe(true);

    const secondDryRun = await service.bulkUpdate({
      sceneName: 'Game',
      selection: { objectNames: ['Coin'] },
      changes: [{ path: 'instance.hidden', value: true }],
      dryRun: true,
    });
    first.setOpacity(112);

    await expect(
      service.bulkUpdate({
        sceneName: 'Game',
        selection: { objectNames: ['Coin'] },
        changes: [{ path: 'instance.hidden', value: true }],
        dryRun: false,
        expectedSelectionRevision: secondDryRun.selectionRevision,
      })
    ).rejects.toMatchObject({
      code: 'stale_scene_instance_selection',
      category: 'conflict',
      retryable: true,
    });
  });

  it('requires explicit bulk selection and never interprets an empty selector as all', () => {
    addInstance();
    expect(() =>
      service.bulkDelete({
        sceneName: 'Game',
        selection: {},
        dryRun: true,
      })
    ).toThrow(
      expect.objectContaining({
        code: 'invalid_bulk_scene_instance_selection',
      })
    );
    expect(scene.getInitialInstances().getInstancesCount()).toBe(1);
  });
});
