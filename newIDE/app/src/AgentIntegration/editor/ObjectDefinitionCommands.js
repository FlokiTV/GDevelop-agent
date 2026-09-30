// @flow
import {
  makeCommandMetadata,
  type CommandDescriptor,
} from '../core/CommandRegistry';

const OBJECT_SELECTOR = {
  objectId: {
    type: 'string',
    minLength: 1,
    description:
      'Persistent object-definition UUID. Preferred stable selector across rename and supported scope moves.',
  },
  objectName: { type: 'string', minLength: 1 },
  sceneName: {
    type: 'string',
    minLength: 1,
    description:
      'Scene name for scene-scoped definitions. With objectScope=auto, a matching scene object is preferred before global.',
  },
  objectScope: {
    type: 'string',
    enum: ['auto', 'global', 'scene'],
    default: 'auto',
  },
};

const LIST_SCOPE = {
  sceneName: { type: 'string', minLength: 1 },
  objectScope: {
    type: 'string',
    enum: ['all', 'global', 'scene'],
    default: 'all',
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
        'Exact writable path from objects.properties.describe for the newly created object.',
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

export const createObjectDefinitionCommandDescriptors = ({
  objectDefinitionService,
}: {|
  objectDefinitionService: any,
|}): Array<CommandDescriptor> => [
  {
    name: 'objects.definitions.list',
    description:
      'List global and/or scene object definitions with persistent UUID identity, name, type, scope/owner and valid scope transitions. Type metadata comes from the connected extension registry.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...LIST_SCOPE,
        query: { type: 'string' },
        offset: { type: 'integer', minimum: 0, default: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
      },
    },
    metadata: READ_METADATA,
    execute: ({ input }) => objectDefinitionService.list(input),
  },
  {
    name: 'objects.definitions.get',
    description:
      'Describe one object definition by persistent UUID or scope/name, including type ownership, attached behaviors, resource links and MCP discovery paths for properties, behaviors, groups and usages.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: OBJECT_SELECTOR,
      anyOf: [{ required: ['objectId'] }, { required: ['objectName'] }],
    },
    metadata: READ_METADATA,
    execute: ({ input }) => objectDefinitionService.get(input),
  },
  {
    name: 'objects.definitions.usages',
    description:
      'Inspect object-definition usages across InitialInstances, object groups and Event Sheets plus intrinsic behavior/resource dependencies. Exact object-typed Event Sheet references carry stable handles; dynamic/text matches are separated as potential references.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: OBJECT_SELECTOR,
      anyOf: [{ required: ['objectId'] }, { required: ['objectName'] }],
    },
    metadata: READ_METADATA,
    execute: ({ input }) => objectDefinitionService.usages(input),
  },
  {
    name: 'objects.definitions.create',
    description:
      'Create a global or scene object definition from an explicit connected-build object type after namespace/type validation. Optional initial property changes use the typed DX-24 objects.properties.set contract.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['objectName', 'objectType', 'objectScope'],
      properties: {
        objectName: { type: 'string', minLength: 1 },
        objectType: {
          type: 'string',
          minLength: 1,
          description:
            'Canonical type returned by editor.types.objects.list/describe.',
        },
        objectScope: { type: 'string', enum: ['global', 'scene'] },
        sceneName: { type: 'string', minLength: 1 },
        position: { type: 'integer', minimum: 0 },
        initialProperties: {
          type: 'array',
          maxItems: 100,
          items: PROPERTY_CHANGE,
        },
      },
    },
    metadata: MUTATION_METADATA,
    execute: ({ input, requestContext }) =>
      objectDefinitionService.create(input, requestContext),
  },
  {
    name: 'objects.definitions.duplicate',
    description:
      'Clone an object definition with native configuration, variables, effects and behaviors, then assign a fresh persistent UUID. Instances are not duplicated.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['newObjectName'],
      properties: {
        ...OBJECT_SELECTOR,
        newObjectName: { type: 'string', minLength: 1 },
        targetScope: { type: 'string', enum: ['global', 'scene'] },
        targetSceneName: { type: 'string', minLength: 1 },
        position: { type: 'integer', minimum: 0 },
      },
      allOf: [
        { anyOf: [{ required: ['objectId'] }, { required: ['objectName'] }] },
      ],
    },
    metadata: MUTATION_METADATA,
    execute: ({ input }) => objectDefinitionService.duplicate(input),
  },
  {
    name: 'objects.definitions.rename',
    description:
      'Rename an object definition while preserving its persistent identity. Uses WholeProjectRefactorer so supported instances, groups and Event Sheet object references are rewritten before the object name changes.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['newObjectName'],
      properties: {
        ...OBJECT_SELECTOR,
        newObjectName: { type: 'string', minLength: 1 },
      },
      allOf: [
        { anyOf: [{ required: ['objectId'] }, { required: ['objectName'] }] },
      ],
    },
    metadata: MUTATION_METADATA,
    execute: ({ input }) => objectDefinitionService.rename(input),
  },
  {
    name: 'objects.definitions.delete',
    description:
      'Plan or delete an object definition. Defaults to dry-run and reports instances, groups, Event Sheet references, behavior/resource dependencies and dynamic-reference warnings. Apply is blocked until authoritative usages are removed.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...OBJECT_SELECTOR,
        dryRun: { type: 'boolean', default: true },
        acknowledgePotentialReferences: { type: 'boolean', default: false },
      },
      allOf: [
        { anyOf: [{ required: ['objectId'] }, { required: ['objectName'] }] },
      ],
    },
    metadata: {
      ...MUTATION_METADATA,
      destructive: true,
    },
    modifiesProjectWhen: input => input.dryRun === false,
    execute: ({ input }) => objectDefinitionService.remove(input),
  },
  {
    name: 'objects.definitions.move-scope',
    description:
      'Plan or promote a scene-local object definition to global scope while preserving its persistent UUID and metadata. Global-to-scene demotion is reported as unsupported because the native editor cannot safely demote a definition that other scenes may depend on.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['targetScope'],
      properties: {
        ...OBJECT_SELECTOR,
        targetScope: { type: 'string', enum: ['global', 'scene'] },
        dryRun: { type: 'boolean', default: true },
        acknowledgeNewGlobalBindings: { type: 'boolean', default: false },
      },
      allOf: [
        { anyOf: [{ required: ['objectId'] }, { required: ['objectName'] }] },
      ],
    },
    metadata: MUTATION_METADATA,
    modifiesProjectWhen: input => input.dryRun === false,
    execute: ({ input }) => objectDefinitionService.moveScope(input),
  },
];
