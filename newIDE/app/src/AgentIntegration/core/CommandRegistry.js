// @flow
import { AgentError } from './AgentError';

export type CommandMetadata = {|
  readOnly: boolean,
  destructive: boolean,
  idempotent: boolean,
  longRunning: boolean,
  requiresProject: boolean,
  modifiesProject: boolean,
  defaultTimeoutMs?: number,
  cacheScope?: 'process' | 'project-revision' | 'request',
  ttlMs?: number,
|};

export type CommandExecutionContext = {|
  environment: any,
  input: { [string]: any },
  requestContext: { [string]: any },
  registry: any,
|};

export type CommandDescriptor = {|
  name: string,
  description: string,
  inputSchema: { [string]: any },
  metadata: CommandMetadata,
  validateInput?: (input: { [string]: any }) => void,
  execute: (context: CommandExecutionContext) => any | Promise<any>,
  deprecated?: {|
    since?: string,
    replacement?: string,
    removeAfter?: string,
  |},
|};

const COMMAND_NAME_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;
const METADATA_KEYS = [
  'readOnly',
  'destructive',
  'idempotent',
  'longRunning',
  'requiresProject',
  'modifiesProject',
];

const assertDescriptor = (descriptor: CommandDescriptor) => {
  if (!descriptor || typeof descriptor !== 'object') {
    throw new AgentError({ code: 'invalid_command_descriptor' });
  }
  if (
    typeof descriptor.name !== 'string' ||
    !COMMAND_NAME_PATTERN.test(descriptor.name)
  ) {
    throw new AgentError({
      code: 'invalid_command_name',
      details: { name: descriptor.name },
    });
  }
  if (!descriptor.description || typeof descriptor.description !== 'string') {
    throw new AgentError({
      code: 'missing_command_description',
      details: { name: descriptor.name },
    });
  }
  if (!descriptor.inputSchema || typeof descriptor.inputSchema !== 'object') {
    throw new AgentError({
      code: 'missing_command_input_schema',
      details: { name: descriptor.name },
    });
  }
  if (!descriptor.metadata || typeof descriptor.metadata !== 'object') {
    throw new AgentError({
      code: 'missing_command_metadata',
      details: { name: descriptor.name },
    });
  }
  for (const key of METADATA_KEYS) {
    if (typeof descriptor.metadata[key] !== 'boolean') {
      throw new AgentError({
        code: 'invalid_command_metadata',
        details: { name: descriptor.name, key },
      });
    }
  }
  if (
    descriptor.metadata.defaultTimeoutMs !== undefined &&
    (!Number.isFinite(descriptor.metadata.defaultTimeoutMs) ||
      descriptor.metadata.defaultTimeoutMs <= 0)
  ) {
    throw new AgentError({
      code: 'invalid_command_timeout',
      details: { name: descriptor.name },
    });
  }
  if (
    descriptor.metadata.cacheScope !== undefined &&
    !['process', 'project-revision', 'request'].includes(
      descriptor.metadata.cacheScope
    )
  ) {
    throw new AgentError({
      code: 'invalid_command_cache_scope',
      details: { name: descriptor.name },
    });
  }
  if (
    descriptor.metadata.ttlMs !== undefined &&
    (!Number.isFinite(descriptor.metadata.ttlMs) || descriptor.metadata.ttlMs < 0)
  ) {
    throw new AgentError({
      code: 'invalid_command_ttl',
      details: { name: descriptor.name },
    });
  }
  if (typeof descriptor.execute !== 'function') {
    throw new AgentError({
      code: 'missing_command_handler',
      details: { name: descriptor.name },
    });
  }
  if (descriptor.metadata.readOnly && descriptor.metadata.modifiesProject) {
    throw new AgentError({
      code: 'inconsistent_command_metadata',
      details: {
        name: descriptor.name,
        reason: 'read_only_command_cannot_modify_project',
      },
    });
  }
};

const publicDescriptor = (descriptor: CommandDescriptor) => ({
  name: descriptor.name,
  description: descriptor.description,
  inputSchema: descriptor.inputSchema,
  metadata: descriptor.metadata,
  ...(descriptor.deprecated ? { deprecated: descriptor.deprecated } : {}),
});

export class CommandRegistry {
  _commands: Map<string, CommandDescriptor>;

  constructor(descriptors?: Array<CommandDescriptor> = []) {
    this._commands = new Map();
    descriptors.forEach(descriptor => this.register(descriptor));
  }

  register(descriptor: CommandDescriptor) {
    assertDescriptor(descriptor);
    if (this._commands.has(descriptor.name)) {
      throw new AgentError({
        code: 'duplicate_command',
        details: { name: descriptor.name },
      });
    }
    this._commands.set(descriptor.name, descriptor);
    return this;
  }

  has(name: string): boolean {
    return this._commands.has(name);
  }

  get(name: string): CommandDescriptor {
    const descriptor = this._commands.get(name);
    if (!descriptor) {
      throw new AgentError({
        code: 'command_not_found',
        details: { name },
      });
    }
    return descriptor;
  }

  describe(name: string) {
    return publicDescriptor(this.get(name));
  }

  list({ query }: { query?: ?string } = {}) {
    const normalizedQuery =
      typeof query === 'string' && query.trim()
        ? query.trim().toLowerCase()
        : null;
    return Array.from(this._commands.values())
      .filter(descriptor => {
        if (!normalizedQuery) return true;
        return (
          descriptor.name.toLowerCase().includes(normalizedQuery) ||
          descriptor.description.toLowerCase().includes(normalizedQuery)
        );
      })
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(publicDescriptor);
  }

  get size(): number {
    return this._commands.size;
  }
}

export const makeCommandMetadata = (
  overrides?: $Shape<CommandMetadata> = {}
): CommandMetadata => ({
  readOnly: true,
  destructive: false,
  idempotent: true,
  longRunning: false,
  requiresProject: false,
  modifiesProject: false,
  ...overrides,
});
