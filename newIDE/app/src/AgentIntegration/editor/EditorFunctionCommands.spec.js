// @flow
import { AgentHost } from '../core/AgentHost';
import { getFunctionMetadata, listFunctionMetadata } from '../FunctionMetadata';
import {
  createEditorFunctionCommandDescriptors,
  createTypedEditorFunctionCommandDescriptors,
  getTypedEditorFunctionCommandName,
} from './EditorFunctionCommands';

const makeHost = ({
  project = {},
  run = jest.fn(async options => options),
} = {}) => ({
  host: new AgentHost({
    environment: { project },
    descriptors: createEditorFunctionCommandDescriptors({
      editorFunctionService: { run },
    }),
  }),
  run,
});

describe('EditorFunctionCommands', () => {
  test('lists executable editor functions with generated schemas', async () => {
    const { host } = makeHost();
    const result = await host.execute('editor.functions.list', {
      query: 'variable',
    });

    expect(result.data.functions.length).toBeGreaterThan(0);
    expect(
      result.data.functions.every(entry => entry.executableInEmbeddedApi)
    ).toBe(true);
    expect(
      result.data.functions.some(entry => entry.name === 'inspect_variables')
    ).toBe(true);
  });

  test('publishes agent-oriented examples from the command registry schemas', () => {
    const { host } = makeHost();
    expect(
      host.describeCommand('editor.functions.list').inputSchema.examples
    ).toEqual([{ query: 'instance', executableOnly: true }]);
    expect(
      host.describeCommand('editor.functions.call').inputSchema.examples
    ).toEqual([
      {
        name: 'inspect_variables',
        arguments: { variable_scope: 'global' },
      },
    ]);
  });

  test('keeps list and describe in exact parity with generated FunctionMetadata', async () => {
    const { host } = makeHost();
    const listed = await host.execute('editor.functions.list', {
      executableOnly: false,
    });
    expect(listed.data.functions).toEqual(
      listFunctionMetadata({ executableOnly: false })
    );

    for (const name of ['inspect_variables', 'create_scene', 'search_docs']) {
      const described = await host.execute('editor.functions.describe', {
        name,
      });
      expect(described.data.function).toEqual(getFunctionMetadata(name));
    }
  });

  test('describes a known editor function', async () => {
    const { host } = makeHost();
    const result = await host.execute('editor.functions.describe', {
      name: 'inspect_variables',
    });

    expect(result.data.function.name).toBe('inspect_variables');
    expect(result.data.function.inputSchema.type).toBe('object');
  });

  test('routes a single executable function through the generic service', async () => {
    const { host, run } = makeHost();
    await host.execute('editor.functions.call', {
      name: 'inspect_variables',
      arguments: { variable_scope: 'global' },
    });

    expect(run).toHaveBeenCalledWith({
      signal: undefined,
      calls: [
        {
          name: 'inspect_variables',
          arguments: { variable_scope: 'global' },
          callId: undefined,
        },
      ],
      save: false,
    });
  });

  test('rejects functions that require a project when none is open', async () => {
    const { host } = makeHost({ project: null });
    await expect(
      host.execute('editor.functions.call', {
        name: 'inspect_variables',
        arguments: {},
      })
    ).rejects.toMatchObject({ code: 'no_project_open' });
  });

  test('allows projectless embedded functions', async () => {
    const { host, run } = makeHost({ project: null });
    await host.execute('editor.functions.call', {
      name: 'initialize_project',
      arguments: { project_name: 'Agent Test', template_slug: '' },
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  test('routes ordered batches and preserves save intent', async () => {
    const { host, run } = makeHost();
    const calls = [
      { name: 'inspect_variables', arguments: { variable_scope: 'global' } },
      { name: 'describe_instances', arguments: { scene_name: 'Scene' } },
    ];
    await host.execute('editor.functions.call-batch', { calls, save: true });
    expect(run).toHaveBeenCalledWith({ signal: undefined, calls, save: true });
  });

  test('rejects generation-service-only functions before execution', async () => {
    const { host, run } = makeHost();
    await expect(
      host.execute('editor.functions.call', {
        name: 'search_docs',
        arguments: { query: 'camera' },
      })
    ).rejects.toMatchObject({ code: 'function_not_executable' });
    expect(run).not.toHaveBeenCalled();
  });

  test('generates one deterministic kebab-case command per embedded executable function', () => {
    const run = jest.fn(async options => options);
    const typedDescriptors = createTypedEditorFunctionCommandDescriptors({
      editorFunctionService: { run },
    });
    const executableFunctions = listFunctionMetadata({ executableOnly: true });
    const expectedNames = executableFunctions.map(metadata =>
      getTypedEditorFunctionCommandName(metadata.name)
    );

    expect(typedDescriptors).toHaveLength(executableFunctions.length);
    expect(typedDescriptors.map(descriptor => descriptor.name)).toEqual(
      expectedNames
    );
    expect(new Set(expectedNames).size).toBe(expectedNames.length);
    expect(expectedNames).toEqual(expectedNames.slice().sort());
    expect(expectedNames).toContain('editor.functions.create-scene');
    expect(expectedNames).not.toContain('editor.functions.search-docs');
  });

  test('projects each function-specific schema directly instead of generic arguments object', () => {
    const { host } = makeHost();
    const createScene = host.describeCommand('editor.functions.create-scene');
    const metadata = getFunctionMetadata('create_scene');
    expect(metadata).not.toBeNull();
    if (!metadata) return;

    expect(createScene.inputSchema.required).toEqual(
      metadata.inputSchema.required
    );
    expect(createScene.inputSchema.properties).toEqual(
      metadata.inputSchema.properties
    );
    expect(createScene.inputSchema.additionalProperties).toBe(true);
    expect(createScene.inputSchema.examples).toEqual([
      metadata.examples[0].arguments,
    ]);
    expect(createScene.inputSchema.properties).not.toHaveProperty('arguments');
  });

  test('does not publish generated examples that violate the effective function schema', () => {
    const { host } = makeHost();
    expect(
      host.describeCommand('editor.functions.create-scene').inputSchema.examples
    ).toBeTruthy();
    expect(
      host.describeCommand('editor.functions.run-gameplay-test').inputSchema
        .examples
    ).toBeUndefined();
    expect(
      host.describeCommand('editor.functions.change-gameplay-tests').inputSchema
        .examples
    ).toBeUndefined();
  });

  test('derives conservative MCP command metadata including argument-dependent mutation', () => {
    const { host } = makeHost();
    expect(
      host.describeCommand('editor.functions.inspect-variables').metadata
    ).toMatchObject({
      readOnly: true,
      destructive: false,
      idempotent: true,
      longRunning: false,
      requiresProject: true,
      modifiesProject: false,
      cacheScope: 'project-revision',
    });
    expect(
      host.describeCommand('editor.functions.create-scene').metadata
    ).toMatchObject({
      readOnly: false,
      destructive: false,
      idempotent: false,
      modifiesProject: true,
    });
    expect(
      host.describeCommand('editor.functions.run-gameplay-test').metadata
    ).toMatchObject({
      readOnly: false,
      destructive: true,
      idempotent: false,
      longRunning: true,
      modifiesProject: true,
      defaultTimeoutMs: 180000,
    });
  });

  test('validates known required fields and primitive types before service execution', async () => {
    const { host, run } = makeHost();
    await expect(
      host.execute('editor.functions.create-scene', {})
    ).rejects.toMatchObject({
      code: 'invalid_command_input',
      details: { functionName: 'create_scene', argumentName: 'scene_name' },
    });
    await expect(
      host.execute('editor.functions.create-scene', { scene_name: 42 })
    ).rejects.toMatchObject({
      code: 'invalid_command_input',
      details: { functionName: 'create_scene', argumentName: 'scene_name' },
    });
    expect(run).not.toHaveBeenCalled();
  });

  test('routes typed tools directly to the same EditorFunctionService with direct arguments', async () => {
    const { host, run } = makeHost();
    const signal: any = { aborted: false };
    const result = await host.execute(
      'editor.functions.inspect-variables',
      { variable_scope: 'global' },
      { signal }
    );

    expect(result.meta).toMatchObject({
      readOnly: true,
      modifiesProject: false,
    });
    expect(run).toHaveBeenCalledWith({
      signal,
      calls: [
        {
          name: 'inspect_variables',
          arguments: { variable_scope: 'global' },
        },
      ],
      save: false,
    });
  });

  test('keeps the four generic compatibility commands alongside every typed tool', () => {
    const { host } = makeHost();
    const names = host.listCommands().map(descriptor => descriptor.name);
    ['list', 'describe', 'call', 'call-batch'].forEach(suffix =>
      expect(names).toContain(`editor.functions.${suffix}`)
    );
    expect(
      names.filter(name => name.startsWith('editor.functions.')).length
    ).toBe(listFunctionMetadata({ executableOnly: true }).length + 4);
  });
});
