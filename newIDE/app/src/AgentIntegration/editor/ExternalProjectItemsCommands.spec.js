// @flow
import { AgentHost } from '../core/AgentHost';
import { createExternalProjectItemsCommandDescriptors } from './ExternalProjectItemsCommands';

const makeHost = (project: any = {}) => {
  const service = {
    listExternalEvents: jest.fn(() => ({ items: [], total: 0 })),
    inspectExternalEvents: jest.fn(input => input),
    createExternalEvents: jest.fn(input => input),
    updateExternalEvents: jest.fn(input => input),
    renameExternalEvents: jest.fn(input => input),
    deleteExternalEvents: jest.fn(input => input),
    listExternalLayouts: jest.fn(() => ({ items: [], total: 0 })),
    inspectExternalLayout: jest.fn(input => input),
    createExternalLayout: jest.fn(input => input),
    updateExternalLayout: jest.fn(input => input),
    duplicateExternalLayout: jest.fn(input => input),
    renameExternalLayout: jest.fn(input => input),
    deleteExternalLayout: jest.fn(input => input),
    listExternalLayoutInstances: jest.fn(input => input),
    createExternalLayoutInstance: jest.fn(input => input),
    updateExternalLayoutInstance: jest.fn(input => input),
    deleteExternalLayoutInstance: jest.fn(input => input),
  };
  return {
    service,
    host: new AgentHost({
      environment: { project },
      descriptors: createExternalProjectItemsCommandDescriptors({
        externalProjectItemsService: service,
      }),
    }),
  };
};

describe('ExternalProjectItemsCommands', () => {
  test('exposes deterministic lifecycle and instance commands with mutation metadata', () => {
    const { host } = makeHost();
    const names = host.listCommands().map(command => command.name);
    expect(names).toEqual([
      'external-events.create',
      'external-events.delete',
      'external-events.inspect',
      'external-events.list',
      'external-events.rename',
      'external-events.update',
      'external-layouts.create',
      'external-layouts.delete',
      'external-layouts.duplicate',
      'external-layouts.inspect',
      'external-layouts.instances.create',
      'external-layouts.instances.delete',
      'external-layouts.instances.list',
      'external-layouts.instances.update',
      'external-layouts.list',
      'external-layouts.rename',
      'external-layouts.update',
    ]);
    expect(host.describeCommand('external-events.list').metadata).toMatchObject({
      readOnly: true,
      requiresProject: true,
      modifiesProject: false,
    });
    expect(host.describeCommand('external-layouts.instances.create').metadata).toMatchObject({
      readOnly: false,
      modifiesProject: true,
      destructive: false,
    });
    expect(host.describeCommand('external-layouts.delete').metadata).toMatchObject({
      destructive: true,
      modifiesProject: true,
    });
  });

  test('dispatches typed inputs directly to the protocol-agnostic service', async () => {
    const { host, service } = makeHost();
    await host.execute('external-events.create', {
      name: 'Shared',
      associatedLayout: 'Game',
    });
    await host.execute('external-layouts.instances.update', {
      name: 'Overlay',
      instanceId: 'abc',
      x: 5,
    });
    expect(service.createExternalEvents).toHaveBeenCalledWith({
      name: 'Shared',
      associatedLayout: 'Game',
    });
    expect(service.updateExternalLayoutInstance).toHaveBeenCalledWith({
      name: 'Overlay',
      instanceId: 'abc',
      x: 5,
    });
  });

  test('requires a project before execution', async () => {
    const { host } = makeHost(null);
    await expect(host.execute('external-layouts.list', {})).rejects.toMatchObject({
      code: 'no_project_open',
    });
  });
});
