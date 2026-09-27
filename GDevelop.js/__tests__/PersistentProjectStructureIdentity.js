const initializeGDevelopJs = require('../../Binaries/embuild/GDevelop.js/libGD.js');

describe('libGD.js - persistent project structure identity', () => {
  let gd = null;

  beforeAll(async () => {
    gd = await initializeGDevelopJs();
  });

  it('persists scene and External Events UUIDs across serialization and rename', () => {
    const serializerElement = new gd.SerializerElement();
    let sceneUuid = null;
    let externalEventsUuid = null;

    {
      const project = gd.ProjectHelper.createNewGDJSProject();
      const scene = project.insertNewLayout('Scene A', 0);
      const externalEvents = project.insertNewExternalEvents('Shared', 0);

      sceneUuid = scene.getPersistentUuid();
      externalEventsUuid = externalEvents.getPersistentUuid();

      expect(sceneUuid).toEqual(expect.any(String));
      expect(sceneUuid).not.toBe('');
      expect(externalEventsUuid).toEqual(expect.any(String));
      expect(externalEventsUuid).not.toBe('');

      scene.setName('Scene Renamed');
      gd.WholeProjectRefactorer.renameLayout(
        project,
        'Scene A',
        'Scene Renamed'
      );
      externalEvents.setName('Shared Renamed');
      gd.WholeProjectRefactorer.renameExternalEvents(
        project,
        'Shared',
        'Shared Renamed'
      );

      expect(scene.getPersistentUuid()).toBe(sceneUuid);
      expect(externalEvents.getPersistentUuid()).toBe(externalEventsUuid);

      project.serializeTo(serializerElement);
      project.delete();
    }

    {
      const project = gd.ProjectHelper.createNewGDJSProject();
      project.unserializeFrom(serializerElement);

      expect(project.getLayout('Scene Renamed').getPersistentUuid()).toBe(
        sceneUuid
      );
      expect(
        project
          .getExternalEvents('Shared Renamed')
          .getPersistentUuid()
      ).toBe(externalEventsUuid);

      project.delete();
    }

    serializerElement.delete();
  });

  it('can reset persistent UUIDs for explicit duplicates without changing the original identity', () => {
    const project = gd.ProjectHelper.createNewGDJSProject();
    const sourceScene = project.insertNewLayout('Source', 0);
    const sourceExternalEvents = project.insertNewExternalEvents('Shared', 0);

    const sceneUuid = sourceScene.getPersistentUuid();
    const externalEventsUuid = sourceExternalEvents.getPersistentUuid();

    sourceScene.resetPersistentUuid();
    sourceExternalEvents.resetPersistentUuid();

    expect(sourceScene.getPersistentUuid()).not.toBe(sceneUuid);
    expect(sourceExternalEvents.getPersistentUuid()).not.toBe(
      externalEventsUuid
    );

    project.delete();
  });

});
