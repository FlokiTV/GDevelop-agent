// @flow
import { createSceneInstanceCommandDescriptors } from './SceneInstanceCommands';

describe('DX-27 scene instance command contracts', () => {
  let service: any;
  let descriptors: Array<any>;

  beforeEach(() => {
    service = {
      list: jest.fn(),
      get: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      transform: jest.fn(),
      duplicate: jest.fn(),
      remove: jest.fn(),
      diagnoseDuplicates: jest.fn(),
      bulkUpdate: jest.fn(),
      bulkDelete: jest.fn(),
    };
    descriptors = createSceneInstanceCommandDescriptors({
      sceneInstanceService: service,
    });
  });

  it('exposes explicit identity-safe CRUD/diagnostic/bulk tools without brush/point upsert', () => {
    expect(descriptors.map(descriptor => descriptor.name)).toEqual([
      'scene.instances.list',
      'scene.instances.get',
      'scene.instances.create',
      'scene.instances.update',
      'scene.instances.transform',
      'scene.instances.duplicate',
      'scene.instances.delete',
      'scene.instances.diagnose-duplicates',
      'scene.instances.bulk-update',
      'scene.instances.bulk-delete',
    ]);
    const create = descriptors.find(
      descriptor => descriptor.name === 'scene.instances.create'
    );
    const update = descriptors.find(
      descriptor => descriptor.name === 'scene.instances.update'
    );
    expect(create.inputSchema.required).toEqual([
      'sceneName',
      'objectName',
      'position',
    ]);
    expect(create.description).toMatch(/only.*creates identity/i);
    expect(update.description).toMatch(/never creates/i);
    expect(update.inputSchema.properties).not.toHaveProperty('position');
    expect(update.inputSchema.properties).not.toHaveProperty('point');
    expect(update.inputSchema.properties).not.toHaveProperty('brush');
  });

  it('supports stable UUID/selector targets and mandatory entity revision on delete', () => {
    const get = descriptors.find(
      descriptor => descriptor.name === 'scene.instances.get'
    );
    const remove = descriptors.find(
      descriptor => descriptor.name === 'scene.instances.delete'
    );
    expect(get.inputSchema.properties.instanceId).toMatchObject({
      type: 'string',
      minLength: 1,
    });
    expect(get.inputSchema.properties.selector).toMatchObject({
      type: 'string',
      pattern: '^instance:',
    });
    expect(remove.inputSchema.required).toContain('expectedInstanceRevision');
    expect(remove.metadata).toMatchObject({
      readOnly: false,
      modifiesProject: true,
      destructive: true,
    });
  });

  it('keeps transform absolute and does not advertise unsupported generic scale factors', () => {
    const transform = descriptors.find(
      descriptor => descriptor.name === 'scene.instances.transform'
    );
    expect(transform.inputSchema.properties).toHaveProperty('position');
    expect(transform.inputSchema.properties).toHaveProperty('angle');
    expect(transform.inputSchema.properties).toHaveProperty('size');
    expect(transform.inputSchema.properties).not.toHaveProperty('scale');
    expect(transform.inputSchema.properties).not.toHaveProperty('scaleX');
    expect(transform.inputSchema.properties).not.toHaveProperty('scaleY');
    expect(transform.description).toMatch(
      /no authoritative generic scaleX\/scaleY\/scaleZ contract/i
    );
  });

  it('defaults bulk mutations to dry-run and requires explicit selection schema', () => {
    const bulkUpdate = descriptors.find(
      descriptor => descriptor.name === 'scene.instances.bulk-update'
    );
    const bulkDelete = descriptors.find(
      descriptor => descriptor.name === 'scene.instances.bulk-delete'
    );
    expect(bulkUpdate.inputSchema.required).toEqual([
      'sceneName',
      'selection',
      'changes',
    ]);
    expect(bulkDelete.inputSchema.required).toEqual(['sceneName', 'selection']);
    expect(bulkUpdate.inputSchema.properties.dryRun.default).toBe(true);
    expect(bulkDelete.inputSchema.properties.dryRun.default).toBe(true);
    expect(bulkUpdate.modifiesProjectWhen({ dryRun: true })).toBe(false);
    expect(bulkUpdate.modifiesProjectWhen({ dryRun: false })).toBe(true);
    expect(bulkDelete.modifiesProjectWhen({ dryRun: true })).toBe(false);
    expect(bulkDelete.modifiesProjectWhen({ dryRun: false })).toBe(true);
    expect(
      bulkDelete.inputSchema.properties.selection.properties.all.description
    ).toMatch(/explicit opt-in/i);
    expect(
      bulkDelete.inputSchema.properties.expectedSelectionRevision
    ).toMatchObject({
      type: 'string',
      minLength: 1,
    });
  });

  it('delegates mutating request context to DX-24-backed update paths', async () => {
    service.update.mockResolvedValue({ updated: true });
    service.transform.mockResolvedValue({ transformed: true });
    service.bulkUpdate.mockResolvedValue({ dryRun: false, applied: true });
    const requestContext = {
      expectedRevision: 7,
      traceId: 'dx27-command-test',
    };

    await descriptors
      .find(descriptor => descriptor.name === 'scene.instances.update')
      .execute({
        input: {
          sceneName: 'Game',
          instanceId: 'abc',
          changes: [{ path: 'instance.opacity', value: 100 }],
        },
        requestContext,
      });
    await descriptors
      .find(descriptor => descriptor.name === 'scene.instances.transform')
      .execute({
        input: {
          sceneName: 'Game',
          instanceId: 'abc',
          position: { x: 1 },
        },
        requestContext,
      });
    await descriptors
      .find(descriptor => descriptor.name === 'scene.instances.bulk-update')
      .execute({
        input: {
          sceneName: 'Game',
          selection: { all: true },
          changes: [{ path: 'instance.hidden', value: true }],
          dryRun: false,
          expectedSelectionRevision: 'selection-rev-x',
        },
        requestContext,
      });

    expect(service.update).toHaveBeenCalledWith(
      expect.any(Object),
      requestContext
    );
    expect(service.transform).toHaveBeenCalledWith(
      expect.any(Object),
      requestContext
    );
    expect(service.bulkUpdate).toHaveBeenCalledWith(
      expect.any(Object),
      requestContext
    );
  });
});
