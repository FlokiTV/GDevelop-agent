// @flow
import { AgentError } from './AgentError';
import { CommandRegistry, makeCommandMetadata } from './CommandRegistry';

const makeDescriptor = (name, overrides = {}) => ({
  name,
  description: `Description for ${name}`,
  inputSchema: { type: 'object', properties: {} },
  metadata: makeCommandMetadata(),
  execute: () => ({ ok: true }),
  ...overrides,
});

describe('CommandRegistry', () => {
  it('lists commands deterministically and searches names/descriptions', () => {
    const registry = new CommandRegistry([
      makeDescriptor('scene.inspect'),
      makeDescriptor('project.status'),
      makeDescriptor('events.read', { description: 'Read scene logic' }),
    ]);

    expect(registry.list().map(command => command.name)).toEqual([
      'events.read',
      'project.status',
      'scene.inspect',
    ]);
    expect(registry.list({ query: 'scene' }).map(command => command.name)).toEqual([
      'events.read',
      'scene.inspect',
    ]);
    expect(registry.describe('project.status').name).toBe('project.status');
  });

  it('rejects duplicate, invalid and contradictory descriptors', () => {
    const registry = new CommandRegistry([makeDescriptor('project.status')]);

    expect(() => registry.register(makeDescriptor('project.status'))).toThrow(
      expect.objectContaining({ code: 'duplicate_command' })
    );
    expect(() => registry.register(makeDescriptor('invalid'))).toThrow(
      expect.objectContaining({ code: 'invalid_command_name' })
    );
    expect(() =>
      registry.register(
        makeDescriptor('project.mutate', {
          metadata: makeCommandMetadata({
            readOnly: true,
            modifiesProject: true,
          }),
        })
      )
    ).toThrow(expect.objectContaining({ code: 'inconsistent_command_metadata' }));
  });

  it('requires explicit boolean command metadata', () => {
    expect(() =>
      new CommandRegistry([
        makeDescriptor('project.status', {
          metadata: ({ readOnly: true }: any),
        }),
      ])
    ).toThrow(expect.objectContaining({ code: 'invalid_command_metadata' }));
  });

  it('validates optional cache metadata centrally', () => {
    expect(
      new CommandRegistry([
        makeDescriptor('agent.commands.list', {
          metadata: makeCommandMetadata({
            cacheScope: 'process',
            ttlMs: 60000,
          }),
        }),
      ]).describe('agent.commands.list').metadata
    ).toMatchObject({ cacheScope: 'process', ttlMs: 60000 });

    expect(() =>
      new CommandRegistry([
        makeDescriptor('agent.commands.bad-cache', {
          metadata: makeCommandMetadata({ cacheScope: ('global': any) }),
        }),
      ])
    ).toThrow(expect.objectContaining({ code: 'invalid_command_cache_scope' }));

    expect(() =>
      new CommandRegistry([
        makeDescriptor('agent.commands.bad-ttl', {
          metadata: makeCommandMetadata({ ttlMs: -1 }),
        }),
      ])
    ).toThrow(expect.objectContaining({ code: 'invalid_command_ttl' }));
  });

  it('uses structured AgentError for missing commands', () => {
    const registry = new CommandRegistry();
    try {
      registry.get('scene.inspect');
      throw new Error('expected error');
    } catch (error) {
      expect(error).toBeInstanceOf(AgentError);
      expect(error.code).toBe('command_not_found');
      expect(error.details).toEqual({ name: 'scene.inspect' });
    }
  });
});
