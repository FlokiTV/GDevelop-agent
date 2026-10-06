// @flow
import { createLayerOrderService } from './LayerOrderService';
import { createLayerVisualService } from './LayerVisualService';

const gd: libGDevelop = global.gd;

const effectMetadata = {
  FakeSepia: {
    kind: 'effect',
    type: 'FakeSepia',
    name: 'FakeSepia',
    fullName: 'Fake Sepia',
    onlyWorkingFor2D: true,
    onlyWorkingFor3D: false,
    unique: false,
    properties: [
      {
        name: 'opacity',
        type: 'Number',
        defaultValue: '1',
        choices: [],
      },
    ],
  },
  FakeNight: {
    kind: 'effect',
    type: 'FakeNight',
    name: 'FakeNight',
    fullName: 'Fake Night',
    onlyWorkingFor2D: true,
    onlyWorkingFor3D: false,
    unique: false,
    properties: [
      {
        name: 'intensity',
        type: 'Number',
        defaultValue: '0.5',
        choices: [],
      },
      {
        name: 'mode',
        type: 'String',
        defaultValue: 'normal',
        choices: [
          { value: 'normal', label: 'Normal' },
          { value: 'strong', label: 'Strong' },
        ],
      },
      {
        name: 'enabledFlag',
        type: 'Boolean',
        defaultValue: 'false',
        choices: [],
      },
    ],
  },
};

