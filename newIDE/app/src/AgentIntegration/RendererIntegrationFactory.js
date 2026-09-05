// @flow
import { createAssetTools } from '../AgentApi/AssetTools';
import { createDiagnosticsTools } from '../AgentApi/DiagnosticsTools';
import {
  createEditorVisualTools,
  restoreOpenSceneEditors,
} from '../AgentApi/EditorVisualTools';
import { createEventTools } from '../AgentApi/EventTools';
import { createEditorFunctionService } from './editor/EditorFunctionService';
import { createEditorVisualService } from './editor/EditorVisualService';
import { createExportService } from './editor/ExportService';
import { createProjectLifecycleService } from './editor/ProjectLifecycleService';
import { createValidationService } from './editor/ValidationService';
import { createPreviewService } from './runtime/PreviewService';
import { createSafetyService } from './safety/SafetyService';
import { createRendererAgentHost } from './RendererAgentHost';

const gd: libGDevelop = global.gd;

type Options = {|
  project: ?gdProject,
  editorTabs: any,
  fileIdentifier: ?string,
  fileMetadata: any,
  loadFromSerializedProject: (serializedProject: gdSerializerElement, fileMetadata: any) => Promise<any>,
  i18n: any,
  resourceManagementProps: any,
  hasUnsavedChanges: boolean,
  editorCallbacks: any,
  processEditorFunctionCalls: (options: any) => Promise<any>,
  generateEvents: any,
  onSceneEventsModifiedOutsideEditor: any,
  onInstancesModifiedOutsideEditor: any,
  onObjectsModifiedOutsideEditor: any,
  onObjectGroupsModifiedOutsideEditor: any,
  onProjectItemRenamedOutsideEditor: any,
  onWillDeleteScene: any,
  onWillDeleteGameplayTest: any,
  onWillDeleteObject: any,
  ensureExtensionInstalled: any,
  onWillInstallExtension: any,
  onExtensionInstalled: any,
  searchAndInstallAsset: any,
  searchAndInstallResources: any,
  getAssetStoreTagForNewObject: any,
  triggerUnsavedChanges: () => void,
  forceUpdate: () => void,
  saveProject: (options?: any) => Promise<any>,
  saveProjectAsWithStorageProvider: (options?: any) => Promise<any>,
  openFromFileMetadataWithStorageProvider: (options: any, openOptions?: any) => Promise<void>,
  closeProject: () => Promise<void>,
  createProjectForAgent: (options: any) => Promise<any>,
  launchNewPreview: (options?: any) => Promise<void>,
  launchHotReloadPreview: () => Promise<void>,
  previewDebuggerServer: ?any,
  runtimeTelemetry: ?any,
  ipcRenderer: ?any,
  pathModule: ?any,
  onOpenLayout: (sceneName: string, options: any) => void,
  prepareGameplayTestRun: (options: any) => Promise<void>,
  watchGameplayTestFrame: (options: any) => () => void,
  clearGameplayTestFramePreview: () => void,
  documentObject: any,
|};

