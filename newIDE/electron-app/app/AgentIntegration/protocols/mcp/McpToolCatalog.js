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
          traceId: {
            anyOf: [{ type: 'string' }, { type: 'null' }],
          },
          readOnly: { type: 'boolean' },
          modifiesProject: { type: 'boolean' },
          projectRevision: {
            anyOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }],
          },
          semanticRevisions: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['scope', 'revision'],
              properties: {
                scope: { type: 'string' },
                revision: { type: 'integer', minimum: 0 },
              },
            },
          },
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
      expectedSemanticRevisions: {
        type: 'object',
        additionalProperties: { type: 'integer', minimum: 0 },
        description:
          'Optional granular optimistic concurrency preconditions keyed by semantic scope. Project-wide expectedRevision remains the safety net.',
      },
      semanticLeaseOwner: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
        description:
          'Optional owner id used to access semantic scopes currently leased by this client.',
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

const isTargetAwareDescriptor = descriptor => {
  const metadata = (descriptor && descriptor.metadata) || {};
  const name =
    descriptor && typeof descriptor.name === 'string' ? descriptor.name : '';
  return (
    !!metadata.requiresProject ||
    !!metadata.modifiesProject ||
    /^(project\.|events\.|editor\.|preview\.|runtime\.|diagnostics\.|validation\.|resources\.|assets\.|target\.)/.test(
      name
    ) ||
    name === 'desktop.window.capture'
  );
};

const withTargetPreconditions = (inputSchema, descriptor) => {
  const schema = inputSchema || {
    type: 'object',
    additionalProperties: false,
    properties: {},
  };
  if (!isTargetAwareDescriptor(descriptor) || schema.type !== 'object') {
    return schema;
  }
  return {
    ...schema,
    properties: {
      ...(schema.properties || {}),
      expectedProjectId: {
        type: 'string',
        minLength: 1,
        maxLength: 500,
        description:
          'Optional active-project identity precondition. Use target.status.project.projectId. Mismatch fails with target_mismatch.',
      },
      expectedProjectPath: {
        type: 'string',
        minLength: 1,
        maxLength: 4096,
        description:
          'Optional normalized active-project path precondition. Mismatch fails with target_mismatch.',
      },
      expectedEditorSelector: {
        type: 'string',
        minLength: 1,
        maxLength: 500,
        description:
          'Optional active editor-tab selector from target.status.editor.activeTargets. Mismatch fails with target_mismatch.',
      },
      expectedSceneId: {
        type: 'string',
        minLength: 1,
        maxLength: 500,
        description:
          'Optional active scene identity from target.status.editor.activeScene.sceneId. Mismatch fails with target_mismatch.',
      },
      expectedSceneSelector: {
        type: 'string',
        minLength: 1,
        maxLength: 500,
        description:
          'Optional active scene selector from target.status.editor.activeScene.selector. Mismatch fails with target_mismatch.',
      },
      expectedPreviewTarget: {
        anyOf: [
          { type: 'string', minLength: 1, maxLength: 500 },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              targetId: { type: 'string', minLength: 1, maxLength: 500 },
              windowId: { type: 'integer', minimum: 1 },
              debuggerId: { type: 'string', minLength: 1, maxLength: 500 },
              sceneSelector: { type: 'string', minLength: 1, maxLength: 500 },
            },
          },
        ],
        description:
          'Optional preview identity precondition. Use one target from target.status.preview.targets. Mismatch fails with target_mismatch.',
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
        withTargetPreconditions(
          withRevisionPrecondition(descriptor.inputSchema, modifiesProject),
          descriptor
        )
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
          ? {
              [`${MCP_META_PREFIX}defaultTimeoutMs`]: metadata.defaultTimeoutMs,
            }
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
    longRunning: !!metadata.longRunning,
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
  withTargetPreconditions,
  isTargetAwareDescriptor,
  descriptorToToolRegistration,
  descriptorsToToolRegistrations,
};
