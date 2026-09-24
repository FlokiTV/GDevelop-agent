// @flow
import {
  editorFunctions,
  editorFunctionsWithoutProject,
} from '../EditorFunctions';
import { generatedFunctionMetadata } from './FunctionMetadata.generated';
import { NON_SCRIPTABLE_FUNCTION_NAMES } from '../EditorFunctions/ScriptExecution/NonScriptableFunctionNames';
import { FUNCTION_TYPES } from '../EditorFunctions/Extensions/CustomFunctionFunctions';
import { PARAMETER_TYPES } from '../EditorFunctions/Extensions/ParameterChanges';

const EXPRESSION_TYPES = ['number', 'string'];

const FUNCTION_SETTING_NAMES = [
  'fullName',
  'description',
  'sentence',
  'group',
  'getterName',
  'isPrivate',
  'isAsync',
  'functionType',
  'expressionType',
  'helpUrl',
  'isDeprecated',
  'deprecationMessage',
];

const EXTENSION_PROPERTY_NAMES = [
  'fullName',
  'shortDescription',
  'description',
  'category',
  'tags',
  'version',
  'author',
  'helpPath',
  'previewIconUrl',
  'iconUrl',
  'dimension',
];

const DEPENDENCY_TYPES = ['npm', 'cordova'];

const nonScriptableFunctionReasons = new Map([
  ['run_script', 'recursive-script-execution-disabled'],
  ['initialize_project', 'project-bootstrap-outside-script'],
  ['read_full_docs', 'generation-service-only'],
  ['search_docs', 'generation-service-only'],
  ['search_object_asset_store', 'generation-service-only'],
  ['search_resource_store', 'generation-service-only'],
  ['create_or_update_plan', 'generation-service-only'],
  ['report_fulfilment_problem', 'generation-service-only'],
  ['run_edit_agent', 'generation-service-only'],
  ['run_explorer_agent', 'generation-service-only'],
  ['get_game_starter_summary', 'project-bootstrap-outside-script'],
  ['generate_events', 'orchestrator-event-generation-outside-script'],
  ['add_scene_events', 'orchestrator-event-generation-outside-script'],
  ['run_tests', 'long-running-preview-lifecycle-outside-script'],
  ['run_gameplay_test', 'long-running-preview-lifecycle-outside-script'],
]);

export const getNonScriptableFunctionReason = (name: string): string | null => {
  if (!NON_SCRIPTABLE_FUNCTION_NAMES.has(name)) return null;
  return (
    nonScriptableFunctionReasons.get(name) || 'non-scriptable-editor-function'
  );
};

export type AgentFunctionArgumentMetadata = {|
  name: string,
  type: string,
  required: boolean,
  provenance: string,
  enum?: Array<any>,
  description?: string,
  schema?: Object,
|};

export type AgentFunctionExposure = {|
  available: boolean,
  hiddenReason: ?string,
  toolName?: ?string,
|};

export type AgentFunctionMetadata = {|
  name: string,
  implementation: string,
  description: string,
  arguments: Array<AgentFunctionArgumentMetadata>,
  inputSchema: Object,
  modifiesProject: boolean,
  mayModifyProject: boolean,
  modificationMode: 'always' | 'never' | 'argument-dependent',
  readOnly: boolean,
  requiresProject: boolean,
  executableInEmbeddedApi: boolean,
  executionScope: 'embedded-editor' | 'generation-service',
  aliases: Array<string>,
  source: ?{| file: string, line: ?number |},
  examples: Array<Object>,
  capabilities: Array<string>,
  exposure: {|
    discovery: {|
      listed: boolean,
      describable: boolean,
    |},
    genericCall: AgentFunctionExposure,
    typedTool: AgentFunctionExposure,
    runScript: AgentFunctionExposure,
    readOnlyRunScript: AgentFunctionExposure,
  |},
|};

