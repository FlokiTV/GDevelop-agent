// @flow
import { createBehaviorLifecycleCommandDescriptors } from './BehaviorLifecycleCommands';

describe('DX-29 behavior lifecycle command contracts', () => {
  let service: any;
  let descriptors: Array<any>;

  beforeEach(() => {
    service = {
      list: jest.fn(),
      available: jest.fn(),
      describe: jest.fn(),
      add: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
    };
    descriptors = createBehaviorLifecycleCommandDescriptors({
      behaviorLifecycleService: service,
    });
  });

  it('exposes contextual discovery plus typed lifecycle tools', () => {
    expect(descriptors.map(descriptor => descriptor.name)).toEqual([
      'objects.behaviors.list',
      'objects.behaviors.available',
      'objects.behaviors.describe',
      'objects.behaviors.add',
      'objects.behaviors.update',
      'objects.behaviors.remove',
    ]);

    const available = descriptors.find(
      descriptor => descriptor.name === 'objects.behaviors.available'
    );
    expect(available.inputSchema.properties).toMatchObject({
      includeCapabilities: { type: 'boolean', default: true },
      compatibleOnly: { type: 'boolean', default: true },
      limit: expect.objectContaining({ maximum: 100 }),
    });
    expect(available.description).toMatch(/native ObjectTools compatibility/i);
  });

  it('keeps add/update project-mutating and makes removal dry-run safe by default', () => {
    const add = descriptors.find(
      descriptor => descriptor.name === 'objects.behaviors.add'
    );
    const update = descriptors.find(
      descriptor => descriptor.name === 'objects.behaviors.update'
    );
    const remove = descriptors.find(
      descriptor => descriptor.name === 'objects.behaviors.remove'
    );

    expect(add.metadata).toMatchObject({
      readOnly: false,
      modifiesProject: true,
    });
    expect(add.inputSchema.required).toEqual(['objectName', 'behaviorType']);
    expect(update.metadata).toMatchObject({
      readOnly: false,
      modifiesProject: true,
    });
    expect(update.inputSchema.required).toEqual([
      'objectName',
      'behaviorName',
      'changes',
    ]);
    expect(remove.metadata).toMatchObject({
      readOnly: false,
      modifiesProject: true,
      destructive: true,
    });
    expect(remove.inputSchema.properties.dryRun.default).toBe(true);
    expect(remove.inputSchema.properties.cascadeDependents.default).toBe(false);
    expect(remove.inputSchema.properties.removeInstanceOverrides.default).toBe(
      false
    );
    expect(remove.modifiesProjectWhen({ dryRun: true })).toBe(false);
    expect(remove.modifiesProjectWhen({ dryRun: false })).toBe(true);
  });

  it('declares exact typed behavior-property changes instead of raw JSON', () => {
    const update = descriptors.find(
      descriptor => descriptor.name === 'objects.behaviors.update'
    );
    const change = update.inputSchema.properties.changes.items;
    expect(change).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['path', 'value'],
      properties: {
        path: { type: 'string', minLength: 1, description: expect.any(String) },
        value: {
          anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }],
        },
      },
    });
    expect(JSON.stringify(update.inputSchema)).not.toMatch(
      /projectJson|rawJson/i
    );
  });

  it('delegates update request context to the DX-24-backed service', async () => {
    service.update.mockResolvedValue({ updated: true });
    const descriptor = descriptors.find(
      candidate => candidate.name === 'objects.behaviors.update'
    );
    const input = {
      sceneName: 'Game',
      objectName: 'Hero',
      behaviorName: 'Platformer',
      changes: [{ path: 'behaviors.Platformer.properties.speed', value: 200 }],
    };
    const requestContext = {
      expectedRevision: 12,
      owner: 'dx29-test',
      traceId: 'dx29-command-context',
    };

    await descriptor.execute({ input, requestContext });

    expect(service.update).toHaveBeenCalledWith(input, requestContext);
  });
});
