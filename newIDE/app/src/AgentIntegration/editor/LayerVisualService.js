// @flow
import { AgentError } from '../core/AgentError';

const CAMERA_TYPES = ['perspective', 'orthographic'];
const DEFAULT_CAMERA_BEHAVIORS = [
  'do-nothing',
  'top-left-anchored-if-never-moved',
];
const RENDERING_TYPES = ['', '2d', '3d', '2d+3d'];
const MAX_CAMERAS = 50;
const CAMERA_MUTATION_FIELDS = [
  'renderingType',
  'cameraType',
  'defaultCameraBehavior',
  'followsBaseLayerCamera',
  'fieldOfView',
  'nearPlaneDistance',
  'farPlaneDistance',
  'plane2DMaxDrawingDistance',
  'cameraCount',
];

const hasDefinedOwnProperty = (input: any, field: string): boolean =>
  !!input &&
  Object.prototype.hasOwnProperty.call(input, field) &&
  input[field] !== undefined;

const hasCameraMutation = (input: any): boolean =>
  CAMERA_MUTATION_FIELDS.some(field => hasDefinedOwnProperty(input, field));

const finiteNumber = (value: any, field: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new AgentError({
      code: 'invalid_layer_camera_value',
      field,
      details: { field, value, expected: 'finite-number' },
    });
  }
  return value;
};

const requireString = (value: any, field: string): string => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AgentError({
      code: 'invalid_layer_visual_input',
      field,
      details: { field, expected: 'non-empty-string' },
    });
  }
  return value;
};

const exactLayerMatch = (item: any, input: any): boolean => {
  if (input && typeof input.layerId === 'string' && input.layerId) {
    if (
      !item.layerId ||
      !item.layerId.toLowerCase().startsWith(input.layerId.toLowerCase())
    ) {
      return false;
    }
  }
  if (
    input &&
    Object.prototype.hasOwnProperty.call(input, 'layerName') &&
    typeof input.layerName === 'string' &&
    item.name !== input.layerName
  ) {
    return false;
  }
  return true;
};

