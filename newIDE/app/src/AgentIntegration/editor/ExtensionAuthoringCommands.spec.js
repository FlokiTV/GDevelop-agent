// @flow
import { createExtensionAuthoringCommandDescriptors } from './ExtensionAuthoringCommands';

describe('AgentIntegration ExtensionAuthoringCommands', () => {
  it('projects extension/function/parameter authoring with strict schemas and conservative metadata', async () => {
    const service = {
      listProjectExtensions: jest.fn(() => ({ items: [], total: 0 })),
      inspectProjectExtension: jest.fn(input => ({ extension: input })),
      createProjectExtension: jest.fn(input =>
        Promise.resolve({ created: input })
      ),
      renameProjectExtension: jest.fn(input =>
        Promise.resolve({ renamed: input })
      ),
      deleteProjectExtension: jest.fn(input =>
        Promise.resolve({ deleted: input })
      ),
      listEventsBasedBehaviors: jest.fn(input => ({ items: [], owner: input })),
      inspectEventsBasedBehavior: jest.fn(input => ({ behavior: input })),
      createEventsBasedBehavior: jest.fn(input =>
        Promise.resolve({ created: input })
      ),
      updateEventsBasedBehavior: jest.fn(input =>
        Promise.resolve({ updated: input })
      ),
      renameEventsBasedBehavior: jest.fn(input =>
        Promise.resolve({ renamed: input })
      ),
      deleteEventsBasedBehavior: jest.fn(input =>
        Promise.resolve({ deleted: input })
      ),
      listEventsBasedObjects: jest.fn(input => ({ items: [], owner: input })),
      inspectEventsBasedObject: jest.fn(input => ({ object: input })),
      createEventsBasedObject: jest.fn(input =>
        Promise.resolve({ created: input })
      ),
      updateEventsBasedObject: jest.fn(input =>
        Promise.resolve({ updated: input })
      ),
      renameEventsBasedObject: jest.fn(input =>
        Promise.resolve({ renamed: input })
      ),
      deleteEventsBasedObject: jest.fn(input =>
        Promise.resolve({ deleted: input })
      ),
      listEventsBasedObjectVariants: jest.fn(input => ({
        items: [],
        owner: input,
      })),
      inspectEventsBasedObjectVariant: jest.fn(input => ({ variant: input })),
      createEventsBasedObjectVariant: jest.fn(input =>
        Promise.resolve({ created: input })
      ),
      updateEventsBasedObjectVariant: jest.fn(input =>
        Promise.resolve({ updated: input })
      ),
      renameEventsBasedObjectVariant: jest.fn(input =>
        Promise.resolve({ renamed: input })
      ),
      deleteEventsBasedObjectVariant: jest.fn(input =>
        Promise.resolve({ deleted: input })
      ),
      moveEventsBasedObjectVariant: jest.fn(input =>
        Promise.resolve({ moved: input })
      ),
      listEventsFunctions: jest.fn(input => ({ items: [], owner: input })),
      inspectEventsFunction: jest.fn(input => ({ eventsFunction: input })),
      createEventsFunction: jest.fn(input =>
        Promise.resolve({ created: input })
      ),
      updateEventsFunction: jest.fn(input =>
        Promise.resolve({ updated: input })
      ),
      renameEventsFunction: jest.fn(input =>
        Promise.resolve({ renamed: input })
      ),
      deleteEventsFunction: jest.fn(input =>
        Promise.resolve({ deleted: input })
      ),
      createEventsFunctionParameter: jest.fn(input =>
        Promise.resolve({ created: input })
      ),
      updateEventsFunctionParameter: jest.fn(input =>
        Promise.resolve({ updated: input })
      ),
      renameEventsFunctionParameter: jest.fn(input =>
        Promise.resolve({ renamed: input })
      ),
      deleteEventsFunctionParameter: jest.fn(input =>
        Promise.resolve({ deleted: input })
      ),
      moveEventsFunctionParameter: jest.fn(input =>
        Promise.resolve({ moved: input })
      ),
    };
    const descriptors = createExtensionAuthoringCommandDescriptors({
      extensionAuthoringService: service,
    });

    expect(descriptors.map(descriptor => descriptor.name)).toEqual([
      'extensions.project.list',
      'extensions.project.inspect',
      'extensions.project.create',
      'extensions.project.rename',
      'extensions.project.delete',
      'extensions.behaviors.list',
      'extensions.behaviors.inspect',
      'extensions.behaviors.create',
      'extensions.behaviors.update',
      'extensions.behaviors.rename',
      'extensions.behaviors.delete',
      'extensions.objects.list',
      'extensions.objects.inspect',
      'extensions.objects.create',
      'extensions.objects.update',
      'extensions.objects.rename',
      'extensions.objects.delete',
      'extensions.objects.variants.list',
      'extensions.objects.variants.inspect',
      'extensions.objects.variants.create',
      'extensions.objects.variants.update',
      'extensions.objects.variants.rename',
      'extensions.objects.variants.delete',
      'extensions.objects.variants.move',
      'extensions.functions.list',
      'extensions.functions.inspect',
      'extensions.functions.create',
      'extensions.functions.update',
      'extensions.functions.rename',
      'extensions.functions.delete',
      'extensions.functions.parameters.create',
      'extensions.functions.parameters.update',
      'extensions.functions.parameters.rename',
      'extensions.functions.parameters.delete',
      'extensions.functions.parameters.move',
    ]);

    const list = descriptors[0];
    expect(list.metadata).toMatchObject({
      readOnly: true,
      requiresProject: true,
      modifiesProject: false,
    });
    expect(list.inputSchema.additionalProperties).toBe(false);

    const projectCreate = descriptors[2];
    expect(projectCreate.metadata).toMatchObject({
      readOnly: false,
      destructive: false,
      longRunning: true,
      requiresProject: true,
      modifiesProject: true,
    });
    await expect(
      projectCreate.execute({ input: { name: 'X' } })
    ).resolves.toEqual({ created: { name: 'X' } });

    const projectDelete = descriptors[4];
    expect(projectDelete.metadata).toMatchObject({
      readOnly: false,
      destructive: true,
      modifiesProject: true,
    });
    expect(projectDelete.inputSchema.properties.allowReferenced).toMatchObject({
      type: 'boolean',
      default: false,
    });

    const functionCreate = descriptors.find(
      descriptor => descriptor.name === 'extensions.functions.create'
    );
    expect(functionCreate).toBeTruthy();
    expect(functionCreate.inputSchema.additionalProperties).toBe(false);
    expect(functionCreate.inputSchema.properties.type.enum).toEqual([
      'action',
      'condition',
      'expression',
      'expression-and-condition',
      'action-with-operator',
    ]);

    const parameterDelete = descriptors.find(
      descriptor => descriptor.name === 'extensions.functions.parameters.delete'
    );
    expect(parameterDelete).toBeTruthy();
    expect(parameterDelete.metadata).toMatchObject({
      readOnly: false,
      destructive: true,
      modifiesProject: true,
    });
  });
});
