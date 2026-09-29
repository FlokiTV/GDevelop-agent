// @flow
import {
  makeCommandMetadata,
  type CommandDescriptor,
} from '../core/CommandRegistry';

const OBJECT_TARGET = {
  objectName: { type: 'string', minLength: 1 },
  sceneName: {
    type: 'string',
    minLength: 1,
    description:
      'Scene name for scene-scoped objects. With objectScope=auto, a matching scene object is preferred before a global object.',
  },
  objectScope: {
    type: 'string',
    enum: ['auto', 'global', 'scene'],
    default: 'auto',
  },
};

const PROPERTY_CHANGE = {
  type: 'object',
  additionalProperties: false,
  required: ['path', 'value'],
  properties: {
    path: {
      type: 'string',
      minLength: 1,
      description:
        'Exact behavior property path returned by objects.behaviors.describe / objects.properties.describe.',
    },
    value: {
      anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }],
    },
  },
};

const READ_METADATA = makeCommandMetadata({
  requiresProject: true,
  cacheScope: 'project-revision',
  ttlMs: 15000,
});

const MUTATION_METADATA = makeCommandMetadata({
  readOnly: false,
  idempotent: false,
  requiresProject: true,
  modifiesProject: true,
});

export const createBehaviorLifecycleCommandDescriptors = ({
  behaviorLifecycleService,
}: {|
  behaviorLifecycleService: any,
|}): Array<CommandDescriptor> => [
  {
    name: 'objects.behaviors.list',
    description:
      'List attached behaviors and capability interfaces on an object definition. Returns connected-build metadata, typed property schemas, dependencies and authoritative discovery/mutation paths without raw project JSON.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['objectName'],
      properties: OBJECT_TARGET,
    },
    metadata: READ_METADATA,
    execute: ({ input }) => behaviorLifecycleService.list(input),
  },
  {
    name: 'objects.behaviors.available',
    description:
      'Discover behavior/capability types available for a specific object using the connected extension registry and native ObjectTools compatibility checks before mutation. Results include structured compatibility diagnostics and current attachment/default-capability state.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['objectName'],
      properties: {
        ...OBJECT_TARGET,
        query: { type: 'string' },
        deprecated: {
          type: 'string',
          enum: ['exclude', 'include', 'only'],
          default: 'exclude',
        },
        includeCapabilities: { type: 'boolean', default: true },
        includeHidden: { type: 'boolean', default: false },
        compatibleOnly: { type: 'boolean', default: true },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
        offset: { type: 'integer', minimum: 0, default: 0 },
      },
    },
    metadata: READ_METADATA,
    execute: ({ input }) => behaviorLifecycleService.available(input),
  },
  {
    name: 'objects.behaviors.describe',
    description:
      'Describe one attached behavior/capability with extension ownership, dependency graph, typed DX-24 property schemas, capability operations unlocked by the behavior and instance-override/reference coverage.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['objectName', 'behaviorName'],
      properties: {
        ...OBJECT_TARGET,
        behaviorName: { type: 'string', minLength: 1 },
      },
    },
    metadata: READ_METADATA,
    execute: ({ input }) => behaviorLifecycleService.describe(input),
  },
  {
    name: 'objects.behaviors.add',
    description:
      'Attach a behavior after unique-name and native compatibility preflight. Required behaviors are added through WholeProjectRefactorer. Hidden capability behaviors remain object-type-managed and are never force-attached to unsupported object types.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['objectName', 'behaviorType'],
      properties: {
        ...OBJECT_TARGET,
        behaviorType: { type: 'string', minLength: 1 },
        behaviorName: {
          type: 'string',
          minLength: 1,
          description:
            'Optional attached name. Defaults to connected behavior metadata defaultName.',
        },
      },
    },
    metadata: MUTATION_METADATA,
    execute: ({ input }) => behaviorLifecycleService.add(input),
  },
  {
    name: 'objects.behaviors.update',
    description:
      'Apply typed property changes to an attached behavior using exact machine-readable paths. This delegates validation and mutation to DX-24 objects.properties.set.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['objectName', 'behaviorName', 'changes'],
      properties: {
        ...OBJECT_TARGET,
        behaviorName: { type: 'string', minLength: 1 },
        changes: {
          type: 'array',
          minItems: 1,
          maxItems: 100,
          items: PROPERTY_CHANGE,
        },
      },
    },
    metadata: MUTATION_METADATA,
    execute: ({ input, requestContext }) =>
      behaviorLifecycleService.update(input, requestContext),
  },
  {
    name: 'objects.behaviors.remove',
    description:
      'Preflight or remove an attached behavior with authoritative required-behavior dependency and InitialInstance-override checks. Defaults to dry-run; dependent behaviors and overrides require explicit opt-in. Default object capabilities cannot be removed.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['objectName', 'behaviorName'],
      properties: {
        ...OBJECT_TARGET,
        behaviorName: { type: 'string', minLength: 1 },
        dryRun: { type: 'boolean', default: true },
        cascadeDependents: { type: 'boolean', default: false },
        removeInstanceOverrides: { type: 'boolean', default: false },
      },
    },
    metadata: {
      ...MUTATION_METADATA,
      destructive: true,
    },
    modifiesProjectWhen: input => input.dryRun === false,
    execute: ({ input }) => behaviorLifecycleService.remove(input),
  },
];
