// @flow
import { createExtensionAuthoringService } from './ExtensionAuthoringService';
import { makeTestExtensions } from '../../fixtures/TestExtensions';

const gd: libGDevelop = global.gd;

describe('AgentIntegration ExtensionAuthoringService', () => {
  let project: gdProject;
  let triggerUnsavedChanges;
  let forceUpdate;
  let lifecycle;
  let service: any;

  beforeAll(() => {
    makeTestExtensions(gd);
  });

  beforeEach(() => {
    // $FlowFixMe[invalid-constructor]
    project = new gd.ProjectHelper.createNewGDJSProject();
    project.resetProjectUuid();
    project.setName('Extension Authoring Test');
    project.insertNewLayout('Game', 0);

    triggerUnsavedChanges = jest.fn();
    forceUpdate = jest.fn();
    lifecycle = {
      ensureLoadFinished: jest.fn(() => Promise.resolve()),
      reloadProjectEventsFunctionsExtensions: jest.fn(() => Promise.resolve()),
    };
    service = createExtensionAuthoringService({
      project,
      triggerUnsavedChanges,
      forceUpdate,
      eventsFunctionsExtensionsState: lifecycle,
    });
  });

  afterEach(() => {
    project.delete();
  });

  it('creates, lists, inspects, renames and deletes project extensions through the official lifecycle', async () => {
    const created = await service.createProjectExtension({
      name: 'AgentExtension',
      fullName: 'Agent Extension',
      description: 'Created through AgentIntegration',
      version: '1.0.0',
    });

    expect(created).toMatchObject({
      created: true,
      extension: {
        name: 'AgentExtension',
        fullName: 'Agent Extension',
        description: 'Created through AgentIntegration',
        version: '1.0.0',
        functions: [],
        behaviors: [],
        objects: [],
      },
    });
    expect(project.hasEventsFunctionsExtensionNamed('AgentExtension')).toBe(
      true
    );

    expect(service.listProjectExtensions()).toEqual({
      items: [
        expect.objectContaining({
          name: 'AgentExtension',
          functionCount: 0,
          behaviorCount: 0,
          objectCount: 0,
        }),
      ],
      total: 1,
    });
    expect(
      service.inspectProjectExtension({ name: 'AgentExtension' }).extension
    ).toMatchObject({
      name: 'AgentExtension',
      dependencies: [],
      sourceFiles: [],
    });

    const renamed = await service.renameProjectExtension({
      name: 'AgentExtension',
      newName: 'AgentExtensionRenamed',
    });
    expect(renamed).toMatchObject({
      renamed: true,
      oldName: 'AgentExtension',
      newName: 'AgentExtensionRenamed',
      extension: { name: 'AgentExtensionRenamed' },
    });
    expect(project.hasEventsFunctionsExtensionNamed('AgentExtension')).toBe(
      false
    );
    expect(
      project.hasEventsFunctionsExtensionNamed('AgentExtensionRenamed')
    ).toBe(true);

    const deleted = await service.deleteProjectExtension({
      name: 'AgentExtensionRenamed',
      allowReferenced: true,
    });
    expect(deleted).toMatchObject({
      deleted: true,
      name: 'AgentExtensionRenamed',
      allowedReferenced: true,
    });
    expect(
      project.hasEventsFunctionsExtensionNamed('AgentExtensionRenamed')
    ).toBe(false);

    expect(lifecycle.ensureLoadFinished).toHaveBeenCalledTimes(3);
    expect(
      lifecycle.reloadProjectEventsFunctionsExtensions
    ).toHaveBeenCalledTimes(3);
    expect(triggerUnsavedChanges).toHaveBeenCalledTimes(3);
    expect(forceUpdate).toHaveBeenCalledTimes(3);
  });

  it('authors free functions and refactors editable parameters without replacing the event sheet', async () => {
    await service.createProjectExtension({ name: 'Logic' });

    const created = await service.createEventsFunction({
      extensionName: 'Logic',
      name: 'ComputeScore',
      type: 'action',
      fullName: 'Compute score',
      description: 'Updates score state',
    });
    expect(created).toMatchObject({
      created: true,
      eventsFunction: {
        name: 'ComputeScore',
        type: 'action',
        fullName: 'Compute score',
        parameters: [],
      },
    });

    await service.createEventsFunctionParameter({
      extensionName: 'Logic',
      name: 'ComputeScore',
      parameterName: 'Amount',
      type: 'expression',
      description: 'Amount to add',
    });
    await service.createEventsFunctionParameter({
      extensionName: 'Logic',
      name: 'ComputeScore',
      parameterName: 'Label',
      type: 'string',
    });

    const renamedParameter = await service.renameEventsFunctionParameter({
      extensionName: 'Logic',
      name: 'ComputeScore',
      parameterName: 'Amount',
      newName: 'Delta',
    });
    expect(renamedParameter).toMatchObject({
      renamed: true,
      oldName: 'Amount',
      newName: 'Delta',
      parameter: { name: 'Delta', type: 'expression' },
    });

    const updatedParameter = await service.updateEventsFunctionParameter({
      extensionName: 'Logic',
      name: 'ComputeScore',
      parameterName: 'Delta',
      optional: true,
      defaultValue: '1',
      longDescription: 'Signed score delta',
    });
    expect(updatedParameter.parameter).toMatchObject({
      name: 'Delta',
      optional: true,
      defaultValue: '1',
      longDescription: 'Signed score delta',
    });

    await service.moveEventsFunctionParameter({
      extensionName: 'Logic',
      name: 'ComputeScore',
      oldIndex: 1,
      newIndex: 0,
    });
    expect(
      service
        .inspectEventsFunction({
          extensionName: 'Logic',
          name: 'ComputeScore',
        })
        .eventsFunction.parameters.map(parameter => parameter.name)
    ).toEqual(['Label', 'Delta']);

    await service.deleteEventsFunctionParameter({
      extensionName: 'Logic',
      name: 'ComputeScore',
      parameterName: 'Label',
    });
    const renamedFunction = await service.renameEventsFunction({
      extensionName: 'Logic',
      name: 'ComputeScore',
      newName: 'ApplyScore',
    });
    expect(renamedFunction).toMatchObject({
      renamed: true,
      oldName: 'ComputeScore',
      newName: 'ApplyScore',
    });

    await expect(
      service.deleteEventsFunction({
        extensionName: 'Logic',
        name: 'ApplyScore',
      })
    ).rejects.toMatchObject({
      code: 'events_function_delete_requires_reference_opt_in',
    });
    await expect(
      service.deleteEventsFunction({
        extensionName: 'Logic',
        name: 'ApplyScore',
        allowReferenced: true,
      })
    ).resolves.toMatchObject({ deleted: true, name: 'ApplyScore' });
  });

  it('authors events-based behaviors, refactors their names and protects required method parameters', async () => {
    await service.createProjectExtension({ name: 'BehaviorLogic' });
    const behaviorCreated = await service.createEventsBasedBehavior({
      extensionName: 'BehaviorLogic',
      name: 'Mover',
      fullName: 'Mover behavior',
      description: 'Moves an object',
      objectType: '',
    });
    expect(behaviorCreated).toMatchObject({
      created: true,
      behavior: {
        name: 'Mover',
        fullName: 'Mover behavior',
        description: 'Moves an object',
      },
    });
    expect(
      service.listEventsBasedBehaviors({ extensionName: 'BehaviorLogic' })
    ).toMatchObject({
      total: 1,
      items: [expect.objectContaining({ name: 'Mover' })],
    });

    await service.updateEventsBasedBehavior({
      extensionName: 'BehaviorLogic',
      name: 'Mover',
      description: 'Moves an object safely',
      private: true,
    });
    const renamedBehavior = await service.renameEventsBasedBehavior({
      extensionName: 'BehaviorLogic',
      name: 'Mover',
      newName: 'Mover2',
    });
    expect(renamedBehavior).toMatchObject({
      renamed: true,
      oldName: 'Mover',
      newName: 'Mover2',
      behavior: { name: 'Mover2', private: true },
    });

    const created = await service.createEventsFunction({
      extensionName: 'BehaviorLogic',
      ownerKind: 'behavior',
      ownerName: 'Mover2',
      name: 'DoMove',
      type: 'action',
    });
    expect(created.eventsFunction.parameters.length).toBeGreaterThanOrEqual(2);
    expect(
      created.eventsFunction.parameters.slice(0, 2).map(item => item.name)
    ).toEqual(expect.arrayContaining([expect.any(String), expect.any(String)]));

    await expect(
      service.deleteEventsFunctionParameter({
        extensionName: 'BehaviorLogic',
        ownerKind: 'behavior',
        ownerName: 'Mover2',
        name: 'DoMove',
        parameterName: created.eventsFunction.parameters[0].name,
      })
    ).rejects.toMatchObject({ code: 'events_function_parameter_required' });

    await expect(
      service.deleteEventsBasedBehavior({
        extensionName: 'BehaviorLogic',
        name: 'Mover2',
      })
    ).rejects.toMatchObject({
      code: 'events_based_behavior_delete_requires_reference_opt_in',
    });
    await expect(
      service.deleteEventsBasedBehavior({
        extensionName: 'BehaviorLogic',
        name: 'Mover2',
        allowReferenced: true,
      })
    ).resolves.toMatchObject({ deleted: true, name: 'Mover2' });
  });

  it('authors custom objects and named variants while preserving native object methods', async () => {
    await service.createProjectExtension({ name: 'ObjectLogic' });

    const createdObject = await service.createEventsBasedObject({
      extensionName: 'ObjectLogic',
      name: 'Panel',
      fullName: 'Panel object',
      renderedIn3D: true,
      animatable: true,
      textContainer: true,
      innerAreaFollowingParentSize: true,
      defaultName: 'PanelInstance',
    });
    expect(createdObject).toMatchObject({
      created: true,
      object: {
        name: 'Panel',
        fullName: 'Panel object',
        renderedIn3D: true,
        animatable: true,
        textContainer: true,
        innerAreaFollowingParentSize: true,
        defaultName: 'PanelInstance',
        variants: [],
      },
    });

    const createdMethod = await service.createEventsFunction({
      extensionName: 'ObjectLogic',
      ownerKind: 'object',
      ownerName: 'Panel',
      name: 'Refresh',
      type: 'action',
    });
    expect(
      createdMethod.eventsFunction.parameters.length
    ).toBeGreaterThanOrEqual(1);

    await service.updateEventsBasedObject({
      extensionName: 'ObjectLogic',
      name: 'Panel',
      description: 'Updated panel',
      private: true,
      renderedIn3D: false,
    });

    const defaultAndNamed = service.listEventsBasedObjectVariants({
      extensionName: 'ObjectLogic',
      name: 'Panel',
    });
    expect(defaultAndNamed).toMatchObject({
      defaultVariant: { name: '' },
      items: [],
      total: 0,
    });

    await service.createEventsBasedObjectVariant({
      extensionName: 'ObjectLogic',
      name: 'Panel',
      variantName: 'Compact',
      area: { minX: 1, minY: 2, maxX: 31, maxY: 42 },
    });
    await service.createEventsBasedObjectVariant({
      extensionName: 'ObjectLogic',
      name: 'Panel',
      variantName: 'Wide',
      area: { minX: 5, maxX: 100 },
    });
    await service.updateEventsBasedObjectVariant({
      extensionName: 'ObjectLogic',
      name: 'Panel',
      variantName: 'Compact',
      assetStoreAssetId: 'asset-1',
      assetStoreOriginalName: 'Original Compact',
      area: { minZ: 3, maxZ: 9 },
    });
    expect(
      service.inspectEventsBasedObjectVariant({
        extensionName: 'ObjectLogic',
        name: 'Panel',
        variantName: 'Compact',
      }).variant
    ).toMatchObject({
      name: 'Compact',
      assetStoreAssetId: 'asset-1',
      assetStoreOriginalName: 'Original Compact',
      area: { minX: 1, minY: 2, minZ: 3, maxX: 31, maxY: 42, maxZ: 9 },
    });

    await service.moveEventsBasedObjectVariant({
      extensionName: 'ObjectLogic',
      name: 'Panel',
      oldIndex: 1,
      newIndex: 0,
    });
    expect(
      service
        .listEventsBasedObjectVariants({
          extensionName: 'ObjectLogic',
          name: 'Panel',
        })
        .items.map(variant => variant.name)
    ).toEqual(['Wide', 'Compact']);

    await expect(
      service.renameEventsBasedObjectVariant({
        extensionName: 'ObjectLogic',
        name: 'Panel',
        variantName: 'Compact',
        newName: 'Small',
      })
    ).rejects.toMatchObject({
      code: 'events_based_object_variant_rename_requires_reference_opt_in',
    });
    await service.renameEventsBasedObjectVariant({
      extensionName: 'ObjectLogic',
      name: 'Panel',
      variantName: 'Compact',
      newName: 'Small',
      allowReferenced: true,
    });
    expect(
      service.inspectEventsBasedObjectVariant({
        extensionName: 'ObjectLogic',
        name: 'Panel',
        variantName: 'Small',
      }).variant.name
    ).toBe('Small');

    await expect(
      service.deleteEventsBasedObjectVariant({
        extensionName: 'ObjectLogic',
        name: 'Panel',
        variantName: 'Wide',
      })
    ).rejects.toMatchObject({
      code: 'events_based_object_variant_delete_requires_reference_opt_in',
    });
    await service.deleteEventsBasedObjectVariant({
      extensionName: 'ObjectLogic',
      name: 'Panel',
      variantName: 'Wide',
      allowReferenced: true,
    });

    const renamedObject = await service.renameEventsBasedObject({
      extensionName: 'ObjectLogic',
      name: 'Panel',
      newName: 'PanelObject',
    });
    expect(renamedObject).toMatchObject({
      renamed: true,
      oldName: 'Panel',
      newName: 'PanelObject',
      object: {
        name: 'PanelObject',
        description: 'Updated panel',
        private: true,
      },
    });
    expect(
      service
        .listEventsFunctions({
          extensionName: 'ObjectLogic',
          ownerKind: 'object',
          ownerName: 'PanelObject',
        })
        .items.map(eventsFunction => eventsFunction.name)
    ).toContain('Refresh');

    await expect(
      service.deleteEventsBasedObject({
        extensionName: 'ObjectLogic',
        name: 'PanelObject',
      })
    ).resolves.toMatchObject({ deleted: true, name: 'PanelObject' });
  });

  it('rejects unsafe names and collisions deterministically', async () => {
    await expect(
      service.createProjectExtension({ name: 'not safe name' })
    ).rejects.toMatchObject({
      code: 'invalid_extension_name',
      details: expect.objectContaining({ safeSuggestion: expect.any(String) }),
    });

    await service.createProjectExtension({ name: 'UniqueExtension' });
    await expect(
      service.createProjectExtension({ name: 'UniqueExtension' })
    ).rejects.toMatchObject({ code: 'project_extension_name_taken' });
  });

  it('surfaces a mutation-applied reload failure with rollback guidance', async () => {
    lifecycle.reloadProjectEventsFunctionsExtensions.mockRejectedValueOnce(
      new Error('code generation failed')
    );

    await expect(
      service.createProjectExtension({ name: 'BrokenReload' })
    ).rejects.toMatchObject({
      code: 'extension_reload_failed',
      details: { operation: 'create', mutationApplied: true },
      recovery: expect.stringContaining('checkpoint'),
    });
    expect(project.hasEventsFunctionsExtensionNamed('BrokenReload')).toBe(true);
  });
});
