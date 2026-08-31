// @flow
import { AgentError } from '../core/AgentError';
import {
  makeCommandMetadata,
  type CommandDescriptor,
} from '../core/CommandRegistry';

type ProjectLifecycleService = {|
  create: (input: any) => Promise<any>,
  open: (input: any) => Promise<any>,
  close: (input?: any) => Promise<any>,
  save: () => Promise<any>,
  saveAs: (input: any) => Promise<any>,
|};

const assertOptionalBoolean = (value: any, code: string) => {
  if (value !== undefined && typeof value !== 'boolean') {
    throw new AgentError({ code });
  }
};

export const createProjectLifecycleCommandDescriptors = ({
  projectLifecycleService,
}: {|
  projectLifecycleService: ProjectLifecycleService,
|}): Array<CommandDescriptor> => [
  {
    name: 'project.create',
    description:
      'Create a new GDevelop project in the live editor, optionally from an example template. Saving is always explicit.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: {
        name: { type: 'string', minLength: 1 },
        templateSlug: { type: 'string' },
      },
    },
    metadata: makeCommandMetadata({
      readOnly: false,
      idempotent: false,
      modifiesProject: true,
    }),
    validateInput: input => {
      if (!input.name || typeof input.name !== 'string') {
        throw new AgentError({ code: 'missing_project_name' });
      }
      if (
        input.templateSlug !== undefined &&
        typeof input.templateSlug !== 'string'
      ) {
        throw new AgentError({ code: 'invalid_template_slug' });
      }
    },
    execute: ({ input }) => projectLifecycleService.create(input),
  },
  {
    name: 'project.open',
    description:
      'Open a local GDevelop project. Unsaved changes are never discarded unless explicitly requested.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['filePath'],
      properties: {
        filePath: { type: 'string', minLength: 1 },
        discardUnsavedChanges: { type: 'boolean' },
      },
    },
    metadata: makeCommandMetadata({
      readOnly: false,
      destructive: true,
      idempotent: false,
      modifiesProject: true,
    }),
    validateInput: input => {
      if (!input.filePath || typeof input.filePath !== 'string') {
        throw new AgentError({ code: 'missing_project_file_path' });
      }
      assertOptionalBoolean(
        input.discardUnsavedChanges,
        'invalid_discard_unsaved_changes'
      );
    },
    execute: ({ input }) => projectLifecycleService.open(input),
  },
  {
    name: 'project.close',
    description:
      'Close the current project. Unsaved changes are never discarded unless explicitly requested.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { discardUnsavedChanges: { type: 'boolean' } },
    },
    metadata: makeCommandMetadata({
      readOnly: false,
      destructive: true,
      idempotent: true,
      modifiesProject: true,
    }),
    validateInput: input =>
      assertOptionalBoolean(
        input.discardUnsavedChanges,
        'invalid_discard_unsaved_changes'
      ),
    execute: ({ input }) => projectLifecycleService.close(input),
  },
  {
    name: 'project.save',
    description:
      'Explicitly save the currently open GDevelop project to its existing storage location.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    metadata: makeCommandMetadata({
      readOnly: false,
      idempotent: true,
      requiresProject: true,
    }),
    execute: () => projectLifecycleService.save(),
  },
  {
    name: 'project.save-as',
    description:
      'Explicitly save the currently open GDevelop project to a local file path.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['filePath'],
      properties: {
        filePath: { type: 'string', minLength: 1 },
        name: { type: 'string' },
      },
    },
    metadata: makeCommandMetadata({
      readOnly: false,
      idempotent: false,
      requiresProject: true,
    }),
    validateInput: input => {
      if (!input.filePath || typeof input.filePath !== 'string') {
        throw new AgentError({ code: 'missing_project_file_path' });
      }
    },
    execute: ({ input }) => projectLifecycleService.saveAs(input),
  },
];
