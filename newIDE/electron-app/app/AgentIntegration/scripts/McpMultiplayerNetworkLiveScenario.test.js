const test = require('node:test');
const assert = require('node:assert/strict');
const {
  REQUIRED_TOOLS,
  assertRequiredTools,
  findPreviewWindows,
} = require('./McpMultiplayerNetworkLiveScenario');

test('requires complete CAP-20/21 MCP surface', () => {
  assert.doesNotThrow(() =>
    assertRequiredTools(REQUIRED_TOOLS.map(name => ({ name })))
  );
  assert.throws(
    () => assertRequiredTools(REQUIRED_TOOLS.slice(1).map(name => ({ name }))),
    /multiplayer_network_tools_missing/
  );
});

test('finds only visible preview windows', () => {
  assert.deepEqual(
    findPreviewWindows([
      { windowId: 1, previewWindow: false, visible: true },
      { windowId: 2, previewWindow: true, visible: false },
      { windowId: 3, previewWindow: true, visible: true },
      { windowId: 4, previewWindow: true, visible: true },
    ]).map(item => item.windowId),
    [3, 4]
  );
});
