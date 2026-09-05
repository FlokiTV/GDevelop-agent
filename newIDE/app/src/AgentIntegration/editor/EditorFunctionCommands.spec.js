// @flow
import { AgentHost } from '../core/AgentHost';
import {
  getFunctionMetadata,
  listFunctionMetadata,
} from '../FunctionMetadata';
import { createEditorFunctionCommandDescriptors } from './EditorFunctionCommands';

const makeHost = ({ project = {}, run = jest.fn(async options => options) } = {}) => ({
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
    expect(host.describeCommand('editor.functions.list').inputSchema.examples).toEqual([
      { query: 'instance', executableOnly: true },
    ]);
    expect(host.describeCommand('editor.functions.call').inputSchema.examples).toEqual([
      {
        name: 'inspect_variables',
        arguments: { scope: 'global' },
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
      const described = await host.execute('editor.functions.describe', { name });
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

  test('routes a single executable function through the service', async () => {
    const { host, run } = makeHost();
    await host.execute('editor.functions.call', {
      name: 'inspect_variables',
      arguments: { scope: 'global' },
    });

    expect(run).toHaveBeenCalledWith({
      calls: [
        {
          name: 'inspect_variables',
          arguments: { scope: 'global' },
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
      arguments: { game_name: 'Agent Test' },
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  test('routes ordered batches and preserves save intent', async () => {
    const { host, run } = makeHost();
    const calls = [
      { name: 'inspect_variables', arguments: {} },
      { name: 'describe_instances', arguments: { scene_name: 'Scene' } },
    ];
    await host.execute('editor.functions.call-batch', { calls, save: true });
    expect(run).toHaveBeenCalledWith({ calls, save: true });
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
});