const descriptionOverrides = {
  create_extension:
    'Create a project-owned events extension, optionally duplicating an existing extension.',
  change_extension_properties:
    'Change, rename or delete a project-owned events extension and its dependency metadata.',
  create_custom_function:
    'Create an Action, Condition or expression function in a project-owned extension scope with typed parameters and return metadata.',
  change_custom_function:
    'Change, rename or delete a custom extension function, including settings and typed parameters.',
  inspect_extension:
    'Inspect project-owned extension declarations, functions, call forms and editable metadata.',
  add_or_edit_variable:
    'Create, update, rename, move/reorder or delete project, scene, object or instance variables without destructive declaration reconstruction.',
  change_project_properties_resources:
    'Change project properties and resource configuration.',
  change_scene_properties_layers_effects_groups:
    'Change scene properties, layers, effects and object groups.',
  create_or_update_plan:
    'Create or update the orchestration plan. This function is handled by the generation service.',
  describe_instances:
    'Inspect initial instances in a scene, including stable shortened IDs and per-instance state.',
  get_game_starter_summary:
    'Return the starter/template summary used while initializing a project.',
  initialize_project:
    'Initialize a new project, optionally from a template, without requiring an already-open project.',
  inspect_project_properties_resources:
    'Inspect project properties and resources without modifying the project.',
  inspect_scene_properties_layers_effects:
    'Inspect scene properties, layers and effects without modifying the project.',
  inspect_variables:
    'Inspect variables at global, scene, object or instance scope.',
  read_full_docs:
    'Read complete GDevelop documentation for extensions. This function is handled by the generation service.',
  read_game_project_json:
    'Read a bounded portion of the simplified game project structure as JSON.',
  report_fulfilment_problem:
    'Report a generation fulfilment problem. This function is handled by the generation service.',
  run_edit_agent:
    'Delegate editing work to a sub-agent. This function is handled by the generation service.',
  run_explorer_agent:
    'Delegate project exploration to a sub-agent. This function is handled by the generation service.',
  run_tests:
    'Run generation-service test orchestration. Direct embedded gameplay tests use run_gameplay_test instead.',
  search_docs:
    'Search GDevelop documentation. This function is handled by the generation service.',
  search_object_asset_store:
    'Search the GDevelop object asset store. This function is handled by the generation service.',
  search_resource_store:
    'Search the GDevelop resource store. This function is handled by the generation service.',
};

const extensionFunctionScopeSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'extension_name'],
  properties: {
    type: {
      type: 'string',
      enum: ['extension', 'custom_behavior', 'custom_object'],
    },
    extension_name: { type: 'string', minLength: 1 },
    custom_behavior_name: { type: 'string', minLength: 1 },
    custom_object_name: { type: 'string', minLength: 1 },
  },
};

const functionParameterSpecSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'type'],
  properties: {
    name: { type: 'string', minLength: 1 },
    type: { type: 'string', enum: PARAMETER_TYPES },
    label: { type: 'string' },
    long_description: { type: 'string' },
    extra_info: {
      anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
    },
    optional: {
      anyOf: [{ type: 'boolean' }, { type: 'string' }],
    },
    default_value: { type: 'string' },
  },
};

const functionParameterChangeSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['parameter_name'],
  properties: {
    parameter_name: { type: 'string', minLength: 1 },
    new_name: { type: 'string', minLength: 1 },
    delete_this_parameter: { type: 'boolean' },
    type: { type: 'string', enum: PARAMETER_TYPES },
    label: { type: 'string' },
    long_description: { type: 'string' },
    extra_info: {
      anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
    },
    optional: {
      anyOf: [{ type: 'boolean' }, { type: 'string' }],
    },
    default_value: { type: 'string' },
    new_index: {
      anyOf: [{ type: 'integer', minimum: 0 }, { type: 'string' }],
    },
  },
};

const functionSettingChangeSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['setting_name', 'new_value'],
  properties: {
    setting_name: { type: 'string', enum: FUNCTION_SETTING_NAMES },
    new_value: {
      anyOf: [{ type: 'string' }, { type: 'boolean' }],
    },
  },
};

const extensionPropertyChangeSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['property_name', 'new_value'],
  properties: {
    property_name: { type: 'string', enum: EXTENSION_PROPERTY_NAMES },
    new_value: { type: 'string' },
  },
};

const extensionDependencyChangeSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['dependency_name'],
  properties: {
    dependency_name: { type: 'string', minLength: 1 },
    delete_this_dependency: { type: 'boolean' },
    new_name: { type: 'string', minLength: 1 },
    type: { type: 'string', enum: DEPENDENCY_TYPES },
    export_name: { type: 'string' },
    version: { type: 'string' },
    extra_settings: {
      type: 'object',
      additionalProperties: { type: 'string' },
    },
  },
};

const variableMutationOperationSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['variable_name_or_path'],
  properties: {
    variable_name_or_path: {
      type: 'string',
      minLength: 1,
      description:
        'Variable path to create/update/delete, or existing declaration path to rename/reorder.',
    },
    value: {
      type: 'string',
      description:
        'Optional serialized value. Omit for rename/reorder-only operations.',
    },
    variable_type: {
      type: 'string',
      enum: ['string', 'number', 'boolean'],
    },
    delete_this_variable: { type: 'boolean' },
    new_variable_name: {
      type: 'string',
      minLength: 1,
      description:
        'Rename the existing declaration in place. References are refactored.',
    },
    move_before_variable: {
      type: 'string',
      minLength: 1,
      description:
        'Move a top-level declaration immediately before this sibling.',
    },
    move_after_variable: {
      type: 'string',
      minLength: 1,
      description:
        'Move a top-level declaration immediately after this sibling.',
    },
    move_to_index: {
      type: 'integer',
      minimum: 0,
      description:
        'Move a top-level declaration to this final zero-based index.',
    },
  },
};

