const test = require('node:test');
const assert = require('node:assert/strict');
const {
  withCommandResultEnvelope,
  withRevisionPrecondition,
  withTargetPreconditions,
  descriptorToToolRegistration,
  descriptorsToToolRegistrations,
} = require('./McpToolCatalog');

const descriptor = (name, metadata = {}) => ({
  name,
  description: `Description for ${name}`,
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { value: { type: 'string' } },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['ok'],
    properties: { ok: { type: 'boolean' } },
  },
  metadata: {
    readOnly: true,
    destructive: false,
    idempotent: true,
    longRunning: false,
    requiresProject: false,
    modifiesProject: false,
    ...metadata,
  },
});

test('projects command metadata to MCP annotations without duplicating schemas', () => {
  const registration = descriptorToToolRegistration(
    descriptor('project.save', {
      readOnly: false,
      destructive: true,
      idempotent: false,
      requiresProject: true,
      modifiesProject: true,
      defaultTimeoutMs: 90000,
      cacheScope: 'process',
      ttlMs: 60000,
    })
  );

  assert.equal(registration.name, 'project.save');
  assert.equal(registration.config.description, 'Description for project.save');
  assert.deepEqual(registration.config.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  });
  assert.equal(registration.config._meta['gdevelop/command'], 'project.save');
  assert.equal(registration.config._meta['gdevelop/requiresProject'], true);
  assert.equal(registration.config._meta['gdevelop/modifiesProject'], true);
  assert.equal(registration.config._meta['gdevelop/defaultTimeoutMs'], 90000);
  assert.equal(registration.config._meta['gdevelop/cacheScope'], 'process');
  assert.equal(registration.config._meta['gdevelop/ttlMs'], 60000);
  assert.ok(registration.config.outputSchema);
  assert.equal(registration.timeoutMs, 90000);
});

test('wraps command data output schemas in the shared AgentIntegration envelope', () => {
  const dataSchema = {
    type: 'object',
    required: ['ok'],
    properties: { ok: { type: 'boolean' } },
  };
  const envelope = withCommandResultEnvelope(dataSchema);
  assert.deepEqual(envelope.required, [
    'contractVersion',
    'command',
    'data',
    'meta',
  ]);
  assert.deepEqual(envelope.properties.contractVersion, {
    type: 'integer',
    const: 1,
  });
  assert.equal(envelope.properties.data, dataSchema);
  assert.deepEqual(envelope.properties.meta.required, [
    'traceId',
    'readOnly',
    'modifiesProject',
    'projectRevision',
    'semanticRevisions',
    'durationMs',
    'idempotencyReplayed',
  ]);
  assert.deepEqual(withCommandResultEnvelope(null).properties.data, {});
});

test('publishes strict input JSON Schema while deferring validation to the canonical handler', async () => {
  const registration = descriptorToToolRegistration(descriptor('typed.test'));
  const standard = registration.config.inputSchema['~standard'];
  const published = await standard.jsonSchema.input();
  assert.equal(published.properties.value.type, 'string');

  const sdkResult = await standard.validate({ value: 42 });
  assert.deepEqual(sdkResult, { value: { value: 42 } });

  const handlerResult = await registration.validateInput({ value: 42 });
  assert.ok(Array.isArray(handlerResult.issues));
  assert.equal(handlerResult.issues.length > 0, true);
});

test('preserves published argument bounds and a generic output envelope when no narrow output schema exists', async () => {
  const bounded = descriptor('bounded.tool');
  bounded.inputSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'count', 'items'],
    properties: {
      name: { type: 'string', minLength: 2, maxLength: 10 },
      count: { type: 'integer', minimum: 1, maximum: 5 },
      items: {
        type: 'array',
        minItems: 1,
        maxItems: 3,
        items: { type: 'string', maxLength: 8 },
      },
    },
  };
  delete bounded.outputSchema;

  const registration = descriptorToToolRegistration(bounded);
  const publishedInput = await registration.config.inputSchema[
    '~standard'
  ].jsonSchema.input();
  assert.deepEqual(publishedInput.properties.name, {
    type: 'string',
    minLength: 2,
    maxLength: 10,
  });
  assert.deepEqual(publishedInput.properties.count, {
    type: 'integer',
    minimum: 1,
    maximum: 5,
  });
  assert.deepEqual(publishedInput.properties.items, {
    type: 'array',
    minItems: 1,
    maxItems: 3,
    items: { type: 'string', maxLength: 8 },
  });

  const publishedOutput = await registration.config.outputSchema[
    '~standard'
  ].jsonSchema.output();
  assert.deepEqual(publishedOutput.required, [
    'contractVersion',
    'command',
    'data',
    'meta',
  ]);
  assert.deepEqual(publishedOutput.properties.data, {});
});

