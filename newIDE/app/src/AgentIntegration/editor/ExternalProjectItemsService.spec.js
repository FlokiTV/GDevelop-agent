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

  it('manages External Events by persistent identity with refactor-safe usages and deletion', () => {
    const created = service.createExternalEvents({
      name: 'SharedLogic',
      associatedLayout: 'Game',
    });
    expect(created).toMatchObject({
      created: true,
      externalEvents: {
        name: 'SharedLogic',
        associatedLayout: 'Game',
        eventCount: 0,
        order: 0,
      },
    });
    const stableId = created.externalEvents.externalEventsId;
    expect(stableId).toEqual(expect.any(String));
    expect(created.externalEvents.selector).toBe(`external-events:${stableId}`);

    const linkBaseEvent = project
      .getLayout('Game')
      .getEvents()
      .insertNewEvent(project, 'BuiltinCommonInstructions::Link', 0);
    gd.asLinkEvent(linkBaseEvent).setTarget('SharedLogic');

    expect(
      service.externalEventsUsages({ externalEventsId: stableId })
    ).toMatchObject({
      total: 1,
      references: [
        expect.objectContaining({
          before: 'SharedLogic',
          kind: 'event-reference',
        }),
      ],
    });

    const renamed = service.renameExternalEvents({
      externalEventsId: stableId,
      newName: 'SharedLogic2',
    });
    expect(renamed).toMatchObject({
      renamed: true,
      oldName: 'SharedLogic',
      newName: 'SharedLogic2',
      preservedExternalEventsId: stableId,
      referencesUpdated: 1,
    });
    expect(project.hasExternalEventsNamed('SharedLogic2')).toBe(true);
    expect(project.getExternalEvents('SharedLogic2').getPersistentUuid()).toBe(
      stableId
    );
    expect(gd.asLinkEvent(linkBaseEvent).getTarget()).toBe('SharedLogic2');

    service.updateExternalEvents({
      externalEventsId: stableId,
      associatedLayout: '',
    });
    expect(
      service.inspectExternalEvents({ selector: `external-events:${stableId}` })
        .externalEvents.associatedLayout
    ).toBe('');

    const duplicated = service.duplicateExternalEvents({
      externalEventsId: stableId,
      newName: 'SharedLogic Copy',
    });
    expect(duplicated.externalEvents.externalEventsId).not.toBe(stableId);
    expect(service.listExternalEvents().items.map(item => item.name)).toEqual([
      'SharedLogic2',
      'SharedLogic Copy',
    ]);

    expect(
      service.reorderExternalEvents({
        externalEventsId: duplicated.externalEvents.externalEventsId,
        position: 0,
      })
    ).toMatchObject({ reordered: true, oldIndex: 1, newIndex: 0 });
    expect(service.listExternalEvents().items.map(item => item.name)).toEqual([
      'SharedLogic Copy',
      'SharedLogic2',
    ]);

    const dryRun = service.deleteExternalEvents({
      externalEventsId: stableId,
      dryRun: true,
    });
    expect(dryRun.blockerCount).toBe(1);
    expect(() =>
      service.deleteExternalEvents({ externalEventsId: stableId })
    ).toThrow(
      expect.objectContaining({ code: 'external_events_delete_blocked' })
    );

    expect(
      service.deleteExternalEvents({
        externalEventsId: duplicated.externalEvents.externalEventsId,
      })
    ).toMatchObject({ deleted: true });
    expect(project.hasExternalEventsNamed('SharedLogic Copy')).toBe(false);
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
    expect(
      service.listExternalLayoutInstances({ name: 'Overlay' })
    ).toMatchObject({
      total: 1,
      items: [expect.objectContaining({ objectName: 'GlobalSprite' })],
    });

    expect(() =>
      service.createExternalLayoutInstance({
        name: 'Overlay',
        objectName: 'MissingObject',
      })
    ).toThrow(
      expect.objectContaining({ code: 'external_layout_object_not_found' })
    );

    expect(
      service.deleteExternalLayoutInstance({
        name: 'Overlay',
        instanceId: shortId,
      })
    ).toMatchObject({ deleted: true });
    expect(service.listExternalLayoutInstances({ name: 'Overlay' }).total).toBe(
      0
    );

    expect(() => service.deleteExternalLayout({ name: 'Overlay' })).toThrow(
      expect.objectContaining({
        code: 'external_layout_delete_requires_reference_opt_in',
      })
    );
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
