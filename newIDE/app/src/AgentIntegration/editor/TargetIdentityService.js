// @flow
import { AgentError } from '../core/AgentError';

const getProjectId = (project: ?gdProject): ?string => {
  if (!project || typeof project.getProjectUuid !== 'function') return null;
  try {
    const value = project.getProjectUuid();
    return typeof value === 'string' && value ? value : null;
  } catch (error) {
    return null;
  }
};

const getProjectName = (project: ?gdProject): ?string => {
  if (!project || typeof project.getName !== 'function') return null;
  try {
    return project.getName();
  } catch (error) {
    return null;
  }
};

const normalizeProjectPath = (
  fileIdentifier: ?string,
  pathModule: ?{| resolve: (path: string) => string |}
): ?string => {
  if (!fileIdentifier || typeof fileIdentifier !== 'string') return null;
  let normalized = fileIdentifier;
  try {
    normalized = pathModule
      ? pathModule.resolve(fileIdentifier)
      : fileIdentifier;
  } catch (error) {}
  return /^[A-Za-z]:[\\/]/.test(normalized)
    ? normalized.toLowerCase()
    : normalized;
};

const sceneSelector = (sceneId: string): string => `scene:${sceneId}`;
const externalEventsSelector = (id: string): string => `external-events:${id}`;
const externalLayoutSelector = (name: string): string =>
  `external-layout:${name}`;

const getSceneIdentity = (project: ?gdProject, sceneName: string): any => {
  let sceneId = sceneName;
  let identityKind = 'name-fallback';
  try {
    if (project && project.hasLayoutNamed(sceneName)) {
      const scene = project.getLayout(sceneName);
      if (typeof scene.getPersistentUuid === 'function') {
        const persistentUuid = scene.getPersistentUuid();
        if (persistentUuid) {
          sceneId = persistentUuid;
          identityKind = 'persistent-uuid';
        }
      }
    }
  } catch (error) {}
  return {
    sceneName,
    sceneId,
    selector: sceneSelector(sceneId),
    identityKind,
  };
};

const getExternalEventsIdentity = (
  project: ?gdProject,
  externalEventsName: string
): any => {
  let externalEventsId = externalEventsName;
  let identityKind = 'name-fallback';
  try {
    if (project && project.hasExternalEventsNamed(externalEventsName)) {
      const externalEvents = project.getExternalEvents(externalEventsName);
      if (typeof externalEvents.getPersistentUuid === 'function') {
        const persistentUuid = externalEvents.getPersistentUuid();
        if (persistentUuid) {
          externalEventsId = persistentUuid;
          identityKind = 'persistent-uuid';
        }
      }
    }
  } catch (error) {}
  return {
    externalEventsName,
    externalEventsId,
    selector: externalEventsSelector(externalEventsId),
    identityKind,
  };
};

const getTabSequence = (id: any): number => {
  if (typeof id !== 'string') return -1;
  const match = /^editor-tab-(\d+)$/.exec(id);
  return match ? Number(match[1]) : -1;
};

