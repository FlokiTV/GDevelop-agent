// @flow
import {
  editorFunctions,
  editorFunctionsWithoutProject,
} from '../EditorFunctions';
import { makeFakeLaunchFunctionOptionsWithProject } from '../EditorFunctions/TestHelpers';
import {
  getFunctionMetadata,
  getFunctionMetadataStats,
  getNonScriptableFunctionReason,
  listFunctionMetadata,
} from './FunctionMetadata';

const gd: libGDevelop = global.gd;

describe('AgentIntegration FunctionMetadata', () => {
  it('covers every exported native EditorFunction exactly once', () => {
    const expectedNames = [
      ...new Set([
        ...Object.keys(editorFunctions),
        ...Object.keys(editorFunctionsWithoutProject),
      ]),
    ].sort();
    const actualNames = listFunctionMetadata().map(entry => entry.name);

    expect(actualNames).toEqual(expectedNames);
    expect(getFunctionMetadataStats().count).toBe(expectedNames.length);
  });

  it('exposes source-derived required arguments and a JSON-schema-like input shape', () => {
    const metadata = getFunctionMetadata('create_scene');
    expect(metadata).not.toBeNull();
    if (!metadata) return;

    expect(metadata.requiresProject).toBe(true);
    expect(metadata.modificationMode).toBe('always');
    expect(metadata.mayModifyProject).toBe(true);
    expect(metadata.readOnly).toBe(false);
    expect(metadata.inputSchema.required).toContain('scene_name');
    expect(metadata.inputSchema.properties.scene_name).toEqual({
      type: 'string',
    });
    expect(metadata.source).toMatchObject({
      file: 'EditorFunctions/index.js',
    });
  });

  it('marks argument-dependent mutations without incorrectly claiming read-only', () => {
    const metadata = getFunctionMetadata('run_gameplay_test');
    expect(metadata).not.toBeNull();
    if (!metadata) return;

    expect(metadata.modifiesProject).toBe(false);
    expect(metadata.mayModifyProject).toBe(true);
    expect(metadata.modificationMode).toBe('argument-dependent');
    expect(metadata.readOnly).toBe(false);
    expect(metadata.inputSchema.required).toEqual(
      expect.arrayContaining(['scope', 'test_name'])
    );
    expect(metadata.inputSchema.properties.screenshots.enum).toEqual([
      'off',
      'on-failure',
    ]);
  });

  it('distinguishes projectless and generation-service-only functions', () => {
    expect(getFunctionMetadata('initialize_project')).toMatchObject({
      requiresProject: false,
      executableInEmbeddedApi: true,
    });
    expect(getFunctionMetadata('search_docs')).toMatchObject({
      executableInEmbeddedApi: false,
      executionScope: 'generation-service',
    });
  });

  it('publishes machine-readable exposure parity for direct, typed and script surfaces', () => {
    listFunctionMetadata().forEach(metadata => {
      expect(metadata.exposure.discovery).toEqual({
        listed: true,
        describable: true,
      });
      expect(metadata.exposure.genericCall.available).toBe(
        metadata.executableInEmbeddedApi
      );
      expect(metadata.exposure.typedTool.available).toBe(
        metadata.executableInEmbeddedApi
      );
      expect(metadata.exposure.typedTool.toolName).toBe(
        metadata.executableInEmbeddedApi
          ? `editor.functions.${metadata.name.replace(/_/g, '-')}`
          : null
      );

      const policyReason = getNonScriptableFunctionReason(metadata.name);
      const expectedScriptReason = metadata.executableInEmbeddedApi
        ? policyReason
        : 'generation-service-only';
      expect(metadata.exposure.runScript.hiddenReason).toBe(
        expectedScriptReason
      );
      expect(metadata.exposure.runScript.available).toBe(
        expectedScriptReason === null
      );

      const expectedReadOnlyScriptReason =
        expectedScriptReason ||
        (!metadata.readOnly ? 'mutating-function-in-read-only-script' : null);
      expect(metadata.exposure.readOnlyRunScript.hiddenReason).toBe(
        expectedReadOnlyScriptReason
      );
      expect(metadata.exposure.readOnlyRunScript.available).toBe(
        expectedReadOnlyScriptReason === null
      );
    });

    const stats = getFunctionMetadataStats();
    expect(stats.directlyCallable).toBe(stats.executableInEmbeddedApi);
    expect(stats.typedTools).toBe(stats.executableInEmbeddedApi);
    expect(stats.runScript).toBeGreaterThan(0);
    expect(stats.runScript).toBeLessThan(stats.directlyCallable);
    expect(stats.readOnlyRunScript).toBeLessThan(stats.runScript);
  });

  it('keeps extension-authoring and variable capabilities truthful', () => {
    for (const name of ['create_extension', 'create_custom_function']) {
      expect(getFunctionMetadata(name)).toMatchObject({
        executableInEmbeddedApi: true,
        exposure: {
          genericCall: { available: true, hiddenReason: null },
          typedTool: {
            available: true,
            hiddenReason: null,
            toolName: `editor.functions.${name.replace(/_/g, '-')}`,
          },
          runScript: { available: true, hiddenReason: null },
          readOnlyRunScript: {
            available: false,
            hiddenReason: 'mutating-function-in-read-only-script',
          },
        },
      });
    }

    const variables = getFunctionMetadata('add_or_edit_variable');
    expect(variables).not.toBeNull();
    if (!variables) return;
    expect(variables.description).toBe(
      'Create, update or delete project, scene, object or instance variables.'
    );
    expect(variables.capabilities).toEqual(
      expect.arrayContaining(['create', 'update', 'delete'])
    );
    expect(variables.capabilities).not.toEqual(
      expect.arrayContaining(['rename', 'move'])
    );
    expect(variables.exposure.runScript).toEqual({
      available: true,
      hiddenReason: null,
    });
  });

  it('projects typed extension-authoring contracts into the unified EditorFunction schema', () => {
    const createExtension = getFunctionMetadata('create_extension');
    expect(createExtension).not.toBeNull();
    expect(createExtension.inputSchema.properties).toMatchObject({
      extension_name: { type: 'string' },
      full_name: { type: 'string' },
      short_description: { type: 'string' },
      tags: { type: 'string' },
    });

    const changeExtension = getFunctionMetadata('change_extension_properties');
    expect(changeExtension).not.toBeNull();
    expect(changeExtension.inputSchema.properties.new_name).toMatchObject({
      type: 'string',
    });
    expect(
      changeExtension.inputSchema.properties.changed_properties.items.properties
        .property_name.enum
    ).toContain('fullName');
    expect(
      changeExtension.inputSchema.properties.changed_dependencies.items
        .properties.type.enum
    ).toEqual(['npm', 'cordova']);

    const createFunction = getFunctionMetadata('create_custom_function');
    expect(createFunction).not.toBeNull();
    expect(createFunction.inputSchema.required).toEqual(
      expect.arrayContaining(['function_name', 'scope'])
    );
    expect(createFunction.inputSchema.properties.scope).toMatchObject({
      type: 'object',
      required: ['type', 'extension_name'],
      properties: {
        type: {
          type: 'string',
          enum: ['extension', 'custom_behavior', 'custom_object'],
        },
      },
    });
    expect(createFunction.inputSchema.properties.function_type.enum).toEqual([
      'Action',
      'Condition',
      'Expression',
      'StringExpression',
      'ExpressionAndCondition',
      'ActionWithOperator',
    ]);
    expect(createFunction.inputSchema.properties.expression_type.enum).toEqual([
      'number',
      'string',
    ]);
    expect(
      createFunction.inputSchema.properties.parameters.items.properties.type
        .enum
    ).toEqual(expect.arrayContaining(['expression', 'string', 'yesorno']));
    expect(createFunction.inputSchema.properties.is_private).toEqual({
      type: 'boolean',
      description: 'Whether the function is private to its extension.',
    });
    expect(createFunction.inputSchema.properties.is_async).toEqual({
      type: 'boolean',
      description: 'Whether the function is asynchronous.',
    });

    const changeFunction = getFunctionMetadata('change_custom_function');
    expect(changeFunction).not.toBeNull();
    expect(changeFunction.inputSchema.required).toEqual(
      expect.arrayContaining(['function_name', 'scope'])
    );
    expect(
      changeFunction.inputSchema.properties.changed_settings.items.properties
        .setting_name.enum
    ).toEqual(
      expect.arrayContaining([
        'functionType',
        'expressionType',
        'isPrivate',
        'isAsync',
      ])
    );
    expect(
      changeFunction.inputSchema.properties.changed_parameters.items.properties
        .type.enum
    ).toEqual(expect.arrayContaining(['expression', 'string']));
    expect(changeFunction.inputSchema.properties.delete_this_function).toEqual({
      type: 'boolean',
    });
  });

  it('searches functions by capability and can filter to embedded-executable tools', () => {
    const instanceMatches = listFunctionMetadata({
      query: 'existing_instance_ids',
      executableOnly: true,
    }).map(entry => entry.name);
    expect(instanceMatches).toContain('put_2d_instances');
    expect(instanceMatches).toContain('put_3d_instances');

    expect(
      listFunctionMetadata({
        query: 'documentation',
        executableOnly: true,
      }).map(entry => entry.name)
    ).not.toContain('search_docs');
  });

  it('does not emit invalid JSON Schema type=unknown for inferred loose arguments', () => {
    listFunctionMetadata().forEach(metadata => {
      Object.values(metadata.inputSchema.properties).forEach(
        (property: any) => {
          expect(property.type).not.toBe('unknown');
        }
      );
    });
  });

  it('uses explicit portable types for inferred arguments that are known by the native implementation', () => {
    expect(
      getFunctionMetadata('read_game_project_json').inputSchema.properties.path
    ).toMatchObject({ type: 'string' });
  });

  it('uses a generated example in a real EditorFunction call', async () => {
    const project = gd.ProjectHelper.createNewGDJSProject();
    try {
      const metadata = getFunctionMetadata('create_scene');
      expect(metadata).not.toBeNull();
      if (!metadata) return;
      const example = metadata.examples[0];
      expect(example).toBeTruthy();

      const result = await editorFunctions.create_scene.launchFunction({
        ...makeFakeLaunchFunctionOptionsWithProject(project),
        args: example.arguments,
      });
      expect(result.success).toBe(true);
      expect(project.hasLayoutNamed(example.arguments.scene_name)).toBe(true);
    } finally {
      project.delete();
    }
  });
});
