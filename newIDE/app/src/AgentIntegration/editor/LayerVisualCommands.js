// @flow
import {
  makeCommandMetadata,
  type CommandDescriptor,
} from '../core/CommandRegistry';

const READ = makeCommandMetadata({
  requiresProject: true,
  cacheScope: 'project-revision',
  ttlMs: 10000,
});
const MUTATE = makeCommandMetadata({
  readOnly: false,
  idempotent: false,
  requiresProject: true,
  modifiesProject: true,
});

const NAME = { type: 'string', minLength: 1, maxLength: 500 };
const UUID_OR_PREFIX = { type: 'string', minLength: 1, maxLength: 100 };
const LAYER_TARGET = {
  layerId: UUID_OR_PREFIX,
  layerName: { type: 'string', maxLength: 500 },
};
const LAYER_TARGET_REQUIREMENT = {
  anyOf: [{ required: ['layerId'] }, { required: ['layerName'] }],
};
const EFFECT_PROPERTIES = {
  type: 'object',
  maxProperties: 100,
  additionalProperties: {
    anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }],
  },
};

export const createLayerVisualCommandDescriptors = ({
  layerVisualService,
}: {|
  layerVisualService: any,
|}): Array<CommandDescriptor> => [
  {
    name: 'scene.layers.visual.capabilities',
    description:
      'Describe persistent layer camera configuration, runtime-only camera state, effect authoring operations and the DX-17/DX-18 QA surfaces used to validate results.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    metadata: READ,
    execute: () => layerVisualService.capabilities(),
  },
  {
    name: 'scene.layers.visual.inspect',
    description:
      'Inspect one editor/project layer camera configuration and ordered visual effects. Persistent defaults are separated explicitly from live runtime camera position/zoom/rotation, which are read with runtime.snapshot.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['sceneName'],
      properties: {
        sceneName: NAME,
        ...LAYER_TARGET,
      },
      allOf: [LAYER_TARGET_REQUIREMENT],
    },
    metadata: READ,
    execute: ({ input }) => layerVisualService.inspect(input),
  },
  {
    name: 'scene.layers.camera.update',
    description:
      'Update persistent layer camera configuration exposed by the connected libGD JavaScript binding: rendering/camera type, default behavior, 3D frustum settings and camera count. Individual persistent camera viewport/size objects are not exposed by this binding; runtime x/y/zoom/rotation are read from runtime.snapshot.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['sceneName'],
      minProperties: 3,
      properties: {
        sceneName: NAME,
        ...LAYER_TARGET,
        renderingType: {
          type: 'string',
          enum: ['', '2d', '3d', '2d+3d'],
        },
        cameraType: {
          type: 'string',
          enum: ['perspective', 'orthographic'],
        },
        defaultCameraBehavior: {
          type: 'string',
          enum: ['do-nothing', 'top-left-anchored-if-never-moved'],
        },
        followsBaseLayerCamera: { type: 'boolean' },
        fieldOfView: {
          type: 'number',
          exclusiveMinimum: 0,
          exclusiveMaximum: 180,
        },
        nearPlaneDistance: { type: 'number', exclusiveMinimum: 0 },
        farPlaneDistance: { type: 'number', exclusiveMinimum: 0 },
        plane2DMaxDrawingDistance: { type: 'number', minimum: 0 },
        cameraCount: { type: 'integer', minimum: 1, maximum: 50 },
      },
      allOf: [LAYER_TARGET_REQUIREMENT],
    },
    metadata: MUTATE,
    execute: ({ input }) => layerVisualService.updateCamera(input),
  },
  {
    name: 'scene.layers.effects.add',
    description:
      'Add one named visual effect to a layer using an installed effect type discovered through editor.types.effects.list/describe. Effect parameters are validated against live connected-build metadata before mutation.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['sceneName', 'effectName', 'effectType'],
      properties: {
        sceneName: NAME,
        ...LAYER_TARGET,
        effectName: NAME,
        effectType: NAME,
        index: { type: 'integer', minimum: 0 },
        enabled: { type: 'boolean' },
        properties: EFFECT_PROPERTIES,
      },
      allOf: [LAYER_TARGET_REQUIREMENT],
    },
    metadata: MUTATE,
    execute: ({ input }) => layerVisualService.addEffect(input),
  },
  {
    name: 'scene.layers.effects.update',
    description:
      'Update one existing layer effect in place: enable/disable, rename, and/or set typed parameters validated against the installed effect schema.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['sceneName', 'effectName'],
      minProperties: 4,
      properties: {
        sceneName: NAME,
        ...LAYER_TARGET,
        effectName: NAME,
        newName: NAME,
        enabled: { type: 'boolean' },
        properties: EFFECT_PROPERTIES,
      },
      allOf: [LAYER_TARGET_REQUIREMENT],
    },
    metadata: MUTATE,
    execute: ({ input }) => layerVisualService.updateEffect(input),
  },
  {
    name: 'scene.layers.effects.reorder',
    description:
      'Move an existing layer effect to an exact zero-based position without recreating it or modifying unrelated layer/camera/effect state.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['sceneName', 'effectName', 'index'],
      properties: {
        sceneName: NAME,
        ...LAYER_TARGET,
        effectName: NAME,
        index: { type: 'integer', minimum: 0 },
      },
      allOf: [LAYER_TARGET_REQUIREMENT],
    },
    metadata: MUTATE,
    execute: ({ input }) => layerVisualService.reorderEffect(input),
  },
  {
    name: 'scene.layers.effects.remove',
    description:
      'Remove one named layer effect while preserving cameras, visibility, render ordering and unrelated layer properties.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['sceneName', 'effectName'],
      properties: {
        sceneName: NAME,
        ...LAYER_TARGET,
        effectName: NAME,
      },
      allOf: [LAYER_TARGET_REQUIREMENT],
    },
    metadata: MUTATE,
    execute: ({ input }) => layerVisualService.removeEffect(input),
  },
];
