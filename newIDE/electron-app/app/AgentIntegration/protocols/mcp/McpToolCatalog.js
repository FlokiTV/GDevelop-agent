const { fromJsonSchema } = require('@modelcontextprotocol/server');

const MCP_META_PREFIX = 'gdevelop/';

const descriptorToToolRegistration = descriptor => {
  const metadata = descriptor.metadata || {};
  return {
    name: descriptor.name,
    config: {
      description: descriptor.description,
      inputSchema: fromJsonSchema(descriptor.inputSchema || {
        type: 'object',
        additionalProperties: false,
        properties: {},
      }),
      annotations: {
        readOnlyHint: !!metadata.readOnly,
        destructiveHint: !!metadata.destructive,
        idempotentHint: !!metadata.idempotent,
        openWorldHint: false,
      },
      _meta: {
        [`${MCP_META_PREFIX}command`]: descriptor.name,
        [`${MCP_META_PREFIX}requiresProject`]: !!metadata.requiresProject,
        [`${MCP_META_PREFIX}modifiesProject`]: !!metadata.modifiesProject,
        [`${MCP_META_PREFIX}longRunning`]: !!metadata.longRunning,
        ...(Number.isFinite(metadata.defaultTimeoutMs)
          ? { [`${MCP_META_PREFIX}defaultTimeoutMs`]: metadata.defaultTimeoutMs }
          : {}),
        ...(descriptor.deprecated
          ? { [`${MCP_META_PREFIX}deprecated`]: descriptor.deprecated }
          : {}),
      },
    },
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
  descriptorToToolRegistration,
  descriptorsToToolRegistrations,
};
