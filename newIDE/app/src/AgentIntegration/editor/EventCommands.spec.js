// @flow
import { AgentHost } from '../core/AgentHost';
import { createEventCommandDescriptors } from './EventCommands';

const makeHost = (project: any = {}) => {
  const eventTools = {
    readEventsJson: jest.fn(input => ({
      target: input.target || input.sceneName,
    })),
    insertEvents: jest.fn(input => ({ inserted: 1, ...input })),
    deleteEvent: jest.fn(input => ({ deleted: true, ...input })),
    moveEvent: jest.fn(input => ({ moved: true, ...input })),
    updateEvent: jest.fn(input => ({ updated: true, ...input })),
    applyEventsJson: jest.fn(input => ({ applied: true, ...input })),
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

  test('keeps legacy sceneName routing while using generic EventTools methods', async () => {
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
    expect(eventTools.readEventsJson).toHaveBeenCalledWith({
      sceneName: 'Scene',
    });
    expect(eventTools.insertEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        sceneName: 'Scene',
        afterHandle: 'event:fp:abc',
      })
    );
    expect(eventTools.deleteEvent).toHaveBeenCalledWith(
      expect.objectContaining({ sceneName: 'Scene', handle: 'event:fp:def' })
    );
    expect(eventTools.moveEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        sceneName: 'Scene',
        beforeHandle: 'event:fp:jkl',
      })
    );
    expect(eventTools.updateEvent).toHaveBeenCalledWith(
      expect.objectContaining({ sceneName: 'Scene', handle: 'event:fp:mno' })
    );
    expect(eventTools.applyEventsJson).toHaveBeenCalledWith({
      sceneName: 'Scene',
      eventsJson: [],
      mode: 'replace',
    });
  });

  test('routes extension-function targets for free, behavior and object methods', async () => {
    const { host, eventTools } = makeHost();
    const freeTarget = {
      kind: 'extension-function',
      extensionName: 'Logic',
      functionName: 'Tick',
    };
    const behaviorTarget = {
      kind: 'extension-function',
      extensionName: 'Logic',
      ownerKind: 'behavior',
      ownerName: 'Mover',
      functionName: 'DoMove',
    };
    const objectTarget = {
      kind: 'extension-function',
      extensionName: 'Logic',
      ownerKind: 'object',
      ownerName: 'Panel',
      functionName: 'Refresh',
    };

    await host.execute('events.read', { target: freeTarget });
    await host.execute('events.read', { target: behaviorTarget });
    await host.execute('events.insert', {
      target: objectTarget,
      expectedEventsRevision: 'events:123',
      eventsJson: [{ type: 'BuiltinCommonInstructions::Comment' }],
    });

    expect(eventTools.readEventsJson).toHaveBeenNthCalledWith(1, {
      target: freeTarget,
    });
    expect(eventTools.readEventsJson).toHaveBeenNthCalledWith(2, {
      target: behaviorTarget,
    });
    expect(eventTools.insertEvents).toHaveBeenCalledWith(
      expect.objectContaining({ target: objectTarget })
    );
  });

  test('validates target and event payload before invoking EventTools', async () => {
    const { host, eventTools } = makeHost();
    await expect(
      host.execute('events.apply', {
        sceneName: 'Scene',
        eventsJson: {},
      })
    ).rejects.toMatchObject({ code: 'invalid_events_json' });
    await expect(
      host.execute('events.read', {
        sceneName: 'Scene',
        target: { kind: 'scene', sceneName: 'Other' },
      })
    ).rejects.toMatchObject({ code: 'ambiguous_events_target' });
    await expect(
      host.execute('events.read', {
        target: {
          kind: 'extension-function',
          extensionName: 'Logic',
          ownerKind: 'behavior',
          functionName: 'DoMove',
        },
      })
    ).rejects.toMatchObject({ code: 'events_function_owner_name_required' });
    expect(eventTools.applyEventsJson).not.toHaveBeenCalled();
  });

  test('requires an open project through AgentHost', async () => {
    const { host } = makeHost(null);
    await expect(
      host.execute('events.read', { sceneName: 'Scene' })
    ).rejects.toMatchObject({ code: 'no_project_open' });
  });
});
