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
import { diffCheckpointToProject } from './CheckpointTools';
import { createRuntimeTelemetry } from './RuntimeTelemetry';
import {
  createEditorVisualTools,
  restoreOpenSceneEditors,
} from './EditorVisualTools';
import { createEventTools } from './EventTools';
import { closeAllPreviewWindowsForAgent } from './PreviewLifecycleTools';
import {
  prepareGameplayTestRunForAgent,
  watchGameplayTestFrameForAgent,
} from './GameplayTestLifecycleTools';
import { clearGameplayTestFramePreview } from '../GameplayTests/GameplayTestFrame';
import { createDiagnosticsTools } from './DiagnosticsTools';
import { exportLocalHtml5ForAgent } from './ExportTools';
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

const getPreviewStatus = (previewDebuggerServer: ?any) => {
  if (!previewDebuggerServer) {
    return {
      available: false,
      serverState: null,
      debuggerIds: [],
      running: false,
    };
  }
  const debuggerIds = previewDebuggerServer.getExistingDebuggerIds
    ? previewDebuggerServer.getExistingDebuggerIds()
    : [];
  const previewDebuggerIds = previewDebuggerServer.getExistingPreviewDebuggerIds
    ? previewDebuggerServer.getExistingPreviewDebuggerIds()
    : debuggerIds;
  return {
    available: true,
    serverState: previewDebuggerServer.getServerState
      ? previewDebuggerServer.getServerState()
      : null,
    debuggerIds,
    previewDebuggerIds,
    running: previewDebuggerIds.length > 0,
  };
};

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
      ipcRenderer.send('gdevelop-agent-api:register', {
        fileIdentifier,
        active: true,
      });
      return () => {
        ipcRenderer.send('gdevelop-agent-api:register', {
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
      const runFunctionCalls = (calls, shouldSave) =>
        editorFunctionService.run({ calls, save: shouldSave });
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
            preview: getPreviewStatus(previewDebuggerServer),
          }),
        },
        editorFunctionService,
        projectLifecycleService,
        safetyService,
      });
      const detachRendererAgentHost = attachRendererAgentHostToIpc({
        ipcRenderer,
        agentHost: rendererAgentHost,
      });

      const controlPreview = (request: any) => {
        if (!previewDebuggerServer)
          throw new Error('preview_debugger_unavailable');
        const action = request.action;
        if (!['play', 'pause', 'refresh'].includes(action)) {
          throw new Error(`unsupported_preview_action:${String(action)}`);
        }
        const debuggerIds = previewDebuggerServer.getExistingDebuggerIds();
        const targetIds = request.debuggerId
          ? debuggerIds.filter(id => id === request.debuggerId)
          : debuggerIds;
        if (!targetIds.length) throw new Error('preview_not_running');
        targetIds.forEach(id =>
          previewDebuggerServer.sendMessage(id, { command: action })
        );
        return { action, debuggerIds: targetIds };
      };

      const runValidationReport = async (request: any) => {
        if (!project || !diagnosticsTools) throw new Error('no_project_open');

        const steps = [];
        let checkpointDiff = null;
        if (typeof request.checkpointId === 'string' && request.checkpointId) {
          try {
            checkpointDiff = diffCheckpointToProject(
              project,
              request.checkpointId
            );
            steps.push({ name: 'checkpoint-diff', ok: true });
          } catch (error) {
            steps.push({
              name: 'checkpoint-diff',
              ok: false,
              error: error && error.message ? error.message : String(error),
            });
          }
        }

        const gameplayTests = [];
        const requestedGameplayTests = Array.isArray(request.gameplayTests)
          ? request.gameplayTests
          : [];
        if (requestedGameplayTests.length > 20) {
          throw new Error('too_many_validation_gameplay_tests');
        }
        for (const gameplayTest of requestedGameplayTests) {
          const argumentsForTest =
            gameplayTest && typeof gameplayTest === 'object'
              ? { ...gameplayTest }
              : {};
          if (
            typeof argumentsForTest.source === 'string' &&
            argumentsForTest.persist === undefined
          ) {
            argumentsForTest.persist = false;
          }
          try {
            const callResult = await runFunctionCalls(
              [
                {
                  name: 'run_gameplay_test',
                  arguments: argumentsForTest,
                },
              ],
              false
            );
            const finishedResult = callResult.results[0] || null;
            const passed = !!(
              finishedResult &&
              finishedResult.status === 'finished' &&
              finishedResult.success
            );
            gameplayTests.push({
              testName: argumentsForTest.test_name || null,
              ok: passed,
              result: finishedResult,
            });
            steps.push({
              name: `gameplay-test:${String(
                argumentsForTest.test_name || gameplayTests.length
              )}`,
              ok: passed,
            });
          } catch (error) {
            const message =
              error && error.message ? error.message : String(error);
            gameplayTests.push({
              testName: argumentsForTest.test_name || null,
              ok: false,
              error: message,
            });
            steps.push({
              name: `gameplay-test:${String(
                argumentsForTest.test_name || gameplayTests.length
              )}`,
              ok: false,
              error: message,
            });
          }
        }

        const runtimeAssertions = [];
        const requestedRuntimeAssertions = Array.isArray(
          request.runtimeAssertions
        )
          ? request.runtimeAssertions
          : [];
        if (requestedRuntimeAssertions.length > 50) {
          throw new Error('too_many_runtime_assertions');
        }
        for (const runtimeAssertion of requestedRuntimeAssertions) {
          try {
            if (!runtimeTelemetry)
              throw new Error('preview_debugger_unavailable');
            const result = await runtimeTelemetry.assertRuntime({
              ...(runtimeAssertion || {}),
              debuggerId:
                (runtimeAssertion && runtimeAssertion.debuggerId) ||
                request.debuggerId,
            });
            runtimeAssertions.push({ ok: !!result.passed, result });
            steps.push({ name: 'runtime-assertion', ok: !!result.passed });
          } catch (error) {
            const message =
              error && error.message ? error.message : String(error);
            runtimeAssertions.push({ ok: false, error: message });
            steps.push({
              name: 'runtime-assertion',
              ok: false,
              error: message,
            });
          }
        }

        let runtimeLogs = null;
        if (request.includeRuntimeLogs) {
          try {
            if (!runtimeTelemetry)
              throw new Error('preview_debugger_unavailable');
            runtimeLogs = runtimeTelemetry.getLogs({
              debuggerId: request.debuggerId,
              limit: request.runtimeLogLimit,
            });
            steps.push({
              name: 'runtime-logs',
              ok: runtimeLogs.errors === 0,
              errors: runtimeLogs.errors,
              warnings: runtimeLogs.warnings,
            });
          } catch (error) {
            runtimeLogs = {
              error: error && error.message ? error.message : String(error),
            };
            steps.push({
              name: 'runtime-logs',
              ok: false,
              error: runtimeLogs.error,
            });
          }
        }

        let exportResult = null;
        if (request.export) {
          try {
            const exportOptions =
              request.export && typeof request.export === 'object'
                ? request.export
                : {};
            exportResult = {
              ok: true,
              result: await exportLocalHtml5ForAgent({
                project,
                i18n,
                outputDir:
                  typeof exportOptions.outputDir === 'string'
                    ? exportOptions.outputDir
                    : undefined,
              }),
            };
            steps.push({ name: 'html5-export', ok: true });
          } catch (error) {
            exportResult = {
              ok: false,
              error: error && error.message ? error.message : String(error),
            };
            steps.push({
              name: 'html5-export',
              ok: false,
              error: exportResult.error,
            });
          }
        }

        // Re-scan after optional gameplay probes/export. HTML5 export refreshes
        // GDevelop's native code-generation diagnostic report, so this final
        // snapshot is more authoritative than a pre-validation scan.
        const diagnostics = diagnosticsTools.inspect(request);
        const failedSteps = steps.filter(step => step.ok === false);
        return {
          ok: diagnostics.summary.ok && failedSteps.length === 0,
          generatedAt: new Date().toISOString(),
          projectName: project.getName(),
          projectUuid: project.getProjectUuid(),
          diagnostics,
          checkpointDiff,
          preview: getPreviewStatus(previewDebuggerServer),
          gameplayTests,
          runtimeAssertions,
          runtimeLogs,
          export: exportResult,
          steps,
          summary: {
            diagnosticErrors: diagnostics.summary.errors,
            diagnosticWarnings: diagnostics.summary.warnings,
            checksRun: steps.length,
            checksFailed: failedSteps.length,
          },
        };
      };

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
            if (!eventTools) throw new Error('no_project_open');
            ipcRenderer.send('gdevelop-agent-api:response', {
              requestId,
              ok: true,
              result: eventTools.readSceneEventsJson(request),
            });
            return;
          }

          if (request.type === 'events-json-apply') {
            if (!eventTools) throw new Error('no_project_open');
            ipcRenderer.send('gdevelop-agent-api:response', {
              requestId,
              ok: true,
              result: eventTools.applySceneEventsJson(request),
            });
            return;
          }

          if (request.type === 'diagnostics-project') {
            if (!diagnosticsTools) throw new Error('no_project_open');
            ipcRenderer.send('gdevelop-agent-api:response', {
              requestId,
              ok: true,
              result: diagnosticsTools.inspect(request),
            });
            return;
          }

          if (request.type === 'validation-report') {
            const result = await runValidationReport(request);
            ipcRenderer.send('gdevelop-agent-api:response', {
              requestId,
              ok: true,
              result,
            });
            return;
          }

          if (request.type === 'runtime-status') {
            if (!runtimeTelemetry)
              throw new Error('preview_debugger_unavailable');
            const result = await runtimeTelemetry.getStatus(request);
            ipcRenderer.send('gdevelop-agent-api:response', {
              requestId,
              ok: true,
              result,
            });
            return;
          }

          if (request.type === 'runtime-snapshot') {
            if (!runtimeTelemetry)
              throw new Error('preview_debugger_unavailable');
            const result = await runtimeTelemetry.getSnapshot(request);
            ipcRenderer.send('gdevelop-agent-api:response', {
              requestId,
              ok: true,
              result,
            });
            return;
          }

          if (request.type === 'runtime-logs') {
            if (!runtimeTelemetry)
              throw new Error('preview_debugger_unavailable');
            ipcRenderer.send('gdevelop-agent-api:response', {
              requestId,
              ok: true,
              result: runtimeTelemetry.getLogs(request),
            });
            return;
          }

          if (request.type === 'runtime-assert') {
            if (!runtimeTelemetry)
              throw new Error('preview_debugger_unavailable');
            const result = await runtimeTelemetry.assertRuntime(request);
            ipcRenderer.send('gdevelop-agent-api:response', {
              requestId,
              ok: true,
              result,
            });
            return;
          }

          if (request.type === 'runtime-wait-for') {
            if (!runtimeTelemetry)
              throw new Error('preview_debugger_unavailable');
            const result = await runtimeTelemetry.waitFor(request);
            ipcRenderer.send('gdevelop-agent-api:response', {
              requestId,
              ok: true,
              result,
            });
            return;
          }

          if (request.type === 'preview-status') {
            ipcRenderer.send('gdevelop-agent-api:response', {
              requestId,
              ok: true,
              result: getPreviewStatus(previewDebuggerServer),
            });
            return;
          }

          if (request.type === 'preview-start') {
            if (!project) throw new Error('no_project_open');
            await launchNewPreview({
              numberOfWindows:
                Number.isInteger(request.numberOfWindows) &&
                request.numberOfWindows > 0
                  ? request.numberOfWindows
                  : 1,
            });
            ipcRenderer.send('gdevelop-agent-api:response', {
              requestId,
              ok: true,
              result: { started: true },
            });
            return;
          }

          if (request.type === 'preview-hot-reload') {
            if (!project) throw new Error('no_project_open');
            await launchHotReloadPreview();
            ipcRenderer.send('gdevelop-agent-api:response', {
              requestId,
              ok: true,
              result: { hotReloaded: true },
            });
            return;
          }

          if (request.type === 'preview-control') {
            const result = controlPreview(request);
            ipcRenderer.send('gdevelop-agent-api:response', {
              requestId,
              ok: true,
              result,
            });
            return;
          }

          if (request.type === 'preview-close-all') {
            const result = await closeAllPreviewWindowsForAgent(ipcRenderer);
            ipcRenderer.send('gdevelop-agent-api:response', {
              requestId,
              ok: true,
              result,
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
            if (!assetTools) throw new Error('no_project_open');
            ipcRenderer.send('gdevelop-agent-api:response', {
              requestId,
              ok: true,
              result: assetTools.listResources(),
            });
            return;
          }

          if (request.type === 'inspect-resource') {
            if (!assetTools) throw new Error('no_project_open');
            if (
              !request.resourceName ||
              typeof request.resourceName !== 'string'
            ) {
              throw new Error('missing_resource_name');
            }
            ipcRenderer.send('gdevelop-agent-api:response', {
              requestId,
              ok: true,
              result: assetTools.inspectResource(request.resourceName),
            });
            return;
          }

          if (request.type === 'import-local-resource') {
            if (!assetTools) throw new Error('no_project_open');
            const result = await assetTools.importLocalResource(request);
            ipcRenderer.send('gdevelop-agent-api:response', {
              requestId,
              ok: true,
              result,
            });
            return;
          }

          if (request.type === 'replace-local-resource') {
            if (!assetTools) throw new Error('no_project_open');
            const result = await assetTools.replaceLocalResource(request);
            ipcRenderer.send('gdevelop-agent-api:response', {
              requestId,
              ok: true,
              result,
            });
            return;
          }

          if (request.type === 'rename-resource') {
            if (!assetTools) throw new Error('no_project_open');
            const result = assetTools.renameResource(request);
            ipcRenderer.send('gdevelop-agent-api:response', {
              requestId,
              ok: true,
              result,
            });
            return;
          }

          if (request.type === 'remove-resource') {
            if (!assetTools) throw new Error('no_project_open');
            const result = assetTools.removeResource(request);
            ipcRenderer.send('gdevelop-agent-api:response', {
              requestId,
              ok: true,
              result,
            });
            return;
          }

          if (request.type === 'export-html5') {
            if (!project) throw new Error('no_project_open');
            const result = await exportLocalHtml5ForAgent({
              project,
              i18n,
              outputDir:
                typeof request.outputDir === 'string'
                  ? request.outputDir
                  : undefined,
            });
            ipcRenderer.send('gdevelop-agent-api:response', {
              requestId,
              ok: true,
              result,
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
