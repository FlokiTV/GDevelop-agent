const test = require('node:test');
const assert = require('node:assert/strict');
const {
  REQUIRED_TOOLS,
  REQUIRED_RESOURCES,
  assertNames,
} = require('./McpConcurrencyResourcesLiveScenario');

test('requires complete CAP-22/23 tool and rich resource surfaces', () => {
  assert.doesNotThrow(() =>
    assertNames(REQUIRED_TOOLS, REQUIRED_TOOLS, 'tools')
  );
  assert.doesNotThrow(() =>
    assertNames(REQUIRED_RESOURCES, REQUIRED_RESOURCES, 'resources')
  );
  assert.throws(
    () => assertNames(REQUIRED_TOOLS.slice(1), REQUIRED_TOOLS, 'tools'),
    /tools:/
  );
});
