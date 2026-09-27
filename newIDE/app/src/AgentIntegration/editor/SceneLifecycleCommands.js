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
const DESTRUCTIVE = makeCommandMetadata({
  ...MUTATE,
  destructive: true,
});

const NAME = { type: 'string', minLength: 1, maxLength: 500 };
const TARGET = {
  name: NAME,
  sceneName: NAME,
  sceneId: NAME,
  selector: NAME,
};

export const createSceneLifecycleCommandDescriptors = ({
  sceneLifecycleService,
}: {|
  sceneLifecycleService: any,
|}): Array<CommandDescriptor> => [
  {
    name: 'project.scenes.list',
    description:
      'List project scenes with persistent UUID identity, stable selector, order and basic metadata.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    metadata: READ,
    execute: () => sceneLifecycleService.list(),
  },
  {
    name: 'project.scenes.get',
    description:
      'Get one scene by persistent sceneId/selector or current display name.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: TARGET,
    },
    metadata: READ,
    execute: ({ input }) => sceneLifecycleService.get(input),
  },
  {
    name: 'project.scenes.usages',
    description:
      'Dry-run the native scene refactorer on an in-memory project clone and report every reference GDevelop would rewrite on rename.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: TARGET,
    },
    metadata: READ,
    execute: ({ input }) => sceneLifecycleService.usages(input),
  },
  {
    name: 'project.scenes.create',
    description: 'Create a scene at an optional deterministic order position.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: {
        name: NAME,
        position: { type: 'integer', minimum: 0 },
      },
    },
    metadata: MUTATE,
    execute: ({ input }) => sceneLifecycleService.create(input),
  },
  {
    name: 'project.scenes.duplicate',
    description:
      'Duplicate a scene while assigning a new persistent scene UUID and preserving the copied content.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['newName'],
      properties: {
        ...TARGET,
        newName: NAME,
        position: { type: 'integer', minimum: 0 },
      },
    },
    metadata: MUTATE,
    execute: ({ input }) => sceneLifecycleService.duplicate(input),
  },
  {
    name: 'project.scenes.rename',
    description:
      'Rename a scene with WholeProjectRefactorer while preserving its persistent scene UUID and returning updated references.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['newName'],
      properties: { ...TARGET, newName: NAME },
    },
    metadata: MUTATE,
    execute: ({ input }) => sceneLifecycleService.rename(input),
  },
  {
    name: 'project.scenes.reorder',
    description:
      'Move a scene to an exact zero-based project order without rebuilding unrelated scenes.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['position'],
      properties: {
        ...TARGET,
        position: { type: 'integer', minimum: 0 },
      },
    },
    metadata: MUTATE,
    execute: ({ input }) => sceneLifecycleService.reorder(input),
  },
  {
    name: 'project.scenes.delete',
    description:
      'Delete or dry-run deletion of a scene. Referenced scenes are blocked unless allowReferenced=true is explicit.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...TARGET,
        dryRun: { type: 'boolean', default: false },
        allowReferenced: { type: 'boolean', default: false },
      },
    },
    metadata: DESTRUCTIVE,
    modifiesProjectWhen: input => !input.dryRun,
    execute: ({ input }) => sceneLifecycleService.delete(input),
  },
];
