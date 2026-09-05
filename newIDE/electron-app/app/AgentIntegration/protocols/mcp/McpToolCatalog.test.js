const test = require('node:test');
const assert = require('node:assert/strict');
const {
  withRevisionPrecondition,
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
  assert.equal(registration.timeoutMs, 90000);
});

test('adds expectedRevision only to project-mutating MCP schemas', () => {
  const baseSchema = descriptor('events.patch').inputSchema;
  assert.deepEqual(
    withRevisionPrecondition(baseSchema, true).properties.expectedRevision,
    {
      type: 'integer',
      minimum: 0,
      description:
        'Optional optimistic concurrency precondition. The command fails with revision_conflict if the open project changed since this revision was read.',
    }
  );
  assert.equal(
    withRevisionPrecondition(baseSchema, false).properties.expectedRevision,
    undefined
  );
});

test('keeps tool order deterministic', () => {
  const names = descriptorsToToolRegistrations([
    descriptor('zeta.command'),
    descriptor('alpha.command'),
    descriptor('middle.command'),
  ]).map(registration => registration.name);
  assert.deepEqual(names, ['alpha.command', 'middle.command', 'zeta.command']);
});
