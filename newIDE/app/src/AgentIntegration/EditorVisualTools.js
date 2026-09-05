// @flow

const gd: libGDevelop = global.gd;

const makeError = (code: string, message?: string): Error => {
  const error: any = new Error(message || code);
  error.code = code;
  return error;
};

const getAllTabs = (editorTabs: any): Array<any> => {
  if (!editorTabs || !editorTabs.panes) return [];
  const tabs = [];
  Object.keys(editorTabs.panes).forEach(paneIdentifier => {
    const pane = editorTabs.panes[paneIdentifier];
    if (!pane || !Array.isArray(pane.editors)) return;
    pane.editors.forEach((editorTab, index) => {
      tabs.push({
        editorTab,
        paneIdentifier,
        active: pane.currentTab === index,
      });
    });
  });
  return tabs;
};

const getSceneEditorEntry = (editorTabs: any, sceneName: string): any => {
  const entries = getAllTabs(editorTabs);
  for (const entry of entries) {
    const editorRef = entry.editorTab && entry.editorTab.editorRef;
    if (!editorRef || typeof editorRef.getLayout !== 'function') continue;
    const layout = editorRef.getLayout();
    if (!layout || layout.getName() !== sceneName) continue;
    if (!editorRef.editor) continue;
    return { ...entry, editorRef, layout, sceneEditor: editorRef.editor };
  }
  return null;
};

export const restoreOpenSceneEditors = ({
  project,
  openSceneEditors,
  onOpenLayout,
}: {|
  project: gdProject,
  openSceneEditors: Array<any>,
  onOpenLayout: (sceneName: string, options: any) => void,
|}): any => {
  const sceneNames = [];
  const seenSceneNames = new Set();
  let requestedActiveSceneName = null;

  for (const entry of openSceneEditors || []) {
    if (!entry || typeof entry.sceneName !== 'string' || !entry.sceneName)
      continue;
    if (entry.active) requestedActiveSceneName = entry.sceneName;
    if (seenSceneNames.has(entry.sceneName)) continue;
    seenSceneNames.add(entry.sceneName);
    if (project.hasLayoutNamed(entry.sceneName))
      sceneNames.push(entry.sceneName);
  }

  const activeSceneName =
    requestedActiveSceneName && sceneNames.includes(requestedActiveSceneName)
      ? requestedActiveSceneName
      : sceneNames.length
      ? sceneNames[sceneNames.length - 1]
      : null;

  sceneNames
    .filter(sceneName => sceneName !== activeSceneName)
    .forEach(sceneName => {
      onOpenLayout(sceneName, {
        openEventsEditor: false,
        openSceneEditor: true,
        focusWhenOpened: 'none',
      });
    });
  if (activeSceneName) {
    onOpenLayout(activeSceneName, {
      openEventsEditor: false,
      openSceneEditor: true,
      focusWhenOpened: 'scene',
    });
  }

  return { sceneNames, activeSceneName };
};

const summarizeInstance = (instance: gdInitialInstance): any => ({
  id: instance.getPersistentUuid().slice(0, 10),
  objectName: instance.getObjectName(),
  x: instance.getX(),
  y: instance.getY(),
  z: instance.getZ(),
  angle: instance.getAngle(),
  layer: instance.getLayer(),
  zOrder: instance.getZOrder(),
  hidden: instance.isHidden(),
});

const findInstances = ({
  layout,
  objectName,
  instanceId,
}: {|
  layout: gdLayout,
  objectName: ?string,
  instanceId: ?string,
|}): Array<gdInitialInstance> => {
  if (!objectName && !instanceId) throw makeError('missing_instance_filter');
  const initialInstances = layout.getInitialInstances();
  if (!initialInstances.getInstancesCount()) return [];

  const matches = [];
  const functor = new gd.InitialInstanceJSFunctor();
  // $FlowFixMe[incompatible-type] - invoke is writable at runtime.
  // $FlowFixMe[cannot-write]
  functor.invoke = instancePtr => {
    // $FlowFixMe[incompatible-type] - wrapPointer is provided by libGD.
    const instance: gdInitialInstance = gd.wrapPointer(
      // $FlowFixMe[incompatible-type]
      instancePtr,
      gd.InitialInstance
    );
    if (objectName && instance.getObjectName() !== objectName) return;
    if (
      instanceId &&
      !instance
        .getPersistentUuid()
        .toLowerCase()
        .startsWith(instanceId.toLowerCase())
    )
      return;
    matches.push(instance);
  };
  // $FlowFixMe[incompatible-type]
  initialInstances.iterateOverInstances(functor);
  functor.delete();
  return matches;
};

