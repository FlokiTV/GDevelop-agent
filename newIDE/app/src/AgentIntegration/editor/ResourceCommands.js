// @flow
import { AgentError } from '../core/AgentError';
import {
  makeCommandMetadata,
  type CommandDescriptor,
} from '../core/CommandRegistry';

const EMPTY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {},
};

const RESOURCE_NAME_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['resourceName'],
  properties: { resourceName: { type: 'string', minLength: 1 } },
};

const assertResourceName = (value: any) => {
  if (!value || typeof value !== 'string') {
    throw new AgentError({ code: 'missing_resource_name' });
  }
};

const assertFilePath = (value: any) => {
  if (!value || typeof value !== 'string') {
    throw new AgentError({ code: 'missing_resource_file_path' });
  }
};

export const createResourceCommandDescriptors = ({
  assetTools,
}: {|
  assetTools: any,
|}): Array<CommandDescriptor> => [
  {
    name: 'resources.list',
    description:
      'List project resources with usage, missing-file and project-folder health information.',
    inputSchema: EMPTY_SCHEMA,
    metadata: makeCommandMetadata({ requiresProject: true }),
    execute: () => assetTools.listResources(),
  },
  {
    name: 'resources.inspect',
    description:
      'Inspect one project resource, including its file status and objects that use it.',
    inputSchema: RESOURCE_NAME_SCHEMA,
    metadata: makeCommandMetadata({ requiresProject: true }),
    validateInput: input => assertResourceName(input.resourceName),
    execute: ({ input }) => assetTools.inspectResource(input.resourceName),
  },
  {
    name: 'resources.import-local',
    description:
      'Import a local file as a project resource, optionally copying it into the project folder.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['filePath'],
      properties: {
        filePath: { type: 'string', minLength: 1 },
        resourceName: { type: 'string' },
        kind: { type: 'string' },
        copyToProject: { type: 'boolean' },
        overwrite: { type: 'boolean' },
        preserveOrigin: { type: 'boolean' },
      },
    },
    metadata: makeCommandMetadata({
      readOnly: false,
      idempotent: false,
      requiresProject: true,
      modifiesProject: true,
      longRunning: true,
    }),
    validateInput: input => assertFilePath(input.filePath),
    execute: ({ input }) => assetTools.importLocalResource(input),
  },
  {
    name: 'resources.replace-local',
    description:
      'Replace the file backing an existing project resource while preserving resource identity and safety checks.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['resourceName', 'filePath'],
      properties: {
        resourceName: { type: 'string', minLength: 1 },
        filePath: { type: 'string', minLength: 1 },
        kind: { type: 'string' },
        copyToProject: { type: 'boolean' },
        preserveOrigin: { type: 'boolean' },
        deletePreviousFile: { type: 'boolean' },
      },
    },
    metadata: makeCommandMetadata({
      readOnly: false,
      destructive: true,
      idempotent: false,
      requiresProject: true,
      modifiesProject: true,
      longRunning: true,
    }),
    validateInput: input => {
      assertResourceName(input.resourceName);
      assertFilePath(input.filePath);
    },
    execute: ({ input }) => assetTools.replaceLocalResource(input),
  },
  {
    name: 'resources.rename',
    description:
      'Rename a project resource and update its references throughout the live project.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['resourceName', 'newResourceName'],
      properties: {
        resourceName: { type: 'string', minLength: 1 },
        newResourceName: { type: 'string', minLength: 1 },
      },
    },
    metadata: makeCommandMetadata({
      readOnly: false,
      idempotent: false,
      requiresProject: true,
      modifiesProject: true,
    }),
    validateInput: input => {
      assertResourceName(input.resourceName);
      if (!input.newResourceName || typeof input.newResourceName !== 'string') {
        throw new AgentError({ code: 'missing_new_resource_name' });
      }
    },
    execute: ({ input }) => assetTools.renameResource(input),
  },
  {
    name: 'resources.remove',
    description:
      'Remove an unused project resource. Optional physical file deletion remains restricted to safe project-local files.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['resourceName'],
      properties: {
        resourceName: { type: 'string', minLength: 1 },
        deleteFile: { type: 'boolean' },
      },
    },
    metadata: makeCommandMetadata({
      readOnly: false,
      destructive: true,
      idempotent: false,
      requiresProject: true,
      modifiesProject: true,
    }),
    validateInput: input => assertResourceName(input.resourceName),
    execute: ({ input }) => assetTools.removeResource(input),
  },
];
