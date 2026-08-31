// @flow
import { AgentError } from './AgentError';
import {
  makeCommandMetadata,
  type CommandDescriptor,
} from './CommandRegistry';

const EMPTY_OBJECT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {},
};

export const createCoreCommandDescriptors = (): Array<CommandDescriptor> => [
  {
    name: 'agent.capabilities',
    description:
      'Return protocol-independent AgentIntegration capabilities and command metadata.',
    inputSchema: EMPTY_OBJECT_SCHEMA,
    metadata: makeCommandMetadata(),
    execute: ({ registry }) => ({
      commandCount: registry.size,
      commands: registry.list(),
    }),
  },
  {
    name: 'agent.commands.list',
    description: 'List registered AgentIntegration commands in deterministic order.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string' },
      },
    },
    metadata: makeCommandMetadata(),
    validateInput: input => {
      if (input.query !== undefined && typeof input.query !== 'string') {
        throw new AgentError({
          code: 'invalid_query',
          message: 'query must be a string.',
        });
      }
    },
    execute: ({ input, registry }) => ({
      commands: registry.list({ query: input.query }),
    }),
  },
  {
    name: 'agent.commands.describe',
    description: 'Describe one registered AgentIntegration command.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: {
        name: { type: 'string', minLength: 1 },
      },
    },
    metadata: makeCommandMetadata(),
    validateInput: input => {
      if (!input.name || typeof input.name !== 'string') {
        throw new AgentError({
          code: 'missing_command_name',
          message: 'name is required.',
        });
      }
    },
    execute: ({ input, registry }) => ({
      command: registry.describe(input.name),
    }),
  },
  {
    name: 'project.status',
    description:
      'Return the status of the GDevelop editor and currently open project.',
    inputSchema: EMPTY_OBJECT_SCHEMA,
    metadata: makeCommandMetadata(),
    execute: ({ environment }) => {
      if (typeof environment.getProjectStatus === 'function') {
        return environment.getProjectStatus();
      }

      const project = environment.project || null;
      return {
        projectOpen: !!project,
        projectName:
          project && typeof project.getName === 'function'
            ? project.getName()
            : null,
        projectUuid:
          project && typeof project.getProjectUuid === 'function'
            ? project.getProjectUuid()
            : null,
        fileIdentifier: environment.fileIdentifier || null,
        hasUnsavedChanges: !!environment.hasUnsavedChanges,
      };
    },
  },
];
