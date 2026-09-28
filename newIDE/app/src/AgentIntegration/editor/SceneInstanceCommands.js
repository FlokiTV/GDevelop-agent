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
const DELETE = makeCommandMetadata({
  readOnly: false,
  idempotent: false,
  destructive: true,
  requiresProject: true,
  modifiesProject: true,
});

const NAME = { type: 'string', minLength: 1, maxLength: 500 };
const UUID_OR_PREFIX = { type: 'string', minLength: 1, maxLength: 100 };
const SELECTOR = {
  type: 'string',
  minLength: 10,
  maxLength: 120,
  pattern: '^instance:',
};
const INSTANCE_TARGET = {
  instanceId: UUID_OR_PREFIX,
  selector: SELECTOR,
};
const INSTANCE_TARGET_REQUIREMENT = {
  oneOf: [{ required: ['instanceId'] }, { required: ['selector'] }],
};
const INSTANCE_PRECONDITIONS = {
  expectedInstanceRevision: {
    type: 'string',
    minLength: 1,
    maxLength: 100,
  },
  expectedObjectName: NAME,
};
const PROPERTY_CHANGE = {
  type: 'object',
  additionalProperties: false,
  required: ['path', 'value'],
  properties: {
    path: { type: 'string', minLength: 1, maxLength: 1000 },
    value: {
      anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }],
    },
  },
};
const NEAR = {
  type: 'object',
  additionalProperties: false,
  required: ['x', 'y', 'radius'],
  properties: {
    x: { type: 'number' },
    y: { type: 'number' },
    radius: { type: 'number', minimum: 0 },
  },
};
const SELECTION = {
  type: 'object',
  additionalProperties: false,
  properties: {
    all: {
      type: 'boolean',
      description:
        'Explicit opt-in to select the entire scene. Required for bulk-all operations instead of relying on an empty selector.',
    },
    instanceIds: {
      type: 'array',
      minItems: 1,
      maxItems: 500,
      uniqueItems: true,
      items: {
        type: 'string',
        minLength: 1,
        maxLength: 120,
        description:
          'Persistent UUID/prefix or instance:<uuid> selector. Each entry must resolve uniquely.',
      },
    },
    objectNames: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      uniqueItems: true,
      items: NAME,
    },
    objectTypes: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      uniqueItems: true,
      items: NAME,
    },
    layerNames: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      uniqueItems: true,
      items: { type: 'string', maxLength: 500 },
    },
    hidden: { type: 'boolean' },
    near: NEAR,
  },
};
const POSITION = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    x: { type: 'number' },
    y: { type: 'number' },
    z: { type: 'number' },
  },
};
const CREATE_POSITION = {
  type: 'object',
  additionalProperties: false,
  required: ['x', 'y'],
  properties: {
    x: { type: 'number' },
    y: { type: 'number' },
    z: { type: 'number' },
  },
};
const SIZE = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    width: { type: 'number', minimum: 0 },
    height: { type: 'number', minimum: 0 },
    depth: { type: 'number', minimum: 0 },
  },
};

