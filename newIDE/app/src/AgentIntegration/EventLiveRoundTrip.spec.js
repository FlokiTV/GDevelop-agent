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
    expect(project.getLayout('Scene').getEvents().getEventAt(0).isDisabled()).toBe(
      true
    );
    expect(triggerUnsavedChanges).toHaveBeenCalledTimes(1);
    expect(onSceneEventsModifiedOutsideEditor).toHaveBeenCalledTimes(1);

    const preview = await host.execute('preview.hot-reload', {});
    expect(preview.data).toEqual({ hotReloaded: true });
    expect(launchHotReloadPreview).toHaveBeenCalledTimes(1);
  });
});
