const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..', '..');
const README = path.join(ROOT, 'README.md');
const SCENARIO = path.join(
  ROOT,
  'scripts',
  'McpVariableMutationLiveScenario.js'
);

test('DX-11 documents and exercises non-destructive variable rename/reorder', () => {
  const readme = fs.readFileSync(README, 'utf8');
  const scenario = fs.readFileSync(SCENARIO, 'utf8');

  [
    'new_variable_name',
    'move_before_variable',
    'move_after_variable',
    'move_to_index',
    'operationErrors',
    'WholeProjectRefactorer',
    '__internal',
  ].forEach(marker =>
    assert.equal(
      readme.toLowerCase().includes(marker.toLowerCase()),
      true,
      marker
    )
  );

  [
    'editor.functions.add-or-edit-variable',
    'editor.functions.inspect-variables',
    'DisplayName|PublicB|__Internal',
    "variable_scope: 'global'",
    "variable_scope: 'scene'",
    "variable_scope: 'object'",
    "variable_scope: 'instance'",
    'deleteRecreateWorkaroundUsed: false',
    'safety.transactions.rollback',
  ].forEach(marker => assert.equal(scenario.includes(marker), true, marker));
});
