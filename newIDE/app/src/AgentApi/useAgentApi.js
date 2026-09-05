// @flow
import * as React from 'react';
import { type I18n as I18nType } from '@lingui/core';
import optionalRequire from '../Utils/OptionalRequire';
import { type EditorCallbacks } from '../EditorFunctions';
import { processEditorFunctionCalls } from '../EditorFunctions/EditorFunctionCallRunner';
import { listAllExamples } from '../Utils/GDevelopServices/Example';
import UrlStorageProvider from '../ProjectsStorage/UrlStorageProvider';
import { type ResourceManagementProps } from '../ResourcesList/ResourceSource';
import { createRuntimeTelemetry } from './RuntimeTelemetry';
import {
  prepareGameplayTestRunForAgent,
  watchGameplayTestFrameForAgent,
} from './GameplayTestLifecycleTools';
import { clearGameplayTestFramePreview } from '../GameplayTests/GameplayTestFrame';
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
import { createRendererIntegration } from '../AgentIntegration/RendererIntegrationFactory';
import {
  attachRendererIntegrationHost,
  registerRendererIntegration,
} from '../AgentIntegration/RendererIntegrationLifecycle';

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
      return registerRendererIntegration({ ipcRenderer, fileIdentifier });
    },
    [fileIdentifier]
  );

  React.useEffect(
    () => {
      if (!ipcRenderer) return;

      const { agentHost } = createRendererIntegration({
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
        pathModule: path,
        onOpenLayout,
        prepareGameplayTestRun: prepareGameplayTestRunForAgent,
        watchGameplayTestFrame: watchGameplayTestFrameForAgent,
        clearGameplayTestFramePreview,
        documentObject: document,
      });
      const detachRendererAgentHost = attachRendererIntegrationHost({
        ipcRenderer,
        agentHost,
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
