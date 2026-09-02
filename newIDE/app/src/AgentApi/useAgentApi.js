// @flow
import * as React from 'react';
import { type I18n as I18nType } from '@lingui/core';
import optionalRequire from '../Utils/OptionalRequire';
import { type EditorCallbacks } from '../EditorFunctions';
import { processEditorFunctionCalls } from '../EditorFunctions/EditorFunctionCallRunner';
import { listAllExamples } from '../Utils/GDevelopServices/Example';
import UrlStorageProvider from '../ProjectsStorage/UrlStorageProvider';
import { type ResourceManagementProps } from '../ResourcesList/ResourceSource';
import { createAssetTools } from './AssetTools';
import { createRuntimeTelemetry } from './RuntimeTelemetry';
import {
  createEditorVisualTools,
  restoreOpenSceneEditors,
} from './EditorVisualTools';
import { createEventTools } from './EventTools';
import {
  prepareGameplayTestRunForAgent,
  watchGameplayTestFrameForAgent,
} from './GameplayTestLifecycleTools';
import { clearGameplayTestFramePreview } from '../GameplayTests/GameplayTestFrame';
import { createDiagnosticsTools } from './DiagnosticsTools';
import {
  type SceneEventsOutsideEditorChanges,
  type InstancesOutsideEditorChanges,
  type ObjectsOutsideEditorChanges,
  type ObjectGroupsOutsideEditorChanges,
  type ProjectItemRenamedOutsideEditorChanges,
  type WillDeleteSceneChanges,
  type WillDeleteGameplayTestChanges,
  type WillDeleteObjectChanges,
} from '../EditorFunctions/OutsideEditorChanges';
import { useEnsureExtensionInstalled } from '../AiGeneration/UseEnsureExtensionInstalled';
import { useGenerateEvents } from '../AiGeneration/UseGenerateEvents';
import { useSearchAndInstallAsset } from '../AiGeneration/UseSearchAndInstallAsset';
import { useSearchAndInstallResource } from '../AiGeneration/UseSearchAndInstallResource';
import { ObjectStoreContext } from '../AssetStore/ObjectStoreContext';
import { ExtensionStoreContext } from '../AssetStore/ExtensionStore/ExtensionStoreContext';
import { enumerateObjectTypes } from '../ObjectsList/EnumerateObjects';
import { type FileMetadata } from '../ProjectsStorage';
import { createEditorFunctionService } from '../AgentIntegration/editor/EditorFunctionService';
import { createProjectLifecycleService } from '../AgentIntegration/editor/ProjectLifecycleService';
import { createExportService } from '../AgentIntegration/editor/ExportService';
import { createEditorVisualService } from '../AgentIntegration/editor/EditorVisualService';
import { createValidationService } from '../AgentIntegration/editor/ValidationService';
import { createPreviewService } from '../AgentIntegration/runtime/PreviewService';
import { createSafetyService } from '../AgentIntegration/safety/SafetyService';
import { createRendererAgentHost } from '../AgentIntegration/RendererAgentHost';
import { attachRendererAgentHostToIpc } from '../AgentIntegration/RendererCommandAdapter';

const gd: libGDevelop = global.gd;
const electron = optionalRequire('electron');
const ipcRenderer = electron ? electron.ipcRenderer : null;
const path = optionalRequire('path');

