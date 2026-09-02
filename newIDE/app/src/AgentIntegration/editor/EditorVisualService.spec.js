// @flow
import { createEditorVisualService } from './EditorVisualService';

describe('EditorVisualService', () => {
  const makeFixture = () => {
    const project: any = {
      hasLayoutNamed: jest.fn(name => name === 'Level1'),
    };
    const editorVisualTools = {
      listOpenSceneEditors: jest.fn(() => [
        { sceneName: 'Level1', active: true, editorReady: true, pane: 'main' },
      ]),
      selectInstances: jest.fn(input => ({ selectedCount: 1, ...input })),
      focusSelection: jest.fn(input => ({ focused: true, ...input })),
    };
    const onOpenLayout = jest.fn();
    return {
      project,
      editorVisualTools,
      onOpenLayout,
      service: createEditorVisualService({
        project,
        editorVisualTools,
        onOpenLayout,
      }),
    };
  };

  test('reports open scene editors and delegates selection/focus', () => {
    const fixture = makeFixture();
    expect(fixture.service.getStatus()).toEqual({
      openSceneEditors: [
        { sceneName: 'Level1', active: true, editorReady: true, pane: 'main' },
      ],
    });
    expect(
      fixture.service.selectInstances({ sceneName: 'Level1', objectName: 'Player' })
    ).toMatchObject({ selectedCount: 1, sceneName: 'Level1' });
    expect(
      fixture.service.focusSelection({ sceneName: 'Level1', mode: 'fit' })
    ).toMatchObject({ focused: true, mode: 'fit' });
  });

  test('opens scene/events using the same live editor callback semantics', () => {
    const fixture = makeFixture();
    expect(
      fixture.service.openScene({ sceneName: 'Level1', mode: 'both' })
    ).toEqual({ opened: true, sceneName: 'Level1', mode: 'both' });
    expect(fixture.onOpenLayout).toHaveBeenCalledWith('Level1', {
      openEventsEditor: true,
      openSceneEditor: true,
      focusWhenOpened: 'scene',
    });
  });

  test('rejects missing projects, missing scenes and invalid modes', () => {
    const fixture = makeFixture();
    expect(() => fixture.service.openScene({ sceneName: 'Missing' })).toThrow(
      'scene_not_found'
    );
    expect(() =>
      fixture.service.openScene({ sceneName: 'Level1', mode: 'invalid' })
    ).toThrow('invalid_scene_open_mode');

    const projectless = createEditorVisualService({
      project: null,
      editorVisualTools: null,
      onOpenLayout: jest.fn(),
    });
    expect(() => projectless.getStatus()).toThrow('no_project_open');
  });
});
