// @flow
import { processEditorFunctionCalls as processRealEditorFunctionCalls } from '../../EditorFunctions/EditorFunctionCallRunner';
import { createEditorFunctionService } from './EditorFunctionService';

jest.mock('../../ObjectsRendering/PixiResourcesLoader', () => ({
  __esModule: true,
  default: {},
}));

const gd: libGDevelop = global.gd;

const createService = (overrides = {}) => {
  const processEditorFunctionCalls = jest.fn(async ({ functionCalls }) => ({
    results: functionCalls.map(call => ({
      status: 'finished',
      didModifyProject: call.name === 'scene.create',
      success: true,
    })),
    createdSceneNames: functionCalls
      .filter(call => call.name === 'scene.create')
      .map(() => 'Scene'),
    createdProject: null,
  }));
  const prepareGameplayTestRun = jest.fn(async () => {});
  const stopWatching = jest.fn();
  const watchGameplayTestFrame = jest.fn(() => stopWatching);
  const triggerUnsavedChanges = jest.fn();
  const forceUpdate = jest.fn();
  const saveProject = jest.fn(async () => ({ fileIdentifier: 'project.json' }));

  const service = createEditorFunctionService({
    project: ({ getName: () => 'Project' }: any),
    i18n: {},
    editorCallbacks: {},
    processEditorFunctionCalls,
    generateEvents: jest.fn(),
    onSceneEventsModifiedOutsideEditor: jest.fn(),
    onInstancesModifiedOutsideEditor: jest.fn(),
    onObjectsModifiedOutsideEditor: jest.fn(),
    onObjectGroupsModifiedOutsideEditor: jest.fn(),
    onProjectItemRenamedOutsideEditor: jest.fn(),
    onWillDeleteScene: jest.fn(),
    onWillDeleteGameplayTest: jest.fn(),
    onWillDeleteObject: jest.fn(),
    ensureExtensionInstalled: jest.fn(),
    onWillInstallExtension: jest.fn(),
    onExtensionInstalled: jest.fn(),
    searchAndInstallAsset: jest.fn(),
    searchAndInstallResources: jest.fn(),
    getAssetStoreTagForNewObject: jest.fn(),
    triggerUnsavedChanges,
    forceUpdate,
    saveProject,
    prepareGameplayTestRun,
    watchGameplayTestFrame,
    clearGameplayTestFramePreview: jest.fn(),
    documentObject: {},
    makeCallId: index => `call-${index}`,
    ...overrides,
  });

  return {
    service,
    processEditorFunctionCalls,
    prepareGameplayTestRun,
    watchGameplayTestFrame,
    stopWatching,
    triggerUnsavedChanges,
    forceUpdate,
    saveProject,
  };
};

