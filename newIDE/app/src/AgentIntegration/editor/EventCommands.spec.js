// @flow
import { AgentHost } from '../core/AgentHost';
import { createEventCommandDescriptors } from './EventCommands';

const makeHost = (project: any = {}) => {
  const eventTools = {
    readSceneEventsJson: jest.fn(input => ({ sceneName: input.sceneName })),
    insertSceneEvents: jest.fn(input => ({ inserted: 1, ...input })),
    deleteSceneEvent: jest.fn(input => ({ deleted: true, ...input })),
    moveSceneEvent: jest.fn(input => ({ moved: true, ...input })),
    updateSceneEvent: jest.fn(input => ({ updated: true, ...input })),
    applySceneEventsJson: jest.fn(input => ({ applied: true, ...input })),
  };
  return {
    eventTools,
    host: new AgentHost({
      environment: { project },
      descriptors: createEventCommandDescriptors({ eventTools }),
    }),
  };
};

describe('EventCommands', () => {
  test('marks reads as read-only and localized edits as project mutations', () => {
    const { host } = makeHost();
    expect(host.describeCommand('events.read').metadata).toMatchObject({
      readOnly: true,
      requiresProject: true,
      modifiesProject: false,
    });
    expect(host.describeCommand('events.insert').metadata).toMatchObject({
      readOnly: false,
      destructive: false,
      requiresProject: true,
      modifiesProject: true,
    });
    expect(host.describeCommand('events.delete').metadata).toMatchObject({
      readOnly: false,
      destructive: true,
      requiresProject: true,
      modifiesProject: true,
    });
    expect(host.describeCommand('events.move').metadata).toMatchObject({
      readOnly: false,
      requiresProject: true,
      modifiesProject: true,
    });
    expect(host.describeCommand('events.update').metadata).toMatchObject({
      readOnly: false,
      requiresProject: true,
      modifiesProject: true,
    });
    expect(host.describeCommand('events.apply').metadata).toMatchObject({
      readOnly: false,
      requiresProject: true,
      modifiesProject: true,
    });
  });

  test('routes canonical read, localized edits and bulk fallback through EventTools', async () => {
    const { host, eventTools } = makeHost();
    await host.execute('events.read', { sceneName: 'Scene' });
    await host.execute('events.insert', {
      sceneName: 'Scene',
      expectedEventsRevision: 'events:abc',
      eventsJson: [{ type: 'BuiltinCommonInstructions::Comment' }],
      afterHandle: 'event:fp:abc',
    });
    await host.execute('events.delete', {
      sceneName: 'Scene',
      expectedEventsRevision: 'events:def',
      handle: 'event:fp:def',
    });
    await host.execute('events.move', {
      sceneName: 'Scene',
      expectedEventsRevision: 'events:ghi',
      handle: 'event:fp:ghi',
      beforeHandle: 'event:fp:jkl',
    });
    await host.execute('events.update', {
      sceneName: 'Scene',
      expectedEventsRevision: 'events:mno',
      handle: 'event:fp:mno',
      eventJson: { type: 'BuiltinCommonInstructions::Standard' },
    });
    await host.execute('events.apply', {
      sceneName: 'Scene',
      eventsJson: [],
      mode: 'replace',
    });
    expect(eventTools.readSceneEventsJson).toHaveBeenCalledWith({
      sceneName: 'Scene',
    });
    expect(eventTools.insertSceneEvents).toHaveBeenCalledWith({
      sceneName: 'Scene',
      expectedEventsRevision: 'events:abc',
      eventsJson: [{ type: 'BuiltinCommonInstructions::Comment' }],
      afterHandle: 'event:fp:abc',
    });
    expect(eventTools.deleteSceneEvent).toHaveBeenCalledWith({
      sceneName: 'Scene',
      expectedEventsRevision: 'events:def',
      handle: 'event:fp:def',
    });
    expect(eventTools.moveSceneEvent).toHaveBeenCalledWith({
      sceneName: 'Scene',
      expectedEventsRevision: 'events:ghi',
      handle: 'event:fp:ghi',
      beforeHandle: 'event:fp:jkl',
    });
    expect(eventTools.updateSceneEvent).toHaveBeenCalledWith({
      sceneName: 'Scene',
      expectedEventsRevision: 'events:mno',
      handle: 'event:fp:mno',
      eventJson: { type: 'BuiltinCommonInstructions::Standard' },
    });
    expect(eventTools.applySceneEventsJson).toHaveBeenCalledWith({
      sceneName: 'Scene',
      eventsJson: [],
      mode: 'replace',
    });
  });

  test('validates event payload before invoking EventTools', async () => {
    const { host, eventTools } = makeHost();
    await expect(
      host.execute('events.apply', {
        sceneName: 'Scene',
        eventsJson: {},
      })
    ).rejects.toMatchObject({ code: 'invalid_events_json' });
    expect(eventTools.applySceneEventsJson).not.toHaveBeenCalled();
  });

  test('requires an open project through AgentHost', async () => {
    const { host } = makeHost(null);
    await expect(
      host.execute('events.read', { sceneName: 'Scene' })
    ).rejects.toMatchObject({ code: 'no_project_open' });
  });
});
