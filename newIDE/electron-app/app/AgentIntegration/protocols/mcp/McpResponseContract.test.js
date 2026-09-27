const test = require('node:test');
const assert = require('node:assert/strict');
const {
  RESPONSE_CONTRACT_VERSION,
  ERROR_CATEGORIES,
  RESPONSE_CONTRACT_GUIDE,
  inferErrorCategory,
  normalizeError,
  makeInputValidationError,
  normalizeSuccessMeta,
  makeSuccessEnvelope,
  makeErrorEnvelope,
} = require('./McpResponseContract');

test('classifies representative cross-tool errors into the stable taxonomy', () => {
  assert.deepEqual(ERROR_CATEGORIES, [
    'validation',
    'not-found',
    'conflict',
    'availability',
    'permission',
    'cancelled',
    'timeout',
    'safety',
    'internal',
    'execution',
  ]);
  assert.equal(inferErrorCategory('invalid_scene_name'), 'validation');
  assert.equal(inferErrorCategory('function_not_found'), 'not-found');
  assert.equal(inferErrorCategory('revision_conflict'), 'conflict');
  assert.equal(inferErrorCategory('target_mismatch'), 'conflict');
  assert.equal(inferErrorCategory('no_project_open'), 'availability');
  assert.equal(inferErrorCategory('renderer_request_timeout'), 'timeout');
  assert.equal(inferErrorCategory('renderer_request_cancelled'), 'cancelled');
  assert.equal(inferErrorCategory('human_confirmation_declined'), 'safety');
  assert.equal(inferErrorCategory('agent_internal_error'), 'internal');
  assert.equal(inferErrorCategory('export_failed'), 'execution');
});

test('converts Standard Schema issues into field-level invalid_command_input errors', () => {
  const error = makeInputValidationError('editor.functions.create-scene', [
    {
      message:
        'data/scene_name must be string, data/calls must NOT have more than 2 items',
    },
  ]);
  assert.equal(error.code, 'invalid_command_input');
  assert.equal(error.category, 'validation');
  assert.equal(error.retryable, false);
  assert.equal(error.field, 'scene_name');
  assert.deepEqual(error.path, ['scene_name']);
  assert.deepEqual(error.details.issues[0].path, ['scene_name']);
});

test('normalizes field/path diagnostics without losing original details', () => {
  const error = normalizeError(
    {
      code: 'invalid_crop',
      message: 'invalid crop',
      retryable: false,
      details: {
        field: 'crop.width',
        path: ['crop', 'width'],
        maximum: 16384,
      },
    },
    'trace-a'
  );
  assert.deepEqual(error, {
    code: 'invalid_crop',
    category: 'validation',
    message: 'invalid crop',
    retryable: false,
    field: 'crop.width',
    path: ['crop', 'width'],
    details: {
      field: 'crop.width',
      path: ['crop', 'width'],
      maximum: 16384,
    },
    traceId: 'trace-a',
  });
});

test('normalizes success meta and mirrors real transaction/lease identifiers', () => {
  assert.deepEqual(
    normalizeSuccessMeta(
      {
        readOnly: false,
        modifiesProject: true,
        projectRevision: 9,
        semanticRevisions: [{ scope: 'project', revision: 9 }],
      },
      {
        input: {
          transactionId: 'tx-1',
          leaseId: 'lease-input',
        },
        data: {
          lease: { leaseId: 'lease-output' },
        },
        semanticLeaseOwner: 'agent::session',
      }
    ),
    {
      traceId: null,
      readOnly: false,
      modifiesProject: true,
      projectRevision: 9,
      semanticRevisions: [{ scope: 'project', revision: 9 }],
      durationMs: null,
      idempotencyReplayed: false,
      transactionId: 'tx-1',
      leaseId: 'lease-output',
      leaseIds: ['lease-output'],
      semanticLeaseOwner: 'agent::session',
    }
  );
});

test('builds one versioned success/error envelope and guide', () => {
  const success = makeSuccessEnvelope({
    command: 'project.status',
    data: { projectOpen: true },
    meta: { readOnly: true, modifiesProject: false },
  });
  assert.equal(success.contractVersion, RESPONSE_CONTRACT_VERSION);
  assert.equal(success.command, 'project.status');
  assert.deepEqual(success.data, { projectOpen: true });
  assert.deepEqual(success.meta.semanticRevisions, []);

  const error = makeErrorEnvelope({
    code: 'revision_conflict',
    category: 'conflict',
    message: 'stale',
    retryable: true,
    traceId: 'trace-b',
  });
  assert.equal(error.contractVersion, RESPONSE_CONTRACT_VERSION);
  assert.equal(error.error.category, 'conflict');
  assert.match(RESPONSE_CONTRACT_GUIDE, /structuredContent\.data/);
  assert.match(RESPONSE_CONTRACT_GUIDE, /pagination/);
});
