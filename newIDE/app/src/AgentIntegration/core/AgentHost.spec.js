// @flow
import { AgentError, serializeAgentError } from './AgentError';
import { AgentHost } from './AgentHost';
import { makeCommandMetadata } from './CommandRegistry';
import { createCoreCommandDescriptors } from './CoreCommands';

const makeDescriptor = (name, overrides = {}) => ({
  name,
  description: `Description for ${name}`,
  inputSchema: { type: 'object', properties: {} },
  metadata: makeCommandMetadata(),
  execute: ({ input }) => input,
  ...overrides,
});

describe('AgentHost', () => {
  it('executes commands with a stable result envelope and trace metadata', async () => {
    const host = new AgentHost({
      descriptors: [makeDescriptor('scene.inspect')],
    });

    await expect(
      host.execute('scene.inspect', { sceneName: 'Level 1' }, { traceId: 'trace-1' })
    ).resolves.toEqual({
      command: 'scene.inspect',
      data: { sceneName: 'Level 1' },
      meta: {
        traceId: 'trace-1',
        readOnly: true,
        modifiesProject: false,
      },
    });
  });

  it('enforces project preconditions before executing a command', async () => {
    const execute = jest.fn();
    const host = new AgentHost({
      descriptors: [
        makeDescriptor('scene.create', {
          metadata: makeCommandMetadata({
            readOnly: false,
            idempotent: false,
            requiresProject: true,
            modifiesProject: true,
          }),
          execute,
        }),
      ],
    });

    await expect(
      host.execute('scene.create', {}, { traceId: 'trace-project' })
    ).rejects.toMatchObject({
      code: 'no_project_open',
      retryable: false,
      traceId: 'trace-project',
    });
    expect(execute).not.toHaveBeenCalled();

    host.setEnvironment({ project: {} });
    await host.execute('scene.create');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('centralizes input validation and normalizes handler failures', async () => {
    const host = new AgentHost({
      descriptors: [
        makeDescriptor('events.patch', {
          validateInput: input => {
            if (typeof input.sceneName !== 'string') {
              throw new AgentError({
                code: 'missing_scene_name',
                hint: 'Read the scene list and pass sceneName.',
              });
            }
          },
          execute: () => {
            const error: any = new Error('stale write');
            error.code = 'revision_conflict';
            error.currentRevision = 7;
            throw error;
          },
        }),
      ],
    });

    await expect(host.execute('events.patch', [])).rejects.toMatchObject({
      code: 'invalid_command_input',
    });
    await expect(host.execute('events.patch', {})).rejects.toMatchObject({
      code: 'missing_scene_name',
      hint: 'Read the scene list and pass sceneName.',
    });
    await expect(
      host.execute('events.patch', { sceneName: 'Game' }, { traceId: 'trace-2' })
    ).rejects.toMatchObject({
      code: 'revision_conflict',
      currentRevision: 7,
      traceId: 'trace-2',
    });
  });

  it('serializes AgentError without leaking its cause', () => {
    const cause = new Error('private stack detail');
    const serialized = serializeAgentError(
      new AgentError({
        code: 'revision_conflict',
        message: 'The project changed.',
        retryable: true,
        hint: 'Read the project again.',
        currentRevision: 9,
        traceId: 'trace-3',
        cause,
      })
    );

    expect(serialized).toEqual({
      code: 'revision_conflict',
      message: 'The project changed.',
      retryable: true,
      hint: 'Read the project again.',
      currentRevision: 9,
      traceId: 'trace-3',
    });
    expect(serialized).not.toHaveProperty('cause');
  });
});

describe('core commands', () => {
  it('exposes capabilities, command discovery and live project status', async () => {
    const project = {
      getName: () => 'Agent Project',
      getProjectUuid: () => 'project-uuid',
    };
    const host = new AgentHost({
      environment: {
        project,
        fileIdentifier: 'project.json',
        hasUnsavedChanges: true,
      },
      descriptors: createCoreCommandDescriptors(),
    });

    const status = await host.execute('project.status');
    expect(status.data).toEqual({
      projectOpen: true,
      projectName: 'Agent Project',
      projectUuid: 'project-uuid',
      fileIdentifier: 'project.json',
      hasUnsavedChanges: true,
    });

    const list = await host.execute('agent.commands.list', { query: 'status' });
    expect(list.data.commands.map(command => command.name)).toEqual([
      'project.status',
    ]);

    const description = await host.execute('agent.commands.describe', {
      name: 'project.status',
    });
    expect(description.data.command.metadata.readOnly).toBe(true);

    const capabilities = await host.execute('agent.capabilities');
    expect(capabilities.data.commandCount).toBe(4);
    expect(capabilities.data.commands).toHaveLength(4);
  });
});
