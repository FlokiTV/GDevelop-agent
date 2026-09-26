// @flow
import { AgentError } from './AgentError';
import { makeCommandMetadata, type CommandDescriptor } from './CommandRegistry';

const EMPTY_OBJECT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {},
  examples: [{}],
};

const DISCOVERY_METADATA = makeCommandMetadata({
  cacheScope: 'process',
  ttlMs: 60000,
});

const COMMAND_SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  required: ['name', 'description', 'inputSchema', 'metadata'],
  properties: {
    name: { type: 'string' },
    description: { type: 'string' },
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    metadata: { type: 'object' },
  },
};

const getRequestIdentity = requestContext =>
  requestContext &&
  requestContext.identity &&
  typeof requestContext.identity === 'object'
    ? requestContext.identity
    : null;

const resolveLeaseOwner = (input, requestContext) => {
  const identity = getRequestIdentity(requestContext);
  const identityOwner =
    identity && typeof identity.ownerKey === 'string' && identity.ownerKey
      ? identity.ownerKey
      : null;
  if (identityOwner) return { owner: identityOwner, identity };
  if (input && typeof input.owner === 'string' && input.owner.trim()) {
    return { owner: input.owner.trim(), identity: null };
  }
  throw new AgentError({ code: 'invalid_lease_owner' });
};

const COMMANDS_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['commands'],
  properties: {
    commands: { type: 'array', items: COMMAND_SUMMARY_SCHEMA },
  },
};

