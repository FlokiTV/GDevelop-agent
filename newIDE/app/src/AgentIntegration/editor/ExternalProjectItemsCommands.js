// @flow
import {
  makeCommandMetadata,
  type CommandDescriptor,
} from '../core/CommandRegistry';

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

const DESTRUCTIVE_METADATA = makeCommandMetadata({
  ...MUTATION_METADATA,
  destructive: true,
});

const NAME = { type: 'string', minLength: 1 };
const ASSOCIATED_LAYOUT = { type: 'string' };
const INSTANCE_PATCH = {
  objectName: NAME,
  x: { type: 'number' },
  y: { type: 'number' },
  z: { type: 'number' },
  angle: { type: 'number' },
  rotationX: { type: 'number' },
  rotationY: { type: 'number' },
  zOrder: { type: 'number' },
  opacity: { type: 'number' },
  layer: { type: 'string' },
  locked: { type: 'boolean' },
  sealed: { type: 'boolean' },
  hidden: { type: 'boolean' },
  flippedX: { type: 'boolean' },
  flippedY: { type: 'boolean' },
  flippedZ: { type: 'boolean' },
  keepRatio: { type: 'boolean' },
  hasCustomSize: { type: 'boolean' },
  hasCustomDepth: { type: 'boolean' },
  customWidth: { type: 'number' },
  customHeight: { type: 'number' },
  customDepth: { type: 'number' },
};

const emptyObjectSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {},
};

export const createExternalProjectItemsCommandDescriptors = ({
  externalProjectItemsService,
}: {|
  externalProjectItemsService: any,
|}): Array<CommandDescriptor> => [
  {
    name: 'external-events.list',
    description:
      'List External Events sheets in the current project with associated scene and root event count.',
    inputSchema: emptyObjectSchema,
    metadata: READ_METADATA,
    execute: () => externalProjectItemsService.listExternalEvents(),
  },
  {
    name: 'external-events.inspect',
    description:
      'Inspect one External Events sheet and its associated scene.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: { name: NAME },
    },
    metadata: READ_METADATA,
    execute: ({ input }) => externalProjectItemsService.inspectExternalEvents(input),
  },
  {
    name: 'external-events.create',
    description:
      'Create an External Events sheet, optionally associated with an existing scene.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: { name: NAME, associatedLayout: ASSOCIATED_LAYOUT },
    },
    metadata: MUTATION_METADATA,
    execute: ({ input }) => externalProjectItemsService.createExternalEvents(input),
  },
  {
    name: 'external-events.update',
    description: 'Update the scene associated with an External Events sheet.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: { name: NAME, associatedLayout: ASSOCIATED_LAYOUT },
    },
    metadata: MUTATION_METADATA,
    execute: ({ input }) => externalProjectItemsService.updateExternalEvents(input),
  },
  {
    name: 'external-events.rename',
    description:
      'Rename External Events with WholeProjectRefactorer so project references are rewritten.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'newName'],
      properties: { name: NAME, newName: NAME },
    },
    metadata: MUTATION_METADATA,
    execute: ({ input }) => externalProjectItemsService.renameExternalEvents(input),
  },
  {
    name: 'external-events.delete',
    description:
      'Delete External Events. Because GDevelop has no authoritative project-wide usage finder, allowReferenced=true is required.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: {
        name: NAME,
        allowReferenced: { type: 'boolean', default: false },
      },
    },
    metadata: DESTRUCTIVE_METADATA,
    execute: ({ input }) => externalProjectItemsService.deleteExternalEvents(input),
  },
  {
    name: 'external-layouts.list',
    description:
      'List External Layouts with associated scenes and initial instance counts.',
    inputSchema: emptyObjectSchema,
    metadata: READ_METADATA,
    execute: () => externalProjectItemsService.listExternalLayouts(),
  },
  {
    name: 'external-layouts.inspect',
    description: 'Inspect one External Layout and its associated scene.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: { name: NAME },
    },
    metadata: READ_METADATA,
    execute: ({ input }) => externalProjectItemsService.inspectExternalLayout(input),
  },
  {
    name: 'external-layouts.create',
    description:
      'Create an External Layout, optionally associated with an existing scene.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: { name: NAME, associatedLayout: ASSOCIATED_LAYOUT },
    },
    metadata: MUTATION_METADATA,
    execute: ({ input }) => externalProjectItemsService.createExternalLayout(input),
  },
  {
    name: 'external-layouts.update',
    description: 'Update the scene associated with an External Layout.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: { name: NAME, associatedLayout: ASSOCIATED_LAYOUT },
    },
    metadata: MUTATION_METADATA,
    execute: ({ input }) => externalProjectItemsService.updateExternalLayout(input),
  },
  {
    name: 'external-layouts.duplicate',
    description:
      'Duplicate an External Layout through canonical serialization, preserving its instances and editor settings.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'newName'],
      properties: { name: NAME, newName: NAME },
    },
    metadata: MUTATION_METADATA,
    execute: ({ input }) => externalProjectItemsService.duplicateExternalLayout(input),
  },
  {
    name: 'external-layouts.rename',
    description:
      'Rename an External Layout with WholeProjectRefactorer so project references are rewritten.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'newName'],
      properties: { name: NAME, newName: NAME },
    },
    metadata: MUTATION_METADATA,
    execute: ({ input }) => externalProjectItemsService.renameExternalLayout(input),
  },
  {
    name: 'external-layouts.delete',
    description:
      'Delete an External Layout. Because GDevelop has no authoritative project-wide usage finder, allowReferenced=true is required.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: {
        name: NAME,
        allowReferenced: { type: 'boolean', default: false },
      },
    },
    metadata: DESTRUCTIVE_METADATA,
    execute: ({ input }) => externalProjectItemsService.deleteExternalLayout(input),
  },
  {
    name: 'external-layouts.instances.list',
    description:
      'List initial instances in an External Layout, optionally filtering by object name.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: { name: NAME, objectName: NAME },
    },
    metadata: READ_METADATA,
    execute: ({ input }) =>
      externalProjectItemsService.listExternalLayoutInstances(input),
  },
  {
    name: 'external-layouts.instances.create',
    description:
      'Create an initial instance in an External Layout using an object available globally or in its associated scene.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'objectName'],
      properties: { name: NAME, ...INSTANCE_PATCH },
    },
    metadata: MUTATION_METADATA,
    execute: ({ input }) =>
      externalProjectItemsService.createExternalLayoutInstance(input),
  },
  {
    name: 'external-layouts.instances.update',
    description:
      'Update an External Layout initial instance by persistent UUID or an unambiguous UUID prefix.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'instanceId'],
      properties: { name: NAME, instanceId: NAME, ...INSTANCE_PATCH },
    },
    metadata: MUTATION_METADATA,
    execute: ({ input }) =>
      externalProjectItemsService.updateExternalLayoutInstance(input),
  },
  {
    name: 'external-layouts.instances.delete',
    description:
      'Delete one External Layout initial instance by persistent UUID or an unambiguous UUID prefix.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'instanceId'],
      properties: { name: NAME, instanceId: NAME },
    },
    metadata: DESTRUCTIVE_METADATA,
    execute: ({ input }) =>
      externalProjectItemsService.deleteExternalLayoutInstance(input),
  },
];
