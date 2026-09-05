// @flow
import { AgentError } from '../core/AgentError';
import {
  makeCommandMetadata,
  type CommandDescriptor,
} from '../core/CommandRegistry';
import {
  getFunctionMetadata,
  getFunctionMetadataStats,
  listFunctionMetadata,
} from '../FunctionMetadata';

const assertFunctionName = (name: any) => {
  if (!name || typeof name !== 'string') {
    throw new AgentError({
      code: 'missing_function_name',
      message: 'name is required.',
    });
  }
};

const assertExecutableFunction = (name: string, project: ?gdProject) => {
  const metadata = getFunctionMetadata(name);
  if (!metadata) {
    throw new AgentError({
      code: 'function_not_found',
      details: { name },
    });
  }
  if (!metadata.executableInEmbeddedApi) {
    throw new AgentError({
      code: 'function_not_executable',
      message: `${name} is not executable in the embedded editor integration.`,
      details: { name, executionScope: metadata.executionScope },
    });
  }
  if (metadata.requiresProject && !project) {
    throw new AgentError({
      code: 'no_project_open',
      message: `${name} requires an open GDevelop project.`,
    });
  }
  return metadata;
};

const LIST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    query: { type: 'string' },
    executableOnly: { type: 'boolean' },
  },
};

const CALL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: {
    name: { type: 'string', minLength: 1 },
    arguments: { type: 'object' },
    callId: { type: 'string' },
    save: { type: 'boolean' },
  },
};

const BATCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['calls'],
  properties: {
    calls: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      items: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1 },
          arguments: { type: 'object' },
          callId: { type: 'string' },
        },
      },
    },
    save: { type: 'boolean' },
  },
};

type Options = {|
  editorFunctionService: {| run: (options: any) => Promise<any> |},
|};

export const createEditorFunctionCommandDescriptors = ({
  editorFunctionService,
}: Options): Array<CommandDescriptor> => [
  {
    name: 'editor.functions.list',
    description:
      'List GDevelop EditorFunctions available to the embedded integration, with generated schemas and capability metadata.',
    inputSchema: LIST_SCHEMA,
    metadata: makeCommandMetadata(),
    validateInput: input => {
      if (input.query !== undefined && typeof input.query !== 'string') {
        throw new AgentError({ code: 'invalid_query' });
      }
      if (
        input.executableOnly !== undefined &&
        typeof input.executableOnly !== 'boolean'
      ) {
        throw new AgentError({ code: 'invalid_executable_only' });
      }
    },
    execute: ({ input }) => ({
      stats: getFunctionMetadataStats(),
      functions: listFunctionMetadata({
        query:
          typeof input.query === 'string' && input.query ? input.query : null,
        executableOnly:
          input.executableOnly === undefined ? true : input.executableOnly,
      }),
    }),
  },
  {
    name: 'editor.functions.describe',
    description:
      'Describe one GDevelop EditorFunction, including its input schema and mutation metadata.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: { name: { type: 'string', minLength: 1 } },
    },
    metadata: makeCommandMetadata(),
    validateInput: input => assertFunctionName(input.name),
    execute: ({ input }) => {
      const metadata = getFunctionMetadata(input.name);
      if (!metadata) {
        throw new AgentError({
          code: 'function_not_found',
          details: { name: input.name },
        });
      }
      return { function: metadata };
    },
  },
  {
    name: 'editor.functions.call',
    description:
      'Execute one GDevelop EditorFunction against the live editor project. The function metadata determines whether a project is required.',
    inputSchema: CALL_SCHEMA,
    metadata: makeCommandMetadata({
      readOnly: false,
      idempotent: false,
      longRunning: true,
      modifiesProject: true,
      defaultTimeoutMs: 180000,
    }),
    validateInput: input => assertFunctionName(input.name),
    execute: ({ environment, input }) => {
      assertExecutableFunction(input.name, environment.project || null);
      return editorFunctionService.run({
        calls: [
          {
            name: input.name,
            arguments: input.arguments,
            callId: input.callId,
          },
        ],
        save: !!input.save,
      });
    },
  },
  {
    name: 'editor.functions.call-batch',
    description:
      'Execute an ordered batch of up to 100 GDevelop EditorFunctions against the live editor project.',
    inputSchema: BATCH_SCHEMA,
    metadata: makeCommandMetadata({
      readOnly: false,
      idempotent: false,
      longRunning: true,
      modifiesProject: true,
      defaultTimeoutMs: 600000,
    }),
    validateInput: input => {
      if (!Array.isArray(input.calls) || input.calls.length === 0) {
        throw new AgentError({ code: 'no_function_calls' });
      }
      if (input.calls.length > 100) {
        throw new AgentError({ code: 'too_many_function_calls' });
      }
      input.calls.forEach((call, index) => {
        if (!call || typeof call.name !== 'string' || !call.name) {
          throw new AgentError({
            code: 'invalid_function_call',
            details: { index },
          });
        }
      });
    },
    execute: ({ environment, input }) => {
      input.calls.forEach(call =>
        assertExecutableFunction(call.name, environment.project || null)
      );
      return editorFunctionService.run({
        calls: input.calls,
        save: !!input.save,
      });
    },
  },
];
