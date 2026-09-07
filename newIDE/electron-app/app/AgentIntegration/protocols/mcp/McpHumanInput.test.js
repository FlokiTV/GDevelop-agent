const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CONFIRMATION_KEY,
  getDestructiveConfirmation,
  requireDestructiveConfirmation,
} = require('./McpHumanInput');

test('requests input_required only for destructive intent flags', () => {
  assert.equal(getDestructiveConfirmation('project.close', {}), null);
  assert.equal(
    getDestructiveConfirmation('resources.remove', { deleteFile: false }),
    null
  );

  const confirmation = requireDestructiveConfirmation({
    command: 'resources.remove',
    input: { resourceName: 'player.png', deleteFile: true },
    requestContext: { mcpReq: {} },
  });

  assert.equal(confirmation.confirmed, false);
  assert.equal(confirmation.inputRequired.resultType, 'input_required');
  const request = confirmation.inputRequired.inputRequests[CONFIRMATION_KEY];
  assert.equal(request.method, 'elicitation/create');
  assert.equal(
    request.params.requestedSchema.properties.confirm.type,
    'boolean'
  );
});

test('accepts, declines and cancels explicit destructive confirmation', () => {
  const makeContext = response => ({
    mcpReq: {
      inputResponses: { [CONFIRMATION_KEY]: response },
    },
  });

  assert.deepEqual(
    requireDestructiveConfirmation({
      command: 'project.close',
      input: { discardUnsavedChanges: true },
      requestContext: makeContext({
        action: 'accept',
        content: { confirm: true },
      }),
    }),
    { confirmed: true }
  );

  const declined = requireDestructiveConfirmation({
    command: 'project.close',
    input: { discardUnsavedChanges: true },
    requestContext: makeContext({ action: 'decline' }),
  });
  assert.equal(declined.declined, true);

  const cancelled = requireDestructiveConfirmation({
    command: 'project.close',
    input: { discardUnsavedChanges: true },
    requestContext: makeContext({ action: 'cancel' }),
  });
  assert.equal(cancelled.declined, true);
});
