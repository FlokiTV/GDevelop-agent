// @flow
import { AgentHost } from '../core/AgentHost';
import { createProjectLifecycleCommandDescriptors } from './ProjectLifecycleCommands';

const makeHost = (project: any = {}) => {
  const service = {
    create: jest.fn(async input => ({ action: 'create', input })),
    open: jest.fn(async input => ({ action: 'open', input })),
    close: jest.fn(async input => ({ action: 'close', input })),
    save: jest.fn(async () => ({ action: 'save' })),
    saveAs: jest.fn(async input => ({ action: 'save-as', input })),
  };
  return {
    service,
    host: new AgentHost({
      environment: { project },
      descriptors: createProjectLifecycleCommandDescriptors({
        projectLifecycleService: service,
      }),
    }),
  };
};

describe('ProjectLifecycleCommands', () => {
  test('exposes lifecycle metadata for safe MCP projection', () => {
    const { host } = makeHost();
    expect(host.describeCommand('project.open').metadata).toMatchObject({
      destructive: true,
      readOnly: false,
      modifiesProject: true,
    });
    expect(host.describeCommand('project.save').metadata).toMatchObject({
      destructive: false,
      readOnly: false,
      requiresProject: true,
    });
  });

  test('routes create/open/close through the lifecycle service', async () => {
    const { host, service } = makeHost();
    await host.execute('project.create', { name: 'Game' });
    await host.execute('project.open', { filePath: 'C:/game.json' });
    await host.execute('project.close', {});
    expect(service.create).toHaveBeenCalledWith({ name: 'Game' });
    expect(service.open).toHaveBeenCalledWith({ filePath: 'C:/game.json' });
    expect(service.close).toHaveBeenCalledWith({});
  });

  test('AgentHost enforces project requirement for save operations', async () => {
    const { host, service } = makeHost(null);
    await expect(host.execute('project.save', {})).rejects.toMatchObject({
      code: 'no_project_open',
    });
    expect(service.save).not.toHaveBeenCalled();
  });

  test('validates required local paths before invoking the service', async () => {
    const { host, service } = makeHost();
    await expect(host.execute('project.open', {})).rejects.toMatchObject({
      code: 'missing_project_file_path',
    });
    await expect(host.execute('project.save-as', {})).rejects.toMatchObject({
      code: 'missing_project_file_path',
    });
    expect(service.open).not.toHaveBeenCalled();
    expect(service.saveAs).not.toHaveBeenCalled();
  });
});
