// @flow
import {
  createEditorVisualTools,
  restoreOpenSceneEditors,
} from './EditorVisualTools';

const gd: libGDevelop = global.gd;

describe('AgentIntegration EditorVisualTools', () => {
  let project: gdProject;
  let layout: gdLayout;
  let player1: gdInitialInstance;
  let player2: gdInitialInstance;
  let enemy: gdInitialInstance;
  let selectedInstances;
  let sceneEditor;
  let editorTabs;

  const addInstance = (objectName, x, y, z = 0) => {
    const instance = layout.getInitialInstances().insertNewInitialInstance();
    instance.setObjectName(objectName);
    instance.setX(x);
    instance.setY(y);
    instance.setZ(z);
    return instance;
  };

  beforeEach(() => {
    project = gd.ProjectHelper.createNewGDJSProject();
    layout = project.insertNewLayout('Level1', 0);
    player1 = addInstance('Player', 10, 20, 30);
    player2 = addInstance('Player', 40, 50, 60);
    enemy = addInstance('Enemy', 100, 120, 0);
    selectedInstances = [];
    sceneEditor = {
      instancesSelection: {
        getSelectedInstances: jest.fn(() => selectedInstances),
      },
      _setSelectedInstances: jest.fn(instances => {
        selectedInstances = instances;
      }),
      focusOnSelection: jest.fn(),
      zoomToFitSelection: jest.fn(),
    };
    editorTabs = {
      panes: {
        left: {
          currentTab: 0,
          editors: [
            {
              editorRef: {
                getLayout: () => layout,
                editor: sceneEditor,
              },
            },
          ],
        },
      },
    };
  });

  afterEach(() => {
    project.delete();
  });

  it('lists open scene editors', () => {
    const tools = createEditorVisualTools({ project, editorTabs });
    expect(tools.listOpenSceneEditors()).toEqual([
      {
        sceneName: 'Level1',
        editorReady: true,
        active: true,
        pane: 'left',
      },
    ]);
  });

  it('restores unique open scene editors and focuses the previously active scene', () => {
    project.insertNewLayout('Level2', 1);
    const onOpenLayout = jest.fn();

    const result = restoreOpenSceneEditors({
      project,
      openSceneEditors: [
        { sceneName: 'Level1', active: false },
        { sceneName: 'Level2', active: true },
        { sceneName: 'Level2', active: false },
        { sceneName: 'DeletedScene', active: false },
      ],
      onOpenLayout,
    });

    expect(result).toEqual({
      sceneNames: ['Level1', 'Level2'],
      activeSceneName: 'Level2',
    });
    expect(onOpenLayout).toHaveBeenNthCalledWith(1, 'Level1', {
      openEventsEditor: false,
      openSceneEditor: true,
      focusWhenOpened: 'none',
    });
    expect(onOpenLayout).toHaveBeenNthCalledWith(2, 'Level2', {
      openEventsEditor: false,
      openSceneEditor: true,
      focusWhenOpened: 'scene',
    });
  });

  it('selects all instances of an object and fits the view', () => {
    const tools = createEditorVisualTools({ project, editorTabs });
    const result = tools.selectInstances({
      sceneName: 'Level1',
      objectName: 'Player',
    });

    expect(result.selectedCount).toBe(2);
    expect(result.focusMode).toBe('fit');
    expect(sceneEditor._setSelectedInstances).toHaveBeenCalledWith(
      [player1, player2],
      false
    );
    expect(sceneEditor.zoomToFitSelection).toHaveBeenCalledTimes(1);
    expect(result.instances[0]).toMatchObject({
      objectName: 'Player',
      x: 10,
      y: 20,
      z: 30,
    });
  });

  it('selects one instance by the same shortened id used by EditorFunctions', () => {
    const tools = createEditorVisualTools({ project, editorTabs });
    const result = tools.selectInstances({
      sceneName: 'Level1',
      instanceId: enemy.getPersistentUuid().slice(0, 10),
    });

    expect(result.selectedCount).toBe(1);
    expect(result.instances[0].id).toBe(enemy.getPersistentUuid().slice(0, 10));
    expect(result.focusMode).toBe('center');
    expect(sceneEditor.focusOnSelection).toHaveBeenCalledTimes(1);
  });

  it('focuses the existing selection without changing it', () => {
    selectedInstances = [player1];
    const tools = createEditorVisualTools({ project, editorTabs });
    const result = tools.focusSelection({ sceneName: 'Level1', mode: 'fit' });

    expect(result.focused).toBe(true);
    expect(result.selectedCount).toBe(1);
    expect(sceneEditor.zoomToFitSelection).toHaveBeenCalledTimes(1);
    expect(sceneEditor._setSelectedInstances).not.toHaveBeenCalled();
  });

  it('refuses selection when the scene editor is not mounted', () => {
    editorTabs.panes.left.editors[0].editorRef.editor = null;
    const tools = createEditorVisualTools({ project, editorTabs });
    expect(() =>
      tools.selectInstances({ sceneName: 'Level1', objectName: 'Player' })
    ).toThrow('scene_editor_not_open:Level1');
  });
});