export const createEditorVisualTools = ({
  project,
  editorTabs,
}: {|
  project: gdProject,
  editorTabs: any,
|}): any => {
  const requireSceneEditor = (sceneName: string) => {
    if (!sceneName || !project.hasLayoutNamed(sceneName)) {
      throw makeError('scene_not_found');
    }
    const entry = getSceneEditorEntry(editorTabs, sceneName);
    if (!entry) {
      throw makeError(
        'scene_editor_not_open',
        `scene_editor_not_open:${sceneName}`
      );
    }
    return entry;
  };

  const listOpenSceneEditors = () =>
    getAllTabs(editorTabs)
      .map(entry => {
        const editorRef = entry.editorTab && entry.editorTab.editorRef;
        if (!editorRef || typeof editorRef.getLayout !== 'function')
          return null;
        const layout = editorRef.getLayout();
        if (!layout) return null;
        return {
          sceneName: layout.getName(),
          editorReady: !!editorRef.editor,
          active: entry.active,
          pane: entry.paneIdentifier,
        };
      })
      .filter(Boolean);

  const selectInstances = (request: any): any => {
    const sceneName =
      typeof request.sceneName === 'string' ? request.sceneName : '';
    const objectName =
      typeof request.objectName === 'string' && request.objectName
        ? request.objectName
        : null;
    const instanceId =
      typeof request.instanceId === 'string' && request.instanceId
        ? request.instanceId
        : null;
    const entry = requireSceneEditor(sceneName);
    const matches = findInstances({
      layout: entry.layout,
      objectName,
      instanceId,
    });
    if (!matches.length) throw makeError('instance_not_found');
    if (instanceId && matches.length > 1) {
      throw makeError('instance_id_ambiguous');
    }

    const sceneEditor = entry.sceneEditor;
    if (typeof sceneEditor._setSelectedInstances !== 'function') {
      throw makeError('scene_editor_selection_unavailable');
    }
    sceneEditor._setSelectedInstances(matches, false);

    const requestedFocusMode = request.focusMode;
    const focusMode =
      requestedFocusMode === 'none' ||
      requestedFocusMode === 'center' ||
      requestedFocusMode === 'fit'
        ? requestedFocusMode
        : matches.length > 1
        ? 'fit'
        : 'center';
    if (focusMode === 'center') sceneEditor.focusOnSelection();
    else if (focusMode === 'fit') sceneEditor.zoomToFitSelection();

    return {
      sceneName,
      selectedCount: matches.length,
      focusMode,
      instances: matches.map(summarizeInstance),
    };
  };

  const focusSelection = (request: any): any => {
    const sceneName =
      typeof request.sceneName === 'string' ? request.sceneName : '';
    const entry = requireSceneEditor(sceneName);
    const sceneEditor = entry.sceneEditor;
    const selectedInstances =
      sceneEditor.instancesSelection &&
      sceneEditor.instancesSelection.getSelectedInstances
        ? sceneEditor.instancesSelection.getSelectedInstances()
        : [];
    if (!selectedInstances.length) throw makeError('no_selected_instances');
    const mode = request.mode === 'fit' ? 'fit' : 'center';
    if (mode === 'fit') sceneEditor.zoomToFitSelection();
    else sceneEditor.focusOnSelection();
    return {
      sceneName,
      focused: true,
      mode,
      selectedCount: selectedInstances.length,
      instances: selectedInstances.map(summarizeInstance),
    };
  };

  return {
    listOpenSceneEditors,
    selectInstances,
    focusSelection,
  };
};
