// @flow
import { AgentError, AGENT_ERROR_CODES } from '../core/AgentError';
import {
  makeCommandMetadata,
  type CommandDescriptor,
} from '../core/CommandRegistry';
import {
  getFunctionMetadata,
  getFunctionMetadataStats,
  listFunctionMetadata,
  type AgentFunctionMetadata,
} from '../FunctionMetadata';

const GENERIC_EDITOR_FUNCTION_COMMAND_NAMES = new Set([
  'editor.functions.list',
  'editor.functions.describe',
  'editor.functions.call',
  'editor.functions.call-batch',
]);

const DESTRUCTIVE_EDITOR_FUNCTION_NAMES = new Set([
  'add_or_edit_variable',
  'change_behavior_property',
  'change_gameplay_tests',
  'change_object_properties_effects',
  'change_object_property',
  'change_project_properties_resources',
  'change_scene_properties_layers_effects_groups',
  'create_object',
  'create_or_replace_object',
  'put_2d_instances',
  'put_3d_instances',
  'remove_behavior',
  'run_gameplay_test',
  'run_script',
]);

const LONG_RUNNING_EDITOR_FUNCTION_TIMEOUTS = new Map([
  ['add_scene_events', 180000],
  ['create_object', 180000],
  ['create_or_replace_object', 180000],
  ['generate_events', 180000],
  ['initialize_project', 180000],
  ['run_gameplay_test', 180000],
  ['run_script', 180000],
]);

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

