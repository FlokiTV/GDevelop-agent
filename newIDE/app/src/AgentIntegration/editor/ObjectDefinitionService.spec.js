// @flow
import { createEventTools } from '../EventTools';
import { makeTestExtensions } from '../../fixtures/TestExtensions';
import { createMetadataDiscoveryService } from './MetadataDiscoveryService';
import { createObjectGroupService } from './ObjectGroupService';
import { createObjectDefinitionService } from './ObjectDefinitionService';

const gd: libGDevelop = global.gd;

const addObjectReferenceAction = ({
  scene,
  objectName,
}: {|
  scene: gdLayout,
  objectName: string,
|}) => {
  const event = new gd.StandardEvent();
  const action = new gd.Instruction();
  action.setType('SetX');
  action.setParametersCount(3);
  action.setParameter(0, objectName);
  action.setParameter(1, '=');
  action.setParameter(2, '10');
  event.getActions().insert(action, 0);
  scene.getEvents().insertEvent(event, scene.getEvents().getEventsCount());
  action.delete();
  event.delete();
};

describe('DX-34 ObjectDefinitionService', () => {
  let project: gdProject;
  let scene: gdLayout;
  let otherScene: gdLayout;
  let service: any;
  let groupService: any;
  let triggerUnsavedChanges: jest.Mock<any, any>;
  let forceUpdate: jest.Mock<any, any>;
  let onObjectsModifiedOutsideEditor: jest.Mock<any, any>;

  beforeAll(() => {
    makeTestExtensions(gd);
  });

  beforeEach(() => {
    // $FlowFixMe[invalid-constructor]
    project = new gd.ProjectHelper.createNewGDJSProject();
    project.resetProjectUuid();
    project.setName('DX34 Object Definitions');
    scene = project.insertNewLayout('Game', 0);
    otherScene = project.insertNewLayout('Other', 1);

    triggerUnsavedChanges = jest.fn();
    forceUpdate = jest.fn();
    onObjectsModifiedOutsideEditor = jest.fn();
    const metadataDiscoveryService = createMetadataDiscoveryService({
      project,
    });
    const eventTools = createEventTools({
      project,
      diagnosticsTools: null,
      metadataDiscoveryService,
      triggerUnsavedChanges,
      onSceneEventsModifiedOutsideEditor: jest.fn(),
      forceUpdate,
    });
    groupService = createObjectGroupService({
      project,
      eventTools,
      metadataDiscoveryService,
      triggerUnsavedChanges,
      forceUpdate,
      onObjectGroupsModifiedOutsideEditor: jest.fn(),
    });
    service = createObjectDefinitionService({
      project,
      eventTools,
      metadataDiscoveryService,
      objectPropertyService: { set: jest.fn() },
      objectGroupService: groupService,
      assetTools: {
        inspectVisualResource: jest.fn(() => null),
      },
      triggerUnsavedChanges,
      forceUpdate,
      onObjectsModifiedOutsideEditor,
    });
  });

  afterEach(() => {
    project.delete();
  });

  it('creates and resolves scene/global definitions by stable persistent identity', async () => {
    const created = await service.create({
      objectName: 'Player',
      objectType: 'Sprite',
      objectScope: 'scene',
      sceneName: 'Game',
    });
    expect(created).toMatchObject({
      created: true,
      object: {
        name: 'Player',
        type: 'Sprite',
        scope: 'scene',
        sceneName: 'Game',
        identity: {
          kind: 'persistent-uuid',
          objectId: expect.any(String),
          stableAcrossRename: true,
        },
      },
    });

    const objectId = created.object.identity.objectId;
    expect(service.get({ objectId }).object.identity.objectId).toBe(objectId);
    expect(
      service.list({ objectScope: 'scene', sceneName: 'Game' }).items
    ).toEqual([
      expect.objectContaining({
        name: 'Player',
        type: 'Sprite',
        scope: 'scene',
      }),
    ]);

    await service.create({
      objectName: 'HUD',
      objectType: 'TextObject::Text',
      objectScope: 'global',
    });
    expect(
      service.list({ objectScope: 'global' }).items.map(item => item.name)
    ).toContain('HUD');
    expect(() =>
      service.get({ objectId, objectName: 'OldPlayerName' })
    ).toThrow(
      expect.objectContaining({ code: 'stale_object_definition_target' })
    );
  });

  it('rejects namespace/type conflicts before creation', async () => {
    scene
      .getObjects()
      .getObjectGroups()
      .insertNew('Actors', 0);
    await expect(
      service.create({
        objectName: 'Actors',
        objectType: 'Sprite',
        objectScope: 'scene',
        sceneName: 'Game',
      })
    ).rejects.toMatchObject({ code: 'object_definition_name_conflict' });

    await expect(
      service.create({
        objectName: 'MissingType',
        objectType: 'FutureExtension::Missing',
        objectScope: 'scene',
        sceneName: 'Game',
      })
    ).rejects.toMatchObject({ code: 'object_definition_unknown_type' });
  });

  it('duplicates native configuration with a fresh definition identity', async () => {
    const sourceResult = await service.create({
      objectName: 'Coin',
      objectType: 'Sprite',
      objectScope: 'scene',
      sceneName: 'Game',
    });
    const source = scene.getObjects().getObject('Coin');
    const sprite = gd.asSpriteConfiguration(source.getConfiguration());
    const animation = new gd.Animation();
    animation.setName('Idle');
    animation.setDirectionsCount(1);
    sprite.getAnimations().addAnimation(animation);
    animation.delete();

    const duplicated = service.duplicate({
      objectId: sourceResult.object.identity.objectId,
      newObjectName: 'CoinCopy',
    });
    const copy = scene.getObjects().getObject('CoinCopy');
    expect(duplicated.duplicated).toBe(true);
    expect(duplicated.object.identity.objectId).not.toBe(
      sourceResult.object.identity.objectId
    );
    expect(
      gd
        .asSpriteConfiguration(copy.getConfiguration())
        .getAnimations()
        .getAnimationsCount()
    ).toBe(1);
    expect(
      gd
        .asSpriteConfiguration(copy.getConfiguration())
        .getAnimations()
        .getAnimation(0)
        .getName()
    ).toBe('Idle');
  });

  it('reports instances/groups/events and preserves all three on native rename', async () => {
    const created = await service.create({
      objectName: 'Enemy',
      objectType: 'Sprite',
      objectScope: 'scene',
      sceneName: 'Game',
    });
    groupService.create({
      groupName: 'Actors',
      groupScope: 'scene',
      sceneName: 'Game',
    });
    groupService.addMember({
      groupName: 'Actors',
      groupScope: 'scene',
      sceneName: 'Game',
      objectName: 'Enemy',
    });
    const instance = scene.getInitialInstances().insertNewInitialInstance();
    instance.setObjectName('Enemy');
    instance.setX(10);
    instance.setY(20);
    addObjectReferenceAction({ scene, objectName: 'Enemy' });

    const before = service.usages({
      objectId: created.object.identity.objectId,
    });
    expect(before.counts).toMatchObject({
      instances: 1,
      groups: 1,
      authoritativeEventReferences: 1,
    });

    const renamed = service.rename({
      objectId: created.object.identity.objectId,
      newObjectName: 'EnemyRenamed',
    });
    expect(renamed).toMatchObject({
      renamed: true,
      oldObjectName: 'Enemy',
      newObjectName: 'EnemyRenamed',
      objectId: created.object.identity.objectId,
      nativeRefactor: true,
      rewrittenReferences: {
        instances: 1,
        groups: 1,
        eventInstructions: 1,
      },
    });
    expect(scene.getObjects().hasObjectNamed('EnemyRenamed')).toBe(true);
    expect(instance.getObjectName()).toBe('EnemyRenamed');
    expect(
      groupService.get({
        groupName: 'Actors',
        groupScope: 'scene',
        sceneName: 'Game',
      }).group.members[0].objectName
    ).toBe('EnemyRenamed');
    expect(
      gd
        .asStandardEvent(scene.getEvents().getEventAt(0))
        .getActions()
        .get(0)
        .getParameter(0)
        .getPlainString()
    ).toBe('EnemyRenamed');
  });

  it('dry-runs and blocks deletion while authoritative usages remain', async () => {
    const created = await service.create({
      objectName: 'Target',
      objectType: 'Sprite',
      objectScope: 'scene',
      sceneName: 'Game',
    });
    groupService.create({
      groupName: 'Targets',
      groupScope: 'scene',
      sceneName: 'Game',
    });
    groupService.addMember({
      groupName: 'Targets',
      sceneName: 'Game',
      objectName: 'Target',
    });
    scene
      .getInitialInstances()
      .insertNewInitialInstance()
      .setObjectName('Target');
    addObjectReferenceAction({ scene, objectName: 'Target' });

    const plan = service.remove({ objectId: created.object.identity.objectId });
    expect(plan.deleted).toBe(false);
    expect(plan.plan.blockers.map(blocker => blocker.code)).toEqual(
      expect.arrayContaining([
        'object_definition_has_instances',
        'object_definition_in_groups',
        'object_definition_referenced_by_events',
      ])
    );
    expect(() =>
      service.remove({
        objectId: created.object.identity.objectId,
        dryRun: false,
      })
    ).toThrow(
      expect.objectContaining({ code: 'object_definition_delete_blocked' })
    );
    expect(scene.getObjects().hasObjectNamed('Target')).toBe(true);

    scene.getInitialInstances().removeInitialInstancesOfObject('Target');
    groupService.removeMember({
      groupName: 'Targets',
      sceneName: 'Game',
      objectName: 'Target',
    });
    scene.getEvents().removeEventAt(0);
    const deleted = service.remove({
      objectId: created.object.identity.objectId,
      dryRun: false,
    });
    expect(deleted.deleted).toBe(true);
    expect(scene.getObjects().hasObjectNamed('Target')).toBe(false);
  });

  it('promotes scene definitions to global while preserving UUID and rejects demotion', async () => {
    const created = await service.create({
      objectName: 'SharedCoin',
      objectType: 'Sprite',
      objectScope: 'scene',
      sceneName: 'Game',
    });
    const objectId = created.object.identity.objectId;

    const planned = service.moveScope({
      objectId,
      targetScope: 'global',
    });
    expect(planned).toMatchObject({
      moved: false,
      plan: {
        operation: 'promote-object-definition',
        identityPreserved: true,
        blockers: [],
      },
    });

    const moved = service.moveScope({
      objectId,
      targetScope: 'global',
      dryRun: false,
    });
    expect(moved.moved).toBe(true);
    expect(moved.object.scope).toBe('global');
    expect(moved.object.identity.objectId).toBe(objectId);
    expect(scene.getObjects().hasObjectNamed('SharedCoin')).toBe(false);
    expect(project.getObjects().hasObjectNamed('SharedCoin')).toBe(true);

    expect(() =>
      service.moveScope({
        objectId,
        targetScope: 'scene',
        sceneName: otherScene.getName(),
        dryRun: false,
      })
    ).toThrow(
      expect.objectContaining({ code: 'object_scope_transition_unsupported' })
    );
  });
});