export const createRendererIntegration = ({
  project,
  editorTabs,
  fileIdentifier,
  fileMetadata,
  loadFromSerializedProject,
  i18n,
  resourceManagementProps,
  hasUnsavedChanges,
  editorCallbacks,
  processEditorFunctionCalls,
  generateEvents,
  onSceneEventsModifiedOutsideEditor,
  onInstancesModifiedOutsideEditor,
  onObjectsModifiedOutsideEditor,
  onObjectGroupsModifiedOutsideEditor,
  onProjectItemRenamedOutsideEditor,
  onWillDeleteScene,
  onWillDeleteGameplayTest,
  onWillDeleteObject,
  ensureExtensionInstalled,
  onWillInstallExtension,
  onExtensionInstalled,
  searchAndInstallAsset,
  searchAndInstallResources,
  getAssetStoreTagForNewObject,
  triggerUnsavedChanges,
  forceUpdate,
  saveProject,
  saveProjectAsWithStorageProvider,
  openFromFileMetadataWithStorageProvider,
  closeProject,
  createProjectForAgent,
  launchNewPreview,
  launchHotReloadPreview,
  previewDebuggerServer,
  runtimeTelemetry,
  ipcRenderer,
  pathModule,
  onOpenLayout,
  prepareGameplayTestRun,
  watchGameplayTestFrame,
  clearGameplayTestFramePreview,
  documentObject,
}: Options) => {
  const assetTools = project
    ? createAssetTools({
        project,
        resourceManagementProps,
        triggerUnsavedChanges,
        forceUpdate,
      })
    : null;
  const editorVisualTools = project
    ? createEditorVisualTools({ project, editorTabs })
    : null;
  const eventTools = project
    ? createEventTools({
        project,
        triggerUnsavedChanges,
        onSceneEventsModifiedOutsideEditor,
      })
    : null;
  const diagnosticsTools = project
    ? createDiagnosticsTools({ project, i18n, assetTools })
    : null;

  const restoreProjectCheckpoint = async (checkpoint: any) => {
    const openSceneEditors = editorVisualTools
      ? editorVisualTools.listOpenSceneEditors()
      : [];
    const serializedProject = gd.Serializer.fromJSObject(checkpoint.snapshot);
    let restoredState;
    try {
      restoredState = await loadFromSerializedProject(
        serializedProject,
        fileMetadata
      );
    } finally {
      serializedProject.delete();
    }

    if (checkpoint.hadUnsavedChanges) triggerUnsavedChanges();

    const restoredProject = restoredState && restoredState.currentProject;
    const restoredEditorContext = restoredProject
      ? restoreOpenSceneEditors({
          project: restoredProject,
          openSceneEditors,
          onOpenLayout,
        })
      : { sceneNames: [], activeSceneName: null };
    return {
      restored: true,
      checkpointId: checkpoint.id,
      projectName: restoredProject ? restoredProject.getName() : null,
      projectUuid: restoredProject
        ? restoredProject.getProjectUuid()
        : null,
      fileIdentifier:
        restoredState && restoredState.currentFileMetadata
          ? restoredState.currentFileMetadata.fileIdentifier
          : null,
      hasUnsavedChanges: checkpoint.hadUnsavedChanges,
      restoredEditorContext,
      restoreStrategy: 'safe-project-reload',
    };
  };

  const editorFunctionService = createEditorFunctionService({
    project,
    i18n,
    editorCallbacks,
    processEditorFunctionCalls,
    generateEvents,
    onSceneEventsModifiedOutsideEditor,
    onInstancesModifiedOutsideEditor,
    onObjectsModifiedOutsideEditor,
    onObjectGroupsModifiedOutsideEditor,
    onProjectItemRenamedOutsideEditor,
    onWillDeleteScene,
    onWillDeleteGameplayTest,
    onWillDeleteObject,
    ensureExtensionInstalled,
    onWillInstallExtension,
    onExtensionInstalled,
    searchAndInstallAsset,
    searchAndInstallResources,
    getAssetStoreTagForNewObject,
    triggerUnsavedChanges,
    forceUpdate,
    saveProject,
    prepareGameplayTestRun,
    watchGameplayTestFrame,
    clearGameplayTestFramePreview,
    documentObject,
  });
  const projectLifecycleService = createProjectLifecycleService({
    project,
    fileIdentifier,
    hasUnsavedChanges,
    createProjectForAgent,
    openFromFileMetadataWithStorageProvider,
    closeProject,
    saveProject,
    saveProjectAsWithStorageProvider,
    pathModule,
  });
  const safetyService = createSafetyService({
    project,
    fileIdentifier,
    hasUnsavedChanges,
    restoreProjectCheckpoint,
  });
  const exportService = createExportService({ project, i18n });
  const editorVisualService = createEditorVisualService({
    project,
    editorVisualTools,
    onOpenLayout,
  });
  const previewService = createPreviewService({
    project,
    previewDebuggerServer,
    launchNewPreview,
    launchHotReloadPreview,
    ipcRenderer,
  });
  const validationService = createValidationService({
    project,
    diagnosticsTools,
    safetyService,
    runtimeTelemetry,
    editorFunctionService,
    exportService,
    getPreviewStatus: previewService.getStatus,
  });

  return {
    agentHost: createRendererAgentHost({
      environment: {
        project,
        fileIdentifier,
        hasUnsavedChanges,
        getProjectStatus: () => ({
          projectOpen: !!project,
          fileIdentifier,
          projectName: project ? project.getName() : null,
          projectUuid: project ? project.getProjectUuid() : null,
          sceneNames: project
            ? Array.from(
                { length: project.getLayoutsCount() },
                (_, index) => project.getLayoutAt(index).getName()
              )
            : [],
          hasUnsavedChanges,
          preview: previewService.getStatus(),
        }),
      },
      assetTools,
      diagnosticsTools,
      editorFunctionService,
      editorVisualService,
      eventTools,
      exportService,
      previewService,
      projectLifecycleService,
      runtimeTelemetry,
      safetyService,
      validationService,
    }),
  };
};
