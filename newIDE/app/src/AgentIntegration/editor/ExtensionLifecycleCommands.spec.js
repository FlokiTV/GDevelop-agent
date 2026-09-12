// @flow
import { createExtensionLifecycleCommandDescriptors } from './ExtensionLifecycleCommands';

const makeService = () => ({
  listInstalled: jest.fn(() => ({ items: [] })),
  inspectInstalled: jest.fn(() => ({ extension: {} })),
  searchCatalog: jest.fn(() => Promise.resolve({ items: [] })),
  describeCatalog: jest.fn(() => Promise.resolve({ extension: {} })),
  install: jest.fn(() => Promise.resolve({ changed: true })),
  update: jest.fn(() => Promise.resolve({ changed: true })),
  remove: jest.fn(() => Promise.resolve({ removed: true })),
});

describe('AgentIntegration ExtensionLifecycleCommands', () => {
  it('projects installed/catalog discovery and guarded lifecycle mutations', async () => {
    const service = makeService();
    const descriptors = createExtensionLifecycleCommandDescriptors({
      extensionLifecycleService: service,
    });
    expect(descriptors.map(descriptor => descriptor.name)).toEqual([
      'extensions.installed.list',
      'extensions.installed.inspect',
      'extensions.catalog.search',
      'extensions.catalog.describe',
      'extensions.install',
      'extensions.update',
      'extensions.remove',
    ]);

    expect(descriptors[0].metadata).toMatchObject({
      readOnly: true,
      requiresProject: true,
    });
    expect(descriptors[2].metadata).toMatchObject({
      readOnly: true,
      longRunning: true,
    });
    expect(descriptors[4].metadata).toMatchObject({
      readOnly: false,
      destructive: false,
      modifiesProject: true,
      longRunning: true,
    });
    expect(descriptors[5].metadata.destructive).toBe(true);
    expect(descriptors[6].metadata.destructive).toBe(true);

    await descriptors[0].execute({ input: {} });
    await descriptors[1].execute({ input: { name: 'StoreExt' } });
    await descriptors[2].execute({ input: { query: 'store' } });
    await descriptors[3].execute({ input: { name: 'StoreExt' } });
    await descriptors[4].execute({ input: { name: 'StoreExt' } });
    await descriptors[5].execute({ input: { name: 'StoreExt' } });
    await descriptors[6].execute({ input: { name: 'StoreExt' } });

    expect(service.listInstalled).toHaveBeenCalledTimes(1);
    expect(service.inspectInstalled).toHaveBeenCalledWith({ name: 'StoreExt' });
    expect(service.searchCatalog).toHaveBeenCalledWith({ query: 'store' });
    expect(service.describeCatalog).toHaveBeenCalledWith({ name: 'StoreExt' });
    expect(service.install).toHaveBeenCalledTimes(1);
    expect(service.update).toHaveBeenCalledTimes(1);
    expect(service.remove).toHaveBeenCalledTimes(1);
  });
});
