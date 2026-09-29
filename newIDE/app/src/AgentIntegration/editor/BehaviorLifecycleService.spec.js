// @flow
import { createBehaviorLifecycleService } from './BehaviorLifecycleService';
import { createMetadataDiscoveryService } from './MetadataDiscoveryService';
import { createObjectPropertyService } from './ObjectPropertyService';
import { makeTestExtensions } from '../../fixtures/TestExtensions';

const gd: libGDevelop = global.gd;

describe('DX-29 BehaviorLifecycleService', () => {
  let project: gdProject;
  let scene: gdLayout;
  let service: any;
  let objectPropertyService: any;
  let editorFunctionService: any;
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
    project.setName('DX29 Behavior Lifecycle Test');
    scene = project.insertNewLayout('Game', 0);
    scene.getObjects().insertNewObject(project, 'Sprite', 'Hero', 0);
    scene.getObjects().insertNewObject(project, 'TextObject::Text', 'Label', 1);
    scene
      .getObjects()
      .insertNewObject(project, 'FakeScene3D::Model3DObject', 'Model', 2);

    editorFunctionService = {
      run: jest.fn().mockResolvedValue({
        results: [
          {
            status: 'finished',
            success: true,
            output: { success: true },
          },
        ],
        didModifyProject: true,
      }),
    };
    triggerUnsavedChanges = jest.fn();
    forceUpdate = jest.fn();
    onObjectsModifiedOutsideEditor = jest.fn();

    const metadataDiscoveryService = createMetadataDiscoveryService({
      project,
    });
    objectPropertyService = createObjectPropertyService({
      project,
      metadataDiscoveryService,
      editorFunctionService,
      triggerUnsavedChanges,
      forceUpdate,
      onInstancesModifiedOutsideEditor: jest.fn(),
    });
    service = createBehaviorLifecycleService({
      project,
      metadataDiscoveryService,
      objectPropertyService,
      triggerUnsavedChanges,
      forceUpdate,
      onObjectsModifiedOutsideEditor,
    });
  });

  afterEach(() => {
    project.delete();
  });

  it('lists attached behaviors/capabilities with DX-24 property tracing and operation discovery', () => {
    const result = service.list({
      sceneName: 'Game',
      objectName: 'Hero',
    });
    expect(result.target).toMatchObject({
      objectName: 'Hero',
      objectType: 'Sprite',
      objectScope: 'scene',
      sceneName: 'Game',
    });

    const resizable = result.items.find(
      item => item.type === 'ResizableCapability::ResizableBehavior'
    );
    expect(resizable).toMatchObject({
      capability: true,
      defaultBehavior: true,
      capabilityInterface: expect.objectContaining({
        kind: 'hidden-behavior-capability',
        providedByObjectType: true,
      }),
      propertyDiscovery: expect.objectContaining({
        command: 'objects.properties.describe',
      }),
      propertyMutation: {
        command: 'objects.behaviors.update',
        delegatesTo: 'objects.properties.set',
      },
      operationDiscovery: expect.objectContaining({
        command: 'events.instructions.search',
      }),
    });
    expect(result.capabilityInterfaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          behaviorType: 'ResizableCapability::ResizableBehavior',
        }),
      ])
    );

    const described = service.describe({
      sceneName: 'Game',
      objectName: 'Hero',
      behaviorName: resizable.name,
    });
    expect(described.behavior.operations.discovery).toMatchObject({
      command: 'events.instructions.search',
      arguments: {
        behaviorType: 'ResizableCapability::ResizableBehavior',
      },
    });
    expect(
      described.behavior.operations.actions.some(operation =>
        /SetWidth$/.test(operation.id)
      )
    ).toBe(true);
    expect(
      described.behavior.operations.actions.some(operation =>
        /SetHeight$/.test(operation.id)
      )
    ).toBe(true);
  });

  it('enumerates registry-backed availability and rejects incompatible behavior before mutation', () => {
    const onSprite = service.available({
      sceneName: 'Game',
      objectName: 'Hero',
      query: 'Fake animated behavior',
      compatibleOnly: false,
      includeCapabilities: true,
      limit: 100,
    });
    const animatedOnSprite = onSprite.items.find(
      item => item.type === 'FakeAnimatedBehavior::AnimatedBehavior'
    );
    expect(animatedOnSprite).toMatchObject({
      compatibility: expect.objectContaining({
        nativeCompatible: true,
        compatible: true,
        attachable: true,
      }),
    });

    const onModel = service.available({
      sceneName: 'Game',
      objectName: 'Model',
      query: 'Fake animated behavior',
      compatibleOnly: false,
      includeCapabilities: true,
      limit: 100,
    });
    const animatedOnModel = onModel.items.find(
      item => item.type === 'FakeAnimatedBehavior::AnimatedBehavior'
    );
    expect(animatedOnModel.compatibility.nativeCompatible).toBe(false);
    expect(animatedOnModel.compatibility.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'missing_required_capability',
          requiredBehaviorType: 'AnimatableCapability::AnimatableBehavior',
        }),
      ])
    );

    const beforeNames = scene
      .getObjects()
      .getObject('Hero')
      .getAllBehaviorNames()
      .toJSArray();
    expect(() =>
      service.add({
        sceneName: 'Game',
        objectName: 'Hero',
        behaviorType: 'FakeTextBehavior::FakeTextBehavior',
      })
    ).toThrow(
      expect.objectContaining({
        code: 'behavior_incompatible_with_object',
        field: 'behaviorType',
      })
    );
    expect(
      scene
        .getObjects()
        .getObject('Hero')
        .getAllBehaviorNames()
        .toJSArray()
    ).toEqual(beforeNames);
    expect(triggerUnsavedChanges).not.toHaveBeenCalled();
  });

  it('adds a compatible behavior with unique-name validation and delegates typed update to DX-24', async () => {
    const added = service.add({
      sceneName: 'Game',
      objectName: 'Label',
      behaviorType: 'FakeBehavior::FakeBehavior',
      behaviorName: 'GameplayBehavior',
    });
    expect(added).toMatchObject({
      added: true,
      alreadyAttached: false,
      behavior: {
        name: 'GameplayBehavior',
        type: 'FakeBehavior::FakeBehavior',
      },
    });
    expect(
      scene
        .getObjects()
        .getObject('Label')
        .hasBehaviorNamed('GameplayBehavior')
    ).toBe(true);
    expect(triggerUnsavedChanges).toHaveBeenCalledTimes(1);
    expect(forceUpdate).toHaveBeenCalledTimes(1);
    expect(onObjectsModifiedOutsideEditor).toHaveBeenCalledWith({
      scene,
      isNewObjectTypeUsed: false,
    });

    expect(() =>
      service.add({
        sceneName: 'Game',
        objectName: 'Label',
        behaviorType: 'FakeTextBehavior::FakeTextBehavior',
        behaviorName: 'GameplayBehavior',
      })
    ).toThrow(
      expect.objectContaining({
        code: 'behavior_name_already_exists',
        field: 'behaviorName',
      })
    );

    const described = service.describe({
      sceneName: 'Game',
      objectName: 'Label',
      behaviorName: 'GameplayBehavior',
    });
    const booleanProperty = described.behavior.properties.find(
      property => property.valueType === 'boolean'
    );
    expect(booleanProperty).toBeTruthy();

    const updated = await service.update({
      sceneName: 'Game',
      objectName: 'Label',
      behaviorName: 'GameplayBehavior',
      changes: [{ path: booleanProperty.path, value: false }],
    });
    expect(updated).toMatchObject({
      updated: true,
      delegatedTo: 'objects.properties.set',
    });
    expect(editorFunctionService.run).toHaveBeenCalledWith(
      expect.objectContaining({
        calls: [
          {
            name: 'change_behavior_property',
            arguments: expect.objectContaining({
              scene_name: 'Game',
              object_name: 'Label',
              behavior_name: 'GameplayBehavior',
              changed_properties: [
                {
                  property_name: booleanProperty.name,
                  new_value: 'false',
                },
              ],
            }),
          },
        ],
      })
    );
  });

  it('treats hidden capabilities as object-type-managed and idempotently resolves an existing capability', () => {
    const hero = scene.getObjects().getObject('Hero');
    const resizableName = hero
      .getAllBehaviorNames()
      .toJSArray()
      .find(
        name =>
          hero.getBehavior(name).getTypeName() ===
          'ResizableCapability::ResizableBehavior'
      );
    expect(resizableName).toBeTruthy();

    const result = service.add({
      sceneName: 'Game',
      objectName: 'Hero',
      behaviorType: 'ResizableCapability::ResizableBehavior',
      behaviorName: resizableName,
    });
    expect(result).toMatchObject({
      added: false,
      alreadyAttached: true,
      behavior: expect.objectContaining({
        name: resizableName,
        type: 'ResizableCapability::ResizableBehavior',
        capability: true,
      }),
    });
    expect(triggerUnsavedChanges).not.toHaveBeenCalled();

    hero.removeBehavior(resizableName);
    expect(
      hero
        .getAllBehaviorNames()
        .toJSArray()
        .some(
          name =>
            hero.getBehavior(name).getTypeName() ===
            'ResizableCapability::ResizableBehavior'
        )
    ).toBe(false);
    const restored = service.add({
      sceneName: 'Game',
      objectName: 'Hero',
      behaviorType: 'ResizableCapability::ResizableBehavior',
      behaviorName: resizableName,
    });
    expect(restored).toMatchObject({
      added: true,
      compatibility: expect.objectContaining({
        capability: true,
        providedByObjectType: true,
        attachable: true,
      }),
      behavior: expect.objectContaining({
        name: resizableName,
        type: 'ResizableCapability::ResizableBehavior',
        defaultBehavior: true,
        capability: true,
      }),
    });
    expect(triggerUnsavedChanges).toHaveBeenCalledTimes(1);

    expect(() =>
      service.add({
        sceneName: 'Game',
        objectName: 'Model',
        behaviorType: 'ResizableCapability::ResizableBehavior',
        behaviorName: 'Resizable',
      })
    ).toThrow(
      expect.objectContaining({
        code: 'capability_managed_by_object_type',
        field: 'behaviorType',
      })
    );
  });

  it('dry-runs removal with dependent behavior diagnostics and protects default capabilities', () => {
    const model = scene.getObjects().getObject('Model');
    const base3DName = model
      .getAllBehaviorNames()
      .toJSArray()
      .find(
        name =>
          model.getBehavior(name).getTypeName() ===
          'FakeScene3D::Base3DBehavior'
      );
    expect(base3DName).toBeTruthy();

    const physics = service.add({
      sceneName: 'Game',
      objectName: 'Model',
      behaviorType: 'FakePhysics3D::Physics3DBehavior',
      behaviorName: 'Physics3D',
    });
    expect(physics.added).toBe(true);

    const preflight = service.remove({
      sceneName: 'Game',
      objectName: 'Model',
      behaviorName: base3DName,
    });
    expect(preflight.removed).toBe(false);
    expect(preflight.preflight.dependentBehaviorNames).toContain('Physics3D');
    expect(preflight.preflight.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'default_behavior_cannot_be_removed',
        }),
        expect.objectContaining({
          code: 'behavior_has_dependents',
          dependentBehaviorNames: expect.arrayContaining(['Physics3D']),
        }),
      ])
    );

    expect(() =>
      service.remove({
        sceneName: 'Game',
        objectName: 'Model',
        behaviorName: base3DName,
        dryRun: false,
        cascadeDependents: true,
      })
    ).toThrow(
      expect.objectContaining({
        code: 'behavior_remove_blocked',
      })
    );
    expect(model.hasBehaviorNamed(base3DName)).toBe(true);
    expect(model.hasBehaviorNamed('Physics3D')).toBe(true);
  });

  it('blocks instance override loss by default and removes it only with explicit opt-in', () => {
    service.add({
      sceneName: 'Game',
      objectName: 'Hero',
      behaviorType: 'FakeBehavior::FakeBehavior',
      behaviorName: 'CustomFake',
    });
    const instance = scene.getInitialInstances().insertNewInitialInstance();
    instance.setObjectName('Hero');
    instance.addNewBehaviorOverriding(
      project,
      'FakeBehavior::FakeBehavior',
      'CustomFake'
    );

    const dryRun = service.remove({
      sceneName: 'Game',
      objectName: 'Hero',
      behaviorName: 'CustomFake',
    });
    expect(dryRun.preflight.instanceOverrides).toEqual([
      expect.objectContaining({
        sceneName: 'Game',
        instanceId: instance.getPersistentUuid(),
        behaviorName: 'CustomFake',
      }),
    ]);
    expect(dryRun.preflight.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'behavior_has_instance_overrides',
        }),
      ])
    );

    expect(() =>
      service.remove({
        sceneName: 'Game',
        objectName: 'Hero',
        behaviorName: 'CustomFake',
        dryRun: false,
      })
    ).toThrow(
      expect.objectContaining({
        code: 'behavior_remove_blocked',
      })
    );

    const removed = service.remove({
      sceneName: 'Game',
      objectName: 'Hero',
      behaviorName: 'CustomFake',
      dryRun: false,
      removeInstanceOverrides: true,
    });
    expect(removed.removed).toBe(true);
    expect(
      scene
        .getObjects()
        .getObject('Hero')
        .hasBehaviorNamed('CustomFake')
    ).toBe(false);
    expect(instance.hasBehaviorOverridingNamed('CustomFake')).toBe(false);
  });
});
