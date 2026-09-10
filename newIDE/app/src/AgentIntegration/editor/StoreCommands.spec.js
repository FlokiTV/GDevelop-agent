// @flow
import { createStoreCommandDescriptors } from './StoreCommands';
import { CommandRegistry } from '../core/CommandRegistry';

describe('AgentIntegration StoreCommands', () => {
  it('registers the CAP-07 store surface with bounded schemas and legacy resource kinds', async () => {
    const calls = [];
    const storeService: any = {
      searchObjects: (input, signal) =>
        calls.push(['searchObjects', input, signal]),
      inspectObject: (input, signal) =>
        calls.push(['inspectObject', input, signal]),
      importObject: (input, signal) =>
        calls.push(['importObject', input, signal]),
      searchResources: (input, signal) =>
        calls.push(['searchResources', input, signal]),
      inspectResource: (input, signal) =>
        calls.push(['inspectResource', input, signal]),
      importResource: (input, signal) =>
        calls.push(['importResource', input, signal]),
    };
    const registry = new CommandRegistry(
      createStoreCommandDescriptors({ storeService })
    );

    expect(registry.list().map(descriptor => descriptor.name)).toEqual([
      'store.objects.import',
      'store.objects.inspect',
      'store.objects.search',
      'store.resources.import',
      'store.resources.inspect',
      'store.resources.search',
    ]);

    const resourceSearch = registry.get('store.resources.search');
    expect(resourceSearch.inputSchema.properties.kind).toEqual({
      type: 'string',
      minLength: 1,
      maxLength: 100,
    });
    expect(resourceSearch.metadata).toMatchObject({
      readOnly: true,
      modifiesProject: false,
      longRunning: true,
      requiresProject: false,
    });
    expect(registry.get('store.resources.import').metadata).toMatchObject({
      readOnly: false,
      modifiesProject: true,
      longRunning: true,
      requiresProject: true,
    });

    const signal = new AbortController().signal;
    await resourceSearch.execute({
      environment: {},
      input: { query: 'music', kind: 'image' },
      requestContext: { signal },
      registry,
    });
    expect(calls).toEqual([
      ['searchResources', { query: 'music', kind: 'image' }, signal],
    ]);
  });
});
