// @flow
import {
  editorFunctions,
  editorFunctionsWithoutProject,
} from '../EditorFunctions';
import { makeFakeLaunchFunctionOptionsWithProject } from '../EditorFunctions/TestHelpers';
import { getNonScriptableFunctionReason } from '../EditorFunctions/ScriptExecution/NonScriptableFunctionNames';
import {
  getFunctionMetadata,
  getFunctionMetadataStats,
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
