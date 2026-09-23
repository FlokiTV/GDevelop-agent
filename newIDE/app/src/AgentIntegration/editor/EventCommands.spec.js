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
    updateEventStyle: jest.fn(input => ({ updated: true, ...input })),
    applyEventsJson: jest.fn(input => ({ applied: true, ...input })),
  };
  const metadataDiscoveryService = {
    validateEventNodeJson: jest.fn(() => ({ knownType: true })),
    getEventNodeMutationSchema: jest.fn(() => ({
      oneOf: [
        {
          type: 'object',
          additionalProperties: true,
          required: ['type'],
          properties: {
            type: {
              type: 'string',
              const: 'BuiltinCommonInstructions::Comment',
            },
            comment: { type: 'string' },
          },
        },
        {
          type: 'object',
          additionalProperties: true,
          required: ['type'],
          properties: {
            type: {
              type: 'string',
              not: { enum: ['BuiltinCommonInstructions::Comment'] },
            },
          },
        },
      ],
      'x-gdevelop-schema-reference': {
        listTool: 'events.nodes.list',
        describeTool: 'events.nodes.describe',
        typeField: 'type',
        strategy: 'connected-build-discriminated-union-with-unknown-fallback',
        knownTypeCount: 1,
      },
    })),
  };
  return {
    eventTools,
    metadataDiscoveryService,
    host: new AgentHost({
      environment: { project },
      descriptors: createEventCommandDescriptors({
        eventTools,
        metadataDiscoveryService,
      }),
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
    expect(host.describeCommand('events.style.update').metadata).toMatchObject({
      readOnly: false,
      destructive: false,
      idempotent: true,
      requiresProject: true,
      modifiesProject: true,
    });
    expect(host.describeCommand('events.apply').metadata).toMatchObject({
      readOnly: false,
      requiresProject: true,
      modifiesProject: true,
    });
  });

  test('publishes an abstract bounded RGB schema for localized style updates', () => {
    const { host } = makeHost();
    const command = host.describeCommand('events.style.update');
    expect(command.inputSchema).toMatchObject({
      required: ['expectedEventsRevision', 'handle', 'style'],
      properties: {
        style: {
          additionalProperties: false,
          minProperties: 1,
          properties: {
            background: {
              required: ['r', 'g', 'b'],
              properties: {
                r: { type: 'integer', minimum: 0, maximum: 255 },
                g: { type: 'integer', minimum: 0, maximum: 255 },
                b: { type: 'integer', minimum: 0, maximum: 255 },
              },
            },
            text: {
              required: ['r', 'g', 'b'],
            },
          },
        },
      },
    });
  });

  test('projects connected-build event-node schema references into mutation inputs', () => {
    const { host } = makeHost();
    const insert = host.describeCommand('events.insert').inputSchema;
    const update = host.describeCommand('events.update').inputSchema;
    const apply = host.describeCommand('events.apply').inputSchema;

    [
      insert.properties.eventsJson.items,
      update.properties.eventJson,
      apply.properties.eventsJson.items,
    ].forEach(schema => {
      expect(schema).toMatchObject({
        oneOf: expect.arrayContaining([
          expect.objectContaining({
            properties: expect.objectContaining({
              type: {
                type: 'string',
                const: 'BuiltinCommonInstructions::Comment',
              },
            }),
          }),
          expect.objectContaining({
            properties: expect.objectContaining({
              type: {
                type: 'string',
                not: {
                  enum: ['BuiltinCommonInstructions::Comment'],
                },
              },
            }),
          }),
        ]),
        'x-gdevelop-schema-reference': {
          listTool: 'events.nodes.list',
          describeTool: 'events.nodes.describe',
          typeField: 'type',
          strategy: 'connected-build-discriminated-union-with-unknown-fallback',
          knownTypeCount: 1,
        },
      });
    });
  });

  test('validates inserted, updated and nested event nodes through connected-build metadata', async () => {
    const { host, metadataDiscoveryService } = makeHost();

    await host.execute('events.insert', {
      sceneName: 'Scene',
      expectedEventsRevision: 'events:insert',
      eventsJson: [
        {
          type: 'BuiltinCommonInstructions::Group',
          events: [
            {
              type: 'BuiltinCommonInstructions::Comment',
              comment: 'Nested',
            },
          ],
        },
      ],
    });
    await host.execute('events.update', {
      sceneName: 'Scene',
      expectedEventsRevision: 'events:update',
      handle: 'event:1',
      eventJson: {
        type: 'BuiltinCommonInstructions::Comment',
        comment: 'Updated',
      },
    });
    await host.execute('events.apply', {
      sceneName: 'Scene',
      eventsJson: [
        {
          type: 'FutureExtension::FutureEvent',
          futureField: { value: true },
        },
      ],
      mode: 'append',
    });

    expect(metadataDiscoveryService.validateEventNodeJson).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'BuiltinCommonInstructions::Group' })
    );
    expect(metadataDiscoveryService.validateEventNodeJson).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'BuiltinCommonInstructions::Comment' })
    );
    expect(metadataDiscoveryService.validateEventNodeJson).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'FutureExtension::FutureEvent' })
    );
    expect(
      metadataDiscoveryService.validateEventNodeJson
    ).toHaveBeenCalledTimes(4);
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
    await host.execute('events.style.update', {
      sceneName: 'Scene',
      expectedEventsRevision: 'events:style',
      handle: 'event:fp:style',
      style: { background: { r: 45, g: 100, b: 180 } },
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
    expect(eventTools.updateEventStyle).toHaveBeenCalledWith(
      expect.objectContaining({
        sceneName: 'Scene',
        handle: 'event:fp:style',
        style: { background: { r: 45, g: 100, b: 180 } },
      })
    );
    expect(eventTools.applyEventsJson).toHaveBeenCalledWith({
      sceneName: 'Scene',
      eventsJson: [],
      mode: 'replace',
    });
  });

  test('routes External Events targets without scene shorthand', async () => {
    const { host, eventTools } = makeHost();
    const target = {
      kind: 'external-events',
      externalEventsName: 'SharedLogic',
    };
    await host.execute('events.read', { target });
    await host.execute('events.insert', {
      target,
      expectedEventsRevision: 'events:ext',
      eventsJson: [{ type: 'BuiltinCommonInstructions::Comment' }],
    });
    expect(eventTools.readEventsJson).toHaveBeenCalledWith({ target });
    expect(eventTools.insertEvents).toHaveBeenCalledWith(
      expect.objectContaining({ target })
    );
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
    await expect(
      host.execute('events.style.update', {
        sceneName: 'Scene',
        expectedEventsRevision: 'events:style',
        handle: 'event:fp:style',
        style: { background: { r: 256, g: 100, b: 180 } },
      })
    ).rejects.toMatchObject({
      code: 'invalid_event_style',
      details: expect.objectContaining({
        field: 'background.r',
        expected: 'integer 0..255',
      }),
    });
    await expect(
      host.execute('events.style.update', {
        sceneName: 'Scene',
        expectedEventsRevision: 'events:style',
        handle: 'event:fp:style',
        style: { background: { r: 45, g: 100 } },
      })
    ).rejects.toMatchObject({ code: 'invalid_event_style' });
    expect(eventTools.applyEventsJson).not.toHaveBeenCalled();
    expect(eventTools.updateEventStyle).not.toHaveBeenCalled();
  });

  test('requires an open project through AgentHost', async () => {
    const { host } = makeHost(null);
    await expect(
      host.execute('events.read', { sceneName: 'Scene' })
    ).rejects.toMatchObject({ code: 'no_project_open' });
  });
});
