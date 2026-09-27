// @flow
import { createTargetIdentityService } from './TargetIdentityService';

const makeProject = () => {
  const scenes = {
    SceneA: {
      getName: () => 'SceneA',
      getPersistentUuid: () => 'scene-uuid-a',
    },
    SceneB: {
      getName: () => 'SceneB',
      getPersistentUuid: () => 'scene-uuid-b',
    },
  };
  const externalEvents = {
    getName: () => 'SharedEvents',
    getPersistentUuid: () => 'external-events-uuid-a',
    getAssociatedLayout: () => 'SceneB',
  };
  return {
    getProjectUuid: () => 'project-uuid-a',
    getName: () => 'Project A',
    hasExternalEventsNamed: name => name === 'SharedEvents',
    getExternalEvents: name => {
      if (name !== 'SharedEvents') throw new Error('external_events_not_found');
      return externalEvents;
    },
    getExternalEventsCount: () => 1,
    getExternalEventsAt: index => {
      if (index !== 0) throw new Error('external_events_not_found');
      return externalEvents;
    },
    hasLayoutNamed: name => !!scenes[name],
    getLayout: name => scenes[name],
    getLayoutsCount: () => 2,
    getLayoutAt: index => [scenes.SceneA, scenes.SceneB][index],
  };
};

describe('TargetIdentityService', () => {
  it('separates project, active editor scene, external events and last-opened scene identity', async () => {
    const editorTabs = {
      panes: {
        left: {
          currentTab: 0,
          editors: [
            {
              id: 'editor-tab-1',
              kind: 'layout',
              projectItemName: 'SceneA',
            },
          ],
        },
        center: {
          currentTab: 1,
          editors: [
            {
              id: 'editor-tab-2',
              kind: 'layout',
              projectItemName: 'SceneB',
            },
            {
              id: 'editor-tab-3',
              kind: 'external events',
              projectItemName: 'SharedEvents',
            },
          ],
        },
      },
    };
    const previewService = {
      getStatus: () => ({
        state: 'ready',
        targets: [
          {
            windowId: 42,
            debuggerId: 'debugger-a',
            sceneName: 'SceneB',
            ready: true,
          },
        ],
      }),
      refreshStatus: jest.fn(async () => ({
        state: 'ready',
        targets: [
          {
            windowId: 42,
            debuggerId: 'debugger-a',
            sceneName: 'SceneB',
            ready: true,
          },
        ],
      })),
    };
    const service = createTargetIdentityService({
      project: makeProject(),
      fileIdentifier: 'C:/Games/ProjectA/game.json',
      pathModule: { resolve: value => value.replace(/\//g, '\\') },
      editorTabs,
      previewService,
    });

    const status = await service.refreshStatus();

    expect(status.project).toMatchObject({
      projectId: 'project-uuid-a',
      projectUuid: 'project-uuid-a',
      projectName: 'Project A',
      normalizedProjectPath: 'c:\\games\\projecta\\game.json',
    });
    expect(status.editor.activeScene).toBeNull();
    expect(status.editor.activeSceneAmbiguous).toBe(true);
    expect(status.editor.activeSceneCandidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sceneId: 'scene-uuid-a',
          selector: 'scene:scene-uuid-a',
        }),
        expect.objectContaining({
          sceneId: 'scene-uuid-b',
          selector: 'scene:scene-uuid-b',
        }),
      ])
    );
    expect(status.editor.activeExternalEvents).toMatchObject({
      externalEventsName: 'SharedEvents',
      externalEventsId: 'external-events-uuid-a',
      associatedSceneName: 'SceneB',
    });
    expect(status.editor.lastOpenedScene).toMatchObject({
      sceneName: 'SceneB',
      sceneId: 'scene-uuid-b',
      selector: 'scene:scene-uuid-b',
    });
    expect(status.preview.targets[0]).toMatchObject({
      targetId: 'preview-window:42',
      projectId: 'project-uuid-a',
      sceneId: 'scene-uuid-b',
      sceneSelector: 'scene:scene-uuid-b',
    });
  });

  it('reports one authoritative active scene when only one scene-bearing tab is active', () => {
    const service = createTargetIdentityService({
      project: makeProject(),
      fileIdentifier: null,
      pathModule: null,
      editorTabs: {
        panes: {
          center: {
            currentTab: 0,
            editors: [
              {
                id: 'editor-tab-9',
                kind: 'layout events',
                projectItemName: 'SceneB',
              },
            ],
          },
        },
      },
      previewService: {
        getStatus: () => ({ state: 'stopped', targets: [] }),
      },
    });

    const status = service.getStatus();
    expect(status.editor.activeSceneAmbiguous).toBe(false);
    expect(status.editor.activeScene).toMatchObject({
      sceneName: 'SceneB',
      selector: 'scene:scene-uuid-b',
    });
    expect(status.editor.primaryTarget).toMatchObject({
      editorSelector: 'editor-tab:editor-tab-9',
      targetKind: 'scene',
    });
  });

  it('keeps editor-active scene distinct from preview-running scene', () => {
    const service = createTargetIdentityService({
      project: makeProject(),
      fileIdentifier: null,
      pathModule: null,
      editorTabs: {
        panes: {
          center: {
            currentTab: 0,
            editors: [
              {
                id: 'editor-tab-10',
                kind: 'layout',
                projectItemName: 'SceneA',
              },
            ],
          },
        },
      },
      previewService: {
        getStatus: () => ({
          state: 'ready',
          targets: [
            {
              windowId: 7,
              debuggerId: 'preview-7',
              sceneName: 'SceneB',
              ready: true,
            },
          ],
        }),
      },
    });

    const status = service.getStatus();
    expect(status.editor.activeScene.sceneName).toBe('SceneA');
    expect(status.preview.targets[0].sceneName).toBe('SceneB');
  });

  it('resolves the current project dynamically after a project object is replaced', () => {
    const projectA = {
      getProjectUuid: () => 'project-a',
      getName: () => 'Project A',
    };
    const projectB = {
      getProjectUuid: () => 'project-b',
      getName: () => 'Project B',
    };
    let currentProject = projectA;
    const service = createTargetIdentityService({
      project: projectA,
      getProject: () => currentProject,
      fileIdentifier: 'C:/Games/game.json',
      pathModule: null,
      editorTabs: { panes: {} },
      previewService: {
        getStatus: () => ({ state: 'stopped', targets: [] }),
      },
    });

    expect(service.getProjectIdentity()).toMatchObject({
      open: true,
      projectId: 'project-a',
      projectName: 'Project A',
    });

    currentProject = projectB;
    expect(service.getProjectIdentity()).toMatchObject({
      open: true,
      projectId: 'project-b',
      projectName: 'Project B',
    });
  });
});