describe('DX-32 LayerVisualService', () => {
  let project: gdProject;
  let scene: gdLayout;
  let layerOrderService: any;
  let service: any;
  let triggerUnsavedChanges: jest.Mock<any, any>;
  let forceUpdate: jest.Mock<any, any>;

  beforeEach(() => {
    // $FlowFixMe[invalid-constructor]
    project = new gd.ProjectHelper.createNewGDJSProject();
    project.resetProjectUuid();
    project.setName('DX32 Layer Visual Test');
    scene = project.insertNewLayout('Game', 0);
    scene.getLayers().insertNewLayer('Gameplay', 1);
    scene.getLayers().insertNewLayer('UI', 2);
    triggerUnsavedChanges = jest.fn();
    forceUpdate = jest.fn();
    layerOrderService = createLayerOrderService({
      project,
      triggerUnsavedChanges,
      forceUpdate,
      onInstancesModifiedOutsideEditor: jest.fn(),
    });
    service = createLayerVisualService({
      project,
      layerOrderService,
      metadataDiscoveryService: {
        describeEffectType: ({ type }) => {
          const item = effectMetadata[type];
          if (!item) {
            const error: any = new Error('metadata_effect_not_found');
            error.code = 'metadata_effect_not_found';
            throw error;
          }
          return { item };
        },
      },
      triggerUnsavedChanges,
      forceUpdate,
    });
  });

  afterEach(() => {
    project.delete();
  });

  test('separates persistent editor camera configuration from runtime camera state', () => {
    expect(service.capabilities()).toMatchObject({
      authority: 'editor-project',
      runtimeStateTool: 'runtime.snapshot',
      persistentCameraFields: expect.arrayContaining([
        'cameraType',
        'camera3D.fieldOfView',
        'cameraCount',
      ]),
      unavailablePersistentCameraFields: expect.arrayContaining([
        expect.objectContaining({
          fields: expect.arrayContaining(['cameras[].viewport']),
          reason: 'individual-gdCamera-not-exposed-by-connected-js-binding',
        }),
      ]),
      runtimeCameraFields: expect.arrayContaining([
        'x',
        'y',
        'zoom',
        'rotation',
      ]),
      effectTypeDiscovery: {
        list: 'editor.types.effects.list',
        describe: 'editor.types.effects.describe',
      },
    });

    const inspected = service.inspect({
      sceneName: 'Game',
      layerName: 'Gameplay',
    });
    expect(inspected).toMatchObject({
      authority: 'editor-project',
      runtimeDynamicCameraStateIncluded: false,
      runtimeStateTool: 'runtime.snapshot',
      layer: {
        name: 'Gameplay',
        cameraType: expect.any(String),
        cameraCount: 0,
        persistentCameraViewportBinding: {
          available: false,
          reason: expect.any(String),
        },
        effects: [],
      },
    });
  });

  test('updates persistent camera/frustum state in place without changing another layer', () => {
    const gameplay = scene.getLayers().getLayer('Gameplay');
    const ui = scene.getLayers().getLayer('UI');
    ui.setCameraType('orthographic');
    ui.setCamera3DFieldOfView(73);
    const uiBefore = {
      type: ui.getCameraType(),
      fov: ui.getCamera3DFieldOfView(),
      cameraCount: ui.getCameraCount(),
    };

    const result = service.updateCamera({
      sceneName: 'Game',
      layerName: 'Gameplay',
      renderingType: '2d+3d',
      cameraType: 'perspective',
      defaultCameraBehavior: 'do-nothing',
      followsBaseLayerCamera: false,
      fieldOfView: 62,
      nearPlaneDistance: 1,
      farPlaneDistance: 5000,
      plane2DMaxDrawingDistance: 2500,
      cameraCount: 2,
    });

    expect(result.updated).toBe(true);
    expect(result.unrelatedPropertiesPreserved).toBe(true);
    expect(result.runtimeDynamicStateModified).toBe(false);
    expect(gameplay.getCameraType()).toBe('perspective');
    expect(gameplay.getCamera3DFieldOfView()).toBe(62);
    expect(gameplay.getCamera3DNearPlaneDistance()).toBe(1);
    expect(gameplay.getCamera3DFarPlaneDistance()).toBe(5000);
    expect(gameplay.getCameraCount()).toBe(2);
    expect(result.after.cameraCount).toBe(2);
    expect(result.after.persistentCameraViewportBinding.available).toBe(false);
    expect({
      type: ui.getCameraType(),
      fov: ui.getCamera3DFieldOfView(),
      cameraCount: ui.getCameraCount(),
    }).toEqual(uiBefore);
    expect(triggerUnsavedChanges).toHaveBeenCalledTimes(1);
    expect(forceUpdate).toHaveBeenCalledTimes(1);
  });

  test('rejects an invalid camera request atomically before touching the layer', () => {
    const gameplay = scene.getLayers().getLayer('Gameplay');
    const before = {
      cameraType: gameplay.getCameraType(),
      near: gameplay.getCamera3DNearPlaneDistance(),
      far: gameplay.getCamera3DFarPlaneDistance(),
      count: gameplay.getCameraCount(),
    };

    expect(() =>
      service.updateCamera({
        sceneName: 'Game',
        layerName: 'Gameplay',
        cameraType: 'orthographic',
        nearPlaneDistance: 100,
        farPlaneDistance: 50,
        cameraCount: 3,
      })
    ).toThrow(
      expect.objectContaining({
        code: 'invalid_layer_camera_frustum',
      })
    );

    expect({
      cameraType: gameplay.getCameraType(),
      near: gameplay.getCamera3DNearPlaneDistance(),
      far: gameplay.getCamera3DFarPlaneDistance(),
      count: gameplay.getCameraCount(),
    }).toEqual(before);
    expect(triggerUnsavedChanges).not.toHaveBeenCalled();
  });

  test('rejects empty camera and effect mutations without marking the project changed', () => {
    const gameplayId = service.inspect({
      sceneName: 'Game',
      layerName: 'Gameplay',
    }).layer.layerId;
    expect(() =>
      service.updateCamera({
        sceneName: 'Game',
        layerName: 'Gameplay',
        layerId: gameplayId,
      })
    ).toThrow(
      expect.objectContaining({ code: 'missing_layer_camera_changes' })
    );

    service.addEffect({
      sceneName: 'Game',
      layerName: 'Gameplay',
      effectName: 'Sepia',
      effectType: 'FakeSepia',
    });
    triggerUnsavedChanges.mockClear();
    forceUpdate.mockClear();
    expect(() =>
      service.updateEffect({
        sceneName: 'Game',
        layerName: 'Gameplay',
        effectName: 'Sepia',
      })
    ).toThrow(
      expect.objectContaining({ code: 'missing_layer_effect_changes' })
    );
    expect(triggerUnsavedChanges).not.toHaveBeenCalled();
    expect(forceUpdate).not.toHaveBeenCalled();
  });

  test('adds, configures, enables/disables, reorders and removes typed layer effects', () => {
    const gameplay = scene.getLayers().getLayer('Gameplay');
    gameplay.setRenderingType('2d');

    const sepia = service.addEffect({
      sceneName: 'Game',
      layerName: 'Gameplay',
      effectName: 'Sepia',
      effectType: 'FakeSepia',
      enabled: true,
      properties: { opacity: 0.7 },
    });
    expect(sepia.created).toMatchObject({
      name: 'Sepia',
      type: 'FakeSepia',
      index: 0,
      enabled: true,
      properties: expect.arrayContaining([
        expect.objectContaining({ name: 'opacity', value: 0.7 }),
      ]),
    });

    service.addEffect({
      sceneName: 'Game',
      layerName: 'Gameplay',
      effectName: 'Night',
      effectType: 'FakeNight',
      properties: {
        intensity: 0.2,
        mode: 'strong',
        enabledFlag: true,
      },
    });

    const updated = service.updateEffect({
      sceneName: 'Game',
      layerName: 'Gameplay',
      effectName: 'Night',
      enabled: false,
      properties: { intensity: 0.9 },
    });
    expect(updated.after).toMatchObject({
      name: 'Night',
      enabled: false,
      properties: expect.arrayContaining([
        expect.objectContaining({ name: 'intensity', value: 0.9 }),
      ]),
    });

    const moved = service.reorderEffect({
      sceneName: 'Game',
      layerName: 'Gameplay',
      effectName: 'Night',
      index: 0,
    });
    expect(moved).toMatchObject({ moved: true, from: 1, to: 0 });
    expect(
      gameplay
        .getEffects()
        .getEffectAt(0)
        .getName()
    ).toBe('Night');

    const removed = service.removeEffect({
      sceneName: 'Game',
      layerName: 'Gameplay',
      effectName: 'Sepia',
    });
    expect(removed.removed).toBe(true);
    expect(gameplay.getEffects().hasEffectNamed('Sepia')).toBe(false);
    expect(gameplay.getEffects().hasEffectNamed('Night')).toBe(true);
  });

  test('rejects invalid effect properties before creating or partially updating effects', () => {
    const gameplay = scene.getLayers().getLayer('Gameplay');
    gameplay.setRenderingType('2d');

    expect(() =>
      service.addEffect({
        sceneName: 'Game',
        layerName: 'Gameplay',
        effectName: 'Night',
        effectType: 'FakeNight',
        properties: { mode: 'not-a-choice' },
      })
    ).toThrow(
      expect.objectContaining({
        code: 'invalid_effect_parameter_value',
        field: 'mode',
      })
    );
    expect(gameplay.getEffects().hasEffectNamed('Night')).toBe(false);

    service.addEffect({
      sceneName: 'Game',
      layerName: 'Gameplay',
      effectName: 'Night',
      effectType: 'FakeNight',
      properties: { intensity: 0.4 },
    });
    const effect = gameplay.getEffects().getEffect('Night');
    const beforeEnabled = effect.isEnabled();
    const beforeName = effect.getName();
    const beforeIntensity = effect.getDoubleParameter('intensity');

    expect(() =>
      service.updateEffect({
        sceneName: 'Game',
        layerName: 'Gameplay',
        effectName: 'Night',
        newName: 'RenamedNight',
        enabled: !beforeEnabled,
        properties: { missingParameter: 3 },
      })
    ).toThrow(
      expect.objectContaining({
        code: 'effect_parameter_not_found',
        field: 'missingParameter',
      })
    );

    expect(effect.getName()).toBe(beforeName);
    expect(effect.isEnabled()).toBe(beforeEnabled);
    expect(effect.getDoubleParameter('intensity')).toBe(beforeIntensity);
    expect(gameplay.getEffects().hasEffectNamed('RenamedNight')).toBe(false);
  });

  test('rejects a 2D-only effect on a 3D-only layer with structured diagnostics', () => {
    scene
      .getLayers()
      .getLayer('Gameplay')
      .setRenderingType('3d');
    expect(() =>
      service.addEffect({
        sceneName: 'Game',
        layerName: 'Gameplay',
        effectName: 'Sepia',
        effectType: 'FakeSepia',
      })
    ).toThrow(
      expect.objectContaining({
        code: 'effect_incompatible_with_layer',
        details: expect.objectContaining({
          layerRenderingType: '3d',
          supportedRendering: '2d',
        }),
      })
    );
  });
});