const argumentOverrides: {
  [string]: { [string]: $Shape<AgentFunctionArgumentMetadata> },
} = {
  add_or_edit_variable: {
    variable_scope: {
      type: 'string',
      enum: ['global', 'scene', 'object', 'group', 'instance'],
      description: 'Variable declaration scope.',
    },
    scene_name: {
      type: 'string',
      description: 'Required for scene/object/instance scope in a scene.',
    },
    variables: {
      type: 'array',
      schema: {
        type: 'array',
        minItems: 1,
        items: variableMutationOperationSchema,
      },
      description:
        'Ordered variable mutations. Each item can create/update, rename, move/reorder or delete one declaration. Group scope keeps create/update/delete only; rename/reorder requires a concrete declaration.',
    },
    variable_name_or_path: {
      type: 'string',
      description:
        'Legacy single-operation variable path. Prefer variables[] for batches.',
    },
    value: {
      type: 'string',
      description: 'Legacy single-operation value.',
    },
    variable_type: {
      type: 'string',
      enum: ['string', 'number', 'boolean'],
    },
    delete_this_variable: { type: 'boolean' },
    new_variable_name: {
      type: 'string',
      description:
        'Legacy single-operation in-place rename; references are refactored. Not supported for group scope.',
    },
    move_before_variable: {
      type: 'string',
      description: 'Legacy single-operation before-sibling reorder.',
    },
    move_after_variable: {
      type: 'string',
      description: 'Legacy single-operation after-sibling reorder.',
    },
    move_to_index: {
      schema: { type: 'integer', minimum: 0 },
      description:
        'Legacy single-operation final zero-based declaration index.',
    },
  },
  create_extension: {
    full_name: {
      type: 'string',
      description: 'Human-readable extension name.',
    },
    short_description: {
      type: 'string',
      description: 'Short extension description.',
    },
    description: {
      type: 'string',
      description: 'Long extension description.',
    },
    category: { type: 'string' },
    tags: {
      type: 'string',
      description: 'Comma-separated extension tags.',
    },
    author: { type: 'string' },
  },
  change_extension_properties: {
    new_name: {
      type: 'string',
      description:
        'Optional new canonical extension name; project references are refactored.',
    },
    changed_properties: {
      type: 'array',
      schema: {
        type: 'array',
        items: extensionPropertyChangeSchema,
      },
      description: 'Extension metadata property patches.',
    },
    changed_dependencies: {
      type: 'array',
      schema: {
        type: 'array',
        items: extensionDependencyChangeSchema,
      },
      description: 'Create, update, rename or delete extension dependencies.',
    },
  },
  create_custom_function: {
    scope: {
      type: 'object',
      required: true,
      schema: extensionFunctionScopeSchema,
      description:
        'Project extension function owner. Use type=extension for free functions.',
    },
    function_type: {
      type: 'string',
      enum: FUNCTION_TYPES,
      description: 'GDevelop function kind.',
    },
    expression_type: {
      type: 'string',
      enum: EXPRESSION_TYPES,
      description:
        'Return type for Expression or ExpressionAndCondition functions.',
    },
    is_private: {
      type: 'boolean',
      description: 'Whether the function is private to its extension.',
    },
    is_async: {
      type: 'boolean',
      description: 'Whether the function is asynchronous.',
    },
    parameters: {
      type: 'array',
      schema: {
        type: 'array',
        items: functionParameterSpecSchema,
      },
      description: 'Ordered typed user parameters.',
    },
  },
  change_custom_function: {
    scope: {
      type: 'object',
      required: true,
      schema: extensionFunctionScopeSchema,
      description:
        'Project extension function owner. Use type=extension for free functions.',
    },
    new_name: {
      type: 'string',
      description:
        'Optional new canonical function name; project calls are refactored.',
    },
    changed_settings: {
      type: 'array',
      schema: {
        type: 'array',
        items: functionSettingChangeSchema,
      },
      description:
        'Function declaration settings including functionType, expressionType, privacy and async state.',
    },
    changed_parameters: {
      type: 'array',
      schema: {
        type: 'array',
        items: functionParameterChangeSchema,
      },
      description:
        'Create, update, rename, move or delete ordered typed parameters.',
    },
  },
  run_gameplay_test: {
    scope: {
      type: 'object',
      required: true,
      description:
        "Gameplay test scope: { type: 'project' } or { type: 'extension', extension_name: '...' }.",
    },
    test_name: {
      type: 'string',
      required: true,
      description: 'Name of the gameplay test to run or create.',
    },
    source: {
      type: 'string',
      description:
        'Optional gameplay-test source. When supplied, it is run and normally persisted.',
    },
    persist: {
      type: 'boolean',
      description:
        'AgentIntegration defaults this to false; set true only when the gameplay test should be saved.',
    },
    screenshots: {
      type: 'string',
      enum: ['off', 'on-failure'],
      description: 'Screenshot collection policy.',
    },
    timeout_ms: {
      type: 'number',
      description: 'Timeout in milliseconds, clamped to 1000..120000.',
    },
  },
  change_gameplay_tests: {
    scope: {
      type: 'object',
      required: true,
      description:
        "Gameplay test scope: { type: 'project' } or { type: 'extension', extension_name: '...' }.",
    },
    changes: {
      type: 'array',
      required: true,
      description:
        'One or more test metadata changes. Test source changes must use run_gameplay_test.',
    },
  },
  read_game_project_json: {
    path: {
      type: 'string',
      description:
        'Optional dot/bracket path into the simplified project JSON. Empty or omitted reads the bounded root.',
    },
  },
  search_docs: {
    query: {
      name: 'query',
      type: 'string',
      required: true,
      provenance: 'service-schema-compatibility',
      description: 'Documentation search query.',
    },
  },
  search_object_asset_store: {
    search_terms: {
      name: 'search_terms',
      type: 'string',
      required: true,
      provenance: 'service-schema-compatibility',
      description: 'Asset-store search terms.',
    },
  },
};

const generationServiceOnlyFunctions = new Set([
  'create_or_update_plan',
  'report_fulfilment_problem',
  'read_full_docs',
  'search_docs',
  'run_explorer_agent',
  'run_edit_agent',
  'run_tests',
  'search_object_asset_store',
  'search_resource_store',
]);

const getTypedToolName = (functionName: string): string =>
  `editor.functions.${functionName.replace(/_/g, '-')}`;

