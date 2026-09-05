// @flow
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createAssetTools } from './AssetTools';

const gd: libGDevelop = global.gd;

const addImageToSpriteObject = (
  project: gdProject,
  objectName: string,
  imageName: string
) => {
  const object = project
    .getObjects()
    .insertNewObject(project, 'Sprite', objectName, 0);
  const spriteObject = gd.asSpriteConfiguration(object.getConfiguration());
  const animation = new gd.Animation();
  animation.setDirectionsCount(1);
  const sprite = new gd.Sprite();
  sprite.setImageName(imageName);
  animation.getDirection(0).addSprite(sprite);
  spriteObject.getAnimations().addAnimation(animation);
  return object;
};

const addImageResource = (
  project: gdProject,
  name: string,
  file: string = name
) => {
  const resource = new gd.ImageResource();
  resource.setName(name);
  resource.setFile(file);
  project.getResourcesManager().addResource(resource);
  resource.delete();
};

const makeTools = (
  project: gdProject,
  options: {| maxLocalFileBytes?: number |} = {}
) => {
  const onNewResourcesAdded = jest.fn();
  const onResourceUsageChanged = jest.fn();
  const triggerUnsavedChanges = jest.fn();
  const forceUpdate = jest.fn();
  const tools = createAssetTools({
    project,
    // Only these callbacks are used by AssetTools.
    // $FlowFixMe[incompatible-type]
    resourceManagementProps: {
      onNewResourcesAdded,
      onResourceUsageChanged,
    },
    triggerUnsavedChanges,
    forceUpdate,
    maxLocalFileBytes: options.maxLocalFileBytes,
  });
  return {
    tools,
    onNewResourcesAdded,
    onResourceUsageChanged,
    triggerUnsavedChanges,
    forceUpdate,
  };
};

