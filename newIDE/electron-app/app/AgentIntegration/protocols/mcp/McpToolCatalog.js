const { fromJsonSchema } = require('@modelcontextprotocol/server');

const MCP_META_PREFIX = 'gdevelop/';

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
  withRevisionPrecondition,
  descriptorToToolRegistration,
  descriptorsToToolRegistrations,
};
