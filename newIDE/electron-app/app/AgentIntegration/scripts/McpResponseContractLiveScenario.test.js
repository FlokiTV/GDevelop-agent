const test = require('node:test');
const assert = require('node:assert/strict');
const {
  REQUIRED_META_FIELDS,
  REQUIRED_TOOLS,
  assertOutputEnvelopeSchema,
  assertSuccessMeta,
  getEnvelope,
  parseArgs,
} = require('./McpResponseContractLiveScenario');

test('DX-21 parser accepts label/evidence and rejects unknown arguments', () => {
  assert.deepEqual(
    parseArgs(['--label', 'source', '--evidence', 'evidence.json']),
    { label: 'source', evidencePath: 'evidence.json' }
  );
  assert.throws(() => parseArgs(['--unknown']), /unknown_argument/);
});

test('DX-21 acceptance requires unrelated tools plus transaction/lease controls', () => {
  for (const name of [
    'project.status',
    'editor.functions.list',
    'editor.functions.describe',
    'editor.functions.call',
    'project.scenes.create',
    'agent.concurrency.lease.acquire',
    'safety.transactions.begin',
    'validation.run',
  ]) {
    assert.equal(REQUIRED_TOOLS.includes(name), true, name);
  }
});

test('DX-21 output schema assertion fixes the versioned outer envelope', () => {
  assert.doesNotThrow(() =>
    assertOutputEnvelopeSchema({
      name: 'project.status',
      outputSchema: {
        type: 'object',
        required: ['contractVersion', 'command', 'data', 'meta'],
        properties: {
          contractVersion: { type: 'integer', const: 1 },
          command: { type: 'string' },
          data: {},
          meta: { type: 'object' },
        },
      },
    })
  );
  assert.throws(
    () =>
      assertOutputEnvelopeSchema({
        name: 'legacy.tool',
        outputSchema: {
          required: ['command', 'data', 'meta'],
          properties: {
            command: { type: 'string' },
            data: {},
            meta: { type: 'object' },
          },
        },
      }),
    /missing_output_required:contractVersion/
  );
});

test('DX-21 success parser uses only the canonical envelope and normalized meta', () => {
  const meta = {
    traceId: 'trace-1',
    readOnly: true,
    modifiesProject: false,
    projectRevision: 2,
    semanticRevisions: [],
    durationMs: 3,
    idempotencyReplayed: false,
  };
  assert.deepEqual(REQUIRED_META_FIELDS, [
    'traceId',
    'readOnly',
    'modifiesProject',
    'projectRevision',
    'semanticRevisions',
    'durationMs',
    'idempotencyReplayed',
  ]);
  assert.doesNotThrow(() => assertSuccessMeta(meta, 'project.status'));

  const envelope = getEnvelope(
    {
      envelope: {
        contractVersion: 1,
        command: 'project.status',
        data: { projectOpen: true },
        meta,
      },
      data: { misleadingLegacyFallback: true },
    },
    'project.status'
  );
  assert.deepEqual(envelope.data, { projectOpen: true });
  assert.throws(
    () => getEnvelope({ data: { projectOpen: true } }, 'project.status'),
    /missing_envelope/
  );
});
