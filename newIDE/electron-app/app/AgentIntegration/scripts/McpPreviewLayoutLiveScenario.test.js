const assert = require('node:assert/strict');
const test = require('node:test');
const {
  LONG_TEXT,
  QA_VIEWPORT,
  REQUIRED_TOOLS,
  assertRequiredTools,
  getReadyPreviewTarget,
} = require('./McpPreviewLayoutLiveScenario');

test('DX-23 live scenario requires typed structural layout and capture tools', () => {
  const tools = REQUIRED_TOOLS.map(name => ({
    name,
    inputSchema:
      name === 'preview.layout.inspect'
        ? { properties: { targets: {} } }
        : name === 'preview.layout.assert'
        ? { properties: { assertions: {} } }
        : name === 'preview.capture.region'
        ? { properties: { target: {}, region: {} } }
        : { properties: {} },
  }));
  assert.doesNotThrow(() => assertRequiredTools(tools));
  assert.equal(REQUIRED_TOOLS.includes('preview.layout.capabilities'), true);
  assert.equal(REQUIRED_TOOLS.includes('preview.layout.inspect'), true);
  assert.equal(REQUIRED_TOOLS.includes('preview.layout.assert'), true);
  assert.equal(REQUIRED_TOOLS.includes('preview.capture.region'), true);
  assert.deepEqual(QA_VIEWPORT, { width: 1280, height: 720 });
  assert.ok(LONG_TEXT.length > 1000);
});

test('DX-23 live scenario rejects missing layout tools and resolves ready preview target', () => {
  assert.throws(
    () =>
      assertRequiredTools(
        REQUIRED_TOOLS.filter(name => name !== 'preview.layout.assert').map(
          name => ({
            name,
            inputSchema:
              name === 'preview.layout.inspect'
                ? { properties: { targets: {} } }
                : name === 'preview.capture.region'
                ? { properties: { target: {}, region: {} } }
                : { properties: {} },
          })
        )
      ),
    /dx23_missing_tools:preview\.layout\.assert/
  );

  const target = getReadyPreviewTarget({
    targets: [
      { windowId: 3, debuggerId: 'debugger-3', ready: false },
      { windowId: 4, debuggerId: 'debugger-4', ready: true },
    ],
  });
  assert.deepEqual(target, {
    windowId: 4,
    debuggerId: 'debugger-4',
    ready: true,
  });
});
