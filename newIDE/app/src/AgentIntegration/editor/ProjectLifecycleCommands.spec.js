// @flow
import { AgentHost } from '../core/AgentHost';
import { createProjectLifecycleCommandDescriptors } from './ProjectLifecycleCommands';

const makeHost = (project: any = {}) => {
  const service = {
    create: jest.fn(async input => ({ action: 'create', input })),
    open: jest.fn(async input => ({ action: 'open', input })),
    close: jest.fn(async input => ({ action: 'close', input })),
    persistenceStatus: jest.fn(input => ({
      action: 'persistence-status',
      input,
      projectId: 'project-1',
    })),
    verifyPersistence: jest.fn(input => ({
      action: 'persistence-verify',
      input,
      verified: true,
    })),
    save: jest.fn(async (input, requestContext) => ({
      action: 'save',
      input,
      requestContext,
    })),
    saveAs: jest.fn(async (input, requestContext) => ({
      action: 'save-as',
      input,
      requestContext,
    })),
    reload: jest.fn(async (input, requestContext) => ({
      action: 'reload',
      input,
      requestContext,
    })),
  };
  return {
    service,
    host: new AgentHost({
      environment: {
        project,
        getProjectStatus: () => ({
          preview: { available: true, running: false },
        }),
      },
      descriptors: createProjectLifecycleCommandDescriptors({
        projectLifecycleService: service,
      }),
    }),
  };
};

describe('ProjectLifecycleCommands', () => {
  test('exposes lifecycle and persistence metadata for safe MCP projection', () => {
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
      modifiesProject: false,
    });
    expect(
      host.describeCommand('project.persistence.status').metadata
    ).toMatchObject({
      readOnly: true,
      requiresProject: true,
    });
    expect(host.describeCommand('project.reload').metadata).toMatchObject({
      destructive: true,
      modifiesProject: true,
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

  test('routes persistence reads and distinguishes preview/export generated state', async () => {
    const { host, service } = makeHost();
    const status = await host.execute('project.persistence.status', {
      expectedProjectId: 'project-1',
    });
    expect(service.persistenceStatus).toHaveBeenCalledWith({
      expectedProjectId: 'project-1',
    });
    expect(status.data).toMatchObject({
      action: 'persistence-status',
      generatedState: {
        preview: { available: true, running: false },
        export: {
          tracked: false,
          relationToPersistence: 'independent-generated-output',
        },
      },
    });

    const verify = await host.execute('project.persistence.verify', {
      expectedPersistedHash: 'hash',
    });
    expect(service.verifyPersistence).toHaveBeenCalledWith({
      expectedPersistedHash: 'hash',
    });
    expect(verify.data.verified).toBe(true);
  });

  test('passes request identity context to save/save-as/reload safety checks', async () => {
    const { host, service } = makeHost();
    const requestContext = {
      identity: {
        ownerKey: 'client::agent',
      },
    };
    await host.execute(
      'project.save',
      { expectedProjectRevision: 4 },
      requestContext
    );
    await host.execute(
      'project.save-as',
      { filePath: 'C:/copy.json' },
      requestContext
    );
    await host.execute(
      'project.reload',
      { discardUnsavedChanges: true },
      requestContext
    );

    expect(service.save).toHaveBeenCalledWith(
      { expectedProjectRevision: 4 },
      requestContext
    );
    expect(service.saveAs).toHaveBeenCalledWith(
      { filePath: 'C:/copy.json' },
      requestContext
    );
    expect(service.reload).toHaveBeenCalledWith(
      { discardUnsavedChanges: true },
      requestContext
    );
  });

  test('AgentHost enforces project requirement for persistence operations', async () => {
    const { host, service } = makeHost(null);
    await expect(host.execute('project.save', {})).rejects.toMatchObject({
      code: 'no_project_open',
    });
    await expect(
      host.execute('project.persistence.status', {})
    ).rejects.toMatchObject({
      code: 'no_project_open',
    });
    await expect(host.execute('project.reload', {})).rejects.toMatchObject({
      code: 'no_project_open',
    });
    expect(service.save).not.toHaveBeenCalled();
    expect(service.persistenceStatus).not.toHaveBeenCalled();
    expect(service.reload).not.toHaveBeenCalled();
  });

  test('validates required local paths and persistence guard types before invoking the service', async () => {
    const { host, service } = makeHost();
    await expect(host.execute('project.open', {})).rejects.toMatchObject({
      code: 'missing_project_file_path',
    });
    await expect(host.execute('project.save-as', {})).rejects.toMatchObject({
      code: 'missing_project_file_path',
    });
    await expect(
      host.execute('project.save', { expectedProjectRevision: -1 })
    ).rejects.toMatchObject({
      code: 'invalid_expected_project_revision',
    });
    await expect(
      host.execute('project.reload', { discardUnsavedChanges: 'yes' })
    ).rejects.toMatchObject({
      code: 'invalid_discard_unsaved_changes',
    });
    await expect(
      host.execute('project.persistence.verify', {
        expectedPersistedHash: 42,
      })
    ).rejects.toMatchObject({
      code: 'invalid_expected_persisted_hash',
    });
    expect(service.open).not.toHaveBeenCalled();
    expect(service.saveAs).not.toHaveBeenCalled();
  });
});