export const createLayerVisualService = ({
  project,
  layerOrderService,
  metadataDiscoveryService,
  triggerUnsavedChanges,
  forceUpdate,
}: any): any => {
  const requireProject = (): gdProject => {
    if (!project) throw new AgentError({ code: 'no_project_open' });
    return project;
  };

  const requireScene = (sceneName: any): gdLayout => {
    const currentProject = requireProject();
    const name = requireString(sceneName, 'sceneName');
    if (!currentProject.hasLayoutNamed(name)) {
      throw new AgentError({
        code: 'scene_not_found',
        field: 'sceneName',
        details: { sceneName: name },
      });
    }
    return currentProject.getLayout(name);
  };

  const resolveLayer = (input: any): any => {
    const scene = requireScene(input && input.sceneName);
    const listed = layerOrderService.list({
      sceneName: scene.getName(),
      includeInstances: false,
    });
    const matches = (listed.layers || []).filter(item =>
      exactLayerMatch(item, input || {})
    );
    if (!matches.length) {
      throw new AgentError({
        code: 'layer_not_found',
        details: {
          sceneName: scene.getName(),
          layerId: input && input.layerId,
          layerName:
            input && Object.prototype.hasOwnProperty.call(input, 'layerName')
              ? input.layerName
              : undefined,
        },
      });
    }
    if (matches.length > 1) {
      throw new AgentError({
        code: 'layer_id_ambiguous',
        details: {
          layerId: input && input.layerId,
          matchCount: matches.length,
        },
      });
    }
    const info = matches[0];
    const layer = scene.getLayers().getLayer(info.name);
    return { scene, layer, info };
  };

  const getEffectMetadata = (effectType: string): any => {
    let result;
    try {
      result = metadataDiscoveryService.describeEffectType({
        type: effectType,
      });
    } catch (error) {
      throw new AgentError({
        code: 'effect_type_not_found',
        field: 'effectType',
        details: {
          effectType,
          metadataErrorCode: error && error.code ? error.code : null,
        },
      });
    }
    const item = result && result.item;
    if (!item || item.kind !== 'effect') {
      throw new AgentError({
        code: 'effect_type_not_found',
        field: 'effectType',
        details: { effectType },
      });
    }
    return item;
  };

  const readEffectValue = (effect: gdEffect, property: any): any => {
    const name = property.name;
    if (effect.hasDoubleParameter(name)) return effect.getDoubleParameter(name);
    if (effect.hasBooleanParameter(name))
      return effect.getBooleanParameter(name);
    if (effect.hasStringParameter(name)) return effect.getStringParameter(name);
    const type = String(property.type || '').toLowerCase();
    if (type === 'number') {
      const parsed = Number(property.defaultValue);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    if (type === 'boolean') {
      return String(property.defaultValue).toLowerCase() === 'true';
    }
    return property.defaultValue;
  };

  const validateEffectCompatibility = (layer: gdLayer, metadata: any) => {
    const renderingType = layer.getRenderingType();
    if (renderingType === '3d' && metadata.onlyWorkingFor2D) {
      throw new AgentError({
        code: 'effect_incompatible_with_layer',
        details: {
          effectType: metadata.type,
          layerRenderingType: renderingType,
          supportedRendering: '2d',
        },
      });
    }
    if (renderingType === '2d' && metadata.onlyWorkingFor3D) {
      throw new AgentError({
        code: 'effect_incompatible_with_layer',
        details: {
          effectType: metadata.type,
          layerRenderingType: renderingType,
          supportedRendering: '3d',
        },
      });
    }
  };

  const serializeEffect = (
    layer: gdLayer,
    effect: gdEffect,
    index: number
  ): any => {
    let metadata = null;
    try {
      metadata = getEffectMetadata(effect.getEffectType());
    } catch (error) {}
    return {
      name: effect.getName(),
      type: effect.getEffectType(),
      index,
      enabled: effect.isEnabled(),
      metadataAvailable: !!metadata,
      compatibility: metadata
        ? {
            onlyWorkingFor2D: !!metadata.onlyWorkingFor2D,
            onlyWorkingFor3D: !!metadata.onlyWorkingFor3D,
            unique: !!metadata.unique,
            layerRenderingType: layer.getRenderingType(),
          }
        : null,
      properties: metadata
        ? (metadata.properties || []).map(property => ({
            ...property,
            value: readEffectValue(effect, property),
          }))
        : [],
    };
  };

  const serializeLayerVisual = (input: any): any => {
    const { scene, layer, info } = resolveLayer(input);
    const effects = layer.getEffects();
    return {
      authority: 'editor-project',
      runtimeDynamicCameraStateIncluded: false,
      runtimeStateTool: 'runtime.snapshot',
      runtimeStatePath: 'scene.layers',
      scene: {
        sceneName: scene.getName(),
        sceneId: scene.getPersistentUuid(),
      },
      layer: {
        layerId: info.layerId,
        selector: info.selector,
        name: layer.getName(),
        index: info.index,
        isBaseLayer: info.isBaseLayer,
        renderingType: layer.getRenderingType(),
        cameraType: layer.getCameraType(),
        defaultCameraBehavior: layer.getDefaultCameraBehavior(),
        followsBaseLayerCamera: layer.isFollowingBaseLayerCamera(),
        camera3D: {
          fieldOfView: layer.getCamera3DFieldOfView(),
          nearPlaneDistance: layer.getCamera3DNearPlaneDistance(),
          farPlaneDistance: layer.getCamera3DFarPlaneDistance(),
          plane2DMaxDrawingDistance: layer.getCamera2DPlaneMaxDrawingDistance(),
        },
        cameraCount: layer.getCameraCount(),
        persistentCameraViewportBinding: {
          available: false,
          reason:
            'The connected libGD JavaScript binding exposes gdLayer camera count/frustum settings but not individual gdCamera viewport/size objects.',
        },
        effects: Array.from({ length: effects.getEffectsCount() }, (_, index) =>
          serializeEffect(layer, effects.getEffectAt(index), index)
        ),
      },
      runtimeNote:
        'Camera position, zoom and rotation are runtime state and are intentionally not persisted by this authoring surface. Read them from runtime.snapshot while a preview is running.',
    };
  };

  const capabilities = () => ({
    authority: 'editor-project',
    persistentCameraFields: [
      'renderingType',
      'cameraType',
      'defaultCameraBehavior',
      'followsBaseLayerCamera',
      'camera3D.fieldOfView',
      'camera3D.nearPlaneDistance',
      'camera3D.farPlaneDistance',
      'camera3D.plane2DMaxDrawingDistance',
      'cameraCount',
    ],
    unavailablePersistentCameraFields: [
      {
        fields: ['cameras[].size', 'cameras[].viewport'],
        reason: 'individual-gdCamera-not-exposed-by-connected-js-binding',
      },
    ],
    runtimeCameraFields: [
      'x',
      'y',
      'width',
      'height',
      'zoom',
      'rotation',
      'rotationX',
      'rotationY',
    ],
    runtimeStateTool: 'runtime.snapshot',
    viewportQaTools: ['preview.viewport.status', 'preview.viewport.set'],
    visualQaTools: [
      'preview.capture.region',
      'preview.visual.baseline.capture',
      'preview.visual.baseline.compare',
    ],
    effectTypeDiscovery: {
      list: 'editor.types.effects.list',
      describe: 'editor.types.effects.describe',
    },
    effectOperations: ['add', 'update', 'reorder', 'remove'],
    projectModified: false,
  });

  const markChanged = () => {
    triggerUnsavedChanges();
    forceUpdate();
  };

  const updateCamera = (input: any): any => {
    if (!hasCameraMutation(input)) {
      throw new AgentError({
        code: 'missing_layer_camera_changes',
        details: { availableFields: CAMERA_MUTATION_FIELDS },
      });
    }

    const { layer } = resolveLayer(input);
    const before = serializeLayerVisual(input).layer;

    // Validate the complete requested state before mutating anything. AgentHost
    // can reject a command, but it cannot undo a partially mutated gdLayer.
    if (
      input.renderingType !== undefined &&
      !RENDERING_TYPES.includes(input.renderingType)
    ) {
      throw new AgentError({
        code: 'invalid_layer_rendering_type',
        field: 'renderingType',
        details: { value: input.renderingType, allowed: RENDERING_TYPES },
      });
    }
    if (
      input.cameraType !== undefined &&
      !CAMERA_TYPES.includes(input.cameraType)
    ) {
      throw new AgentError({
        code: 'invalid_layer_camera_type',
        field: 'cameraType',
        details: { value: input.cameraType, allowed: CAMERA_TYPES },
      });
    }
    if (
      input.defaultCameraBehavior !== undefined &&
      !DEFAULT_CAMERA_BEHAVIORS.includes(input.defaultCameraBehavior)
    ) {
      throw new AgentError({
        code: 'invalid_default_camera_behavior',
        field: 'defaultCameraBehavior',
        details: {
          value: input.defaultCameraBehavior,
          allowed: DEFAULT_CAMERA_BEHAVIORS,
        },
      });
    }

    const nextFieldOfView =
      input.fieldOfView !== undefined
        ? finiteNumber(input.fieldOfView, 'fieldOfView')
        : layer.getCamera3DFieldOfView();
    if (nextFieldOfView <= 0 || nextFieldOfView >= 180) {
      throw new AgentError({
        code: 'invalid_layer_camera_value',
        field: 'fieldOfView',
        details: {
          value: nextFieldOfView,
          exclusiveMinimum: 0,
          exclusiveMaximum: 180,
        },
      });
    }
    const nextNearPlane =
      input.nearPlaneDistance !== undefined
        ? finiteNumber(input.nearPlaneDistance, 'nearPlaneDistance')
        : layer.getCamera3DNearPlaneDistance();
    const nextFarPlane =
      input.farPlaneDistance !== undefined
        ? finiteNumber(input.farPlaneDistance, 'farPlaneDistance')
        : layer.getCamera3DFarPlaneDistance();
    if (nextNearPlane <= 0 || nextFarPlane <= 0) {
      throw new AgentError({
        code: 'invalid_layer_camera_value',
        details: {
          nearPlaneDistance: nextNearPlane,
          farPlaneDistance: nextFarPlane,
          exclusiveMinimum: 0,
        },
      });
    }
    if (nextFarPlane <= nextNearPlane) {
      throw new AgentError({
        code: 'invalid_layer_camera_frustum',
        details: {
          nearPlaneDistance: nextNearPlane,
          farPlaneDistance: nextFarPlane,
        },
      });
    }
    const nextPlane2DDistance =
      input.plane2DMaxDrawingDistance !== undefined
        ? finiteNumber(
            input.plane2DMaxDrawingDistance,
            'plane2DMaxDrawingDistance'
          )
        : layer.getCamera2DPlaneMaxDrawingDistance();
    if (nextPlane2DDistance < 0) {
      throw new AgentError({
        code: 'invalid_layer_camera_value',
        field: 'plane2DMaxDrawingDistance',
        details: { value: nextPlane2DDistance, minimum: 0 },
      });
    }

    const nextCameraCount =
      input.cameraCount !== undefined
        ? input.cameraCount
        : layer.getCameraCount();
    if (
      !Number.isInteger(nextCameraCount) ||
      nextCameraCount < 1 ||
      nextCameraCount > MAX_CAMERAS
    ) {
      throw new AgentError({
        code: 'invalid_layer_camera_count',
        field: 'cameraCount',
        details: { value: nextCameraCount, minimum: 1, maximum: MAX_CAMERAS },
      });
    }
    if (input.renderingType !== undefined) {
      if (!RENDERING_TYPES.includes(input.renderingType)) {
        throw new AgentError({
          code: 'invalid_layer_rendering_type',
          field: 'renderingType',
          details: {
            value: input.renderingType,
            allowed: RENDERING_TYPES,
          },
        });
      }
      layer.setRenderingType(input.renderingType);
    }
    if (input.cameraType !== undefined) {
      if (!CAMERA_TYPES.includes(input.cameraType)) {
        throw new AgentError({
          code: 'invalid_layer_camera_type',
          field: 'cameraType',
          details: { value: input.cameraType, allowed: CAMERA_TYPES },
        });
      }
      layer.setCameraType(input.cameraType);
    }
    if (input.defaultCameraBehavior !== undefined) {
      if (!DEFAULT_CAMERA_BEHAVIORS.includes(input.defaultCameraBehavior)) {
        throw new AgentError({
          code: 'invalid_default_camera_behavior',
          field: 'defaultCameraBehavior',
          details: {
            value: input.defaultCameraBehavior,
            allowed: DEFAULT_CAMERA_BEHAVIORS,
          },
        });
      }
      layer.setDefaultCameraBehavior(input.defaultCameraBehavior);
    }
    if (input.followsBaseLayerCamera !== undefined) {
      layer.setFollowBaseLayerCamera(!!input.followsBaseLayerCamera);
    }
    if (input.fieldOfView !== undefined) {
      const value = finiteNumber(input.fieldOfView, 'fieldOfView');
      if (value <= 0 || value >= 180) {
        throw new AgentError({
          code: 'invalid_layer_camera_value',
          field: 'fieldOfView',
          details: { value, exclusiveMinimum: 0, exclusiveMaximum: 180 },
        });
      }
      layer.setCamera3DFieldOfView(value);
    }
    if (input.nearPlaneDistance !== undefined) {
      const value = finiteNumber(input.nearPlaneDistance, 'nearPlaneDistance');
      if (value <= 0) {
        throw new AgentError({
          code: 'invalid_layer_camera_value',
          field: 'nearPlaneDistance',
          details: { value, exclusiveMinimum: 0 },
        });
      }
      layer.setCamera3DNearPlaneDistance(value);
    }
    if (input.farPlaneDistance !== undefined) {
      const value = finiteNumber(input.farPlaneDistance, 'farPlaneDistance');
      if (value <= 0) {
        throw new AgentError({
          code: 'invalid_layer_camera_value',
          field: 'farPlaneDistance',
          details: { value, exclusiveMinimum: 0 },
        });
      }
      layer.setCamera3DFarPlaneDistance(value);
    }
    if (
      layer.getCamera3DFarPlaneDistance() <=
      layer.getCamera3DNearPlaneDistance()
    ) {
      throw new AgentError({
        code: 'invalid_layer_camera_frustum',
        details: {
          nearPlaneDistance: layer.getCamera3DNearPlaneDistance(),
          farPlaneDistance: layer.getCamera3DFarPlaneDistance(),
        },
      });
    }
    if (input.plane2DMaxDrawingDistance !== undefined) {
      const value = finiteNumber(
        input.plane2DMaxDrawingDistance,
        'plane2DMaxDrawingDistance'
      );
      if (value < 0) {
        throw new AgentError({
          code: 'invalid_layer_camera_value',
          field: 'plane2DMaxDrawingDistance',
          details: { value, minimum: 0 },
        });
      }
      layer.setCamera2DPlaneMaxDrawingDistance(value);
    }

    if (input.cameraCount !== undefined) {
      if (
        !Number.isInteger(input.cameraCount) ||
        input.cameraCount < 1 ||
        input.cameraCount > MAX_CAMERAS
      ) {
        throw new AgentError({
          code: 'invalid_layer_camera_count',
          field: 'cameraCount',
          details: {
            value: input.cameraCount,
            minimum: 1,
            maximum: MAX_CAMERAS,
          },
        });
      }
      layer.setCameraCount(input.cameraCount);
    }

    markChanged();
    return {
      updated: true,
      before,
      after: serializeLayerVisual(input).layer,
      unrelatedPropertiesPreserved: true,
      runtimeDynamicStateModified: false,
    };
  };

  const validatePropertyValue = (property: any, value: any): any => {
    const type = String(property.type || '').toLowerCase();
    const choices = Array.isArray(property.choices) ? property.choices : [];
    if (choices.length) {
      const allowed = choices.map(choice => choice.value);
      if (!allowed.includes(String(value))) {
        throw new AgentError({
          code: 'invalid_effect_parameter_value',
          field: property.name,
          details: { value, allowed },
        });
      }
    }
    if (type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new AgentError({
          code: 'invalid_effect_parameter_value',
          field: property.name,
          details: { value, expected: 'number' },
        });
      }
      return value;
    }
    if (type === 'boolean') {
      if (typeof value !== 'boolean') {
        throw new AgentError({
          code: 'invalid_effect_parameter_value',
          field: property.name,
          details: { value, expected: 'boolean' },
        });
      }
      return value;
    }
    if (typeof value !== 'string') {
      throw new AgentError({
        code: 'invalid_effect_parameter_value',
        field: property.name,
        details: { value, expected: 'string' },
      });
    }
    return value;
  };

  const validateEffectProperties = (
    metadata: any,
    properties: any
  ): Array<any> => {
    const entries = [];
    Object.keys(properties || {}).forEach(name => {
      const property = (metadata.properties || []).find(
        item => item.name === name
      );
      if (!property) {
        throw new AgentError({
          code: 'effect_parameter_not_found',
          field: name,
          details: {
            parameterName: name,
            available: (metadata.properties || []).map(item => item.name),
          },
        });
      }
      entries.push({
        name,
        value: validatePropertyValue(property, properties[name]),
      });
    });
    return entries;
  };

  const setEffectProperty = (
    effect: gdEffect,
    metadata: any,
    name: string,
    value: any
  ) => {
    const property = (metadata.properties || []).find(
      item => item.name === name
    );
    if (!property) {
      throw new AgentError({
        code: 'effect_parameter_not_found',
        field: name,
        details: {
          parameterName: name,
          available: (metadata.properties || []).map(item => item.name),
        },
      });
    }
    const normalized = validatePropertyValue(property, value);
    const type = String(property.type || '').toLowerCase();
    if (type === 'number') effect.setDoubleParameter(name, normalized);
    else if (type === 'boolean') effect.setBooleanParameter(name, normalized);
    else effect.setStringParameter(name, normalized);
  };

  const requireEffect = (layer: gdLayer, name: any): gdEffect => {
    const effectName = requireString(name, 'effectName');
    const effects = layer.getEffects();
    if (!effects.hasEffectNamed(effectName)) {
      throw new AgentError({
        code: 'layer_effect_not_found',
        field: 'effectName',
        details: { effectName },
      });
    }
    return effects.getEffect(effectName);
  };

  const addEffect = (input: any): any => {
    const { layer } = resolveLayer(input);
    const name = requireString(input && input.effectName, 'effectName');
    const type = requireString(input && input.effectType, 'effectType');
    const effects = layer.getEffects();
    if (effects.hasEffectNamed(name)) {
      throw new AgentError({
        code: 'layer_effect_already_exists',
        details: { effectName: name },
      });
    }
    const metadata = getEffectMetadata(type);
    validateEffectCompatibility(layer, metadata);
    if (
      metadata.unique &&
      Array.from({ length: effects.getEffectsCount() }, (_, index) =>
        effects.getEffectAt(index)
      ).some(effect => effect.getEffectType() === type)
    ) {
      throw new AgentError({
        code: 'unique_effect_type_already_present',
        details: { effectType: type },
      });
    }
    const index =
      input && input.index !== undefined
        ? input.index
        : effects.getEffectsCount();
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index > effects.getEffectsCount()
    ) {
      throw new AgentError({
        code: 'invalid_effect_position',
        field: 'index',
        details: {
          value: index,
          minimum: 0,
          maximum: effects.getEffectsCount(),
        },
      });
    }
    const properties =
      input && input.properties && typeof input.properties === 'object'
        ? input.properties
        : {};
    const validatedProperties = validateEffectProperties(metadata, properties);
    const effect = effects.insertNewEffect(name, index);
    effect.setEffectType(type);
    if (input.enabled !== undefined) effect.setEnabled(!!input.enabled);
    validatedProperties.forEach(({ name: propertyName, value }) =>
      setEffectProperty(effect, metadata, propertyName, value)
    );
    markChanged();
    const finalIndex = effects.getEffectPosition(name);
    return {
      created: serializeEffect(layer, effect, finalIndex),
      unrelatedPropertiesPreserved: true,
    };
  };

  const updateEffect = (input: any): any => {
    const hasPropertyUpdates =
      input &&
      input.properties &&
      typeof input.properties === 'object' &&
      Object.keys(input.properties).length > 0;
    if (
      !hasDefinedOwnProperty(input, 'newName') &&
      !hasDefinedOwnProperty(input, 'enabled') &&
      !hasPropertyUpdates
    ) {
      throw new AgentError({ code: 'missing_layer_effect_changes' });
    }

    const { layer } = resolveLayer(input);
    const effect = requireEffect(layer, input && input.effectName);
    const effects = layer.getEffects();
    const beforeName = effect.getName();
    const beforeIndex = effects.getEffectPosition(beforeName);
    const before = serializeEffect(layer, effect, beforeIndex);
    const metadata = getEffectMetadata(effect.getEffectType());
    validateEffectCompatibility(layer, metadata);

    const properties =
      input && input.properties && typeof input.properties === 'object'
        ? input.properties
        : {};
    const validatedProperties = validateEffectProperties(metadata, properties);
    let nextName = beforeName;
    if (input.newName !== undefined && input.newName !== beforeName) {
      nextName = requireString(input.newName, 'newName');
      if (effects.hasEffectNamed(nextName)) {
        throw new AgentError({
          code: 'layer_effect_already_exists',
          details: { effectName: nextName },
        });
      }
    }

    if (input.enabled !== undefined) effect.setEnabled(!!input.enabled);
    if (nextName !== beforeName) effect.setName(nextName);
    validatedProperties.forEach(({ name: propertyName, value }) =>
      setEffectProperty(effect, metadata, propertyName, value)
    );
    markChanged();
    const name = effect.getName();
    return {
      updated: true,
      before,
      after: serializeEffect(layer, effect, effects.getEffectPosition(name)),
      unrelatedPropertiesPreserved: true,
    };
  };

  const reorderEffect = (input: any): any => {
    const { layer } = resolveLayer(input);
    const effect = requireEffect(layer, input && input.effectName);
    const effects = layer.getEffects();
    const from = effects.getEffectPosition(effect.getName());
    const to = input && input.index;
    const max = Math.max(0, effects.getEffectsCount() - 1);
    if (!Number.isInteger(to) || to < 0 || to > max) {
      throw new AgentError({
        code: 'invalid_effect_position',
        field: 'index',
        details: { value: to, minimum: 0, maximum: max },
      });
    }
    if (from !== to) effects.moveEffect(from, to);
    markChanged();
    return {
      moved: from !== to,
      from,
      to,
      effect: serializeEffect(
        layer,
        effect,
        effects.getEffectPosition(effect.getName())
      ),
      unrelatedPropertiesPreserved: true,
    };
  };

  const removeEffect = (input: any): any => {
    const { layer } = resolveLayer(input);
    const effect = requireEffect(layer, input && input.effectName);
    const effects = layer.getEffects();
    const before = serializeEffect(
      layer,
      effect,
      effects.getEffectPosition(effect.getName())
    );
    effects.removeEffect(effect.getName());
    markChanged();
    return {
      removed: true,
      effect: before,
      unrelatedPropertiesPreserved: true,
    };
  };

  return {
    capabilities,
    inspect: serializeLayerVisual,
    updateCamera,
    addEffect,
    updateEffect,
    reorderEffect,
    removeEffect,
  };
};
