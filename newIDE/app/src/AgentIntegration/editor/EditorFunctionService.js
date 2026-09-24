// @flow
import { AgentError } from '../core/AgentError';
import {
  doExtensionChangesNeedCodeRegeneration,
  makeExtensionsOutsideEditorChangesAccumulator,
} from '../../AiGeneration/ExtensionsOutsideEditorChangesAccumulator';
import {
  hasVariableRenameOrReorder,
  runVariableRenameOrReorder,
} from './VariableMutationService';

export type AgentFunctionCall = {|
  name: string,
  arguments?: any,
  callId?: string,
|};

type EditorFunctionServiceOptions = {|
  project: ?gdProject,
  i18n: any,
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
  eventsFunctionsExtensionsState: any,
  onExtensionsModifiedOutsideEditor: any,
  onWillDeleteExtensionItem: any,
  ensureExtensionInstalled: any,
  onWillInstallExtension: any,
  onExtensionInstalled: any,
  searchAndInstallAsset: any,
  searchAndInstallResources: any,
  getAssetStoreTagForNewObject: any,
  triggerUnsavedChanges: () => void,
  forceUpdate: () => void,
  saveProject: (options?: any) => Promise<any>,
  prepareGameplayTestRun: (options: any) => Promise<void>,
  watchGameplayTestFrame: (options: any) => () => void,
  clearGameplayTestFramePreview: () => void,
  documentObject: any,
  makeCallId?: (index: number) => string,
|};

const defaultMakeCallId = (index: number): string =>
  `agent-${Date.now()}-${index}-${Math.random()
    .toString(16)
    .slice(2)}`;

