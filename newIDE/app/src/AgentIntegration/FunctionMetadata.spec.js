// @flow
import {
  editorFunctions,
  editorFunctionsWithoutProject,
} from '../EditorFunctions';
import { makeFakeLaunchFunctionOptionsWithProject } from '../EditorFunctions/TestHelpers';
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