const makeExposureMetadata = ({
  name,
  executableInEmbeddedApi,
  readOnly,
}: {|
  name: string,
  executableInEmbeddedApi: boolean,
  readOnly: boolean,
|}) => {
  const embeddedHiddenReason = executableInEmbeddedApi
    ? null
    : 'generation-service-only';
  const nonScriptableReason = getNonScriptableFunctionReason(name);
  const runScriptHiddenReason =
    embeddedHiddenReason || nonScriptableReason || null;
  const readOnlyRunScriptHiddenReason =
    runScriptHiddenReason ||
    (!readOnly ? 'mutating-function-in-read-only-script' : null);

  return {
    discovery: {
      listed: true,
      describable: true,
    },
    genericCall: {
      available: executableInEmbeddedApi,
      hiddenReason: embeddedHiddenReason,
    },
    typedTool: {
      available: executableInEmbeddedApi,
      hiddenReason: embeddedHiddenReason,
      toolName: executableInEmbeddedApi ? getTypedToolName(name) : null,
    },
    runScript: {
      available: !runScriptHiddenReason,
      hiddenReason: runScriptHiddenReason,
    },
    readOnlyRunScript: {
      available: !readOnlyRunScriptHiddenReason,
      hiddenReason: readOnlyRunScriptHiddenReason,
    },
  };
};

const capabilityStopWords = new Set([
  'a',
  'an',
  'and',
  'as',
  'by',
  'for',
  'from',
  'in',
  'into',
  'of',
  'on',
  'or',
  'the',
  'this',
  'to',
  'with',
  'without',
  'function',
  'project',
  'gdevelop',
]);

const normalizeSearchText = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const makeCapabilities = (entry: any): Array<string> => {
  const tokens = normalizeSearchText(
    `${entry.name} ${entry.description || ''} ${entry.arguments
      .map(argument => argument.name)
      .join(' ')}`
  )
    .split(' ')
    .filter(token => token.length >= 3 && !capabilityStopWords.has(token));
  return [...new Set(tokens)].slice(0, 40);
};

