// @flow
import { AgentHost } from './core/AgentHost';
import { createEventTools } from './EventTools';
import { createEventCommandDescriptors } from './editor/EventCommands';
import { createPreviewCommandDescriptors } from './runtime/PreviewCommands';
import { createPreviewService } from './runtime/PreviewService';

const gd: libGDevelop = global.gd;

describe('AgentIntegration event live round trip', () => {
  let project: gdProject;

  beforeEach(() => {
    project = gd.ProjectHelper.createNewGDJSProject();
    const scene = project.insertNewLayout('Scene', 0);
    scene
      .getEvents()
      .insertNewEvent(project, 'BuiltinCommonInstructions::Standard', 0);
  });

  afterEach(() => {
    project.delete();
  });

  it('keeps a running preview alive across multiple live event mutations and hot reloads', async () => {
    const onSceneEventsModifiedOutsideEditor = jest.fn();
    const triggerUnsavedChanges = jest.fn();
    const launchHotReloadPreview = jest.fn(() => Promise.resolve());
    const previewDebuggerServer = {
      getExistingDebuggerIds: jest.fn(() => ['preview-debugger']),
      getExistingPreviewDebuggerIds: jest.fn(() => ['preview-debugger']),
      getServerState: jest.fn(() => 'running'),
    };
    const eventTools = createEventTools({
      project,
      diagnosticsTools: {
        inspect: jest.fn(() => ({ issues: [] })),
      },
      triggerUnsavedChanges,
      onSceneEventsModifiedOutsideEditor,
    });
    const previewService = createPreviewService({
      project,
      previewDebuggerServer,
      launchNewPreview: jest.fn(() => Promise.resolve()),
      launchHotReloadPreview,
      ipcRenderer: {},
    });
    const host = new AgentHost({
      environment: { project },
      descriptors: [
        ...createEventCommandDescriptors({ eventTools }),
        ...createPreviewCommandDescriptors({ previewService }),
      ],
    });

    const initialStatus = await host.execute('preview.status', {});
    expect(initialStatus.data.running).toBe(true);

    let read = await host.execute('events.read', { sceneName: 'Scene' });
    await host.execute('events.update', {
      sceneName: 'Scene',
      expectedEventsRevision: read.data.eventsRevision,
      handle: read.data.events[0].handle,
      eventJson: { ...read.data.eventsJson[0], disabled: true },
    });
    await host.execute('preview.hot-reload', {});
    expect((await host.execute('preview.status', {})).data.running).toBe(true);

    read = await host.execute('events.read', { sceneName: 'Scene' });
    await host.execute('events.update', {
      sceneName: 'Scene',
      expectedEventsRevision: read.data.eventsRevision,
      handle: read.data.events[0].handle,
      eventJson: { ...read.data.eventsJson[0], disabled: false },
    });
    await host.execute('preview.hot-reload', {});

    const finalStatus = await host.execute('preview.status', {});
    expect(finalStatus.data).toMatchObject({
      available: true,
      running: true,
      previewDebuggerIds: ['preview-debugger'],
    });
    expect(launchHotReloadPreview).toHaveBeenCalledTimes(2);
    expect(triggerUnsavedChanges).toHaveBeenCalledTimes(2);
    expect(onSceneEventsModifiedOutsideEditor).toHaveBeenCalledTimes(2);
  });

  it('patches Group presentation only and notifies the live Events Sheet refresh path', async () => {
    const scene = project.getLayout('Scene');
    const group = scene
      .getEvents()
      .insertNewEvent(project, 'BuiltinCommonInstructions::Group', 0);
    group.setAiGeneratedEventId('live-style-group');
    group
      .getSubEvents()
      .insertNewEvent(project, 'BuiltinCommonInstructions::Comment', 0);

    const onSceneEventsModifiedOutsideEditor = jest.fn();
    const triggerUnsavedChanges = jest.fn();
    const eventTools = createEventTools({
      project,
      diagnosticsTools: {
        inspect: jest.fn(() => ({ issues: [] })),
      },
      triggerUnsavedChanges,
      onSceneEventsModifiedOutsideEditor,
    });
    const host = new AgentHost({
      environment: { project },
      descriptors: createEventCommandDescriptors({ eventTools }),
    });

    const before = await host.execute('events.read', { sceneName: 'Scene' });
    const groupJson = before.data.eventsJson[0];
    const result = await host.execute('events.style.update', {
      sceneName: 'Scene',
      expectedEventsRevision: before.data.eventsRevision,
      handle: before.data.events[0].handle,
      style: { background: { r: 45, g: 100, b: 180 } },
    });

    expect(result.data).toMatchObject({
      updated: true,
      changed: true,
      event: { handle: 'event:id:live-style-group', path: [0] },
      beforeStyle: {
        background: expect.objectContaining({
          r: expect.any(Number),
          g: expect.any(Number),
          b: expect.any(Number),
        }),
      },
      afterStyle: { background: { r: 45, g: 100, b: 180 } },
      diff: { operation: 'style-update', changed: true },
    });
    const after = await host.execute('events.read', { sceneName: 'Scene' });
    expect(after.data.eventsJson[0]).toMatchObject({
      ...groupJson,
      colorR: 45,
      colorG: 100,
      colorB: 180,
    });
    expect(after.data.eventsJson[0].events).toEqual(groupJson.events);
    expect(triggerUnsavedChanges).toHaveBeenCalledTimes(1);
    expect(onSceneEventsModifiedOutsideEditor).toHaveBeenCalledTimes(1);
    expect(onSceneEventsModifiedOutsideEditor).toHaveBeenCalledWith({
      scene,
      newOrChangedAiGeneratedEventIds: new Set(['live-style-group']),
    });
  });

  it('reads, patches live UI state and hot reloads preview without reopening the scene', async () => {
    const onSceneEventsModifiedOutsideEditor = jest.fn();
    const triggerUnsavedChanges = jest.fn();
    const launchHotReloadPreview = jest.fn(() => Promise.resolve());
    const eventTools = createEventTools({
      project,
      diagnosticsTools: {
        inspect: jest.fn(() => ({ issues: [] })),
      },
      triggerUnsavedChanges,
      onSceneEventsModifiedOutsideEditor,
    });
    const previewService = createPreviewService({
      project,
      previewDebuggerServer: null,
      launchNewPreview: jest.fn(() => Promise.resolve()),
      launchHotReloadPreview,
      ipcRenderer: {},
    });
    const host = new AgentHost({
      environment: { project },
      descriptors: [
        ...createEventCommandDescriptors({ eventTools }),
        ...createPreviewCommandDescriptors({ previewService }),
      ],
    });

    const read = await host.execute('events.read', { sceneName: 'Scene' });
    const current = read.data;
    const replacement = {
      ...current.eventsJson[0],
      disabled: true,
    };

    const patched = await host.execute('events.update', {
      sceneName: 'Scene',
      expectedEventsRevision: current.eventsRevision,
      handle: current.events[0].handle,
      eventJson: replacement,
    });

    expect(patched.data.updated).toBe(true);
    expect(patched.data.validation).toEqual({ ok: true, issues: [] });
    expect(patched.data.diff).toMatchObject({
      operation: 'update',
      beforeEventsRevision: current.eventsRevision,
      eventsRevision: patched.data.eventsRevision,
      beforeEventCount: 1,
      afterEventCount: 1,
    });
    expect(
      project
        .getLayout('Scene')
        .getEvents()
        .getEventAt(0)
        .isDisabled()
    ).toBe(true);
    expect(triggerUnsavedChanges).toHaveBeenCalledTimes(1);
    expect(onSceneEventsModifiedOutsideEditor).toHaveBeenCalledTimes(1);

    const preview = await host.execute('preview.hot-reload', {});
    expect(preview.data).toEqual({ hotReloaded: true });
    expect(launchHotReloadPreview).toHaveBeenCalledTimes(1);
  });
});