export const createSceneInstanceCommandDescriptors = ({
  sceneInstanceService,
}: {|
  sceneInstanceService: any,
|}): Array<CommandDescriptor> => [
  {
    name: 'scene.instances.list',
    description:
      'List persistent scene InitialInstances with stable IDs/selectors, object/type, layer, position, angle, Z/render-order and visibility metadata. Optional filters never create or mutate instances.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['sceneName'],
      properties: {
        sceneName: NAME,
        selection: SELECTION,
        offset: { type: 'integer', minimum: 0, default: 0 },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 1000,
          default: 200,
        },
      },
    },
    metadata: READ,
    execute: ({ input }) => sceneInstanceService.list(input),
  },
  {
    name: 'scene.instances.get',
    description:
      'Get exactly one persistent scene instance by full UUID, unambiguous UUID prefix or instance:<uuid> selector. Returns its instanceRevision for guarded mutations and never falls back to point/brush matching.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['sceneName'],
      properties: {
        sceneName: NAME,
        ...INSTANCE_TARGET,
      },
      ...INSTANCE_TARGET_REQUIREMENT,
    },
    metadata: READ,
    execute: ({ input }) => sceneInstanceService.get(input),
  },
  {
    name: 'scene.instances.create',
    description:
      'Create exactly one new scene instance at explicit absolute scene coordinates. This is the only DX-27 single-instance operation that creates identity; update/transform never upsert from brush/point position.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['sceneName', 'objectName', 'position'],
      properties: {
        sceneName: NAME,
        objectName: NAME,
        position: CREATE_POSITION,
        angle: { type: 'number' },
        layerName: { type: 'string', maxLength: 500, default: '' },
        zOrder: {
          type: 'integer',
          minimum: -2147483648,
          maximum: 2147483647,
        },
        hidden: { type: 'boolean' },
        opacity: { type: 'number', minimum: 0, maximum: 255 },
      },
    },
    metadata: MUTATE,
    execute: ({ input }) => sceneInstanceService.create(input),
  },
  {
    name: 'scene.instances.update',
    description:
      'Update non-placement typed properties on one existing persistent instance through DX-24. The target must resolve uniquely; missing targets return structured not-found and this command never creates a replacement. Position/rotation/size, layer and Z-order have explicit commands.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['sceneName', 'changes'],
      properties: {
        sceneName: NAME,
        ...INSTANCE_TARGET,
        ...INSTANCE_PRECONDITIONS,
        changes: {
          type: 'array',
          minItems: 1,
          maxItems: 100,
          items: PROPERTY_CHANGE,
        },
      },
      allOf: [INSTANCE_TARGET_REQUIREMENT],
    },
    metadata: MUTATE,
    execute: ({ input, requestContext }) =>
      sceneInstanceService.update(input, requestContext),
  },
  {
    name: 'scene.instances.transform',
    description:
      'Move/transform exactly one existing persistent instance in place using absolute x/y/z, angle/rotation and native custom width/height/depth overrides. Generic multiplicative scale factors are not exposed because InitialInstance has no authoritative generic scaleX/scaleY/scaleZ contract.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['sceneName'],
      properties: {
        sceneName: NAME,
        ...INSTANCE_TARGET,
        ...INSTANCE_PRECONDITIONS,
        position: POSITION,
        angle: { type: 'number' },
        rotationX: { type: 'number' },
        rotationY: { type: 'number' },
        size: SIZE,
      },
      allOf: [
        INSTANCE_TARGET_REQUIREMENT,
        {
          anyOf: [
            { required: ['position'] },
            { required: ['angle'] },
            { required: ['rotationX'] },
            { required: ['rotationY'] },
            { required: ['size'] },
          ],
        },
      ],
    },
    metadata: MUTATE,
    execute: ({ input, requestContext }) =>
      sceneInstanceService.transform(input, requestContext),
  },
  {
    name: 'scene.instances.duplicate',
    description:
      'Clone one existing InitialInstance, preserve its configuration/placement by default, reset the clone persistent UUID and return the new stable identity. Optional offsets are explicit and relative to the source clone.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['sceneName'],
      properties: {
        sceneName: NAME,
        ...INSTANCE_TARGET,
        ...INSTANCE_PRECONDITIONS,
        offset: POSITION,
        angleOffset: { type: 'number' },
      },
      ...INSTANCE_TARGET_REQUIREMENT,
    },
    metadata: MUTATE,
    execute: ({ input }) => sceneInstanceService.duplicate(input),
  },
  {
    name: 'scene.instances.delete',
    description:
      'Delete exactly one existing persistent instance. expectedInstanceRevision from scene.instances.get is mandatory in addition to canonical DX-19 project expectedRevision/ownership safeguards.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['sceneName', 'expectedInstanceRevision'],
      properties: {
        sceneName: NAME,
        ...INSTANCE_TARGET,
        ...INSTANCE_PRECONDITIONS,
      },
      allOf: [INSTANCE_TARGET_REQUIREMENT],
    },
    metadata: DELETE,
    execute: ({ input }) => sceneInstanceService.remove(input),
  },
  {
    name: 'scene.instances.diagnose-duplicates',
    description:
      'Diagnose likely duplicate instances by same object name/type/layer and near placement/angle. Results are deterministic suggestions only: this command never deletes anything and cleanup requires explicit bulk-delete dry-run/apply.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['sceneName'],
      properties: {
        sceneName: NAME,
        selection: SELECTION,
        positionTolerance: { type: 'number', minimum: 0, default: 0.5 },
        zTolerance: { type: 'number', minimum: 0, default: 0.01 },
        angleTolerance: { type: 'number', minimum: 0, default: 0.1 },
      },
    },
    metadata: READ,
    execute: ({ input }) => sceneInstanceService.diagnoseDuplicates(input),
  },
  {
    name: 'scene.instances.bulk-update',
    description:
      'Safely update non-placement typed properties across an explicit selection. Defaults to dry-run, validates every selected target through DX-24, and requires the dry-run selectionRevision to apply so target-set drift is rejected.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['sceneName', 'selection', 'changes'],
      properties: {
        sceneName: NAME,
        selection: SELECTION,
        changes: {
          type: 'array',
          minItems: 1,
          maxItems: 100,
          items: PROPERTY_CHANGE,
        },
        dryRun: { type: 'boolean', default: true },
        expectedSelectionRevision: {
          type: 'string',
          minLength: 1,
          maxLength: 100,
        },
      },
    },
    metadata: MUTATE,
    modifiesProjectWhen: input => input.dryRun === false,
    execute: ({ input, requestContext }) =>
      sceneInstanceService.bulkUpdate(input, requestContext),
  },
  {
    name: 'scene.instances.bulk-delete',
    description:
      'Safely delete an explicit deterministic selection. Defaults to dry-run and requires the exact dry-run selectionRevision to apply; no empty selector implicitly means all.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['sceneName', 'selection'],
      properties: {
        sceneName: NAME,
        selection: SELECTION,
        dryRun: { type: 'boolean', default: true },
        expectedSelectionRevision: {
          type: 'string',
          minLength: 1,
          maxLength: 100,
        },
      },
    },
    metadata: DELETE,
    modifiesProjectWhen: input => input.dryRun === false,
    execute: ({ input }) => sceneInstanceService.bulkDelete(input),
  },
];