type Props = {|
  project: ?gdProject,
  editorTabs: any,
  fileIdentifier: ?string,
  fileMetadata: ?FileMetadata,
  loadFromSerializedProject: (
    serializedProject: gdSerializerElement,
    fileMetadata: ?FileMetadata
  ) => Promise<any>,
  i18n: I18nType,
  resourceManagementProps: ResourceManagementProps,
  saveProject: (options?: {|
    skipNewVersionWarning: boolean,
  |}) => Promise<?FileMetadata>,
  saveProjectAsWithStorageProvider: (options?: any) => Promise<?FileMetadata>,
  openFromFileMetadataWithStorageProvider: (
    fileMetadataAndStorageProviderName: any,
    options?: any
  ) => Promise<void>,
  closeProject: () => Promise<void>,
  hasUnsavedChanges: boolean,
  createEmptyProject: (newProjectSetup: any) => Promise<any>,
  createProjectFromExample: (exampleProjectSetup: any) => Promise<any>,
  launchNewPreview: (options?: any) => Promise<void>,
  launchHotReloadPreview: () => Promise<void>,
  previewDebuggerServer: ?any,
  triggerUnsavedChanges: () => void,
  forceUpdate: () => void,
  onOpenLayout: (
    sceneName: string,
    options: {|
      openEventsEditor: boolean,
      openSceneEditor: boolean,
      focusWhenOpened:
        | 'scene-or-events-otherwise'
        | 'scene'
        | 'events'
        | 'none',
    |}
  ) => void,
  onSceneEventsModifiedOutsideEditor: (
    changes: SceneEventsOutsideEditorChanges
  ) => void,
  onInstancesModifiedOutsideEditor: (
    changes: InstancesOutsideEditorChanges
  ) => void,
  onObjectsModifiedOutsideEditor: (
    changes: ObjectsOutsideEditorChanges
  ) => void,
  onObjectGroupsModifiedOutsideEditor: (
    changes: ObjectGroupsOutsideEditorChanges
  ) => void,
  onProjectItemRenamedOutsideEditor: (
    changes: ProjectItemRenamedOutsideEditorChanges
  ) => void,
  onWillDeleteScene: (changes: WillDeleteSceneChanges) => Promise<void>,
  onWillDeleteGameplayTest: (
    changes: WillDeleteGameplayTestChanges
  ) => Promise<void>,
  onWillDeleteObject: (changes: WillDeleteObjectChanges) => void,
  onWillInstallExtension: (extensionNames: Array<string>) => void,
  onExtensionInstalled: (extensionNames: Array<string>) => void,
|};