export const createEditorFunctionService = ({
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
  eventsFunctionsExtensionsState,
  onExtensionsModifiedOutsideEditor,
  onWillDeleteExtensionItem,
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
  makeCallId = defaultMakeCallId,
}: EditorFunctionServiceOptions) => {
  const processCalls = (
    functionCalls: Array<any>,
    liveMutationCallbacks: ?{|
      onSceneEventsModifiedOutsideEditor: any,
      onInstancesModifiedOutsideEditor: any,
      onObjectsModifiedOutsideEditor: any,
      onObjectGroupsModifiedOutsideEditor: any,
      onProjectItemRenamedOutsideEditor: any,
      onExtensionsModifiedOutsideEditor: any,
      ensureExtensionsUpToDate: () => Promise<void>,
      reloadExtensionMetadata: (extensionName: string) => void,
    |} = null
  ) =>
    processEditorFunctionCalls({
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
      onSceneEventsModifiedOutsideEditor:
        liveMutationCallbacks?.onSceneEventsModifiedOutsideEditor ||
        onSceneEventsModifiedOutsideEditor,
      onInstancesModifiedOutsideEditor:
        liveMutationCallbacks?.onInstancesModifiedOutsideEditor ||
        onInstancesModifiedOutsideEditor,
      onObjectsModifiedOutsideEditor:
        liveMutationCallbacks?.onObjectsModifiedOutsideEditor ||
        onObjectsModifiedOutsideEditor,
      onObjectGroupsModifiedOutsideEditor:
        liveMutationCallbacks?.onObjectGroupsModifiedOutsideEditor ||
        onObjectGroupsModifiedOutsideEditor,
      onProjectItemRenamedOutsideEditor:
        liveMutationCallbacks?.onProjectItemRenamedOutsideEditor ||
        onProjectItemRenamedOutsideEditor,
      onWillDeleteScene,
      onWillDeleteGameplayTest,
      onWillDeleteObject,
      onExtensionsModifiedOutsideEditor:
        liveMutationCallbacks?.onExtensionsModifiedOutsideEditor ||
        onExtensionsModifiedOutsideEditor,
      ensureExtensionsUpToDate:
        liveMutationCallbacks?.ensureExtensionsUpToDate || (async () => {}),
      reloadExtensionMetadata:
        liveMutationCallbacks?.reloadExtensionMetadata || (() => {}),
      onWillDeleteExtensionItem,
      ensureExtensionInstalled,
      onWillInstallExtension,
      onExtensionInstalled,
      searchAndInstallAsset,
      searchAndInstallResources,
      getAssetStoreTagForNewObject,
    });

  const run = async ({
    calls,
    save = false,
    signal = null,
  }: {|
    calls: Array<AgentFunctionCall>,
    save?: boolean,
    signal?: any,
  |}) => {
    const throwIfCancelled = () => {
      if (signal && signal.aborted) {
        throw new AgentError({
          code: 'operation_cancelled',
          message: 'The editor function operation was cancelled.',
          retryable: false,
        });
      }
    };

    throwIfCancelled();
    if (calls.length === 0) throw new Error('no_function_calls');
    if (calls.length > 100) throw new Error('too_many_function_calls');

    const variableRenameOrReorderCalls = calls.filter(
      call =>
        call &&
        call.name === 'add_or_edit_variable' &&
        hasVariableRenameOrReorder(call.arguments || {})
    );
    if (variableRenameOrReorderCalls.length > 0) {
      if (calls.length !== 1 || variableRenameOrReorderCalls.length !== 1) {
        throw new AgentError({
          code: 'variable_rename_reorder_requires_single_call',
          message:
            'Variable rename/reorder must be sent as a single add_or_edit_variable call. Apply create/update/delete operations in separate calls.',
          retryable: false,
        });
      }
      if (!project) throw new Error('project_required');

      const call = variableRenameOrReorderCalls[0];
      const mutation = runVariableRenameOrReorder({
        project,
        args:
          call.arguments && typeof call.arguments === 'object'
            ? call.arguments
            : {},
      });

      if (mutation.didModifyProject) {
        triggerUnsavedChanges();
        forceUpdate();
      }

      throwIfCancelled();

      let saved = false;
      if (save) {
        const fileMetadata = await saveProject({
          skipNewVersionWarning: true,
        });
        if (!fileMetadata) throw new Error('project_save_failed');
        saved = true;
      }

      return {
        results: [
          {
            status: 'finished',
            call_id: call.callId || makeCallId(0),
            didModifyProject: mutation.didModifyProject,
            success: mutation.output.success,
            output: mutation.output,
          },
        ],
        createdSceneNames: [],
        didModifyProject: mutation.didModifyProject,
        saved,
        createdProject: null,
      };
    }

    const functionCalls = calls.map((call, index) => {
      if (!call || typeof call.name !== 'string' || !call.name) {
        throw new Error(`invalid_function_call_at_index:${index}`);
      }
      const normalizedArguments =
        call.arguments && typeof call.arguments === 'object'
          ? { ...call.arguments }
          : {};
      if (
        call.name === 'run_gameplay_test' &&
        normalizedArguments.persist === undefined
      ) {
        normalizedArguments.persist = false;
      }
      return {
        name: call.name,
        arguments: JSON.stringify(normalizedArguments),
        call_id: call.callId || makeCallId(index),
      };
    });

    let didNotifyLiveMutation = false;
    const pendingSceneEvents = new Map();
    const pendingInstances = new Map();
    const pendingObjects = new Map();
    const pendingObjectGroups = new Map();
    const pendingExtensions = makeExtensionsOutsideEditorChangesAccumulator();

    const ensureExtensionsUpToDate = async () => {
      if (!project || pendingExtensions.isEmpty()) return;
      const changes = pendingExtensions.flush();
      if (doExtensionChangesNeedCodeRegeneration(changes)) {
        await eventsFunctionsExtensionsState.reloadProjectEventsFunctionsExtensions(
          project
        );
      } else {
        changes.extensionNames.forEach(extensionName => {
          if (!project.hasEventsFunctionsExtensionNamed(extensionName)) return;
          eventsFunctionsExtensionsState.reloadProjectEventsFunctionsExtensionMetadata(
            project,
            project.getEventsFunctionsExtension(extensionName)
          );
        });
      }
      onExtensionsModifiedOutsideEditor(changes);
    };

    const reloadExtensionMetadata = (extensionName: string) => {
      if (
        !project ||
        !project.hasEventsFunctionsExtensionNamed(extensionName)
      ) {
        return;
      }
      eventsFunctionsExtensionsState.reloadProjectEventsFunctionsExtensionMetadata(
        project,
        project.getEventsFunctionsExtension(extensionName)
      );
    };

    const queueExtensionsMutation = (changes: any) => {
      didNotifyLiveMutation = true;
      pendingExtensions.add(changes);
    };

    const queueSceneEventsMutation = (changes: any) => {
      didNotifyLiveMutation = true;
      const existing = pendingSceneEvents.get(changes.scene);
      if (existing) {
        changes.newOrChangedAiGeneratedEventIds.forEach(eventId =>
          existing.newOrChangedAiGeneratedEventIds.add(eventId)
        );
        return;
      }
      pendingSceneEvents.set(changes.scene, {
        scene: changes.scene,
        newOrChangedAiGeneratedEventIds: new Set(
          changes.newOrChangedAiGeneratedEventIds
        ),
      });
    };
    const queueSceneMutation = (pending: Map<any, any>) => (changes: any) => {
      didNotifyLiveMutation = true;
      pending.set(changes.scene, changes);
    };
    const queueObjectsMutation = (changes: any) => {
      didNotifyLiveMutation = true;
      const existing = pendingObjects.get(changes.scene);
      pendingObjects.set(changes.scene, {
        scene: changes.scene,
        isNewObjectTypeUsed:
          !!changes.isNewObjectTypeUsed ||
          !!(existing && existing.isNewObjectTypeUsed),
      });
    };
    const observeOrderedLiveMutation = (callback: any) => (changes: any) => {
      didNotifyLiveMutation = true;
      callback(changes);
    };
    const flushLiveMutations = () => {
      pendingSceneEvents.forEach(changes =>
        onSceneEventsModifiedOutsideEditor(changes)
      );
      pendingInstances.forEach(changes =>
        onInstancesModifiedOutsideEditor(changes)
      );
      pendingObjects.forEach(changes =>
        onObjectsModifiedOutsideEditor(changes)
      );
      pendingObjectGroups.forEach(changes =>
        onObjectGroupsModifiedOutsideEditor(changes)
      );
      pendingSceneEvents.clear();
      pendingInstances.clear();
      pendingObjects.clear();
      pendingObjectGroups.clear();
    };
    const liveMutationCallbacks = {
      onSceneEventsModifiedOutsideEditor: queueSceneEventsMutation,
      onInstancesModifiedOutsideEditor: queueSceneMutation(pendingInstances),
      onObjectsModifiedOutsideEditor: queueObjectsMutation,
      onObjectGroupsModifiedOutsideEditor: queueSceneMutation(
        pendingObjectGroups
      ),
      onProjectItemRenamedOutsideEditor: observeOrderedLiveMutation(
        onProjectItemRenamedOutsideEditor
      ),
      onExtensionsModifiedOutsideEditor: queueExtensionsMutation,
      ensureExtensionsUpToDate,
      reloadExtensionMetadata,
    };

    let processedCallsResult;
    if (functionCalls.some(call => call.name === 'run_gameplay_test')) {
      const results = [];
      const createdSceneNames = [];
      let createdProject = null;
      for (const functionCall of functionCalls) {
        let stopWatchingGameplayFrame = () => {};
        if (functionCall.name === 'run_gameplay_test') {
          await prepareGameplayTestRun({
            clearPreview: clearGameplayTestFramePreview,
          });
          stopWatchingGameplayFrame = watchGameplayTestFrame({
            documentObject,
          });
        }
        let processedCall;
        try {
          processedCall = await processCalls(
            [functionCall],
            liveMutationCallbacks
          );
        } finally {
          flushLiveMutations();
          await ensureExtensionsUpToDate();
          stopWatchingGameplayFrame();
        }
        results.push(...processedCall.results);
        createdSceneNames.push(...processedCall.createdSceneNames);
        if (processedCall.createdProject) {
          createdProject = processedCall.createdProject;
        }
        if (signal && signal.aborted) break;
      }
      processedCallsResult = { results, createdSceneNames, createdProject };
    } else {
      try {
        processedCallsResult = await processCalls(
          functionCalls,
          liveMutationCallbacks
        );
      } finally {
        flushLiveMutations();
        await ensureExtensionsUpToDate();
      }
    }

    const { results, createdSceneNames, createdProject } = processedCallsResult;
    const didModifyProject =
      didNotifyLiveMutation ||
      results.some(
        result => result.status === 'finished' && result.didModifyProject
      );

    if (didModifyProject) {
      triggerUnsavedChanges();
      forceUpdate();
    }

    throwIfCancelled();

    let saved = false;
    if (save) {
      if (!project) throw new Error('save_after_creation_requires_followup');
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
      createdProject: createdProject
        ? {
            name: createdProject.getName(),
            uuid: createdProject.getProjectUuid(),
          }
        : null,
    };
  };

  return { run };
};
