// @flow
import {
  makeCommandMetadata,
  type CommandDescriptor,
} from '../core/CommandRegistry';
import { REFERENCE_NODE_KINDS } from './ReferenceGraphService';

const READ_METADATA = makeCommandMetadata({
  requiresProject: true,
  cacheScope: 'project-revision',
  ttlMs: 10000,
});

const NODE_SELECTOR_PROPERTIES = {
  selector: {
    type: 'string',
    minLength: 1,
    description:
      'Preferred stable/canonical selector returned by a previous graph query.',
  },
  kind: {
    type: 'string',
    enum: REFERENCE_NODE_KINDS,
  },
  name: { type: 'string', minLength: 1 },
  path: { type: 'string', minLength: 1 },
};

const FILTER_PROPERTIES = {
  sceneName: { type: 'string', minLength: 1 },
  externalEventsName: { type: 'string', minLength: 1 },
  extensionName: { type: 'string', minLength: 1 },
  resourceKind: { type: 'string', minLength: 1 },
  referenceKinds: {
    type: 'array',
    maxItems: 100,
    uniqueItems: true,
    items: { type: 'string', minLength: 1 },
  },
  strengths: {
    type: 'array',
    maxItems: 3,
    uniqueItems: true,
    items: {
      type: 'string',
      enum: ['hard', 'soft', 'dynamic'],
    },
  },
};

const TRAVERSAL_PROPERTIES = {
  maxDepth: {
    type: 'integer',
    minimum: 0,
    maximum: 12,
    default: 1,
  },
  maxVisitedNodes: {
    type: 'integer',
    minimum: 1,
    maximum: 10000,
    default: 1000,
  },
  offset: { type: 'integer', minimum: 0, default: 0 },
  limit: {
    type: 'integer',
    minimum: 1,
    maximum: 2000,
    default: 200,
  },
};

const NODE_SELECTOR_REQUIREMENT = {
  anyOf: [
    { required: ['selector'] },
    { required: ['name'] },
    { required: ['path'] },
    { required: ['kind'] },
  ],
};

export const createReferenceGraphCommandDescriptors = ({
  referenceGraphService,
}: {|
  referenceGraphService: any,
|}): Array<CommandDescriptor> => [
  {
    name: 'references.graph.capabilities',
    description:
      'Describe project-wide reference graph node kinds, hard/soft/dynamic edge semantics, bounded traversal, pagination and DX integration coverage.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    metadata: READ_METADATA,
    execute: () => referenceGraphService.capabilities(),
  },
  {
    name: 'references.graph.query',
    description:
      'Traverse project-wide references from one stable selector/name/path in inbound, outbound or both directions. Edges carry exact Event Sheet handles/parameter locations where discoverable and preserve hard/soft/dynamic safety strength.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...NODE_SELECTOR_PROPERTIES,
        direction: {
          type: 'string',
          enum: ['inbound', 'outbound', 'both'],
          default: 'both',
        },
        ...TRAVERSAL_PROPERTIES,
        ...FILTER_PROPERTIES,
      },
      ...NODE_SELECTOR_REQUIREMENT,
    },
    metadata: READ_METADATA,
    execute: ({ input }) => referenceGraphService.query(input),
  },
  {
    name: 'references.graph.usages',
    description:
      'Find project-wide inbound usages of one entity without selecting a type-specific usage scanner. Supports bounded transitive traversal, filters and stable pagination.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...NODE_SELECTOR_PROPERTIES,
        ...TRAVERSAL_PROPERTIES,
        ...FILTER_PROPERTIES,
      },
      ...NODE_SELECTOR_REQUIREMENT,
    },
    metadata: READ_METADATA,
    execute: ({ input }) => referenceGraphService.usages(input),
  },
  {
    name: 'references.graph.impact',
    description:
      'Analyze rename/move/delete impact for one graph node. Returns affected references, auto-refactorable hard edges, blockers and unresolved soft/dynamic warnings without modifying the project.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['operation'],
      properties: {
        ...NODE_SELECTOR_PROPERTIES,
        operation: {
          type: 'string',
          enum: ['rename', 'move', 'delete'],
        },
        maxDepth: {
          type: 'integer',
          minimum: 0,
          maximum: 12,
          default: 2,
        },
        maxVisitedNodes: {
          type: 'integer',
          minimum: 1,
          maximum: 10000,
          default: 1000,
        },
        ...FILTER_PROPERTIES,
      },
      allOf: [NODE_SELECTOR_REQUIREMENT],
    },
    metadata: READ_METADATA,
    execute: ({ input }) => referenceGraphService.impact(input),
  },
];
