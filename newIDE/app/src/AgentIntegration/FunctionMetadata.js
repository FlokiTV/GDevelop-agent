// @flow
import {
  editorFunctions,
  editorFunctionsWithoutProject,
} from '../EditorFunctions';
import { generatedFunctionMetadata } from './FunctionMetadata.generated';

export type AgentFunctionArgumentMetadata = {|
  name: string,
  type: string,
  required: boolean,
  provenance: string,
  enum?: Array<any>,
  description?: string,
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
|};

const descriptionOverrides = {
  add_or_edit_variable:
    'Create, update, move, rename or delete project, scene, object or instance variables.',
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

const argumentOverrides: {
  [string]: { [string]: $Shape<AgentFunctionArgumentMetadata> },
} = {
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
      provenance: override.provenance || 'agent-api-override',
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
    const property = {};
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
    generated.description ||
    descriptionOverrides[generated.name] ||
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
        )} ${entry.arguments.map(argument => argument.name).join(' ')}`
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
    withSource: functions.filter(functionMetadata => !!functionMetadata.source)
      .length,
    withArguments: functions.filter(
      functionMetadata => functionMetadata.arguments.length > 0
    ).length,
  };
};
