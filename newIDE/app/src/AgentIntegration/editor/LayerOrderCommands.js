// @flow
import {
  makeCommandMetadata,
  type CommandDescriptor,
} from '../core/CommandRegistry';

const READ = makeCommandMetadata({
  requiresProject: true,
  cacheScope: 'project-revision',
  ttlMs: 15000,
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
const LAYER_PRECONDITIONS = {
  expectedIndex: { type: 'integer', minimum: 0 },
  expectedName: { type: 'string', maxLength: 500 },
};
const INSTANCE_PRECONDITIONS = {
  expectedLayerId: UUID_OR_PREFIX,
  expectedLayerName: { type: 'string', maxLength: 500 },
  expectedZOrder: {
    type: 'integer',
    minimum: -2147483648,
    maximum: 2147483647,
  },
};

export const createLayerOrderCommandDescriptors = ({
  layerOrderService,
}: {|
  layerOrderService: any,
|}): Array<CommandDescriptor> => [
  {
    name: 'scene.layers.list',
    description:
      'List a scene layers in authoritative editor/project render order with persistent layer UUIDs, visibility/state metadata, membership and per-instance Z/render-order. Runtime dynamic changes are explicitly excluded.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['sceneName'],
      properties: {
        sceneName: NAME,
        includeInstances: { type: 'boolean', default: true },
      },
    },
    metadata: READ,
    execute: ({ input }) => layerOrderService.list(input),
  },
  {
    name: 'scene.render.compare',
    description:
      'Compare two persistent scene instances using authoritative editor/project layer order then Z-order. Equal Z-order on the same layer is reported as indeterminate because the editor container has no authoritative tie-break.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['sceneName', 'aInstanceId', 'bInstanceId'],
      properties: {
        sceneName: NAME,
        aInstanceId: UUID_OR_PREFIX,
        bInstanceId: UUID_OR_PREFIX,
      },
    },
    metadata: READ,
    execute: ({ input }) => layerOrderService.compare(input),
  },
  {
    name: 'scene.layers.create',
    description:
      'Create a named scene layer at an optional zero-based render-order position. The layer receives a persistent UUID and existing layers are not rebuilt.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['sceneName', 'name'],
      properties: {
        sceneName: NAME,
        name: NAME,
        position: { type: 'integer', minimum: 0 },
      },
    },
    metadata: MUTATE,
    execute: ({ input }) => layerOrderService.create(input),
  },
  {
    name: 'scene.layers.rename',
    description:
      'Rename a named scene layer while preserving its persistent UUID and using WholeProjectRefactorer to update instance/event references. Supports expected index/name conflict guards in addition to the canonical project revision/lease preconditions.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['sceneName', 'newName'],
      properties: {
        sceneName: NAME,
        ...LAYER_TARGET,
        ...LAYER_PRECONDITIONS,
        newName: NAME,
      },
      ...LAYER_TARGET_REQUIREMENT,
    },
    metadata: MUTATE,
    execute: ({ input }) => layerOrderService.rename(input),
  },
  {
    name: 'scene.layers.reorder',
    description:
      'Move an existing layer to an exact zero-based render-order position without recreating it or changing cameras, effects, visibility or unrelated layer properties.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['sceneName', 'position'],
      properties: {
        sceneName: NAME,
        ...LAYER_TARGET,
        ...LAYER_PRECONDITIONS,
        position: { type: 'integer', minimum: 0 },
      },
      ...LAYER_TARGET_REQUIREMENT,
    },
    metadata: MUTATE,
    execute: ({ input }) => layerOrderService.reorder(input),
  },
  {
    name: 'scene.layers.delete',
    description:
      'Safely delete a non-base layer by explicitly selecting a replacement layer. References and instances are moved to the replacement before the layer is removed, preventing silent instance loss.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['sceneName'],
      properties: {
        sceneName: NAME,
        ...LAYER_TARGET,
        ...LAYER_PRECONDITIONS,
        replacementLayerId: UUID_OR_PREFIX,
        replacementLayerName: { type: 'string', maxLength: 500 },
      },
      allOf: [
        LAYER_TARGET_REQUIREMENT,
        {
          anyOf: [
            { required: ['replacementLayerId'] },
            { required: ['replacementLayerName'] },
          ],
        },
      ],
    },
    metadata: MUTATE,
    execute: ({ input }) => layerOrderService.remove(input),
  },
  {
    name: 'scene.instances.move-layer',
    description:
      'Move one persistent InitialInstance to another existing layer in-place, preserving its UUID, Z-order and unrelated instance properties.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['sceneName', 'instanceId'],
      properties: {
        sceneName: NAME,
        instanceId: UUID_OR_PREFIX,
        targetLayerId: UUID_OR_PREFIX,
        targetLayerName: { type: 'string', maxLength: 500 },
        ...INSTANCE_PRECONDITIONS,
      },
      anyOf: [
        { required: ['targetLayerId'] },
        { required: ['targetLayerName'] },
      ],
    },
    metadata: MUTATE,
    execute: ({ input }) => layerOrderService.moveInstanceToLayer(input),
  },
  {
    name: 'scene.instances.set-render-order',
    description:
      'Set an instance integer Z-order or place it before/below or after/above another instance on the same layer. Relative changes only alter the target instance and return the resulting authoritative relation.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['sceneName', 'instanceId'],
      properties: {
        sceneName: NAME,
        instanceId: UUID_OR_PREFIX,
        zOrder: {
          type: 'integer',
          minimum: -2147483648,
          maximum: 2147483647,
        },
        beforeInstanceId: UUID_OR_PREFIX,
        afterInstanceId: UUID_OR_PREFIX,
        ...INSTANCE_PRECONDITIONS,
      },
      oneOf: [
        { required: ['zOrder'] },
        { required: ['beforeInstanceId'] },
        { required: ['afterInstanceId'] },
      ],
    },
    metadata: MUTATE,
    execute: ({ input }) => layerOrderService.setInstanceRenderOrder(input),
  },
];