export const createCoreCommandDescriptors = (): Array<CommandDescriptor> => [
  {
    name: 'agent.capabilities',
    description:
      'Return protocol-independent AgentIntegration capabilities and command metadata.',
    inputSchema: EMPTY_OBJECT_SCHEMA,
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['commandCount', 'commands'],
      properties: {
        commandCount: { type: 'integer', minimum: 0 },
        commands: { type: 'array', items: COMMAND_SUMMARY_SCHEMA },
      },
    },
    metadata: DISCOVERY_METADATA,
    execute: ({ registry }) => ({
      commandCount: registry.size,
      commands: registry.list(),
    }),
  },
  {
    name: 'agent.commands.list',
    description:
      'List registered AgentIntegration commands in deterministic order.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string' },
      },
      examples: [{ query: 'scene' }],
    },
    outputSchema: COMMANDS_OUTPUT_SCHEMA,
    metadata: DISCOVERY_METADATA,
    validateInput: input => {
      if (input.query !== undefined && typeof input.query !== 'string') {
        throw new AgentError({
          code: 'invalid_query',
          message: 'query must be a string.',
        });
      }
    },
    execute: ({ input, registry }) => ({
      commands: registry.list({ query: input.query }),
    }),
  },
  {
    name: 'agent.commands.describe',
    description: 'Describe one registered AgentIntegration command.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: {
        name: { type: 'string', minLength: 1 },
      },
      examples: [{ name: 'project.status' }],
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['command'],
      properties: { command: COMMAND_SUMMARY_SCHEMA },
    },
    metadata: DISCOVERY_METADATA,
    validateInput: input => {
      if (!input.name || typeof input.name !== 'string') {
        throw new AgentError({
          code: 'missing_command_name',
          message: 'name is required.',
        });
      }
    },
    execute: ({ input, registry }) => ({
      command: registry.describe(input.name),
    }),
  },
  {
    name: 'agent.concurrency.capabilities',
    description:
      'Describe granular semantic revision and bounded lease concurrency support.',
    inputSchema: EMPTY_OBJECT_SCHEMA,
    metadata: DISCOVERY_METADATA,
    execute: ({ environment }) => ({
      semanticRevisions: { supported: !!environment.semanticConcurrency },
      callerIdentity: {
        supported: true,
        source: 'mcp-request-headers',
        headers: [
          'X-GDevelop-Client-Id',
          'X-GDevelop-Agent-Id',
          'X-GDevelop-Session-Id',
          'X-GDevelop-Task-Id',
        ],
      },
      semanticLeases: {
        supported: !!environment.semanticConcurrency,
        processLocal: true,
        persisted: false,
        ownerBoundToCallerIdentity: true,
        explicitRenew: true,
        minTtlMs: 1000,
        maxTtlMs: 300000,
      },
      projectRevisionSafetyNet: true,
    }),
  },
  {
    name: 'agent.concurrency.status',
    description:
      'Read semantic scope revisions and active bounded leases for the live project.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        scopes: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
          maxItems: 100,
        },
      },
    },
    metadata: makeCommandMetadata({ requiresProject: true }),
    execute: ({ environment, input, requestContext }) => {
      const concurrency = environment.semanticConcurrency;
      if (!concurrency) return { supported: false, scopes: [], leases: [] };
      const scopes =
        Array.isArray(input.scopes) && input.scopes.length
          ? input.scopes
          : ['project'];
      return {
        supported: true,
        identity: getRequestIdentity(requestContext),
        scopes: concurrency.snapshot(scopes),
        leases: concurrency.listLeases(),
      };
    },
  },
  {
    name: 'agent.concurrency.lease.acquire',
    description:
      'Acquire a process-local bounded semantic lease for a project scope, owned by the current MCP agent/session identity.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['scope'],
      properties: {
        scope: { type: 'string', minLength: 1 },
        owner: {
          type: 'string',
          minLength: 1,
          description: 'Legacy direct-host fallback. MCP callers are bound to connection identity.',
        },
        ttlMs: {
          type: 'integer',
          minimum: 1000,
          maximum: 300000,
          default: 30000,
        },
      },
    },
    metadata: makeCommandMetadata({
      requiresProject: true,
      readOnly: false,
      idempotent: false,
    }),
    execute: ({ environment, input, requestContext }) => {
      const { owner, identity } = resolveLeaseOwner(input, requestContext);
      return {
        lease: environment.semanticConcurrency.acquireLease({
          ...input,
          owner,
          identity,
        }),
      };
    },
  },
  {
    name: 'agent.concurrency.lease.renew',
    description:
      'Renew a semantic lease owned by the current MCP agent/session identity.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['scope', 'leaseId'],
      properties: {
        scope: { type: 'string', minLength: 1 },
        leaseId: { type: 'string', minLength: 1 },
        owner: {
          type: 'string',
          minLength: 1,
          description: 'Legacy direct-host fallback. MCP callers are bound to connection identity.',
        },
        ttlMs: {
          type: 'integer',
          minimum: 1000,
          maximum: 300000,
          default: 30000,
        },
      },
    },
    metadata: makeCommandMetadata({
      requiresProject: true,
      readOnly: false,
      idempotent: false,
    }),
    execute: ({ environment, input, requestContext }) => {
      const { owner, identity } = resolveLeaseOwner(input, requestContext);
      return {
        lease: environment.semanticConcurrency.renewLease({
          ...input,
          owner,
          identity,
        }),
      };
    },
  },
  {
    name: 'agent.concurrency.lease.release',
    description: 'Release a semantic lease owned by the caller.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['scope', 'leaseId'],
      properties: {
        scope: { type: 'string', minLength: 1 },
        owner: {
          type: 'string',
          minLength: 1,
          description: 'Legacy direct-host fallback. MCP callers are bound to connection identity.',
        },
        leaseId: { type: 'string', minLength: 1 },
      },
    },
    metadata: makeCommandMetadata({
      requiresProject: true,
      readOnly: false,
      idempotent: true,
    }),
    execute: ({ environment, input, requestContext }) => {
      const { owner } = resolveLeaseOwner(input, requestContext);
      return {
        released: environment.semanticConcurrency.releaseLease({
          ...input,
          owner,
        }),
      };
    },
  },
  {
    name: 'project.status',
    description:
      'Return the status of the GDevelop editor and currently open project.',
    inputSchema: EMPTY_OBJECT_SCHEMA,
    outputSchema: {
      type: 'object',
      additionalProperties: true,
      required: ['projectOpen'],
      properties: {
        projectOpen: { type: 'boolean' },
        projectName: { type: ['string', 'null'] },
        projectUuid: { type: ['string', 'null'] },
        fileIdentifier: { type: ['string', 'null'] },
        hasUnsavedChanges: { type: 'boolean' },
        projectRevision: { type: ['integer', 'null'], minimum: 0 },
      },
    },
    metadata: makeCommandMetadata(),
    execute: ({ environment }) => {
      if (typeof environment.getProjectStatus === 'function') {
        return environment.getProjectStatus();
      }

      const project = environment.project || null;
      return {
        projectOpen: !!project,
        projectName:
          project && typeof project.getName === 'function'
            ? project.getName()
            : null,
        projectUuid:
          project && typeof project.getProjectUuid === 'function'
            ? project.getProjectUuid()
            : null,
        fileIdentifier: environment.fileIdentifier || null,
        hasUnsavedChanges: !!environment.hasUnsavedChanges,
      };
    },
  },
];
