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

      const onRequest = async (
        event,
        { requestId, request }: { requestId: string, request: any }
      ) => {
        try {
          if (!request || typeof request !== 'object') {
            throw new Error('invalid_request');
          }

          if (request.type === 'status') {
            const commandResult = await rendererAgentHost.execute(
              'project.status',
              {},
              { traceId: requestId }
            );
            ipcRenderer.send('gdevelop-agent-api:response', {
              requestId,
              ok: true,
              result: commandResult.data,
            });
            return;
          }

          if (request.type === 'list-functions') {
            const query =
              typeof request.query === 'string' && request.query
                ? request.query
                : null;
            const commandResult = await rendererAgentHost.execute(
              'editor.functions.list',
              {
                ...(query ? { query } : {}),
                executableOnly: !!request.executableOnly,
              },
              { traceId: requestId }
            );
            ipcRenderer.send('gdevelop-agent-api:response', {
              requestId,
              ok: true,
              result: {
                projectOpen: !!project,
                fileIdentifier,
                query,
                ...commandResult.data,
              },
            });
            return;
          }

          if (request.type === 'describe-function') {
            const commandResult = await rendererAgentHost.execute(
              'editor.functions.describe',
              { name: request.name },
              { traceId: requestId }
            );
            ipcRenderer.send('gdevelop-agent-api:response', {
              requestId,
              ok: true,
              result: {
                projectOpen: !!project,
                fileIdentifier,
                ...commandResult.data,
              },
            });
            return;
          }

          if (request.type === 'capabilities') {
            ipcRenderer.send('gdevelop-agent-api:response', {
              requestId,
              ok: true,
              result: {
                version: 2,
                projectLifecycle: [
                  'create',
                  'open-local',
                  'close',
                  'save',
                  'save-as-local',
                ],
                authoring: [
                  'editor-functions',
                  'batch-editor-functions',
                  'editor-function-schema-inspection',
                  'editor-function-capability-search',
                  'deterministic-events-json-read',
                  'deterministic-events-json-apply',
                  'resource-list-inspect',
                  'local-resource-import',
                  'local-resource-replace',
                  'resource-rename',
                  'resource-remove-safe',
                  'resource-health-scan',
                  'asset-store-search-install',
                  'resource-store-search-install',
                ],
                runtime: [
                  'preview-start',
                  'preview-hot-reload',
                  'preview-play-pause-refresh',
                  'preview-close-all',
                  'preview-keyboard-mouse-input',
                  'preview-touch-input',
                  'preview-virtual-gamepad',
                  'preview-input-sequences',
                  'runtime-status-snapshot',
                  'runtime-console-errors',
                  'runtime-assertions-wait-for',
                  'gameplay-tests',
                  'editor-function-tests',
                ],
                safety: [
                  'checkpoint-create-list-delete',
                  'checkpoint-diff',
                  'checkpoint-restore',
                  'transaction-begin-commit-rollback',
                ],
                validation: [
                  'project-diagnostics',
                  'events-validation',
                  'resource-health',
                  'required-behavior-validation',
                  'checkpoint-diff-report',
                  'gameplay-test-report',
                  'runtime-assertion-report',
                  'html5-export-validation',
                ],
                output: ['html5-export'],
                editorUi: [
                  'open-scene',
                  'open-events',
                  'select-scene-instances',
                  'focus-scene-selection',
                  'capture-editor-preview-windows',
                ],
              },
            });
            return;
          }

          if (request.type === 'create-project') {
            const commandResult = await rendererAgentHost.execute(
              'project.create',
              {
                name: request.name,
                templateSlug: request.templateSlug,
              },
              { traceId: requestId }
            );
            ipcRenderer.send('gdevelop-agent-api:response', {
              requestId,
              ok: true,
              result: commandResult.data,
            });
            return;
          }

          if (request.type === 'open-project') {
            const commandResult = await rendererAgentHost.execute(
              'project.open',
              {
                filePath: request.filePath,
                discardUnsavedChanges: request.discardUnsavedChanges,
              },
              { traceId: requestId }
            );
            ipcRenderer.send('gdevelop-agent-api:response', {
              requestId,
              ok: true,
              result: commandResult.data,
            });
            return;
          }

          if (request.type === 'close-project') {
            const commandResult = await rendererAgentHost.execute(
              'project.close',
              { discardUnsavedChanges: request.discardUnsavedChanges },
              { traceId: requestId }
            );
            ipcRenderer.send('gdevelop-agent-api:response', {
              requestId,
              ok: true,
              result: commandResult.data,
            });
            return;
          }

          if (request.type === 'save-project') {
            const commandResult = await rendererAgentHost.execute(
              'project.save',
              {},
              { traceId: requestId }
            );
            ipcRenderer.send('gdevelop-agent-api:response', {
              requestId,
              ok: true,
              result: commandResult.data,
            });
            return;
          }

          if (request.type === 'save-project-as') {
            const commandResult = await rendererAgentHost.execute(
              'project.save-as',
              { filePath: request.filePath, name: request.name },
              { traceId: requestId }
            );
            ipcRenderer.send('gdevelop-agent-api:response', {
              requestId,
              ok: true,
              result: commandResult.data,
            });
            return;
          }

          if (request.type === 'checkpoint-create') {
            const commandResult = await rendererAgentHost.execute(
              'safety.checkpoints.create',
              { label: request.label },
              { traceId: requestId }
            );
            ipcRenderer.send('gdevelop-agent-api:response', {
              requestId,
              ok: true,
              result: commandResult.data,
            });
            return;
          }

          if (request.type === 'checkpoint-list') {
            const commandResult = await rendererAgentHost.execute(
              'safety.checkpoints.list',
              {},
              { traceId: requestId }
            );
            ipcRenderer.send('gdevelop-agent-api:response', {
              requestId,
              ok: true,
              result: commandResult.data,
            });
            return;
          }

          if (request.type === 'checkpoint-diff') {
            const commandResult = await rendererAgentHost.execute(
              'safety.checkpoints.diff',
              { checkpointId: request.checkpointId },
              { traceId: requestId }
            );
            ipcRenderer.send('gdevelop-agent-api:response', {
              requestId,
              ok: true,
              result: commandResult.data,
            });
            return;
          }

          if (request.type === 'checkpoint-delete') {
            const commandResult = await rendererAgentHost.execute(
              'safety.checkpoints.delete',
              { checkpointId: request.checkpointId },
              { traceId: requestId }
            );
            ipcRenderer.send('gdevelop-agent-api:response', {
              requestId,
              ok: true,
              result: commandResult.data,
            });
            return;
          }

          if (request.type === 'checkpoint-restore') {
            const commandResult = await rendererAgentHost.execute(
              'safety.checkpoints.restore',
              { checkpointId: request.checkpointId },
              { traceId: requestId }
            );
            ipcRenderer.send('gdevelop-agent-api:response', {
              requestId,
              ok: true,
              result: commandResult.data,
            });
            return;
          }

          if (request.type === 'transaction-status') {
            const commandResult = await rendererAgentHost.execute(
              'safety.transactions.status',
              {},
              { traceId: requestId }
            );
            ipcRenderer.send('gdevelop-agent-api:response', {
              requestId,
              ok: true,
              result: commandResult.data,
            });
            return;
          }

          if (request.type === 'transaction-begin') {
            const commandResult = await rendererAgentHost.execute(
              'safety.transactions.begin',
              { label: request.label },
              { traceId: requestId }
            );
            ipcRenderer.send('gdevelop-agent-api:response', {
              requestId,
              ok: true,
              result: commandResult.data,
            });
            return;
          }

          if (request.type === 'transaction-commit') {
            const commandResult = await rendererAgentHost.execute(
              'safety.transactions.commit',
              {},
              { traceId: requestId }
            );
            ipcRenderer.send('gdevelop-agent-api:response', {
              requestId,
              ok: true,
              result: commandResult.data,
            });
            return;
          }

          if (request.type === 'transaction-rollback') {
            const commandResult = await rendererAgentHost.execute(
              'safety.transactions.rollback',
              {},
              { traceId: requestId }
            );
            ipcRenderer.send('gdevelop-agent-api:response', {
              requestId,
              ok: true,
              result: commandResult.data,
            });
            return;
          }

          if (request.type === 'events-json-read') {
            const commandResult = await rendererAgentHost.execute(
              'events.read',
              { sceneName: request.sceneName },
              { traceId: requestId }
            );
            ipcRenderer.send('gdevelop-agent-api:response', {
              requestId,
              ok: true,
              result: commandResult.data,
            });
            return;
          }

          if (request.type === 'events-json-apply') {
            const commandResult = await rendererAgentHost.execute(
              'events.apply',
              {
                sceneName: request.sceneName,
                eventsJson: request.eventsJson,
                mode: request.mode,
              },
              { traceId: requestId }
            );
            ipcRenderer.send('gdevelop-agent-api:response', {
              requestId,
              ok: true,
              result: commandResult.data,
            });
            return;
          }

          if (request.type === 'diagnostics-project') {
            const commandResult = await rendererAgentHost.execute(
              'diagnostics.inspect',
              {
                includeNativeReport: request.includeNativeReport,
                includeAssets: request.includeAssets,
              },
              { traceId: requestId }
            );
            ipcRenderer.send('gdevelop-agent-api:response', {
              requestId,
              ok: true,
              result: commandResult.data,
            });
            return;
          }

          if (request.type === 'validation-report') {
            const { type: ignoredType, ...validationInput } = request;
            const commandResult = await rendererAgentHost.execute(
              'validation.run',
              validationInput,
              { traceId: requestId }
            );
            ipcRenderer.send('gdevelop-agent-api:response', {
              requestId,
              ok: true,
              result: commandResult.data,
            });
            return;
          }

          if (request.type === 'runtime-status') {
            const commandResult = await rendererAgentHost.execute(
              'runtime.status',
              request,
              { traceId: requestId }
            );
            ipcRenderer.send('gdevelop-agent-api:response', {
              requestId,
              ok: true,
              result: commandResult.data,
            });
            return;
          }

          if (request.type === 'runtime-snapshot') {
            const commandResult = await rendererAgentHost.execute(
              'runtime.snapshot',
              request,
              { traceId: requestId }
            );
            ipcRenderer.send('gdevelop-agent-api:response', {
              requestId,
              ok: true,
              result: commandResult.data,
            });
            return;
          }

          if (request.type === 'runtime-logs') {
            const commandResult = await rendererAgentHost.execute(
              'runtime.logs',
              request,
              { traceId: requestId }
            );
            ipcRenderer.send('gdevelop-agent-api:response', {
              requestId,
              ok: true,
              result: commandResult.data,
            });
            return;
          }

          if (request.type === 'runtime-assert') {
            const commandResult = await rendererAgentHost.execute(
              'runtime.assert',
              request,
              { traceId: requestId }
            );
            ipcRenderer.send('gdevelop-agent-api:response', {
              requestId,
              ok: true,
              result: commandResult.data,
            });
            return;
          }

          if (request.type === 'runtime-wait-for') {
            const commandResult = await rendererAgentHost.execute(
              'runtime.wait-for',
              request,
              { traceId: requestId }
            );
            ipcRenderer.send('gdevelop-agent-api:response', {
              requestId,
              ok: true,
              result: commandResult.data,
            });
            return;
          }

          if (request.type === 'preview-status') {
            const commandResult = await rendererAgentHost.execute(
              'preview.status',
              {},
              { traceId: requestId }
            );
            ipcRenderer.send('gdevelop-agent-api:response', {
              requestId,
              ok: true,
              result: commandResult.data,
            });
            return;
          }

          if (request.type === 'preview-start') {
            const commandResult = await rendererAgentHost.execute(
              'preview.start',
              { numberOfWindows: request.numberOfWindows },
              { traceId: requestId }
            );
            ipcRenderer.send('gdevelop-agent-api:response', {
              requestId,
              ok: true,
              result: commandResult.data,
            });
            return;
          }

          if (request.type === 'preview-hot-reload') {
            const commandResult = await rendererAgentHost.execute(
              'preview.hot-reload',
              {},
              { traceId: requestId }
            );
            ipcRenderer.send('gdevelop-agent-api:response', {
              requestId,
              ok: true,
              result: commandResult.data,
            });
            return;
          }

          if (request.type === 'preview-control') {
            const commandResult = await rendererAgentHost.execute(
              'preview.control',
              { action: request.action, debuggerId: request.debuggerId },
              { traceId: requestId }
            );
            ipcRenderer.send('gdevelop-agent-api:response', {
              requestId,
              ok: true,
              result: commandResult.data,
            });
            return;
          }

          if (request.type === 'preview-close-all') {
            const commandResult = await rendererAgentHost.execute(
              'preview.close-all',
              {},
              { traceId: requestId }
            );
            ipcRenderer.send('gdevelop-agent-api:response', {
              requestId,
              ok: true,
              result: commandResult.data,
            });
            return;
          }

          if (request.type === 'editor-visual-status') {
            if (!editorVisualTools) throw new Error('no_project_open');
            ipcRenderer.send('gdevelop-agent-api:response', {
              requestId,
              ok: true,
              result: {
                openSceneEditors: editorVisualTools.listOpenSceneEditors(),
                capture: 'GET /v1/capture?windowId=<id>',
              },
            });
            return;
          }

          if (request.type === 'editor-select-instances') {
            if (!editorVisualTools) throw new Error('no_project_open');
            ipcRenderer.send('gdevelop-agent-api:response', {
              requestId,
              ok: true,
              result: editorVisualTools.selectInstances(request),
            });
            return;
          }

          if (request.type === 'editor-focus-selection') {
            if (!editorVisualTools) throw new Error('no_project_open');
            ipcRenderer.send('gdevelop-agent-api:response', {
              requestId,
              ok: true,
              result: editorVisualTools.focusSelection(request),
            });
            return;
          }

          if (request.type === 'open-scene') {
            if (!project) throw new Error('no_project_open');
            if (
              !request.sceneName ||
              !project.hasLayoutNamed(request.sceneName)
            ) {
              throw new Error('scene_not_found');
            }
            const mode = request.mode || 'scene';
            onOpenLayout(request.sceneName, {
              openEventsEditor: mode === 'events' || mode === 'both',
              openSceneEditor: mode !== 'events',
              focusWhenOpened: mode === 'events' ? 'events' : 'scene',
            });
            ipcRenderer.send('gdevelop-agent-api:response', {
              requestId,
              ok: true,
              result: { opened: true, sceneName: request.sceneName, mode },
            });
            return;
          }

          if (request.type === 'list-resources') {
            const commandResult = await rendererAgentHost.execute(
              'resources.list',
              {},
              { traceId: requestId }
            );
            ipcRenderer.send('gdevelop-agent-api:response', {
              requestId,
              ok: true,
              result: commandResult.data,
            });
            return;
          }

          if (request.type === 'inspect-resource') {
            const commandResult = await rendererAgentHost.execute(
              'resources.inspect',
              { resourceName: request.resourceName },
              { traceId: requestId }
            );
            ipcRenderer.send('gdevelop-agent-api:response', {
              requestId,
              ok: true,
              result: commandResult.data,
            });
            return;
          }

          if (request.type === 'import-local-resource') {
            const commandResult = await rendererAgentHost.execute(
              'resources.import-local',
              {
                filePath: request.filePath,
                resourceName: request.resourceName,
                kind: request.kind,
                copyToProject: request.copyToProject,
                overwrite: request.overwrite,
                preserveOrigin: request.preserveOrigin,
              },
              { traceId: requestId }
            );
            ipcRenderer.send('gdevelop-agent-api:response', {
              requestId,
              ok: true,
              result: commandResult.data,
            });
            return;
          }

          if (request.type === 'replace-local-resource') {
            const commandResult = await rendererAgentHost.execute(
              'resources.replace-local',
              {
                resourceName: request.resourceName,
                filePath: request.filePath,
                kind: request.kind,
                copyToProject: request.copyToProject,
                preserveOrigin: request.preserveOrigin,
                deletePreviousFile: request.deletePreviousFile,
              },
              { traceId: requestId }
            );
            ipcRenderer.send('gdevelop-agent-api:response', {
              requestId,
              ok: true,
              result: commandResult.data,
            });
            return;
          }

          if (request.type === 'rename-resource') {
            const commandResult = await rendererAgentHost.execute(
              'resources.rename',
              {
                resourceName: request.resourceName,
                newResourceName: request.newResourceName,
              },
              { traceId: requestId }
            );
            ipcRenderer.send('gdevelop-agent-api:response', {
              requestId,
              ok: true,
              result: commandResult.data,
            });
            return;
          }

          if (request.type === 'remove-resource') {
            const commandResult = await rendererAgentHost.execute(
              'resources.remove',
              {
                resourceName: request.resourceName,
                deleteFile: request.deleteFile,
              },
              { traceId: requestId }
            );
            ipcRenderer.send('gdevelop-agent-api:response', {
              requestId,
              ok: true,
              result: commandResult.data,
            });
            return;
          }

          if (request.type === 'export-html5') {
            const commandResult = await rendererAgentHost.execute(
              'export.html5',
              { outputDir: request.outputDir },
              { traceId: requestId }
            );
            ipcRenderer.send('gdevelop-agent-api:response', {
              requestId,
              ok: true,
              result: commandResult.data,
            });
            return;
          }

          if (request.type === 'editor-function') {
            const commandResult = await rendererAgentHost.execute(
              'editor.functions.call',
              {
                name: request.name,
                arguments: request.arguments,
                callId: request.callId,
                save: !!request.save,
              },
              { traceId: requestId }
            );
            ipcRenderer.send('gdevelop-agent-api:response', {
              requestId,
              ok: true,
              result: commandResult.data,
            });
            return;
          }

          if (request.type === 'editor-functions') {
            const commandResult = await rendererAgentHost.execute(
              'editor.functions.call-batch',
              {
                calls: Array.isArray(request.calls) ? request.calls : [],
                save: !!request.save,
              },
              { traceId: requestId }
            );
            ipcRenderer.send('gdevelop-agent-api:response', {
              requestId,
              ok: true,
              result: commandResult.data,
            });
            return;
          }

          throw new Error(`unsupported_request_type:${String(request.type)}`);
        } catch (error) {
          console.error('[AgentApi] Request failed:', error);
          ipcRenderer.send('gdevelop-agent-api:response', {
            requestId,
            ok: false,
            error: error && error.message ? error.message : String(error),
            code: error && error.code ? String(error.code) : undefined,
          });
        }
      };

      ipcRenderer.on('gdevelop-agent-api:request', onRequest);
      return () => {
        detachRendererAgentHost();
        ipcRenderer.removeListener('gdevelop-agent-api:request', onRequest);
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