const applyArgumentOverrides = (
  functionName: string,
  generatedArguments: Array<any>
): Array<AgentFunctionArgumentMetadata> => {
  const overrides = argumentOverrides[functionName] || {};
  const byName = new Map();

  generatedArguments.forEach(argument => {
    byName.set(argument.name, {
      ...argument,
      ...(overrides[argument.name] || {}),
    });
  });

  Object.keys(overrides).forEach(argumentName => {
    if (byName.has(argumentName)) return;
    const override = overrides[argumentName];
    byName.set(argumentName, {
      name: argumentName,
      type: override.type || 'unknown',
      required: !!override.required,
      provenance: override.provenance || 'agent-integration-override',
      ...override,
    });
  });

  return [...byName.values()].sort((a, b) => {
    if (a.required !== b.required) return a.required ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
};

const makeInputSchema = (
  argumentsMetadata: Array<AgentFunctionArgumentMetadata>
): Object => {
  const properties = {};
  const required = [];
  argumentsMetadata.forEach(argument => {
    const property = argument.schema ? { ...argument.schema } : {};
    if (argument.type && !['unknown', 'mixed', 'any'].includes(argument.type)) {
      if (argument.type.includes('|') || argument.type.endsWith('[]')) {
        if (argument.type.endsWith('[]')) {
          property.type = 'array';
          property.items = { type: argument.type.slice(0, -2) };
        } else {
          property.anyOf = argument.type.split('|').map(type => ({ type }));
        }
      } else {
        property.type = argument.type;
      }
    }
    if (argument.enum && argument.enum.length) property.enum = argument.enum;
    if (argument.description) property.description = argument.description;
    properties[argument.name] = property;
    if (argument.required) required.push(argument.name);
  });
  return {
    type: 'object',
    properties,
    required,
    // The source inference intentionally does not claim exhaustiveness for
    // nested/custom arguments that can be forwarded to helpers.
    additionalProperties: true,
  };
};

const metadataByName: Map<string, AgentFunctionMetadata> = new Map();

generatedFunctionMetadata.forEach(generated => {
  const nativeFunction = generated.requiresProject
    ? editorFunctions[generated.name]
    : editorFunctionsWithoutProject[generated.name];
  if (!nativeFunction) return;

  const argumentsMetadata = applyArgumentOverrides(
    generated.name,
    generated.arguments || []
  );
  const description =
    descriptionOverrides[generated.name] ||
    generated.description ||
    `Editor function ${generated.name}.`;
  const executableInEmbeddedApi = !generationServiceOnlyFunctions.has(
    generated.name
  );
  const hasConditionalModification =
    typeof nativeFunction.getModifiesProject === 'function';
  const modifiesProject = !!nativeFunction.modifiesProject;
  const mayModifyProject = modifiesProject || hasConditionalModification;
  const entry: AgentFunctionMetadata = {
    name: generated.name,
    implementation: generated.implementation,
    description,
    arguments: argumentsMetadata,
    inputSchema: makeInputSchema(argumentsMetadata),
    modifiesProject,
    mayModifyProject,
    modificationMode: hasConditionalModification
      ? 'argument-dependent'
      : modifiesProject
      ? 'always'
      : 'never',
    readOnly: !mayModifyProject,
    requiresProject: !!generated.requiresProject,
    executableInEmbeddedApi,
    executionScope: executableInEmbeddedApi
      ? 'embedded-editor'
      : 'generation-service',
    aliases: generated.aliases || [],
    source: generated.source || null,
    examples: generated.generatedExample ? [generated.generatedExample] : [],
    capabilities: [],
    exposure: makeExposureMetadata({
      name: generated.name,
      executableInEmbeddedApi,
      readOnly: !mayModifyProject,
    }),
  };
  entry.capabilities = makeCapabilities(entry);
  metadataByName.set(entry.name, entry);
});

export const getFunctionMetadata = (
  name: string
): AgentFunctionMetadata | null => metadataByName.get(name) || null;

export const listFunctionMetadata = ({
  query,
  executableOnly = false,
}: {|
  query?: ?string,
  executableOnly?: boolean,
|} = {}): Array<AgentFunctionMetadata> => {
  let entries = [...metadataByName.values()];
  if (executableOnly) {
    entries = entries.filter(entry => entry.executableInEmbeddedApi);
  }
  const normalizedQuery = query ? normalizeSearchText(query) : '';
  if (normalizedQuery) {
    const terms = normalizedQuery.split(' ').filter(Boolean);
    entries = entries.filter(entry => {
      const haystack = normalizeSearchText(
        `${entry.name} ${entry.implementation} ${
          entry.description
        } ${entry.aliases.join(' ')} ${entry.capabilities.join(
          ' '
        )} ${entry.arguments.map(argument => argument.name).join(' ')} ${[
          entry.exposure.genericCall.hiddenReason,
          entry.exposure.typedTool.hiddenReason,
          entry.exposure.runScript.hiddenReason,
          entry.exposure.readOnlyRunScript.hiddenReason,
        ]
          .filter(Boolean)
          .join(' ')}`
      );
      return terms.every(term => haystack.includes(term));
    });
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
};

export const getFunctionMetadataStats = () => {
  const functions = listFunctionMetadata();
  return {
    count: functions.length,
    executableInEmbeddedApi: functions.filter(
      functionMetadata => functionMetadata.executableInEmbeddedApi
    ).length,
    generationServiceOnly: functions.filter(
      functionMetadata => !functionMetadata.executableInEmbeddedApi
    ).length,
    directlyCallable: functions.filter(
      functionMetadata => functionMetadata.exposure.genericCall.available
    ).length,
    typedTools: functions.filter(
      functionMetadata => functionMetadata.exposure.typedTool.available
    ).length,
    runScript: functions.filter(
      functionMetadata => functionMetadata.exposure.runScript.available
    ).length,
    readOnlyRunScript: functions.filter(
      functionMetadata => functionMetadata.exposure.readOnlyRunScript.available
    ).length,
    withSource: functions.filter(functionMetadata => !!functionMetadata.source)
      .length,
    withArguments: functions.filter(
      functionMetadata => functionMetadata.arguments.length > 0
    ).length,
  };
};