describe('EditorFunctionService', () => {
  it('processes ordinary batches once and preserves mutation/save semantics', async () => {
    const {
      service,
      processEditorFunctionCalls,
      triggerUnsavedChanges,
      forceUpdate,
      saveProject,
    } = createService();

    const result = await service.run({
      calls: [
        { name: 'scene.inspect', arguments: { sceneName: 'Game' } },
        { name: 'scene.create', arguments: { name: 'Scene' } },
      ],
      save: true,
    });

    expect(processEditorFunctionCalls).toHaveBeenCalledTimes(1);
    const options = processEditorFunctionCalls.mock.calls[0][0];
    expect(options.functionCalls).toEqual([
      {
        name: 'scene.inspect',
        arguments: JSON.stringify({ sceneName: 'Game' }),
        call_id: 'call-0',
      },
      {
        name: 'scene.create',
        arguments: JSON.stringify({ name: 'Scene' }),
        call_id: 'call-1',
      },
    ]);
    expect(options.toolsVersion).toBe('v12');
    expect(options.toolOptions).toEqual({ includeEventsJson: true });
    expect(triggerUnsavedChanges).toHaveBeenCalledTimes(1);
    expect(forceUpdate).toHaveBeenCalledTimes(1);
    expect(saveProject).toHaveBeenCalledWith({ skipNewVersionWarning: true });
    expect(result).toMatchObject({
      createdSceneNames: ['Scene'],
      didModifyProject: true,
      saved: true,
    });
  });

  it('treats granular live invalidation as a project mutation even when result metadata omits it', async () => {
    const scene = {};
    const onInstancesModifiedOutsideEditor = jest.fn();
    const processEditorFunctionCalls = jest.fn(async options => {
      options.onInstancesModifiedOutsideEditor({ scene });
      return {
        results: [
          {
            status: 'finished',
            didModifyProject: false,
            success: true,
          },
        ],
        createdSceneNames: [],
        createdProject: null,
      };
    });
    const {
      service,
      triggerUnsavedChanges,
      forceUpdate,
    } = createService({
      processEditorFunctionCalls,
      onInstancesModifiedOutsideEditor,
    });

    const result = await service.run({
      calls: [{ name: 'put_2d_instances', arguments: {} }],
    });

    expect(onInstancesModifiedOutsideEditor).toHaveBeenCalledWith({ scene });
    expect(triggerUnsavedChanges).toHaveBeenCalledTimes(1);
    expect(forceUpdate).toHaveBeenCalledTimes(1);
    expect(result.didModifyProject).toBe(true);
  });

  it('mutates the live project with the real runner, invalidates the scene editor, and never autosaves', async () => {
    const project = gd.ProjectHelper.createNewGDJSProject();
    const scene = project.insertNewLayout('TestScene', 0);
    scene.getObjects().insertNewObject(project, 'Sprite', 'Player', 0);
    const onInstancesModifiedOutsideEditor = jest.fn();
    const triggerUnsavedChanges = jest.fn();
    const forceUpdate = jest.fn();
    const saveProject = jest.fn(async () => ({ fileIdentifier: 'project.json' }));

    const service = createEditorFunctionService({
      project,
      i18n: {},
      editorCallbacks: {},
      processEditorFunctionCalls: processRealEditorFunctionCalls,
      generateEvents: jest.fn(),
      onSceneEventsModifiedOutsideEditor: jest.fn(),
      onInstancesModifiedOutsideEditor,
      onObjectsModifiedOutsideEditor: jest.fn(),
      onObjectGroupsModifiedOutsideEditor: jest.fn(),
      onProjectItemRenamedOutsideEditor: jest.fn(),
      onWillDeleteScene: jest.fn(),
      onWillDeleteGameplayTest: jest.fn(),
      onWillDeleteObject: jest.fn(),
      ensureExtensionInstalled: jest.fn(async () => {}),
      onWillInstallExtension: jest.fn(),
      onExtensionInstalled: jest.fn(),
      searchAndInstallAsset: jest.fn(),
      searchAndInstallResources: jest.fn(),
      getAssetStoreTagForNewObject: jest.fn(() => null),
      triggerUnsavedChanges,
      forceUpdate,
      saveProject,
      prepareGameplayTestRun: jest.fn(async () => {}),
      watchGameplayTestFrame: jest.fn(() => () => {}),
      clearGameplayTestFramePreview: jest.fn(),
      documentObject: {},
      makeCallId: index => `live-${index}`,
    });

    try {
      expect(scene.getInitialInstances().getInstancesCount()).toBe(0);

      const result = await service.run({
        calls: [
          {
            name: 'put_2d_instances',
            arguments: {
              scene_name: 'TestScene',
              object_name: 'Player',
              layer_name: '',
              brush_kind: 'point',
              brush_position: '100,200',
              new_instances_count: 1,
            },
          },
        ],
      });

      expect(scene.getInitialInstances().getInstancesCount()).toBe(1);
      expect(onInstancesModifiedOutsideEditor).toHaveBeenCalledWith({ scene });
      expect(triggerUnsavedChanges).toHaveBeenCalledTimes(1);
      expect(forceUpdate).toHaveBeenCalledTimes(1);
      expect(saveProject).not.toHaveBeenCalled();
      expect(result).toMatchObject({ didModifyProject: true, saved: false });
    } finally {
      project.delete();
    }
  });

  it('serializes gameplay tests so each run gets a fresh disposable frame', async () => {
    const {
      service,
      processEditorFunctionCalls,
      prepareGameplayTestRun,
      watchGameplayTestFrame,
      stopWatching,
    } = createService();

    await service.run({
      calls: [
        { name: 'scene.inspect' },
        { name: 'run_gameplay_test', arguments: { test_name: 'A' } },
        { name: 'run_gameplay_test', arguments: { test_name: 'B' } },
      ],
    });

    expect(processEditorFunctionCalls).toHaveBeenCalledTimes(3);
    expect(prepareGameplayTestRun).toHaveBeenCalledTimes(2);
    expect(watchGameplayTestFrame).toHaveBeenCalledTimes(2);
    expect(stopWatching).toHaveBeenCalledTimes(2);
  });

  it('stops watching gameplay frames even when processing fails', async () => {
    const failure = new Error('runner failed');
    const processEditorFunctionCalls = jest.fn(async () => {
      throw failure;
    });
    const { service, stopWatching } = createService({
      processEditorFunctionCalls,
    });

    await expect(
      service.run({ calls: [{ name: 'run_gameplay_test' }] })
    ).rejects.toBe(failure);
    expect(stopWatching).toHaveBeenCalledTimes(1);
  });

  it('preserves created-project reporting', async () => {
    const createdProject = {
      getName: () => 'New Project',
      getProjectUuid: () => 'new-project-uuid',
    };
    const processEditorFunctionCalls = jest.fn(async () => ({
      results: [{ status: 'finished', didModifyProject: false }],
      createdSceneNames: [],
      createdProject,
    }));
    const { service } = createService({ processEditorFunctionCalls });

    await expect(service.run({ calls: [{ name: 'initialize_project' }] })).resolves.toMatchObject({
      createdProject: {
        name: 'New Project',
        uuid: 'new-project-uuid',
      },
    });
  });

  it('rejects invalid batches and explicit save without an open project', async () => {
    const { service } = createService();
    await expect(service.run({ calls: [] })).rejects.toThrow('no_function_calls');
    await expect(
      service.run({ calls: Array.from({ length: 101 }, () => ({ name: 'x.y' })) })
    ).rejects.toThrow('too_many_function_calls');
    await expect(
      service.run({ calls: [({}: any)] })
    ).rejects.toThrow('invalid_function_call_at_index:0');

    const { service: projectlessService } = createService({ project: null });
    await expect(
      projectlessService.run({ calls: [{ name: 'initialize_project' }], save: true })
    ).rejects.toThrow('save_after_creation_requires_followup');
  });
});
