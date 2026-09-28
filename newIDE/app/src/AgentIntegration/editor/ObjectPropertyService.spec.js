// @flow
import { createMetadataDiscoveryService } from './MetadataDiscoveryService';
import { createObjectPropertyService } from './ObjectPropertyService';
import { makeTestExtensions } from '../../fixtures/TestExtensions';

const gd: libGDevelop = global.gd;

describe('AgentIntegration ObjectPropertyService', () => {
  let project: gdProject;
  let scene: gdLayout;
  let service: any;
  let editorFunctionService: any;
  let triggerUnsavedChanges: jest.Mock<any, any>;
  let forceUpdate: jest.Mock<any, any>;
  let onInstancesModifiedOutsideEditor: jest.Mock<any, any>;

  beforeAll(() => {
    makeTestExtensions(gd);
  });

  beforeEach(() => {
    // $FlowFixMe[invalid-constructor]
    project = new gd.ProjectHelper.createNewGDJSProject();
    project.resetProjectUuid();
    project.setName('Object Property Test');
    scene = project.insertNewLayout('Game', 0);
    const labelObject = scene
      .getObjects()
      .insertNewObject(project, 'TextObject::Text', 'Label', 0);
    labelObject.addNewBehavior(
      project,
      'FakeBehavior::FakeBehavior',
      'TypedBehavior'
    );
    scene.getObjects().insertNewObject(project, 'Sprite', 'Hero', 1);
    scene
      .getObjects()
      .insertNewObject(
        project,
        'PanelSpriteObject::PanelSprite',
        'NinePatch',
        2
      );
    const resizableObject = scene
      .getObjects()
      .insertNewObject(
        project,
        'TiledSpriteObject::TiledSprite',
        'ResizableTile',
        3
      );
    scene
      .getObjects()
      .insertNewObject(project, 'FakeTextInput::TextInput', 'CustomInput', 4);
    const resizableBehaviorName = resizableObject
      .getAllBehaviorNames()
      .toJSArray()
      .find(
        name =>
          resizableObject.getBehavior(name).getTypeName() ===
          'ResizableCapability::ResizableBehavior'
      );
    if (!resizableBehaviorName) {
      resizableObject.addNewBehavior(
        project,
        'ResizableCapability::ResizableBehavior',
        'Resizable'
      );
    }

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
    onInstancesModifiedOutsideEditor = jest.fn();
    service = createObjectPropertyService({
      project,
      metadataDiscoveryService: createMetadataDiscoveryService({ project }),
      editorFunctionService,
      triggerUnsavedChanges,
      forceUpdate,
      onInstancesModifiedOutsideEditor,
    });
  });

  afterEach(() => {
    project.delete();
  });

  it('describes live object-definition properties with typed paths and legacy changed_properties contract', () => {
    const result = service.describe({
      targetKind: 'object-definition',
      sceneName: 'Game',
      objectName: 'Label',
    });

    expect(result.target).toMatchObject({
      kind: 'object-definition',
      objectName: 'Label',
      objectType: 'TextObject::Text',
      objectScope: 'scene',
      sceneName: 'Game',
    });
    expect(result.schemaSource).toBe('connected-build-live-descriptors');
    expect(result.properties).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'text',
          path: 'configuration.text',
          valueType: 'string',
          writable: true,
          mutation: expect.objectContaining({
            command: 'objects.properties.set',
            backend: expect.objectContaining({
              command: 'editor.functions.change-object-property',
              changedPropertiesField: 'changed_properties',
              propertyName: 'text',
            }),
          }),
        }),
      ])
    );
    expect(result.mutationContract.legacyChangedProperties.shape).toMatchObject(
      {
        type: 'array',
        items: expect.objectContaining({
          required: ['property_name', 'new_value'],
        }),
      }
    );
  });

  it('covers common visual object schemas from live descriptors without static per-type tables', () => {
    const text = service.describe({
      targetKind: 'object-definition',
      sceneName: 'Game',
      objectName: 'Label',
    });
    expect(text.properties).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'configuration.text',
          valueType: 'string',
          writable: true,
        }),
        expect.objectContaining({
          path: 'configuration.font',
          descriptorType: 'resource',
          valueType: 'string',
          constraints: expect.objectContaining({
            extraInfo: expect.arrayContaining(['font']),
          }),
        }),
        expect.objectContaining({
          path: 'configuration.textAlignment',
          valueType: 'string',
          constraints: expect.objectContaining({
            choices: [
              { value: 'left', label: expect.any(String) },
              { value: 'center', label: expect.any(String) },
              { value: 'right', label: expect.any(String) },
            ],
          }),
        }),
      ])
    );

    const tiled = service.describe({
      targetKind: 'object-definition',
      sceneName: 'Game',
      objectName: 'ResizableTile',
    });
    expect(tiled.properties).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'configuration.width',
          valueType: 'number',
          writable: true,
        }),
        expect.objectContaining({
          path: 'configuration.height',
          valueType: 'number',
          writable: true,
        }),
      ])
    );

    const panel = service.describe({
      targetKind: 'object-definition',
      sceneName: 'Game',
      objectName: 'NinePatch',
    });
    expect(panel.target.objectType).toBe('PanelSpriteObject::PanelSprite');
    expect(panel.properties).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'configuration.width',
          valueType: 'number',
        }),
        expect.objectContaining({
          path: 'configuration.height',
          valueType: 'number',
        }),
        expect.objectContaining({
          path: 'configuration.leftMargin',
          valueType: 'number',
        }),
      ])
    );

    const spriteDefinition = service.describe({
      targetKind: 'object-definition',
      sceneName: 'Game',
      objectName: 'Hero',
    });
    expect(spriteDefinition.target.objectType).toBe('Sprite');

    const spriteInstance = scene
      .getInitialInstances()
      .insertNewInitialInstance();
    spriteInstance.setObjectName('Hero');
    spriteInstance.setRawDoubleProperty('animation', 2);
    spriteInstance.setOpacity(210);
    const instance = service.describe({
      targetKind: 'scene-instance',
      sceneName: 'Game',
      instanceId: spriteInstance.getPersistentUuid(),
    });
    expect(instance.properties).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'instance.opacity',
          valueType: 'number',
          currentValue: 210,
          constraints: { minimum: 0, maximum: 255 },
        }),
        expect.objectContaining({
          path: 'instance.custom.animation',
          valueType: 'number',
          currentValue: 2,
          writable: true,
        }),
      ])
    );
  });

  it('describes attached behavior properties and dispatches typed behavior mutation through the canonical backend', async () => {
    const described = service.describe({
      targetKind: 'behavior',
      sceneName: 'Game',
      objectName: 'Label',
      behaviorName: 'TypedBehavior',
    });
    expect(described.target).toMatchObject({
      kind: 'behavior',
      objectName: 'Label',
      behaviorName: 'TypedBehavior',
      behaviorType: 'FakeBehavior::FakeBehavior',
    });
    expect(described.properties).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'behaviors.TypedBehavior.properties.property1',
          valueType: 'string',
          currentValue: 'Initial value 1',
          writable: true,
        }),
        expect.objectContaining({
          path: 'behaviors.TypedBehavior.properties.property2',
          valueType: 'boolean',
          currentValue: true,
          writable: true,
        }),
      ])
    );

    await service.set({
      targetKind: 'behavior',
      sceneName: 'Game',
      objectName: 'Label',
      behaviorName: 'TypedBehavior',
      changes: [
        {
          path: 'behaviors.TypedBehavior.properties.property2',
          value: false,
        },
      ],
    });
    expect(editorFunctionService.run).toHaveBeenCalledWith(
      expect.objectContaining({
        calls: [
          {
            name: 'change_behavior_property',
            arguments: {
              scene_name: 'Game',
              object_name: 'Label',
              behavior_name: 'TypedBehavior',
              changed_properties: [
                { property_name: 'property2', new_value: 'false' },
              ],
            },
          },
        ],
      })
    );
  });

  it('rejects unknown paths and incompatible typed values before EditorFunction dispatch', async () => {
    await expect(
      service.set({
        targetKind: 'object-definition',
        sceneName: 'Game',
        objectName: 'Label',
        changes: [{ path: 'configuration.text', value: 42 }],
      })
    ).rejects.toMatchObject({
      code: 'invalid_property_type',
      field: 'changes[0].value',
      path: 'configuration.text',
      details: expect.objectContaining({
        expectedType: 'string',
        actualType: 'number',
      }),
    });
    expect(editorFunctionService.run).not.toHaveBeenCalled();

    await expect(
      service.set({
        targetKind: 'object-definition',
        sceneName: 'Game',
        objectName: 'Label',
        changes: [{ path: 'configuration.notARealProperty', value: 'x' }],
      })
    ).rejects.toMatchObject({
      code: 'unknown_property_path',
      field: 'changes[0].path',
      path: 'configuration.notARealProperty',
      details: expect.objectContaining({
        availablePaths: expect.arrayContaining(['configuration.text']),
      }),
    });
    expect(editorFunctionService.run).not.toHaveBeenCalled();
  });

  it('dispatches validated definition values through the canonical changed_properties backend', async () => {
    const result = await service.set({
      targetKind: 'object-definition',
      sceneName: 'Game',
      objectName: 'Label',
      changes: [{ path: 'configuration.text', value: 'Score' }],
    });

    expect(editorFunctionService.run).toHaveBeenCalledTimes(1);
    expect(editorFunctionService.run).toHaveBeenCalledWith(
      expect.objectContaining({
        save: false,
        calls: [
          {
            name: 'change_object_property',
            arguments: {
              scene_name: 'Game',
              object_name: 'Label',
              changed_properties: [
                { property_name: 'text', new_value: 'Score' },
              ],
            },
          },
        ],
      })
    );
    expect(result).toMatchObject({
      updated: true,
      applied: [
        expect.objectContaining({
          path: 'configuration.text',
          value: 'Score',
        }),
      ],
      mutation: {
        backend: expect.objectContaining({
          command: 'editor.functions.change-object-property',
        }),
        execution: expect.any(Object),
      },
    });
  });

  it('uses native typed InitialInstance setters and reports instance/definition layers separately', async () => {
    const instance = scene.getInitialInstances().insertNewInitialInstance();
    instance.setObjectName('Label');
    instance.setX(12);
    instance.setOpacity(255);
    const instanceId = instance.getPersistentUuid();

    const described = service.describe({
      targetKind: 'scene-instance',
      sceneName: 'Game',
      instanceId,
    });
    expect(described.target).toMatchObject({
      kind: 'scene-instance',
      sceneName: 'Game',
      instanceId,
      objectName: 'Label',
    });
    expect(described.properties).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'instance.x',
          layer: 'instance',
          valueType: 'number',
          currentValue: 12,
          writable: true,
        }),
        expect.objectContaining({
          path: 'instance.opacity',
          constraints: { minimum: 0, maximum: 255 },
        }),
        expect.objectContaining({
          path: 'instance.id',
          writable: false,
          readOnlyReason: 'persistent-identity',
        }),
      ])
    );

    const result = await service.set({
      targetKind: 'scene-instance',
      sceneName: 'Game',
      instanceId,
      changes: [
        { path: 'instance.x', value: 48 },
        { path: 'instance.opacity', value: 128 },
      ],
    });
    expect(instance.getX()).toBe(48);
    expect(instance.getOpacity()).toBe(128);
    expect(result.mutation.backend).toMatchObject({
      kind: 'native-initial-instance-mutation',
      operations: [
        { kind: 'native-initial-instance-setter', setter: 'setX' },
        { kind: 'native-initial-instance-setter', setter: 'setOpacity' },
      ],
    });
    expect(triggerUnsavedChanges).toHaveBeenCalledTimes(1);
    expect(forceUpdate).toHaveBeenCalledTimes(1);
    expect(onInstancesModifiedOutsideEditor).toHaveBeenCalledWith({ scene });
    expect(editorFunctionService.run).not.toHaveBeenCalled();
  });

  it('discovers and mutates extension-defined InitialInstance properties without static host knowledge', async () => {
    const instance = scene.getInitialInstances().insertNewInitialInstance();
    instance.setObjectName('CustomInput');
    instance.setRawStringProperty('initialValue', 'Before');
    const instanceId = instance.getPersistentUuid();

    const described = service.describe({
      targetKind: 'scene-instance',
      sceneName: 'Game',
      instanceId,
    });
    expect(described.properties).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'initialValue',
          path: 'instance.custom.initialValue',
          layer: 'instance',
          valueType: 'string',
          currentValue: 'Before',
          writable: true,
          mutation: expect.objectContaining({
            backend: {
              kind: 'native-initial-instance-custom-property',
              propertyName: 'initialValue',
            },
          }),
        }),
        expect.objectContaining({
          name: 'placeholder',
          path: 'instance.custom.placeholder',
          valueType: 'string',
        }),
      ])
    );

    const result = await service.set({
      targetKind: 'scene-instance',
      sceneName: 'Game',
      instanceId,
      changes: [
        { path: 'instance.custom.initialValue', value: 'After' },
        { path: 'instance.custom.placeholder', value: 'Type here' },
      ],
    });
    expect(instance.getRawStringProperty('initialValue')).toBe('After');
    expect(instance.getRawStringProperty('placeholder')).toBe('Type here');
    expect(result.mutation.backend).toMatchObject({
      kind: 'native-initial-instance-mutation',
      operations: [
        {
          kind: 'native-initial-instance-custom-property',
          propertyName: 'initialValue',
        },
        {
          kind: 'native-initial-instance-custom-property',
          propertyName: 'placeholder',
        },
      ],
    });
    expect(editorFunctionService.run).not.toHaveBeenCalled();
  });

  it('discovers ResizableCapability width/height action paths and refuses generic definition mutation without trial-and-error', async () => {
    const described = service.describe({
      targetKind: 'object-definition',
      sceneName: 'Game',
      objectName: 'ResizableTile',
    });
    const resizable = described.behaviors.find(
      behavior => behavior.type === 'ResizableCapability::ResizableBehavior'
    );
    expect(resizable).toBeTruthy();
    expect(resizable.capability).toBe(true);

    const width = described.runtimeOnlyProperties.find(
      property => property.path === 'runtime.width'
    );
    const height = described.runtimeOnlyProperties.find(
      property => property.path === 'runtime.height'
    );
    expect(width).toMatchObject({
      layer: 'runtime-only',
      writable: false,
      readOnlyReason: 'runtime-capability-backed',
      authoritativeMutation: {
        kind: 'behavior-capability-action',
        behaviorType: 'ResizableCapability::ResizableBehavior',
        action: expect.objectContaining({
          id: expect.stringMatching(/SetWidth$/),
          discovery: expect.objectContaining({
            command: 'events.instructions.describe',
          }),
          authoring: {
            command: 'events.patch',
            instructionId: expect.stringMatching(/SetWidth$/),
          },
        }),
      },
    });
    expect(height.authoritativeMutation.action.id).toMatch(/SetHeight$/);

    await expect(
      service.set({
        targetKind: 'object-definition',
        sceneName: 'Game',
        objectName: 'ResizableTile',
        changes: [{ path: 'runtime.width', value: 320 }],
      })
    ).rejects.toMatchObject({
      code: 'unsupported_property_mutation',
      field: 'changes[0].path',
      path: 'runtime.width',
      details: expect.objectContaining({
        reason: 'runtime-capability-backed',
        authoritativeMutation: expect.objectContaining({
          kind: 'behavior-capability-action',
        }),
      }),
    });
    expect(editorFunctionService.run).not.toHaveBeenCalled();
  });
});
