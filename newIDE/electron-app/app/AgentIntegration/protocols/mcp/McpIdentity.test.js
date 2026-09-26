const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getIdentityFromRequest,
} = require('./McpServerFactory');

const makeRequest = headers => ({ headers: new Headers(headers) });

test('derives stable owner identity from MCP agent/session/task headers', () => {
  assert.deepEqual(
    getIdentityFromRequest(
      makeRequest({
        'x-gdevelop-client-id': 'client-a',
        'x-gdevelop-agent-id': 'agent-a',
        'x-gdevelop-session-id': 'session-a',
        'x-gdevelop-task-id': 'task-a',
      })
    ),
    {
      clientId: 'client-a',
      agentId: 'agent-a',
      sessionId: 'session-a',
      taskId: 'task-a',
      ownerKey: 'agent-a::session-a',
    }
  );
});

test('falls back to client identity and rejects unsafe identity header values', () => {
  assert.deepEqual(
    getIdentityFromRequest(
      makeRequest({
        'x-gdevelop-client-id': 'client-b',
        'x-gdevelop-agent-id': 'unsafe value with spaces',
        'x-gdevelop-session-id': '../unsafe',
      })
    ),
    {
      clientId: 'client-b',
      agentId: 'client-b',
      sessionId: 'client-b',
      ownerKey: 'client-b::client-b',
    }
  );

  assert.deepEqual(getIdentityFromRequest(null), {
    clientId: 'anonymous-client',
    agentId: 'anonymous-client',
    sessionId: 'anonymous-client',
    ownerKey: 'anonymous-client::anonymous-client',
  });
});
