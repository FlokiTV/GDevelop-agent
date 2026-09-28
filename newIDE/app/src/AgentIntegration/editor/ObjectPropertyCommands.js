// @flow
import {
  makeCommandMetadata,
  type CommandDescriptor,
} from '../core/CommandRegistry';

const TARGET_PROPERTIES = {
  targetKind: {
    type: 'string',
    enum: ['object-definition', 'scene-instance', 'behavior'],
    default: 'object-definition',
    description:
      'Property layer to inspect/mutate. Object definitions are serialized configuration, scene instances are InitialInstance overrides, and behavior targets address one attached behavior.',
  },
  objectName: {
    type: 'string',
    minLength: 1,
    description:
      'Object name. Required for object-definition and behavior targets; optional consistency check for scene-instance targets.',
  },
  sceneName: {
    type: 'string',
    minLength: 1,
    description:
      'Scene name. Required for scene-instance and scene-scoped definitions/behaviors.',
  },
  objectScope: {
    type: 'string',
    enum: ['auto', 'global', 'scene'],
    default: 'auto',
    description:
      'Resolution mode for object-definition/behavior targets. auto prefers a scene-local object when sceneName is supplied, then falls back to global.',
  },
  instanceId: {
    type: 'string',
    minLength: 1,
    description:
      'Persistent InitialInstance UUID or unambiguous prefix. Required for scene-instance.',
  },
  behaviorName: {
    type: 'string',
    minLength: 1,
    description: 'Attached behavior name. Required for behavior targets.',
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
        'Exact writable path returned by objects.properties.describe.',
    },
    value: {
      anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }],
      description:
        'Typed value. It must match the live descriptor/setter schema for the path.',
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

export const createObjectPropertyCommandDescriptors = ({
  objectPropertyService,
}: {|
  objectPropertyService: any,
|}): Array<CommandDescriptor> => [
  {
    name: 'objects.properties.describe',
    description:
      'Discover live property schemas for an object definition, scene instance or attached behavior. Returns typed current/default values where safe, writable/read-only state, constraints, attached behaviors/capabilities, runtime-only capability paths and the authoritative mutation contract before editing.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: TARGET_PROPERTIES,
      examples: [
        {
          targetKind: 'object-definition',
          sceneName: 'Game',
          objectName: 'Player',
        },
        {
          targetKind: 'scene-instance',
          sceneName: 'Game',
          instanceId: '01234567',
        },
        {
          targetKind: 'behavior',
          sceneName: 'Game',
          objectName: 'Player',
          behaviorName: 'Resizable',
        },
      ],
    },
    metadata: READ_METADATA,
    execute: ({ input }) => objectPropertyService.describe(input),
  },
  {
    name: 'objects.properties.set',
    description:
      'Mutate one or more exact writable property paths returned by objects.properties.describe. Values are validated against the live connected-build schema before the canonical EditorFunction or native InitialInstance setter is dispatched; read-only/runtime capability paths return actionable structured diagnostics.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['changes'],
      properties: {
        ...TARGET_PROPERTIES,
        changes: {
          type: 'array',
          minItems: 1,
          maxItems: 100,
          items: PROPERTY_CHANGE,
        },
      },
      examples: [
        {
          targetKind: 'object-definition',
          sceneName: 'Game',
          objectName: 'Label',
          changes: [{ path: 'configuration.text', value: 'Score' }],
        },
        {
          targetKind: 'scene-instance',
          sceneName: 'Game',
          instanceId: '01234567',
          changes: [{ path: 'instance.opacity', value: 192 }],
        },
      ],
    },
    metadata: MUTATION_METADATA,
    execute: ({ input, requestContext }) =>
      objectPropertyService.set(input, requestContext),
  },
];
