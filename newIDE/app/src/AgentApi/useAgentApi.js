// @flow
import * as React from 'react';
import { type I18n as I18nType } from '@lingui/core';
import optionalRequire from '../Utils/OptionalRequire';
import {
  editorFunctions,
  type EditorCallbacks,
  type EditorFunctionCall,
} from '../EditorFunctions';
import { processEditorFunctionCalls } from '../EditorFunctions/EditorFunctionCallRunner';
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
import { type ResourceManagementProps } from '../ResourcesList/ResourceSource';
import { type FileMetadata } from '../ProjectsStorage';

const electron = optionalRequire('electron');
const ipcRenderer = electron ? electron.ipcRenderer : null;

const makeCallId = (index: number): string =>
  `agent-api-${Date.now()}-${index}-${Math.random()
    .toString(16)
    .slice(2)}`;

type AgentFunctionCall = {|
  name: string,
  arguments?: any,
  callId?: string,
|};

type Props = {|
  project: ?gdProject,
  fileIdentifier: ?string,
  i18n: I18nType,
  resourceManagementProps: ResourceManagementProps,
  saveProject: (options?: {|
    skipNewVersionWarning: boolean,
  |}) => Promise<?FileMetadata>,
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

const getFunctions = () =>
  Object.keys(editorFunctions)
    .sort()
    .map(name => ({
      name,
      modifiesProject: !!editorFunctions[name].modifiesProject,
    }));

export default function useAgentApi({
  project,
  fileIdentifier,
  i18n,
  resourceManagementProps,
  saveProject,
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

  const editorCallbacks: EditorCallbacks = React.useMemo(
    () => ({
      onOpenLayout,
      // The embedded API is intentionally scoped to the project currently open
      // in this renderer. Project creation stays with the regular editor flow.
      onCreateProject: async () => ({
        createdProject: null,
        exampleSlug: null,
      }),
    }),
    [onOpenLayout]
  );

  React.useEffect(
    () => {
      if (!ipcRenderer) return;
      ipcRenderer.send('gdevelop-agent-api:register', { fileIdentifier });
      return () => {
        ipcRenderer.send('gdevelop-agent-api:register', {
          fileIdentifier: null,
        });
      };
    },
    [fileIdentifier]
  );

  React.useEffect(
    () => {
      if (!ipcRenderer) return;

      const runFunctionCalls = async (
        calls: Array<AgentFunctionCall>,
        shouldSave: boolean
      ) => {
        if (!project) throw new Error('no_project_open');
        if (calls.length === 0) throw new Error('no_function_calls');
        if (calls.length > 100) throw new Error('too_many_function_calls');

        const functionCalls: Array<EditorFunctionCall> = calls.map(
          (call, index) => {
            if (!call || typeof call.name !== 'string' || !call.name) {
              throw new Error(`invalid_function_call_at_index:${index}`);
            }
            return {
              name: call.name,
              arguments: JSON.stringify(
                call.arguments && typeof call.arguments === 'object'
                  ? call.arguments
                  : {}
              ),
              call_id: call.callId || makeCallId(index),
            };
          }
        );

        const { results, createdSceneNames } = await processEditorFunctionCalls(
          {
            project,
            functionCalls,
            i18n,
            editorCallbacks,
            toolOptions: { includeEventsJson: true },
            toolsVersion: 'v12',
            runScriptReadOnly: false,
            relatedAiRequestId: null,
            getRelatedAiRequestLastMessages: () => ({
              lastUserMessage: null,
              lastAssistantMessages: [],
            }),
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
          }
        );

        const didModifyProject = results.some(
          result => result.status === 'finished' && result.didModifyProject
        );
        if (didModifyProject) {
          triggerUnsavedChanges();
          forceUpdate();
        }

        let saved = false;
        if (shouldSave) {
          const fileMetadata = await saveProject({
            skipNewVersionWarning: true,
          });
          if (!fileMetadata) throw new Error('project_save_failed');
          saved = true;
        }

        return {
          results,
          createdSceneNames,
          didModifyProject,
          saved,
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
            ipcRenderer.send('gdevelop-agent-api:response', {
              requestId,
              ok: true,
              result: {
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
              },
            });
            return;
          }

          if (request.type === 'list-functions') {
            ipcRenderer.send('gdevelop-agent-api:response', {
              requestId,
              ok: true,
              result: {
                projectOpen: !!project,
                fileIdentifier,
                functions: getFunctions(),
              },
            });
            return;
          }

          if (!project) throw new Error('no_project_open');

          if (request.type === 'save-project') {
            const fileMetadata = await saveProject({
              skipNewVersionWarning: true,
            });
            if (!fileMetadata) throw new Error('project_save_failed');
            ipcRenderer.send('gdevelop-agent-api:response', {
              requestId,
              ok: true,
              result: { saved: true, fileIdentifier },
            });
            return;
          }

          if (request.type === 'editor-function') {
            const result = await runFunctionCalls(
              [
                {
                  name: request.name,
                  arguments: request.arguments,
                  callId: request.callId,
                },
              ],
              !!request.save
            );
            ipcRenderer.send('gdevelop-agent-api:response', {
              requestId,
              ok: true,
              result,
            });
            return;
          }

          if (request.type === 'editor-functions') {
            const calls = Array.isArray(request.calls) ? request.calls : [];
            const result = await runFunctionCalls(calls, !!request.save);
            ipcRenderer.send('gdevelop-agent-api:response', {
              requestId,
              ok: true,
              result,
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
          });
        }
      };

      ipcRenderer.on('gdevelop-agent-api:request', onRequest);
      return () => {
        ipcRenderer.removeListener('gdevelop-agent-api:request', onRequest);
      };
    },
    [
      project,
      fileIdentifier,
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
      triggerUnsavedChanges,
      forceUpdate,
    ]
  );
}
