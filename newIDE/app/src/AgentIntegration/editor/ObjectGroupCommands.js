// @flow
import {
  makeCommandMetadata,
  type CommandDescriptor,
} from '../core/CommandRegistry';

const GROUP_SELECTOR = {
  groupName: { type: 'string', minLength: 1 },
  sceneName: {
    type: 'string',
    minLength: 1,
    description:
      'Scene owning a scene-scoped group. With groupScope=auto, a matching scene group is preferred before a global group.',
  },
  groupScope: {
    type: 'string',
    enum: ['auto', 'global', 'scene'],
    default: 'auto',
  },
};

const LIST_SCOPE = {
  sceneName: { type: 'string', minLength: 1 },
  groupScope: {
    type: 'string',
    enum: ['all', 'global', 'scene'],
    default: 'all',
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

export const createObjectGroupCommandDescriptors = ({
  objectGroupService,
}: {|
  objectGroupService: any,
|}): Array<CommandDescriptor> => [
  {
    name: 'objects.groups.list',
    description:
      'List global and/or scene object groups with canonical scope/name selectors, ordered concrete members, object types/scopes and diagnostics. No raw project JSON is required.',
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
    execute: ({ input }) => objectGroupService.list(input),
  },
  {
    name: 'objects.groups.get',
    description:
      'Describe one object group, its ordered members, resolved object types/scopes, canonical identity selector, diagnostics and reference semantics.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['groupName'],
      properties: GROUP_SELECTOR,
    },
    metadata: READ_METADATA,
    execute: ({ input }) => objectGroupService.get(input),
  },
  {
    name: 'objects.groups.for-object',
    description:
      'Reverse lookup every global/scene group containing a concrete object name. Results retain group scope and ordered membership.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['objectName'],
      properties: {
        objectName: { type: 'string', minLength: 1 },
        ...LIST_SCOPE,
      },
    },
    metadata: READ_METADATA,
    execute: ({ input }) => objectGroupService.groupsForObject(input),
  },
  {
    name: 'objects.groups.usages',
    description:
      'Find Event Sheet usages of one group with stable event/instruction handles and parameter indices where metadata proves an object-or-group reference. Dynamic/expression matches are reported separately and never presented as authoritative.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['groupName'],
      properties: GROUP_SELECTOR,
    },
    metadata: READ_METADATA,
    execute: ({ input }) => objectGroupService.usages(input),
  },
  {
    name: 'objects.groups.create',
    description:
      'Create a global or scene object group after namespace-conflict validation. Scene groups cannot collide with visible scene/global objects or groups.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['groupName', 'groupScope'],
      properties: {
        groupName: { type: 'string', minLength: 1 },
        groupScope: { type: 'string', enum: ['global', 'scene'] },
        sceneName: { type: 'string', minLength: 1 },
        position: { type: 'integer', minimum: 0 },
      },
    },
    metadata: MUTATION_METADATA,
    execute: ({ input }) => objectGroupService.create(input),
  },
  {
    name: 'objects.groups.rename',
    description:
      'Rename a group through GDevelop WholeProjectRefactorer so supported Event Sheet object/group references are rewritten before the group identity changes.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['groupName', 'newGroupName'],
      properties: {
        ...GROUP_SELECTOR,
        newGroupName: { type: 'string', minLength: 1 },
      },
    },
    metadata: MUTATION_METADATA,
    execute: ({ input }) => objectGroupService.rename(input),
  },
  {
    name: 'objects.groups.delete',
    description:
      'Plan or delete an object group. Defaults to dry-run and blocks apply while authoritative Event Sheet references remain, returning all discovered usages and coverage.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['groupName'],
      properties: {
        ...GROUP_SELECTOR,
        dryRun: { type: 'boolean', default: true },
      },
    },
    metadata: {
      ...MUTATION_METADATA,
      destructive: true,
    },
    modifiesProjectWhen: input => input.dryRun === false,
    execute: ({ input }) => objectGroupService.remove(input),
  },
  {
    name: 'objects.groups.members.add',
    description:
      'Add one existing concrete object to a group with scope validation and duplicate rejection. Scene groups can resolve scene or global objects; global groups accept global objects only.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['groupName', 'objectName'],
      properties: {
        ...GROUP_SELECTOR,
        objectName: { type: 'string', minLength: 1 },
      },
    },
    metadata: MUTATION_METADATA,
    execute: ({ input }) => objectGroupService.addMember(input),
  },
  {
    name: 'objects.groups.members.remove',
    description:
      'Remove one concrete object name from a group. Missing members fail with a structured diagnostic instead of silently changing nothing.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['groupName', 'objectName'],
      properties: {
        ...GROUP_SELECTOR,
        objectName: { type: 'string', minLength: 1 },
      },
    },
    metadata: {
      ...MUTATION_METADATA,
      destructive: true,
    },
    execute: ({ input }) => objectGroupService.removeMember(input),
  },
  {
    name: 'objects.groups.members.move',
    description:
      'Reorder one member inside a group by objectName or fromIndex. The membership set is preserved exactly.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['groupName', 'toIndex'],
      properties: {
        ...GROUP_SELECTOR,
        objectName: { type: 'string', minLength: 1 },
        fromIndex: { type: 'integer', minimum: 0 },
        toIndex: { type: 'integer', minimum: 0 },
      },
      anyOf: [{ required: ['objectName'] }, { required: ['fromIndex'] }],
    },
    metadata: MUTATION_METADATA,
    execute: ({ input }) => objectGroupService.moveMember(input),
  },
];
