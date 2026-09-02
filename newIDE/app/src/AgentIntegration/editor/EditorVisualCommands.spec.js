// @flow
import { createEditorVisualCommandDescriptors } from './EditorVisualCommands';

describe('EditorVisualCommands', () => {
  test('projects visual navigation into stable command descriptors', async () => {
    const editorVisualService = {
      getStatus: jest.fn(() => ({ openSceneEditors: [] })),
      selectInstances: jest.fn(input => ({ selected: input.sceneName })),
      focusSelection: jest.fn(input => ({ focused: input.sceneName })),
      openScene: jest.fn(input => ({ opened: input.sceneName, mode: input.mode })),
    };
    const descriptors = createEditorVisualCommandDescriptors({
      editorVisualService,
    });

    expect(descriptors.map(descriptor => descriptor.name)).toEqual([
      'editor.visual.status',
      'editor.instances.select',
      'editor.selection.focus',
      'scene.open',
    ]);
    expect(descriptors[0].metadata.readOnly).toBe(true);
    expect(descriptors.slice(1).every(descriptor => descriptor.metadata.readOnly === false)).toBe(
      true
    );
    expect(descriptors.every(descriptor => descriptor.metadata.requiresProject)).toBe(
      true
    );

    const openDescriptor = descriptors.find(descriptor => descriptor.name === 'scene.open');
    if (!openDescriptor) throw new Error('missing_scene_open_descriptor');
    expect(
      openDescriptor.execute({ input: { sceneName: 'Level1', mode: 'events' } })
    ).toEqual({ opened: 'Level1', mode: 'events' });
    expect(editorVisualService.openScene).toHaveBeenCalledWith({
      sceneName: 'Level1',
      mode: 'events',
    });
  });
});
