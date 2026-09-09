// @flow
import { createMetadataDiscoveryCommandDescriptors } from './MetadataDiscoveryCommands';
import { CommandRegistry } from '../core/CommandRegistry';

describe('AgentIntegration MetadataDiscoveryCommands', () => {
  it('registers the complete CAP-01/02 read-only command surface with strict schemas', async () => {
    const calls = [];
    const metadataDiscoveryService: any = {
      searchInstructions: input => {
        calls.push(['searchInstructions', input]);
        return { items: [], total: 0 };
      },
      describeInstruction: input => {
        calls.push(['describeInstruction', input]);
        return { item: { id: input.id } };
      },
      listObjectTypes: input => {
        calls.push(['listObjectTypes', input]);
        return { items: [], total: 0 };
      },
      describeObjectType: input => {
        calls.push(['describeObjectType', input]);
        return { item: { type: input.type } };
      },
      listBehaviorTypes: input => {
        calls.push(['listBehaviorTypes', input]);
        return { items: [], total: 0 };
      },
      describeBehaviorType: input => {
        calls.push(['describeBehaviorType', input]);
        return { item: { type: input.type } };
      },
      listEffectTypes: input => {
        calls.push(['listEffectTypes', input]);
        return { items: [], total: 0 };
      },
      describeEffectType: input => {
        calls.push(['describeEffectType', input]);
        return { item: { type: input.type } };
      },
    };

    const descriptors = createMetadataDiscoveryCommandDescriptors({
      metadataDiscoveryService,
    });
    const registry = new CommandRegistry(descriptors);
    expect(registry.list().map(descriptor => descriptor.name)).toEqual([
      'editor.types.behaviors.describe',
      'editor.types.behaviors.list',
      'editor.types.effects.describe',
      'editor.types.effects.list',
      'editor.types.objects.describe',
      'editor.types.objects.list',
      'events.instructions.describe',
      'events.instructions.search',
    ]);

    registry.list().forEach(descriptor => {
      expect(descriptor.metadata).toMatchObject({
        readOnly: true,
        destructive: false,
        idempotent: true,
        longRunning: false,
        requiresProject: true,
        modifiesProject: false,
        cacheScope: 'project-revision',
      });
      expect(descriptor.inputSchema.additionalProperties).toBe(false);
    });

    const searchDescriptor = registry.get('events.instructions.search');
    expect(searchDescriptor.inputSchema.properties.limit.maximum).toBe(100);
    expect(searchDescriptor.inputSchema.properties.kind.enum).toEqual([
      'any',
      'action',
      'condition',
      'expression',
    ]);
    expect(
      registry.get('editor.types.behaviors.list').inputSchema.properties
        .objectType
    ).toBeTruthy();

    await registry.get('events.instructions.search').execute({
      environment: {},
      input: { query: 'platform', limit: 5 },
      requestContext: {},
      registry,
    });
    await registry.get('editor.types.effects.describe').execute({
      environment: {},
      input: { type: 'SomeEffect' },
      requestContext: {},
      registry,
    });

    expect(calls).toEqual([
      ['searchInstructions', { query: 'platform', limit: 5 }],
      ['describeEffectType', { type: 'SomeEffect' }],
    ]);
  });
});
