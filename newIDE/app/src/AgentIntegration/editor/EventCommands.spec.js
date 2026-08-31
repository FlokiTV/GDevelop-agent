// @flow
import { AgentHost } from '../core/AgentHost';
import { createEventCommandDescriptors } from './EventCommands';

const makeHost = (project: any = {}) => {
  const eventTools = {
    readSceneEventsJson: jest.fn(input => ({ sceneName: input.sceneName })),
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
  test('marks event reads as read-only and apply as project mutation', () => {
    const { host } = makeHost();
    expect(host.describeCommand('events.read').metadata).toMatchObject({
      readOnly: true,
      requiresProject: true,
      modifiesProject: false,
    });
    expect(host.describeCommand('events.apply').metadata).toMatchObject({
      readOnly: false,
      requiresProject: true,
      modifiesProject: true,
    });
  });

  test('routes canonical read and apply through EventTools', async () => {
    const { host, eventTools } = makeHost();
    await host.execute('events.read', { sceneName: 'Scene' });
    await host.execute('events.apply', {
      sceneName: 'Scene',
      eventsJson: [],
      mode: 'replace',
    });
    expect(eventTools.readSceneEventsJson).toHaveBeenCalledWith({
      sceneName: 'Scene',
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