describe('AgentIntegration AssetTools', () => {
  it('lists used and orphaned resources and inspects object usage', () => {
    const project = gd.ProjectHelper.createNewGDJSProject();
    addImageResource(project, 'used.png');
    addImageResource(project, 'orphan.png');
    addImageToSpriteObject(project, 'Player', 'used.png');

    const { tools } = makeTools(project);
    const result = tools.listResources();
    expect(result.summary.total).toBe(2);
    expect(result.summary.used).toBe(1);
    expect(result.summary.orphaned).toBe(1);
    expect(
      result.resources.find(resource => resource.name === 'used.png')
        .usedInProject
    ).toBe(true);
    expect(
      result.resources.find(resource => resource.name === 'orphan.png').orphaned
    ).toBe(true);

    const inspected = tools.inspectResource('used.png');
    expect(inspected.objectNamesUsingResource).toContain('Player');
    project.delete();
  });

  it('ignores empty resource references exposed by objects or behaviors', () => {
    const project = gd.ProjectHelper.createNewGDJSProject();
    addImageToSpriteObject(project, 'EmptySprite', '');
    const { tools } = makeTools(project);

    const result = tools.listResources();
    expect(result.unregisteredReferences).toEqual([]);
    expect(result.summary.unregisteredReferences).toBe(0);
    project.delete();
  });

  it('keeps fileStatus consistent with insideProjectFolder on Windows path casing', () => {
    if (process.platform !== 'win32') return;

    const project = gd.ProjectHelper.createNewGDJSProject();
    const projectFolder = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gd-agent-assets-case-')
    );
    const projectFile = path.join(projectFolder, 'game.json');
    const resourceFile = path.join(projectFolder, 'inside.png');
    fs.writeFileSync(resourceFile, Buffer.from([1, 2, 3]));
    project.setProjectFile(projectFile);
    addImageResource(project, 'inside.png', resourceFile.toLowerCase());

    const { tools } = makeTools(project);
    const resource = tools.inspectResource('inside.png');

    expect(resource.fileExists).toBe(true);
    expect(resource.insideProjectFolder).toBe(true);
    expect(resource.fileStatus).toBe('');

    project.delete();
    fs.rmSync(projectFolder, { recursive: true, force: true });
  });

  it('renames a resource and updates object references', () => {
    const project = gd.ProjectHelper.createNewGDJSProject();
    addImageResource(project, 'old.png');
    const object = addImageToSpriteObject(project, 'Player', 'old.png');
    const { tools, onResourceUsageChanged, triggerUnsavedChanges } = makeTools(
      project
    );

    tools.renameResource({
      resourceName: 'old.png',
      newResourceName: 'player.png',
    });

    expect(project.getResourcesManager().hasResource('old.png')).toBe(false);
    expect(project.getResourcesManager().hasResource('player.png')).toBe(true);
    expect(
      gd
        .asSpriteConfiguration(object.getConfiguration())
        .getAnimations()
        .getAnimation(0)
        .getDirection(0)
        .getSprite(0)
        .getImageName()
    ).toBe('player.png');
    expect(onResourceUsageChanged).toHaveBeenCalledTimes(1);
    expect(triggerUnsavedChanges).toHaveBeenCalledTimes(1);
    project.delete();
  });

  it('refuses to remove a resource that is still referenced', () => {
    const project = gd.ProjectHelper.createNewGDJSProject();
    addImageResource(project, 'used.png');
    addImageToSpriteObject(project, 'Player', 'used.png');
    const { tools } = makeTools(project);

    expect(() => tools.removeResource({ resourceName: 'used.png' })).toThrow(
      'resource_in_use:used.png'
    );
    expect(project.getResourcesManager().hasResource('used.png')).toBe(true);
    project.delete();
  });

  it('removes an orphan resource and can delete its local file safely', () => {
    const project = gd.ProjectHelper.createNewGDJSProject();
    const projectFolder = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gd-agent-assets-')
    );
    const projectFile = path.join(projectFolder, 'game.json');
    const resourceFile = path.join(projectFolder, 'orphan.png');
    fs.writeFileSync(resourceFile, Buffer.from([1, 2, 3]));
    project.setProjectFile(projectFile);
    addImageResource(project, 'orphan.png', 'orphan.png');
    const { tools } = makeTools(project);

    const result = tools.removeResource({
      resourceName: 'orphan.png',
      deleteFile: true,
    });

    expect(result.removed).toBe(true);
    expect(result.fileDeleted).toBe(true);
    expect(project.getResourcesManager().hasResource('orphan.png')).toBe(false);
    expect(fs.existsSync(resourceFile)).toBe(false);

    project.delete();
    fs.rmSync(projectFolder, { recursive: true, force: true });
  });

  it('rejects oversized local resource files before mutating the project', async () => {
    const project = gd.ProjectHelper.createNewGDJSProject();
    const sourceFolder = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gd-agent-assets-size-')
    );
    const sourceFile = path.join(sourceFolder, 'oversized.png');
    fs.writeFileSync(sourceFile, Buffer.alloc(32, 1));
    const { tools, triggerUnsavedChanges } = makeTools(project, {
      maxLocalFileBytes: 16,
    });

    await expect(
      tools.importLocalResource({
        filePath: sourceFile,
        resourceName: 'oversized.png',
      })
    ).rejects.toThrow('resource_file_too_large:32:16');
    expect(project.getResourcesManager().hasResource('oversized.png')).toBe(
      false
    );
    expect(triggerUnsavedChanges).not.toHaveBeenCalled();

    project.delete();
    fs.rmSync(sourceFolder, { recursive: true, force: true });
  });

  it('refuses physical deletion for a resource file outside the project folder', () => {
    const project = gd.ProjectHelper.createNewGDJSProject();
    const projectFolder = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gd-agent-assets-project-')
    );
    const outsideFolder = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gd-agent-assets-outside-')
    );
    const outsideFile = path.join(outsideFolder, 'outside.png');
    fs.writeFileSync(outsideFile, Buffer.from([1, 2, 3]));
    project.setProjectFile(path.join(projectFolder, 'game.json'));
    addImageResource(project, 'outside.png', outsideFile);
    const { tools } = makeTools(project);

    expect(() =>
      tools.removeResource({ resourceName: 'outside.png', deleteFile: true })
    ).toThrow('resource_file_outside_project_folder');
    expect(project.getResourcesManager().hasResource('outside.png')).toBe(true);
    expect(fs.existsSync(outsideFile)).toBe(true);

    project.delete();
    fs.rmSync(projectFolder, { recursive: true, force: true });
    fs.rmSync(outsideFolder, { recursive: true, force: true });
  });

  it('refuses physical deletion when another resource shares the file', () => {
    const project = gd.ProjectHelper.createNewGDJSProject();
    const projectFolder = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gd-agent-assets-')
    );
    const resourceFile = path.join(projectFolder, 'shared.png');
    fs.writeFileSync(resourceFile, Buffer.from([1, 2, 3]));
    project.setProjectFile(path.join(projectFolder, 'game.json'));
    addImageResource(project, 'one', 'shared.png');
    addImageResource(project, 'two', 'shared.png');
    const { tools } = makeTools(project);

    expect(() =>
      tools.removeResource({ resourceName: 'one', deleteFile: true })
    ).toThrow('resource_file_shared_by:two');
    expect(project.getResourcesManager().hasResource('one')).toBe(true);
    expect(fs.existsSync(resourceFile)).toBe(true);

    project.delete();
    fs.rmSync(projectFolder, { recursive: true, force: true });
  });

  it('preserves resource identity metadata and origin when replacing its file', async () => {
    const project = gd.ProjectHelper.createNewGDJSProject();
    const projectFolder = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gd-agent-assets-replace-')
    );
    const oldFile = path.join(projectFolder, 'old.png');
    const replacementFile = path.join(projectFolder, 'replacement.png');
    fs.writeFileSync(oldFile, Buffer.from([1, 2, 3]));
    fs.writeFileSync(replacementFile, Buffer.from([4, 5, 6]));
    project.setProjectFile(path.join(projectFolder, 'game.json'));
    addImageResource(project, 'player.png', 'old.png');
    const resource = project.getResourcesManager().getResource('player.png');
    resource.setMetadata('keep-this-metadata');
    resource.setOrigin('store-origin', 'store-id');
    const { tools } = makeTools(project);

    const result = await tools.replaceLocalResource({
      resourceName: 'player.png',
      filePath: replacementFile,
      copyToProject: false,
      preserveOrigin: true,
    });

    const replacedResource = project
      .getResourcesManager()
      .getResource('player.png');
    expect(result.replaced).toBe(true);
    expect(replacedResource.getName()).toBe('player.png');
    expect(replacedResource.getMetadata()).toBe('keep-this-metadata');
    expect(replacedResource.getOriginName()).toBe('store-origin');
    expect(replacedResource.getOriginIdentifier()).toBe('store-id');
    expect(replacedResource.getFile()).toBe('replacement.png');

    project.delete();
    fs.rmSync(projectFolder, { recursive: true, force: true });
  });
});