test('adds mutation controls only to project-mutating MCP schemas', () => {
  const baseSchema = descriptor('events.patch').inputSchema;
  const mutatingProperties = withRevisionPrecondition(baseSchema, true)
    .properties;
  assert.deepEqual(mutatingProperties.expectedRevision, {
    type: 'integer',
    minimum: 0,
    description:
      'Optional optimistic concurrency precondition. The command fails with revision_conflict if the open project changed since this revision was read.',
  });
  assert.deepEqual(mutatingProperties.idempotencyKey, {
    type: 'string',
    minLength: 1,
    maxLength: 200,
    description:
      'Optional retry key. Repeating the same mutating command with the same key and input returns the original result without applying the mutation again.',
  });

  const readOnlyProperties = withRevisionPrecondition(baseSchema, false)
    .properties;
  assert.equal(readOnlyProperties.expectedRevision, undefined);
  assert.equal(readOnlyProperties.idempotencyKey, undefined);
});

test('keeps CommandRegistry metadata and MCP projection in exact parity', () => {
  const descriptors = [
    descriptor('project.status', {
      cacheScope: 'project-revision',
      ttlMs: 250,
    }),
    descriptor('project.save', {
      readOnly: false,
      destructive: true,
      idempotent: false,
      longRunning: true,
      requiresProject: true,
      modifiesProject: true,
      defaultTimeoutMs: 90000,
    }),
  ];

  const registrations = descriptorsToToolRegistrations(descriptors);
  for (const source of descriptors) {
    const registration = registrations.find(item => item.name === source.name);
    assert.ok(registration);
    assert.equal(registration.config.description, source.description);
    assert.deepEqual(registration.config.annotations, {
      readOnlyHint: source.metadata.readOnly,
      destructiveHint: source.metadata.destructive,
      idempotentHint: source.metadata.idempotent,
      openWorldHint: false,
    });
    assert.equal(registration.config._meta['gdevelop/command'], source.name);
    assert.equal(
      registration.config._meta['gdevelop/requiresProject'],
      source.metadata.requiresProject
    );
    assert.equal(
      registration.config._meta['gdevelop/modifiesProject'],
      source.metadata.modifiesProject
    );
    assert.equal(
      registration.config._meta['gdevelop/longRunning'],
      source.metadata.longRunning
    );
    assert.equal(
      registration.config._meta['gdevelop/defaultTimeoutMs'],
      source.metadata.defaultTimeoutMs
    );
    assert.equal(
      registration.config._meta['gdevelop/cacheScope'],
      source.metadata.cacheScope
    );
    assert.equal(
      registration.config._meta['gdevelop/ttlMs'],
      source.metadata.ttlMs
    );
    assert.equal(registration.timeoutMs, source.metadata.defaultTimeoutMs);
    assert.ok(registration.config.outputSchema);
  }
});

test('keeps tool order deterministic', () => {
  const names = descriptorsToToolRegistrations([
    descriptor('zeta.command'),
    descriptor('alpha.command'),
    descriptor('middle.command'),
  ]).map(registration => registration.name);
  assert.deepEqual(names, ['alpha.command', 'middle.command', 'zeta.command']);
});

test('adds target identity preconditions to project/scene/preview tools but not unrelated desktop helpers', () => {
  const targetAware = withTargetPreconditions(
    descriptor('events.update', { requiresProject: true }).inputSchema,
    descriptor('events.update', { requiresProject: true })
  ).properties;
  assert.equal(targetAware.expectedProjectId.type, 'string');
  assert.equal(targetAware.expectedProjectPath.type, 'string');
  assert.equal(targetAware.expectedEditorSelector.type, 'string');
  assert.equal(targetAware.expectedSceneId.type, 'string');
  assert.equal(targetAware.expectedSceneSelector.type, 'string');
  assert.ok(Array.isArray(targetAware.expectedPreviewTarget.anyOf));

  const preview = withTargetPreconditions(
    descriptor('preview.input.send').inputSchema,
    descriptor('preview.input.send')
  ).properties;
  assert.equal(
    preview.expectedPreviewTarget.description.includes('target_mismatch'),
    true
  );

  const unrelated = withTargetPreconditions(
    descriptor('agent.workspace.temp.read').inputSchema,
    descriptor('agent.workspace.temp.read')
  ).properties;
  assert.equal(unrelated.expectedProjectId, undefined);
  assert.equal(unrelated.expectedPreviewTarget, undefined);
});
