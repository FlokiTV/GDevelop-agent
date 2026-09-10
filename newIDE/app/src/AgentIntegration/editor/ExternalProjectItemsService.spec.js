// @flow
import { createExternalProjectItemsService } from './ExternalProjectItemsService';
import { makeTestExtensions } from '../../fixtures/TestExtensions';

const gd: libGDevelop = global.gd;

describe('AgentIntegration ExternalProjectItemsService', () => {
  let project: gdProject;
  let triggerUnsavedChanges;
  let forceUpdate;
  let service: any;

  beforeAll(() => {
    makeTestExtensions(gd);
  });

  beforeEach(() => {
    // $FlowFixMe[invalid-constructor]
    project = new gd.ProjectHelper.createNewGDJSProject();
    project.resetProjectUuid();
    project.setName('External Project Items Test');
    project.insertNewLayout('Game', 0);
    project.getObjects().insertNewObject(project, 'Sprite', 'GlobalSprite', 0);
    triggerUnsavedChanges = jest.fn();
    forceUpdate = jest.fn();
    service = createExternalProjectItemsService({
      project,
      triggerUnsavedChanges,
      forceUpdate,
    });
  });

  afterEach(() => {
    project.delete();
  });

  it('creates, updates, lists, renames and safely deletes External Events', () => {
    expect(
      service.createExternalEvents({
        name: 'SharedLogic',
        associatedLayout: 'Game',
      })
    ).toMatchObject({
      created: true,
      externalEvents: {
        name: 'SharedLogic',
        associatedLayout: 'Game',
        eventCount: 0,
      },
    });
    expect(service.listExternalEvents()).toMatchObject({
      total: 1,
      items: [{ name: 'SharedLogic', associatedLayout: 'Game' }],
    });

    service.updateExternalEvents({
      name: 'SharedLogic',
      associatedLayout: '',
    });
    expect(
      service.inspectExternalEvents({ name: 'SharedLogic' }).externalEvents
        .associatedLayout
    ).toBe('');

    expect(
      service.renameExternalEvents({
        name: 'SharedLogic',
        newName: 'SharedLogic2',
      })
    ).toMatchObject({
      renamed: true,
      oldName: 'SharedLogic',
      newName: 'SharedLogic2',
    });
    expect(project.hasExternalEventsNamed('SharedLogic2')).toBe(true);

    expect(() =>
      service.deleteExternalEvents({ name: 'SharedLogic2' })
    ).toThrow(expect.objectContaining({
      code: 'external_events_delete_requires_reference_opt_in',
    }));
    expect(
      service.deleteExternalEvents({
        name: 'SharedLogic2',
        allowReferenced: true,
      })
    ).toMatchObject({ deleted: true, allowedReferenced: true });
    expect(service.listExternalEvents().total).toBe(0);
  });

  it('duplicates External Layouts with independent instances and refactors names', () => {
    service.createExternalLayout({ name: 'HUD', associatedLayout: 'Game' });
    const createdInstance = service.createExternalLayoutInstance({
      name: 'HUD',
      objectName: 'GlobalSprite',
      x: 10,
      y: 20,
      zOrder: 3,
      opacity: 200,
    });
    expect(createdInstance).toMatchObject({
      created: true,
      instance: {
        objectName: 'GlobalSprite',
        x: 10,
        y: 20,
        zOrder: 3,
        opacity: 200,
      },
    });

    expect(
      service.duplicateExternalLayout({ name: 'HUD', newName: 'HUD Copy' })
    ).toMatchObject({
      duplicated: true,
      sourceName: 'HUD',
      externalLayout: {
        name: 'HUD Copy',
        associatedLayout: 'Game',
        instanceCount: 1,
      },
    });

    service.updateExternalLayoutInstance({
      name: 'HUD Copy',
      instanceId: service.listExternalLayoutInstances({ name: 'HUD Copy' })
        .items[0].id,
      x: 99,
    });
    expect(
      service.listExternalLayoutInstances({ name: 'HUD' }).items[0].x
    ).toBe(10);
    expect(
      service.listExternalLayoutInstances({ name: 'HUD Copy' }).items[0].x
    ).toBe(99);

    expect(
      service.renameExternalLayout({ name: 'HUD Copy', newName: 'HUD Clone' })
    ).toMatchObject({ renamed: true, newName: 'HUD Clone' });
    expect(project.hasExternalLayoutNamed('HUD Clone')).toBe(true);
  });

  it('supports full External Layout instance CRUD and rejects unknown objects', () => {
    service.createExternalLayout({ name: 'Overlay', associatedLayout: 'Game' });
    const created = service.createExternalLayoutInstance({
      name: 'Overlay',
      objectName: 'GlobalSprite',
      x: 1,
      y: 2,
      hidden: true,
      hasCustomSize: true,
      customWidth: 64,
      customHeight: 32,
    });
    expect(created.instance.id).toEqual(expect.any(String));

    const shortId = created.instance.id.slice(0, 10);
    expect(
      service.updateExternalLayoutInstance({
        name: 'Overlay',
        instanceId: shortId,
        x: 5,
        y: 6,
        hidden: false,
      }).instance
    ).toMatchObject({ x: 5, y: 6, hidden: false });
    expect(service.listExternalLayoutInstances({ name: 'Overlay' })).toMatchObject({
      total: 1,
      items: [expect.objectContaining({ objectName: 'GlobalSprite' })],
    });

    expect(() =>
      service.createExternalLayoutInstance({
        name: 'Overlay',
        objectName: 'MissingObject',
      })
    ).toThrow(expect.objectContaining({ code: 'external_layout_object_not_found' }));

    expect(
      service.deleteExternalLayoutInstance({
        name: 'Overlay',
        instanceId: shortId,
      })
    ).toMatchObject({ deleted: true });
    expect(service.listExternalLayoutInstances({ name: 'Overlay' }).total).toBe(0);

    expect(() =>
      service.deleteExternalLayout({ name: 'Overlay' })
    ).toThrow(expect.objectContaining({
      code: 'external_layout_delete_requires_reference_opt_in',
    }));
    expect(
      service.deleteExternalLayout({ name: 'Overlay', allowReferenced: true })
    ).toMatchObject({ deleted: true, allowedReferenced: true });
  });

  it('rejects invalid associations and duplicate names deterministically', () => {
    expect(() =>
      service.createExternalEvents({
        name: 'BadAssociation',
        associatedLayout: 'Missing',
      })
    ).toThrow(expect.objectContaining({ code: 'associated_scene_not_found' }));

    service.createExternalLayout({ name: 'UniqueLayout' });
    expect(() =>
      service.createExternalLayout({ name: 'UniqueLayout' })
    ).toThrow(expect.objectContaining({ code: 'external_layout_name_taken' }));
  });
});
