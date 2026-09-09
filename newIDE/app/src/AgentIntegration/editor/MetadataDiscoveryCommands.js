// @flow
import {
  makeCommandMetadata,
  type CommandDescriptor,
} from '../core/CommandRegistry';

const PAGINATION_PROPERTIES = {
  limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
  offset: { type: 'integer', minimum: 0, default: 0 },
};

const DEPRECATION_PROPERTY = {
  type: 'string',
  enum: ['exclude', 'include', 'only'],
  default: 'exclude',
  description:
    'Filter deprecated metadata. Default excludes deprecated entries.',
};

const DISCOVERY_METADATA = makeCommandMetadata({
  requiresProject: true,
  cacheScope: 'project-revision',
  ttlMs: 30000,
});

const INSTRUCTION_FILTER_PROPERTIES = {
  query: { type: 'string' },
  kind: {
    type: 'string',
    enum: ['any', 'action', 'condition', 'expression'],
    default: 'any',
  },
  extension: {
    type: 'string',
    description: 'Exact extension name or namespace.',
  },
  objectType: {
    type: 'string',
    description:
      'Canonical object type used by the instruction scope/requirements.',
  },
  behaviorType: {
    type: 'string',
    description:
      'Canonical behavior type used by the instruction scope/requirements.',
  },
  deprecated: DEPRECATION_PROPERTY,
  includeHidden: { type: 'boolean', default: false },
};

const TYPE_FILTER_PROPERTIES = {
  query: { type: 'string' },
  extension: {
    type: 'string',
    description: 'Exact extension name or namespace.',
  },
  deprecated: DEPRECATION_PROPERTY,
  includeHidden: { type: 'boolean', default: false },
  renderingMode: {
    type: 'string',
    enum: ['any', '2d', '3d'],
    default: 'any',
  },
};

const makeListSchema = (properties: any) => ({
  type: 'object',
  additionalProperties: false,
  properties: {
    ...properties,
    ...PAGINATION_PROPERTIES,
  },
});

const makeDescribeTypeSchema = () => ({
  type: 'object',
  additionalProperties: false,
  required: ['type'],
  properties: {
    type: { type: 'string', minLength: 1 },
    extension: {
      type: 'string',
      description: 'Optional exact extension name/namespace disambiguator.',
    },
  },
});

export const createMetadataDiscoveryCommandDescriptors = ({
  metadataDiscoveryService,
}: {|
  metadataDiscoveryService: any,
|}): Array<CommandDescriptor> => [
  {
    name: 'events.instructions.search',
    description:
      'Search authoritative installed GDevelop actions, conditions and expressions, including canonical ids, parameter schemas, requirements, extension ownership and event-context compatibility.',
    inputSchema: makeListSchema(INSTRUCTION_FILTER_PROPERTIES),
    metadata: DISCOVERY_METADATA,
    execute: ({ input }) => metadataDiscoveryService.searchInstructions(input),
  },
  {
    name: 'events.instructions.describe',
    description:
      'Describe one installed GDevelop action, condition or expression by canonical id, with optional scope/extension disambiguation.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'string', minLength: 1 },
        kind: {
          type: 'string',
          enum: ['any', 'action', 'condition', 'expression'],
          default: 'any',
        },
        extension: { type: 'string' },
        objectType: { type: 'string' },
        behaviorType: { type: 'string' },
        includeHidden: { type: 'boolean', default: false },
      },
    },
    metadata: DISCOVERY_METADATA,
    execute: ({ input }) => metadataDiscoveryService.describeInstruction(input),
  },
  {
    name: 'editor.types.objects.list',
    description:
      'List installed GDevelop object types from the connected build, with canonical type, extension ownership, 2D/3D rendering metadata and capability-oriented search.',
    inputSchema: makeListSchema(TYPE_FILTER_PROPERTIES),
    metadata: DISCOVERY_METADATA,
    execute: ({ input }) => metadataDiscoveryService.listObjectTypes(input),
  },
  {
    name: 'editor.types.objects.describe',
    description:
      'Describe one installed GDevelop object type, including default configuration property schema when the type can be instantiated safely in an isolated temporary container.',
    inputSchema: makeDescribeTypeSchema(),
    metadata: DISCOVERY_METADATA,
    execute: ({ input }) => metadataDiscoveryService.describeObjectType(input),
  },
  {
    name: 'editor.types.behaviors.list',
    description:
      'List installed GDevelop behavior types with applicability constraints, required behaviors, extension ownership and searchable metadata.',
    inputSchema: makeListSchema({
      ...TYPE_FILTER_PROPERTIES,
      objectType: {
        type: 'string',
        description:
          'Optional canonical object type; behaviors restricted to a different object type are excluded.',
      },
    }),
    metadata: DISCOVERY_METADATA,
    execute: ({ input }) => metadataDiscoveryService.listBehaviorTypes(input),
  },
  {
    name: 'editor.types.behaviors.describe',
    description:
      'Describe one installed GDevelop behavior type, including object applicability, required behavior types and default/shared property schemas.',
    inputSchema: makeDescribeTypeSchema(),
    metadata: DISCOVERY_METADATA,
    execute: ({ input }) =>
      metadataDiscoveryService.describeBehaviorType(input),
  },
  {
    name: 'editor.types.effects.list',
    description:
      'List installed GDevelop effect types with extension ownership, uniqueness and 2D/3D compatibility metadata.',
    inputSchema: makeListSchema(TYPE_FILTER_PROPERTIES),
    metadata: DISCOVERY_METADATA,
    execute: ({ input }) => metadataDiscoveryService.listEffectTypes(input),
  },
  {
    name: 'editor.types.effects.describe',
    description:
      'Describe one installed GDevelop effect type, including its complete property defaults, choices and 2D/3D compatibility constraints.',
    inputSchema: makeDescribeTypeSchema(),
    metadata: DISCOVERY_METADATA,
    execute: ({ input }) => metadataDiscoveryService.describeEffectType(input),
  },
];
