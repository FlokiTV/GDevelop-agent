// @flow
import { AgentHost } from '../core/AgentHost';
import { createResourceCommandDescriptors } from './ResourceCommands';

const makeHost = (project: any = {}) => {
  const assetTools = {
    listResources: jest.fn(() => ({ resources: [] })),
    inspectResource: jest.fn(resourceName => ({ name: resourceName })),
    inspectResourcePackaging: jest.fn(input => ({ resources: [], input })),
    inspectVisualResource: jest.fn(input => ({ visual: true, input })),
    importVisualResource: jest.fn(input => ({ imported: true, input })),
    replaceVisualResource: jest.fn(input => ({ replaced: true, input })),
    relocateVisualResource: jest.fn(input => ({ relocated: true, input })),
    deleteVisualResource: jest.fn(input => ({ deleted: true, input })),
    readTextResource: jest.fn(input => ({ content: 'ok', input })),
    writeTextResource: jest.fn(input => ({ written: true, input })),
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
    expect(host.describeCommand('resources.inspect').metadata.readOnly).toBe(
      true
    );
    expect(
      host.describeCommand('resources.replace-local').metadata
    ).toMatchObject({
      destructive: true,
      modifiesProject: true,
    });
    expect(host.describeCommand('resources.remove').metadata).toMatchObject({
      destructive: true,
      modifiesProject: true,
    });
  });

  test('exposes text authoring and packaging metadata with correct safety', () => {
    const { host } = makeHost();
    expect(host.describeCommand('resources.text.read').metadata.readOnly).toBe(
      true
    );
    expect(
      host.describeCommand('resources.packaging.inspect').metadata.readOnly
    ).toBe(true);
    expect(
      host.describeCommand('resources.text.create').metadata
    ).toMatchObject({
      modifiesProject: true,
      destructive: false,
    });
    expect(
      host.describeCommand('resources.text.update').metadata
    ).toMatchObject({
      modifiesProject: true,
      destructive: true,
      idempotent: true,
    });
  });

  test('routes text create/update/read and packaging inspection', async () => {
    const { host, assetTools } = makeHost();
    const createInput = {
      resourceName: 'locales/es.json',
      relativePath: 'locales/es.json',
      format: 'json',
      content: '{"hello":"Hola"}',
    };
    const updateInput = {
      resourceName: 'locales/es.json',
      format: 'json',
      content: '{"hello":"Buenas"}',
    };

    await host.execute('resources.text.create', createInput);
    await host.execute('resources.text.update', updateInput);
    await host.execute('resources.text.read', {
      resourceName: 'locales/es.json',
      parseJson: true,
    });
    await host.execute('resources.packaging.inspect', {
      resourceName: 'locales/es.json',
    });

    expect(assetTools.writeTextResource).toHaveBeenNthCalledWith(1, {
      ...createInput,
      createOnly: true,
    });
    expect(assetTools.writeTextResource).toHaveBeenNthCalledWith(2, {
      ...updateInput,
      updateOnly: true,
    });
    expect(assetTools.readTextResource).toHaveBeenCalledWith({
      resourceName: 'locales/es.json',
      parseJson: true,
    });
    expect(assetTools.inspectResourcePackaging).toHaveBeenCalledWith({
      resourceName: 'locales/es.json',
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
    const renameInput = {
      resourceName: 'hero.png',
      newResourceName: 'player.png',
    };
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
    await expect(
      host.execute('resources.import-local', {})
    ).rejects.toMatchObject({
      code: 'missing_resource_file_path',
    });
    await expect(
      host.execute('resources.replace-local', { resourceName: 'hero.png' })
    ).rejects.toMatchObject({ code: 'missing_resource_file_path' });
    await expect(
      host.execute('resources.rename', { resourceName: 'hero.png' })
    ).rejects.toMatchObject({ code: 'missing_new_resource_name' });
    expect(assetTools.importLocalResource).not.toHaveBeenCalled();
    expect(assetTools.replaceLocalResource).not.toHaveBeenCalled();
    expect(assetTools.renameResource).not.toHaveBeenCalled();
  });

  test('exposes visual authoring contracts with safe dry-run metadata', () => {
    const { host } = makeHost();
    expect(
      host.describeCommand('resources.visual.inspect').metadata
    ).toMatchObject({
      readOnly: true,
      modifiesProject: false,
    });
    expect(
      host.describeCommand('resources.visual.import').metadata
    ).toMatchObject({
      modifiesProject: true,
      destructive: false,
    });
    expect(
      host.describeCommand('resources.visual.replace').metadata
    ).toMatchObject({
      modifiesProject: true,
      destructive: true,
      idempotent: true,
    });
    const relocate = host.registry.get('resources.visual.relocate');
    const remove = host.registry.get('resources.visual.delete');
    expect(relocate.modifiesProjectWhen({ dryRun: true })).toBe(false);
    expect(relocate.modifiesProjectWhen({ dryRun: false })).toBe(true);
    expect(remove.modifiesProjectWhen({ dryRun: true })).toBe(false);
    expect(remove.modifiesProjectWhen({ dryRun: false })).toBe(true);
  });

  test('routes visual inspect/import/replace/relocate/delete without path bootstrap', async () => {
    const { host, assetTools } = makeHost();
    const imageBytes = Buffer.from([1, 2, 3]).toString('base64');
    const importInput = {
      resourceName: 'hero',
      kind: 'image',
      contentBase64: imageBytes,
    };
    const replaceInput = {
      resourceName: 'hero',
      contentBase64: imageBytes,
    };
    const relocateInput = {
      resourceName: 'hero',
      newResourceName: 'player-art',
      newRelativePath: 'art/player.png',
      dryRun: false,
    };
    const deleteInput = {
      resourceName: 'player-art',
      deleteFile: true,
      dryRun: true,
    };

    await host.execute('resources.visual.inspect', { resourceName: 'hero' });
    await host.execute('resources.visual.import', importInput);
    await host.execute('resources.visual.replace', replaceInput);
    await host.execute('resources.visual.relocate', relocateInput);
    await host.execute('resources.visual.delete', deleteInput);

    expect(assetTools.inspectVisualResource).toHaveBeenCalledWith({
      resourceName: 'hero',
    });
    expect(assetTools.importVisualResource).toHaveBeenCalledWith(importInput);
    expect(assetTools.replaceVisualResource).toHaveBeenCalledWith(replaceInput);
    expect(assetTools.relocateVisualResource).toHaveBeenCalledWith(
      relocateInput
    );
    expect(assetTools.deleteVisualResource).toHaveBeenCalledWith(deleteInput);
  });

  test('validates visual content and relocation intent before mutation', async () => {
    const { host, assetTools } = makeHost();
    await expect(
      host.execute('resources.visual.import', { resourceName: 'hero' })
    ).rejects.toMatchObject({ code: 'missing_visual_resource_content' });
    await expect(
      host.execute('resources.visual.relocate', { resourceName: 'hero' })
    ).rejects.toMatchObject({ code: 'missing_visual_resource_relocation' });
    expect(assetTools.importVisualResource).not.toHaveBeenCalled();
    expect(assetTools.relocateVisualResource).not.toHaveBeenCalled();
  });

  test('does not advance project revision for visual dry-runs', async () => {
    let revision = 10;
    const projectRevisionTracker = {
      synchronize: jest.fn(() => revision),
      markMutation: jest.fn(() => ++revision),
      getLastChangeContext: jest.fn(() => null),
    };
    const assetTools = {
      listResources: jest.fn(() => ({ resources: [] })),
      inspectResource: jest.fn(),
      inspectResourcePackaging: jest.fn(),
      inspectVisualResource: jest.fn(),
      importVisualResource: jest.fn(),
      replaceVisualResource: jest.fn(),
      relocateVisualResource: jest.fn(input => ({
        dryRun: input.dryRun !== false,
      })),
      deleteVisualResource: jest.fn(input => ({
        dryRun: input.dryRun !== false,
      })),
      readTextResource: jest.fn(),
      writeTextResource: jest.fn(),
      importLocalResource: jest.fn(),
      replaceLocalResource: jest.fn(),
      renameResource: jest.fn(),
      removeResource: jest.fn(),
    };
    const host = new AgentHost({
      environment: { project: {}, projectRevisionTracker },
      descriptors: createResourceCommandDescriptors({ assetTools }),
    });

    const relocate = await host.execute('resources.visual.relocate', {
      resourceName: 'hero',
      newRelativePath: 'art/hero.png',
      dryRun: true,
    });
    const remove = await host.execute('resources.visual.delete', {
      resourceName: 'hero',
      dryRun: true,
    });
    expect(relocate.meta.modifiesProject).toBe(false);
    expect(remove.meta.modifiesProject).toBe(false);
    expect(projectRevisionTracker.markMutation).not.toHaveBeenCalled();
    expect(revision).toBe(10);
  });

  test('requires a live project for resource operations', async () => {
    const { host } = makeHost(null);
    await expect(host.execute('resources.list', {})).rejects.toMatchObject({
      code: 'no_project_open',
    });
  });
});