export default function useAgentApi({
  project,
  editorTabs,
  fileIdentifier,
  fileMetadata,
  loadFromSerializedProject,
  i18n,
  resourceManagementProps,
  saveProject,
  saveProjectAsWithStorageProvider,
  openFromFileMetadataWithStorageProvider,
  closeProject,
  hasUnsavedChanges,
  createEmptyProject,
  createProjectFromExample,
  launchNewPreview,
  launchHotReloadPreview,
  previewDebuggerServer,
  triggerUnsavedChanges,
  forceUpdate,
  onOpenLayout,
  onSceneEventsModifiedOutsideEditor,
  onInstancesModifiedOutsideEditor,
  onObjectsModifiedOutsideEditor,
  onObjectGroupsModifiedOutsideEditor,
  onProjectItemRenamedOutsideEditor,
  onWillDeleteScene,
  onWillDeleteGameplayTest,
  onWillDeleteObject,
  onWillInstallExtension,
  onExtensionInstalled,
}: Props) {
  const { ensureExtensionInstalled } = useEnsureExtensionInstalled({
    project,
    i18n,
  });
  const { searchAndInstallAsset } = useSearchAndInstallAsset({
    project,
    resourceManagementProps,
    onWillInstallExtension,
    onExtensionInstalled,
  });
  const { searchAndInstallResources } = useSearchAndInstallResource({
    project,
    resourceManagementProps,
  });
  const { generateEvents } = useGenerateEvents({ project });
  const { translatedObjectShortHeadersByType, fetchObjects } = React.useContext(
    ObjectStoreContext
  );
  const { fetchExtensionsAndFilters } = React.useContext(ExtensionStoreContext);

  React.useEffect(
    () => {
      // Keep the same registries warm as the built-in AI editor tools so calls
      // that install an object/extension behave the same through the embedded API.
      fetchObjects();
      fetchExtensionsAndFilters();
    },
    [fetchObjects, fetchExtensionsAndFilters]
  );

  const getAssetStoreTagForNewObject = React.useCallback(
    (objectType: string): string | null => {
      const installedObjectMetadata = project
        ? enumerateObjectTypes(project, null).find(
            enumeratedObjectMetadata =>
              enumeratedObjectMetadata.type === objectType
          )
        : null;
      if (installedObjectMetadata && installedObjectMetadata.assetStoreTag) {
        return installedObjectMetadata.assetStoreTag;
      }
      const header = translatedObjectShortHeadersByType[objectType];
      return (header && header.assetStoreTag) || null;
    },
    [project, translatedObjectShortHeadersByType]
  );

  const createProjectForAgent = React.useCallback(
    async ({ name, exampleSlug }: { name: string, exampleSlug: ?string }) => {
      const newProjectSetup = {
        projectName: name,
        storageProvider: UrlStorageProvider,
        saveAsLocation: null,
        creationSource: 'ai-agent-request',
      };

      if (exampleSlug) {
        const { exampleShortHeaders } = await listAllExamples();
        const exampleShortHeader = exampleShortHeaders.find(
          header => header.slug === exampleSlug
        );
        if (exampleShortHeader) {
          const { createdProject } = await createProjectFromExample({
            exampleShortHeader,
            newProjectSetup,
            i18n,
          });
          return { exampleSlug, createdProject };
        }
      }

      const { createdProject } = await createEmptyProject(newProjectSetup);
      return { exampleSlug: null, createdProject };
    },
    [createEmptyProject, createProjectFromExample, i18n]
  );

  const editorCallbacks: EditorCallbacks = React.useMemo(
    () => ({
      onOpenLayout,
      onCreateProject: createProjectForAgent,
    }),
    [onOpenLayout, createProjectForAgent]
  );

  const runtimeTelemetry = React.useMemo(
    () =>
      previewDebuggerServer
        ? createRuntimeTelemetry(previewDebuggerServer)
        : null,
    [previewDebuggerServer]
  );

  React.useEffect(
    () => () => {
      if (runtimeTelemetry) runtimeTelemetry.dispose();
    },
    [runtimeTelemetry]
  );

  React.useEffect(
    () => {
      if (!ipcRenderer) return;
      // Keep this renderer registered even when no project is open, so callers
      // can invoke projectless functions such as initialize_project.
      ipcRenderer.send('gdevelop-agent-integration:register', {
        fileIdentifier,
        active: true,
      });
      return () => {
        ipcRenderer.send('gdevelop-agent-integration:register', {
          fileIdentifier: null,
          active: false,
        });
      };
    },
    [fileIdentifier]
  );

  React.useEffect(
    () => {
      if (!ipcRenderer) return;

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
        const serializedProject = gd.Serializer.fromJSObject(
          checkpoint.snapshot
        );
        let restoredState;
        try {
          restoredState = await loadFromSerializedProject(
            serializedProject,
            fileMetadata
          );
        } finally {
          serializedProject.delete();
        }

        // loadFromSerializedProject safely replaces the whole project and seals
        // unsaved changes as part of the normal open lifecycle. Restore the
        // checkpoint's previous dirty state after the new project is mounted.
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
        prepareGameplayTestRun: prepareGameplayTestRunForAgent,
        watchGameplayTestFrame: watchGameplayTestFrameForAgent,
        clearGameplayTestFramePreview,
        documentObject: document,
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
        pathModule: path,
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

      const rendererAgentHost = createRendererAgentHost({
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
      });
      const detachRendererAgentHost = attachRendererAgentHostToIpc({
        ipcRenderer,
        agentHost: rendererAgentHost,
      });

      return () => {
        detachRendererAgentHost();
      };
    },
    [
      project,
      editorTabs,
      fileIdentifier,
      fileMetadata,
      loadFromSerializedProject,
      i18n,
      editorCallbacks,
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
      saveProject,
      saveProjectAsWithStorageProvider,
      openFromFileMetadataWithStorageProvider,
      closeProject,
      hasUnsavedChanges,
      createProjectForAgent,
      launchNewPreview,
      launchHotReloadPreview,
      previewDebuggerServer,
      runtimeTelemetry,
      resourceManagementProps,
      onOpenLayout,
      triggerUnsavedChanges,
      forceUpdate,
    ]
  );
}
