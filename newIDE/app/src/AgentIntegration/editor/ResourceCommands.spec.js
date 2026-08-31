// @flow
import { AgentHost } from '../core/AgentHost';
import { createResourceCommandDescriptors } from './ResourceCommands';

const makeHost = (project: any = {}) => {
  const assetTools = {
    listResources: jest.fn(() => ({ resources: [] })),
    inspectResource: jest.fn(resourceName => ({ name: resourceName })),
    importLocalResource: jest.fn(async input => ({ imported: true, input })),
    replaceLocalResource: jest.fn(async input => ({ replaced: true, input })),
    renameResource: jest.fn(input => ({ renamed: true, input })),
    removeResource: jest.fn(input => ({ removed: true, input })),
  };
  return {
    assetTools,
    host: new AgentHost({
      environment: { project },
      descriptors: createResourceCommandDescriptors({ assetTools }),
    }),
  };
};

describe('ResourceCommands', () => {
  test('exposes read-only list/inspect and destructive replace/remove metadata', () => {
    const { host } = makeHost();
    expect(host.describeCommand('resources.list').metadata.readOnly).toBe(true);
    expect(host.describeCommand('resources.inspect').metadata.readOnly).toBe(true);
    expect(host.describeCommand('resources.replace-local').metadata).toMatchObject({
      destructive: true,
      modifiesProject: true,
    });
    expect(host.describeCommand('resources.remove').metadata).toMatchObject({
      destructive: true,
      modifiesProject: true,
    });
  });

  test('routes list and inspect through AssetTools', async () => {
    const { host, assetTools } = makeHost();
    await host.execute('resources.list', {});
    await host.execute('resources.inspect', { resourceName: 'hero.png' });
    expect(assetTools.listResources).toHaveBeenCalledTimes(1);
    expect(assetTools.inspectResource).toHaveBeenCalledWith('hero.png');
  });

  test('routes mutating resource operations without changing payloads', async () => {
    const { host, assetTools } = makeHost();
    const importInput = { filePath: 'C:/hero.png', resourceName: 'hero.png' };
    const replaceInput = { resourceName: 'hero.png', filePath: 'C:/new.png' };
    const renameInput = { resourceName: 'hero.png', newResourceName: 'player.png' };
    const removeInput = { resourceName: 'player.png', deleteFile: false };

    await host.execute('resources.import-local', importInput);
    await host.execute('resources.replace-local', replaceInput);
    await host.execute('resources.rename', renameInput);
    await host.execute('resources.remove', removeInput);

    expect(assetTools.importLocalResource).toHaveBeenCalledWith(importInput);
    expect(assetTools.replaceLocalResource).toHaveBeenCalledWith(replaceInput);
    expect(assetTools.renameResource).toHaveBeenCalledWith(renameInput);
    expect(assetTools.removeResource).toHaveBeenCalledWith(removeInput);
  });

  test('validates required resource paths and names before AssetTools', async () => {
    const { host, assetTools } = makeHost();
    await expect(host.execute('resources.import-local', {})).rejects.toMatchObject({
      code: 'missing_resource_file_path',
    });
    await expect(
      host.execute('resources.replace-local', { resourceName: 'hero.png' })
    ).rejects.toMatchObject({ code: 'missing_resource_file_path' });
    await expect(host.execute('resources.rename', { resourceName: 'hero.png' }))
      .rejects.toMatchObject({ code: 'missing_new_resource_name' });
    expect(assetTools.importLocalResource).not.toHaveBeenCalled();
    expect(assetTools.replaceLocalResource).not.toHaveBeenCalled();
    expect(assetTools.renameResource).not.toHaveBeenCalled();
  });

  test('requires a live project for resource operations', async () => {
    const { host } = makeHost(null);
    await expect(host.execute('resources.list', {})).rejects.toMatchObject({
      code: 'no_project_open',
    });
  });
});
