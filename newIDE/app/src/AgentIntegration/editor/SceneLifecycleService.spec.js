// @flow
import { createSceneLifecycleService } from './SceneLifecycleService';

const gd: libGDevelop = global.gd;

describe('SceneLifecycleService', () => {
  let project: gdProject;
  let service: any;
  let triggerUnsavedChanges;
  let forceUpdate;
  let onWillDeleteScene;

  beforeEach(() => {
    // $FlowFixMe[invalid-constructor]
    project = new gd.ProjectHelper.createNewGDJSProject();
    project.resetProjectUuid();
    project.setName('DX33 Scene Lifecycle');
    project.insertNewLayout('Menu', 0);
    project.insertNewLayout('Game', 1);
    project.setFirstLayout('Menu');
    triggerUnsavedChanges = jest.fn();
    forceUpdate = jest.fn();
    onWillDeleteScene = jest.fn(async () => {});
    service = createSceneLifecycleService({
      project,
      triggerUnsavedChanges,
      forceUpdate,
      onWillDeleteScene,
    });
  });

  afterEach(() => {
    project.delete();
  });

  it('lists and gets scenes by persistent identity', () => {
    const list = service.list();
    expect(list.total).toBe(2);
    expect(list.items[0]).toMatchObject({
      name: 'Menu',
      order: 0,
      firstScene: true,
    });
    expect(list.items[0].sceneId).toBeTruthy();
    expect(list.items[0].selector).toBe(`scene:${list.items[0].sceneId}`);

    expect(
      service.get({ selector: list.items[1].selector }).scene
    ).toMatchObject({
      sceneId: list.items[1].sceneId,
      name: 'Game',
    });
  });

  it('duplicates with a new persistent UUID and preserves source content', () => {
    const source = project.getLayout('Game');
    source.setBackgroundColor(10, 20, 30);
    const sourceId = source.getPersistentUuid();

    const result = service.duplicate({
      sceneId: sourceId,
      newName: 'Game Copy',
    });

    expect(result.scene.name).toBe('Game Copy');
    expect(result.scene.sceneId).not.toBe(sourceId);
    expect(project.getLayout('Game Copy').getBackgroundColorRed()).toBe(10);
    expect(project.getLayout('Game Copy').getBackgroundColorGreen()).toBe(20);
    expect(project.getLayout('Game Copy').getBackgroundColorBlue()).toBe(30);
  });

  it('renames by persistent UUID while preserving identity and native references', () => {
    const game = project.getLayout('Game');
    const gameId = game.getPersistentUuid();
    project.setFirstLayout('Game');
    project.setPreviewLayout('Game');
    const externalEvents = project.insertNewExternalEvents('Shared', 0);
    externalEvents.setAssociatedLayout('Game');

    const result = service.rename({
      sceneId: gameId,
      newName: 'Gameplay',
    });

    expect(result.preservedSceneId).toBe(gameId);
    expect(result.scene.selector).toBe(`scene:${gameId}`);
    expect(project.hasLayoutNamed('Game')).toBe(false);
    expect(project.getLayout('Gameplay').getPersistentUuid()).toBe(gameId);
    expect(project.getFirstLayout()).toBe('Gameplay');
    expect(project.getPreviewLayout()).toBe('Gameplay');
    expect(externalEvents.getAssociatedLayout()).toBe('Gameplay');
    expect(result.referencesUpdated).toBeGreaterThanOrEqual(3);
  });

  it('detects stale id/name pairs and invalid order without mutating', () => {
    const items = service.list().items;
    expect(() =>
      service.get({
        sceneId: items[0].sceneId,
        name: items[1].name,
      })
    ).toThrow(expect.objectContaining({ code: 'stale_scene_target' }));
    expect(() =>
      service.reorder({ sceneId: items[0].sceneId, position: 99 })
    ).toThrow(expect.objectContaining({ code: 'invalid_scene_order' }));
    expect(service.list().items.map(item => item.name)).toEqual([
      'Menu',
      'Game',
    ]);
  });

  it('reorders one scene without changing persistent identities or unrelated content', () => {
    const before = service.list().items;
    project.getLayout('Menu').setWindowDefaultTitle('Keep me');
    const gameId = before.find(item => item.name === 'Game').sceneId;
    const menuId = before.find(item => item.name === 'Menu').sceneId;

    const result = service.reorder({ sceneId: gameId, position: 0 });

    expect(result.reordered).toBe(true);
    expect(service.list().items.map(item => item.name)).toEqual([
      'Game',
      'Menu',
    ]);
    expect(project.getLayout('Game').getPersistentUuid()).toBe(gameId);
    expect(project.getLayout('Menu').getPersistentUuid()).toBe(menuId);
    expect(project.getLayout('Menu').getWindowDefaultTitle()).toBe('Keep me');
  });

  it('dry-runs deletion, blocks referenced scenes and deletes unreferenced scenes safely', async () => {
    project.setFirstLayout('Game');
    const gameId = project.getLayout('Game').getPersistentUuid();

    const dryRun = await service.delete({ sceneId: gameId, dryRun: true });
    expect(dryRun.blockerCount).toBeGreaterThanOrEqual(1);
    expect(project.hasLayoutNamed('Game')).toBe(true);

    await expect(service.delete({ sceneId: gameId })).rejects.toMatchObject({
      code: 'scene_delete_blocked',
    });

    project.setFirstLayout('Menu');
    const deleted = await service.delete({ sceneId: gameId });
    expect(deleted.deleted).toBe(true);
    expect(project.hasLayoutNamed('Game')).toBe(false);
    expect(onWillDeleteScene).toHaveBeenCalledTimes(1);
  });
});
