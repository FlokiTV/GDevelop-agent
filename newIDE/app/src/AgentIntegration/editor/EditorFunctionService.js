// @flow

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
  const processCalls = (functionCalls: Array<any>) =>
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
    });

  const run = async ({
    calls,
    save = false,
  }: {|
    calls: Array<AgentFunctionCall>,
    save?: boolean,
  |}) => {
    if (calls.length === 0) throw new Error('no_function_calls');
    if (calls.length > 100) throw new Error('too_many_function_calls');

    const functionCalls = calls.map((call, index) => {
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
    });

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
          processedCall = await processCalls([functionCall]);
        } finally {
          stopWatchingGameplayFrame();
        }
        results.push(...processedCall.results);
        createdSceneNames.push(...processedCall.createdSceneNames);
        if (processedCall.createdProject) {
          createdProject = processedCall.createdProject;
        }
      }
      processedCallsResult = { results, createdSceneNames, createdProject };
    } else {
      processedCallsResult = await processCalls(functionCalls);
    }

    const {
      results,
      createdSceneNames,
      createdProject,
    } = processedCallsResult;
    const didModifyProject = results.some(
      result => result.status === 'finished' && result.didModifyProject
    );

    if (didModifyProject) {
      triggerUnsavedChanges();
      forceUpdate();
    }

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