const matchesSchemaType = (value: any, type: string): boolean => {
  switch (type) {
    case 'array':
      return Array.isArray(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'integer':
      return Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'object':
      return !!value && typeof value === 'object' && !Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'null':
      return value === null;
    default:
      return true;
  }
};

const validateKnownFunctionArguments = (
  input: { [string]: any },
  metadata: AgentFunctionMetadata
) => {
  const schema = metadata.inputSchema || {};
  const properties = schema.properties || {};
  const required = Array.isArray(schema.required) ? schema.required : [];

  required.forEach(argumentName => {
    if (input[argumentName] === undefined) {
      throw new AgentError({
        code: AGENT_ERROR_CODES.INVALID_COMMAND_INPUT,
        message: `Missing required EditorFunction argument: ${argumentName}.`,
        details: { functionName: metadata.name, argumentName },
      });
    }
  });

  Object.keys(properties).forEach(argumentName => {
    if (input[argumentName] === undefined) return;
    const propertySchema = properties[argumentName] || {};
    const value = input[argumentName];
    const allowedTypes = propertySchema.type
      ? [propertySchema.type]
      : Array.isArray(propertySchema.anyOf)
      ? propertySchema.anyOf
          .map(option => option && option.type)
          .filter(type => typeof type === 'string')
      : [];

    if (
      allowedTypes.length &&
      !allowedTypes.some(type => matchesSchemaType(value, type))
    ) {
      throw new AgentError({
        code: AGENT_ERROR_CODES.INVALID_COMMAND_INPUT,
        message: `Invalid type for EditorFunction argument: ${argumentName}.`,
        details: {
          functionName: metadata.name,
          argumentName,
          allowedTypes,
        },
      });
    }
    if (
      Array.isArray(propertySchema.enum) &&
      !propertySchema.enum.includes(value)
    ) {
      throw new AgentError({
        code: AGENT_ERROR_CODES.INVALID_COMMAND_INPUT,
        message: `Invalid value for EditorFunction argument: ${argumentName}.`,
        details: {
          functionName: metadata.name,
          argumentName,
          allowedValues: propertySchema.enum,
        },
      });
    }
  });
};

export const getTypedEditorFunctionCommandName = (
  functionName: string
): string => {
  if (!/^[a-z][a-z0-9_]*$/.test(functionName)) {
    throw new Error(`invalid_editor_function_name:${functionName}`);
  }
  return `editor.functions.${functionName.replace(/_/g, '-')}`;
};

const getTypedEditorFunctionCommandMetadata = (
  metadata: AgentFunctionMetadata
) => {
  const modifiesProject = metadata.mayModifyProject;
  const defaultTimeoutMs = LONG_RUNNING_EDITOR_FUNCTION_TIMEOUTS.get(
    metadata.name
  );
  return makeCommandMetadata({
    readOnly: !modifiesProject,
    destructive: DESTRUCTIVE_EDITOR_FUNCTION_NAMES.has(metadata.name),
    idempotent: !modifiesProject,
    longRunning: !!defaultTimeoutMs,
    requiresProject: metadata.requiresProject,
    modifiesProject,
    ...(defaultTimeoutMs ? { defaultTimeoutMs } : {}),
    ...(!modifiesProject && metadata.requiresProject
      ? { cacheScope: 'project-revision', ttlMs: 30000 }
      : {}),
  });
};

const getTypedEditorFunctionInputSchema = (metadata: AgentFunctionMetadata) => {
  const examples = metadata.examples
    .map(example => example && example.arguments)
    .filter(
      argumentsValue => !!argumentsValue && typeof argumentsValue === 'object'
    )
    .filter(argumentsValue => {
      try {
        validateKnownFunctionArguments(argumentsValue, metadata);
        return true;
      } catch (error) {
        return false;
      }
    });
  return {
    ...metadata.inputSchema,
    ...(examples.length ? { examples } : {}),
  };
};

export const createTypedEditorFunctionCommandDescriptors = ({
  editorFunctionService,
}: {|
  editorFunctionService: {| run: (options: any) => Promise<any> |},
|}): Array<CommandDescriptor> => {
  const commandNames = new Set(GENERIC_EDITOR_FUNCTION_COMMAND_NAMES);
  return listFunctionMetadata({ executableOnly: true }).map(metadata => {
    const commandName = getTypedEditorFunctionCommandName(metadata.name);
    if (commandNames.has(commandName)) {
      throw new Error(`duplicate_typed_editor_function_command:${commandName}`);
    }
    commandNames.add(commandName);

    return {
      name: commandName,
      description: `Execute the GDevelop EditorFunction '${
        metadata.name
      }' directly with its function-specific arguments. ${
        metadata.description
      }`,
      inputSchema: getTypedEditorFunctionInputSchema(metadata),
      metadata: getTypedEditorFunctionCommandMetadata(metadata),
      validateInput: input => validateKnownFunctionArguments(input, metadata),
      execute: ({ input, requestContext }) =>
        editorFunctionService.run({
          signal: requestContext && requestContext.signal,
          calls: [
            {
              name: metadata.name,
              arguments: input,
            },
          ],
          save: false,
        }),
    };
  });
};

const LIST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    query: { type: 'string' },
    executableOnly: { type: 'boolean' },
  },
  examples: [{ query: 'instance', executableOnly: true }],
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
  examples: [
    {
      name: 'inspect_variables',
      arguments: { variable_scope: 'global' },
    },
  ],
};

const EDITOR_FUNCTION_DISCOVERY_METADATA = makeCommandMetadata({
  cacheScope: 'process',
  ttlMs: 60000,
});

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
  examples: [
    {
      calls: [
        { name: 'inspect_variables', arguments: { variable_scope: 'global' } },
        { name: 'describe_instances', arguments: { scene_name: 'Scene' } },
      ],
    },
  ],
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
    metadata: EDITOR_FUNCTION_DISCOVERY_METADATA,
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
      examples: [{ name: 'inspect_variables' }],
    },
    metadata: EDITOR_FUNCTION_DISCOVERY_METADATA,
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
    execute: ({ environment, input, requestContext }) => {
      assertExecutableFunction(input.name, environment.project || null);
      return editorFunctionService.run({
        signal: requestContext && requestContext.signal,
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
    execute: ({ environment, input, requestContext }) => {
      input.calls.forEach(call =>
        assertExecutableFunction(call.name, environment.project || null)
      );
      return editorFunctionService.run({
        signal: requestContext && requestContext.signal,
        calls: input.calls,
        save: !!input.save,
      });
    },
  },
  ...createTypedEditorFunctionCommandDescriptors({ editorFunctionService }),
];
