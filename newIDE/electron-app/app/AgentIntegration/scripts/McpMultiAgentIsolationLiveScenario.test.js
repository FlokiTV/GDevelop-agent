const test = require('node:test');
const assert = require('node:assert/strict');
const {
  IDENTITIES,
  REQUIRED_TOOLS,
  errorOf,
} = require('./McpMultiAgentIsolationLiveScenario');

test('DX-19 live scenario requires identity, temp workspace, lease and transaction tools', () => {
  for (const name of [
    'agent.concurrency.lease.renew',
    'agent.workspace.temp.create',
    'agent.workspace.temp.write',
    'agent.workspace.temp.release',
    'safety.transactions.status',
    'safety.transactions.rollback',
  ]) {
    assert.equal(REQUIRED_TOOLS.includes(name), true);
  }
  assert.notEqual(IDENTITIES.a.ownerKey, IDENTITIES.b.ownerKey);
  assert.notEqual(IDENTITIES.a.taskId, IDENTITIES.b.taskId);
});

test('DX-19 live scenario reads structured MCP tool error codes', () => {
  assert.deepEqual(
    errorOf({
      structuredContent: {
        data: {
          error: {
            code: 'revision_conflict',
            details: { expectedRevision: 1, actualRevision: 2 },
          },
        },
      },
    }),
    {
      code: 'revision_conflict',
      details: { expectedRevision: 1, actualRevision: 2 },
    }
  );
  assert.equal(errorOf({ structuredContent: { data: {} } }), null);
});