const summarizeEditorTarget = ({
  project,
  editorTab,
  paneIdentifier,
  active,
}: any): any => {
  if (!editorTab) return null;
  const projectItemName =
    typeof editorTab.projectItemName === 'string' && editorTab.projectItemName
      ? editorTab.projectItemName
      : null;
  const editorTabId =
    typeof editorTab.id === 'string' && editorTab.id ? editorTab.id : null;
  const base = {
    editorTabId,
    editorSelector: editorTabId ? `editor-tab:${editorTabId}` : null,
    editorKind: editorTab.kind || null,
    projectItemName,
    pane: paneIdentifier,
    active: !!active,
  };

  if (
    (editorTab.kind === 'layout' || editorTab.kind === 'layout events') &&
    projectItemName
  ) {
    return {
      ...base,
      targetKind: 'scene',
      ...getSceneIdentity(project, projectItemName),
    };
  }

  if (editorTab.kind === 'external events' && projectItemName) {
    let associatedSceneName = null;
    try {
      if (project && project.hasExternalEventsNamed(projectItemName)) {
        const externalEvents = project.getExternalEvents(projectItemName);
        const candidate = externalEvents.getAssociatedLayout();
        if (candidate && project.hasLayoutNamed(candidate)) {
          associatedSceneName = candidate;
        }
      }
    } catch (error) {}
    const externalEventsIdentity = getExternalEventsIdentity(
      project,
      projectItemName
    );
    const associatedSceneIdentity = associatedSceneName
      ? getSceneIdentity(project, associatedSceneName)
      : null;
    return {
      ...base,
      targetKind: 'external-events',
      ...externalEventsIdentity,
      associatedSceneName,
      associatedSceneId: associatedSceneIdentity
        ? associatedSceneIdentity.sceneId
        : null,
      associatedSceneSelector: associatedSceneIdentity
        ? associatedSceneIdentity.selector
        : null,
    };
  }

  if (editorTab.kind === 'external layout' && projectItemName) {
    return {
      ...base,
      targetKind: 'external-layout',
      externalLayoutName: projectItemName,
      selector: externalLayoutSelector(projectItemName),
    };
  }

  return {
    ...base,
    targetKind: 'editor',
    selector: base.editorSelector,
  };
};

const listEditorTargets = (
  project: ?gdProject,
  editorTabs: any
): Array<any> => {
  if (!editorTabs || !editorTabs.panes) return [];
  const targets = [];
  Object.keys(editorTabs.panes).forEach(paneIdentifier => {
    const pane = editorTabs.panes[paneIdentifier];
    if (!pane || !Array.isArray(pane.editors)) return;
    pane.editors.forEach((editorTab, index) => {
      const target = summarizeEditorTarget({
        project,
        editorTab,
        paneIdentifier,
        active: pane.currentTab === index,
      });
      if (target) targets.push(target);
    });
  });
  return targets;
};

