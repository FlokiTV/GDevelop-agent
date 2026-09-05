const { fromJsonSchema } = require('@modelcontextprotocol/server');

const MCP_META_PREFIX = 'gdevelop/';

const withCommandResultEnvelope = outputSchema => {
  if (!outputSchema || typeof outputSchema !== 'object') return null;
  return {
    type: 'object',
    additionalProperties: false,
    required: ['command', 'data', 'meta'],
    properties: {
      command: { type: 'string' },
      data: outputSchema,
      meta: {
        type: 'object',
        additionalProperties: true,
        required: ['readOnly', 'modifiesProject'],
        properties: {
          traceId: { type: ['string', 'null'] },
          readOnly: { type: 'boolean' },
          modifiesProject: { type: 'boolean' },
          projectRevision: { type: ['integer', 'null'], minimum: 0 },
        },
      },
    },
  };
};

const withRevisionPrecondition = (inputSchema, modifiesProject) => {
  const schema = inputSchema || {
    type: 'object',
    additionalProperties: false,
    properties: {},
  };
  if (!modifiesProject || schema.type !== 'object') return schema;
  return {
    ...schema,
    properties: {
      ...(schema.properties || {}),
      expectedRevision: {
        type: 'integer',
        minimum: 0,
        description:
          'Optional optimistic concurrency precondition. The command fails with revision_conflict if the open project changed since this revision was read.',
      },
      idempotencyKey: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
        description:
          'Optional retry key. Repeating the same mutating command with the same key and input returns the original result without applying the mutation again.',
      },
    },
  };
};

const descriptorToToolRegistration = descriptor => {
  const metadata = descriptor.metadata || {};
  const modifiesProject = !!metadata.modifiesProject;
  return {
    name: descriptor.name,
    config: {
      description: descriptor.description,
      inputSchema: fromJsonSchema(
        withRevisionPrecondition(descriptor.inputSchema, modifiesProject)
      ),
      ...(descriptor.outputSchema
        ? {
            outputSchema: fromJsonSchema(
              withCommandResultEnvelope(descriptor.outputSchema)
            ),
          }
        : {}),
      annotations: {
        readOnlyHint: !!metadata.readOnly,
        destructiveHint: !!metadata.destructive,
        idempotentHint: !!metadata.idempotent,
        openWorldHint: false,
      },
      _meta: {
        [`${MCP_META_PREFIX}command`]: descriptor.name,
        [`${MCP_META_PREFIX}requiresProject`]: !!metadata.requiresProject,
        [`${MCP_META_PREFIX}modifiesProject`]: modifiesProject,
        [`${MCP_META_PREFIX}longRunning`]: !!metadata.longRunning,
        ...(Number.isFinite(metadata.defaultTimeoutMs)
          ? { [`${MCP_META_PREFIX}defaultTimeoutMs`]: metadata.defaultTimeoutMs }
          : {}),
        ...(typeof metadata.cacheScope === 'string'
          ? { [`${MCP_META_PREFIX}cacheScope`]: metadata.cacheScope }
          : {}),
        ...(Number.isFinite(metadata.ttlMs)
          ? { [`${MCP_META_PREFIX}ttlMs`]: metadata.ttlMs }
          : {}),
        ...(descriptor.deprecated
          ? { [`${MCP_META_PREFIX}deprecated`]: descriptor.deprecated }
          : {}),
      },
    },
    modifiesProject,
    timeoutMs: Number.isFinite(metadata.defaultTimeoutMs)
      ? metadata.defaultTimeoutMs
      : undefined,
  };
};

const descriptorsToToolRegistrations = descriptors =>
  (Array.isArray(descriptors) ? descriptors : [])
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(descriptorToToolRegistration);

module.exports = {
  MCP_META_PREFIX,
  withCommandResultEnvelope,
  withRevisionPrecondition,
  descriptorToToolRegistration,
  descriptorsToToolRegistrations,
};
