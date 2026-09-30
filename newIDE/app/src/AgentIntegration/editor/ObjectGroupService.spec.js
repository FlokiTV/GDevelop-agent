// @flow
import { createEventTools } from '../EventTools';
import { createMetadataDiscoveryService } from './MetadataDiscoveryService';
import { createObjectGroupService } from './ObjectGroupService';
import { makeTestExtensions } from '../../fixtures/TestExtensions';

const gd: libGDevelop = global.gd;

const addObjectReferenceAction = ({
  scene,
  objectOrGroupName,
}: {|
  scene: gdLayout,
  objectOrGroupName: string,
|}) => {
  const event = new gd.StandardEvent();
  const action = new gd.Instruction();
  action.setType('SetX');
  action.setParametersCount(3);
  action.setParameter(0, objectOrGroupName);
  action.setParameter(1, '=');
  action.setParameter(2, '10');
  event.getActions().insert(action, 0);
  scene.getEvents().insertEvent(event, scene.getEvents().getEventsCount());
  action.delete();
  event.delete();
};

describe('DX-31 ObjectGroupService', () => {
  let project: gdProject;
  let scene: gdLayout;
  let service: any;
  let metadataDiscoveryService: any;
  let triggerUnsavedChanges: jest.Mock<any, any>;
  let forceUpdate: jest.Mock<any, any>;
  let onObjectGroupsModifiedOutsideEditor: jest.Mock<any, any>;

  beforeAll(() => {
    makeTestExtensions(gd);
  });

  beforeEach(() => {
    // $FlowFixMe[invalid-constructor]
    project = new gd.ProjectHelper.createNewGDJSProject();
    project.resetProjectUuid();
    project.setName('DX31 Object Groups');
    scene = project.insertNewLayout('Game', 0);
    scene.getObjects().insertNewObject(project, 'Sprite', 'Player', 0);
    scene.getObjects().insertNewObject(project, 'Sprite', 'Enemy', 1);
    project.getObjects().insertNewObject(project, 'TextObject::Text', 'HUD', 0);

    triggerUnsavedChanges = jest.fn();
    forceUpdate = jest.fn();
    onObjectGroupsModifiedOutsideEditor = jest.fn();
    metadataDiscoveryService = createMetadataDiscoveryService({ project });
    const eventTools = createEventTools({
      project,
      diagnosticsTools: null,
      metadataDiscoveryService,
      triggerUnsavedChanges,
      onSceneEventsModifiedOutsideEditor: jest.fn(),
      forceUpdate,
    });
    service = createObjectGroupService({
      project,
      eventTools,
      metadataDiscoveryService,
      triggerUnsavedChanges,
      forceUpdate,
      onObjectGroupsModifiedOutsideEditor,
    });
  });

  afterEach(() => {
    project.delete();
  });

  it('creates, lists, reorders and reverse-resolves typed group members', () => {
    const created = service.create({
      groupName: 'Actors',
      groupScope: 'scene',
      sceneName: 'Game',
    });
    expect(created.group).toMatchObject({
      name: 'Actors',
      scope: 'scene',
      sceneName: 'Game',
      memberCount: 0,
      identity: {
        kind: 'canonical-scope-name',
        nativePersistentUuid: false,
      },
    });

    service.addMember({
      groupName: 'Actors',
      groupScope: 'scene',
      sceneName: 'Game',
      objectName: 'Player',
    });
    service.addMember({
      groupName: 'Actors',
      groupScope: 'scene',
      sceneName: 'Game',
      objectName: 'HUD',
    });
    service.addMember({
      groupName: 'Actors',
      groupScope: 'scene',
      sceneName: 'Game',
      objectName: 'Enemy',
    });

    const moved = service.moveMember({
      groupName: 'Actors',
      groupScope: 'scene',
      sceneName: 'Game',
      objectName: 'Enemy',
      toIndex: 0,
    });
    expect(moved.group.members).toEqual([
      expect.objectContaining({
        position: 0,
        objectName: 'Enemy',
        objectType: 'Sprite',
        objectScope: 'scene',
      }),
      expect.objectContaining({
        position: 1,
        objectName: 'Player',
        objectScope: 'scene',
      }),
      expect.objectContaining({
        position: 2,
        objectName: 'HUD',
        objectType: 'TextObject::Text',
        objectScope: 'global',
      }),
    ]);

    const reverse = service.groupsForObject({
      objectName: 'HUD',
      sceneName: 'Game',
      groupScope: 'scene',
    });
    expect(reverse.count).toBe(1);
    expect(reverse.items[0].name).toBe('Actors');

    const listed = service.list({ sceneName: 'Game', groupScope: 'all' });
    expect(listed.items.map(item => item.name)).toContain('Actors');
    expect(onObjectGroupsModifiedOutsideEditor).toHaveBeenCalledWith({ scene });
  });

  it('rejects namespace collisions, duplicates and invalid members with structured codes', () => {
    expect(() =>
      service.create({
        groupName: 'Player',
        groupScope: 'scene',
        sceneName: 'Game',
      })
    ).toThrow(expect.objectContaining({ code: 'object_group_name_conflict' }));

    service.create({
      groupName: 'Actors',
      groupScope: 'scene',
      sceneName: 'Game',
    });
    service.addMember({
      groupName: 'Actors',
      sceneName: 'Game',
      objectName: 'Player',
    });
    expect(() =>
      service.addMember({
        groupName: 'Actors',
        sceneName: 'Game',
        objectName: 'Player',
      })
    ).toThrow(
      expect.objectContaining({ code: 'object_group_member_already_exists' })
    );
    expect(() =>
      service.addMember({
        groupName: 'Actors',
        sceneName: 'Game',
        objectName: 'Missing',
      })
    ).toThrow(
      expect.objectContaining({ code: 'object_group_member_not_found' })
    );
  });

  it('maps object-typed Event Sheet references to group usages and preserves them on native rename', () => {
    service.create({
      groupName: 'Actors',
      groupScope: 'scene',
      sceneName: 'Game',
    });
    service.addMember({
      groupName: 'Actors',
      sceneName: 'Game',
      objectName: 'Player',
    });
    addObjectReferenceAction({ scene, objectOrGroupName: 'Actors' });

    const before = service.usages({
      groupName: 'Actors',
      groupScope: 'scene',
      sceneName: 'Game',
    });
    expect(before.usages.authoritativeReferences).toEqual([
      expect.objectContaining({
        referenceKind: 'object-or-object-group-parameter',
        groupEntityKind: 'object-group',
        instructionType: 'SetX',
        parameterIndex: 0,
        parameterValue: 'Actors',
        authoritative: true,
        eventHandle: expect.stringMatching(/^event:/),
        instructionHandle: expect.stringMatching(/^action:/),
      }),
    ]);

    const renamed = service.rename({
      groupName: 'Actors',
      groupScope: 'scene',
      sceneName: 'Game',
      newGroupName: 'Units',
    });
    expect(renamed).toMatchObject({
      renamed: true,
      oldGroupName: 'Actors',
      newGroupName: 'Units',
      rewrittenReferences: 1,
      nativeRefactor: true,
    });
    expect(
      gd
        .asStandardEvent(scene.getEvents().getEventAt(0))
        .getActions()
        .get(0)
        .getParameter(0)
        .getPlainString()
    ).toBe('Units');
    expect(
      service.usages({
        groupName: 'Units',
        groupScope: 'scene',
        sceneName: 'Game',
      }).usages.authoritativeReferenceCount
    ).toBe(1);
  });

  it('dry-runs and blocks deletion of a referenced group, then deletes cleanly after reference removal', () => {
    service.create({
      groupName: 'Targets',
      groupScope: 'scene',
      sceneName: 'Game',
    });
    service.addMember({
      groupName: 'Targets',
      sceneName: 'Game',
      objectName: 'Enemy',
    });
    addObjectReferenceAction({ scene, objectOrGroupName: 'Targets' });
    triggerUnsavedChanges.mockClear();

    const plan = service.remove({
      groupName: 'Targets',
      groupScope: 'scene',
      sceneName: 'Game',
    });
    expect(plan).toMatchObject({
      deleted: false,
      plan: {
        blockers: [
          expect.objectContaining({
            code: 'object_group_in_use',
            referenceCount: 1,
          }),
        ],
      },
    });
    expect(triggerUnsavedChanges).not.toHaveBeenCalled();

    expect(() =>
      service.remove({
        groupName: 'Targets',
        groupScope: 'scene',
        sceneName: 'Game',
        dryRun: false,
      })
    ).toThrow(expect.objectContaining({ code: 'object_group_delete_blocked' }));
    expect(
      scene
        .getObjects()
        .getObjectGroups()
        .has('Targets')
    ).toBe(true);

    scene.getEvents().removeEventAt(0);
    const deleted = service.remove({
      groupName: 'Targets',
      groupScope: 'scene',
      sceneName: 'Game',
      dryRun: false,
    });
    expect(deleted.deleted).toBe(true);
    expect(
      scene
        .getObjects()
        .getObjectGroups()
        .has('Targets')
    ).toBe(false);
  });

  it('supports global groups and rejects scene-local members in global scope', () => {
    const created = service.create({
      groupName: 'GlobalUI',
      groupScope: 'global',
    });
    expect(created.group.scope).toBe('global');

    service.addMember({
      groupName: 'GlobalUI',
      groupScope: 'global',
      objectName: 'HUD',
    });
    expect(
      service.get({ groupName: 'GlobalUI', groupScope: 'global' }).group.members
    ).toEqual([
      expect.objectContaining({
        objectName: 'HUD',
        objectScope: 'global',
      }),
    ]);
    expect(() =>
      service.addMember({
        groupName: 'GlobalUI',
        groupScope: 'global',
        objectName: 'Player',
      })
    ).toThrow(
      expect.objectContaining({ code: 'object_group_member_not_found' })
    );
  });
});