const uniqueBy = (items: Array<any>, getKey: any): Array<any> => {
  const seen = new Set();
  return items.filter(item => {
    const key = getKey(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

export const createTargetIdentityService = ({
  project,
  getProject,
  fileIdentifier,
  pathModule,
  editorTabs,
  previewService,
}: any): any => {
  const resolveProject = (): ?gdProject => {
    if (typeof getProject === 'function') {
      try {
        return getProject();
      } catch (error) {}
    }
    return project;
  };

  const getProjectIdentity = () => {
    const currentProject = resolveProject();
    const projectId = getProjectId(currentProject);
    const scenes =
      currentProject && typeof currentProject.getLayoutsCount === 'function'
        ? Array.from(
            { length: currentProject.getLayoutsCount() },
            (_, index) => {
              const scene = currentProject.getLayoutAt(index);
              return {
                ...getSceneIdentity(currentProject, scene.getName()),
                order: index,
              };
            }
          )
        : [];
    const externalEvents =
      currentProject &&
      typeof currentProject.getExternalEventsCount === 'function'
        ? Array.from(
            { length: currentProject.getExternalEventsCount() },
            (_, index) => {
              const item = currentProject.getExternalEventsAt(index);
              return {
                ...getExternalEventsIdentity(currentProject, item.getName()),
                order: index,
                associatedSceneName: item.getAssociatedLayout() || null,
              };
            }
          )
        : [];
    return {
      open: !!currentProject && !!projectId,
      projectId,
      projectUuid: projectId,
      projectName: getProjectName(currentProject),
      fileIdentifier: fileIdentifier || null,
      normalizedProjectPath: normalizeProjectPath(fileIdentifier, pathModule),
      scenes,
      externalEvents,
    };
  };

  const getEditorIdentity = () => {
    const targets = listEditorTargets(resolveProject(), editorTabs);
    const activeTargets = targets.filter(target => target.active);
    const activeSceneTargets = uniqueBy(
      activeTargets
        .map(target => {
          if (target.targetKind === 'scene') return target;
          if (
            target.targetKind === 'external-events' &&
            target.associatedSceneName
          ) {
            return {
              targetKind: 'scene',
              sceneName: target.associatedSceneName,
              sceneId: target.associatedSceneId,
              selector: target.associatedSceneSelector,
              sourceEditorSelector: target.editorSelector,
              sourceTargetSelector: target.selector,
            };
          }
          return null;
        })
        .filter(Boolean),
      target => target.sceneId
    );
    const activeExternalEvents = uniqueBy(
      activeTargets.filter(target => target.targetKind === 'external-events'),
      target => target.externalEventsId
    );
    const sceneTabs = targets
      .filter(target => target.targetKind === 'scene')
      .slice()
      .sort(
        (left, right) =>
          getTabSequence(left.editorTabId) - getTabSequence(right.editorTabId)
      );
    const lastOpenedScene = sceneTabs.length
      ? sceneTabs[sceneTabs.length - 1]
      : null;
    return {
      targets,
      activeTargets,
      primaryTarget: activeTargets.length === 1 ? activeTargets[0] : null,
      activeScene:
        activeSceneTargets.length === 1 ? activeSceneTargets[0] : null,
      activeSceneAmbiguous: activeSceneTargets.length > 1,
      activeSceneCandidates: activeSceneTargets,
      activeExternalEvents:
        activeExternalEvents.length === 1 ? activeExternalEvents[0] : null,
      activeExternalEventsCandidates: activeExternalEvents,
      lastOpenedScene,
    };
  };

  const decoratePreviewStatus = (status: any): any => {
    const projectIdentity = getProjectIdentity();
    const targets = Array.isArray(status && status.targets)
      ? status.targets.map(target => {
          const sceneName =
            target && typeof target.sceneName === 'string' && target.sceneName
              ? target.sceneName
              : null;
          const windowId =
            target && Number.isInteger(target.windowId)
              ? target.windowId
              : null;
          const debuggerId =
            target && typeof target.debuggerId === 'string'
              ? target.debuggerId
              : null;
          const sceneIdentity = sceneName
            ? getSceneIdentity(resolveProject(), sceneName)
            : null;
          return {
            ...target,
            targetId: windowId
              ? `preview-window:${windowId}`
              : debuggerId
              ? `preview-debugger:${debuggerId}`
              : null,
            projectId: projectIdentity.projectId,
            sceneName,
            sceneId: sceneIdentity ? sceneIdentity.sceneId : null,
            sceneSelector: sceneIdentity ? sceneIdentity.selector : null,
          };
        })
      : [];
    return {
      ...(status || {}),
      project: projectIdentity,
      targets,
    };
  };

  const getStatus = (): any => ({
    project: getProjectIdentity(),
    editor: getEditorIdentity(),
    preview: decoratePreviewStatus(
      previewService && typeof previewService.getStatus === 'function'
        ? previewService.getStatus()
        : { state: 'stopped', targets: [], previewWindowIds: [] }
    ),
  });

  const refreshStatus = async (): Promise<any> => ({
    project: getProjectIdentity(),
    editor: getEditorIdentity(),
    preview: decoratePreviewStatus(
      previewService && typeof previewService.refreshStatus === 'function'
        ? await previewService.refreshStatus()
        : previewService && typeof previewService.getStatus === 'function'
        ? previewService.getStatus()
        : { state: 'stopped', targets: [], previewWindowIds: [] }
    ),
  });

  const requireProjectIdentity = () => {
    const identity = getProjectIdentity();
    if (!identity.open) throw new AgentError({ code: 'no_project_open' });
    return identity;
  };

  return {
    getProjectIdentity,
    getEditorIdentity,
    decoratePreviewStatus,
    getStatus,
    refreshStatus,
    requireProjectIdentity,
  };
};

export { externalEventsSelector, normalizeProjectPath, sceneSelector };
