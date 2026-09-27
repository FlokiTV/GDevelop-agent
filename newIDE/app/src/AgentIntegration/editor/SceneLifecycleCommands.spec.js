// @flow
import { createSceneLifecycleCommandDescriptors } from './SceneLifecycleCommands';

describe('SceneLifecycleCommands', () => {
  it('publishes complete project.scenes lifecycle surface', () => {
    const service = {
      list: jest.fn(),
      get: jest.fn(),
      usages: jest.fn(),
      create: jest.fn(),
      duplicate: jest.fn(),
      rename: jest.fn(),
      reorder: jest.fn(),
      delete: jest.fn(),
    };
    const descriptors = createSceneLifecycleCommandDescriptors({
      sceneLifecycleService: service,
    });
    expect(descriptors.map(descriptor => descriptor.name)).toEqual([
      'project.scenes.list',
      'project.scenes.get',
      'project.scenes.usages',
      'project.scenes.create',
      'project.scenes.duplicate',
      'project.scenes.rename',
      'project.scenes.reorder',
      'project.scenes.delete',
    ]);
    expect(
      descriptors.find(descriptor => descriptor.name === 'project.scenes.list')
        .metadata.readOnly
    ).toBe(true);
    expect(
      descriptors.find(
        descriptor => descriptor.name === 'project.scenes.delete'
      ).metadata
    ).toMatchObject({ modifiesProject: true, destructive: true });
  });
});
