const test = require('node:test');
const assert = require('node:assert/strict');
const {
  REQUIRED_TOOLS,
  assertRequiredTools,
  findPreviewWindow,
} = require('./McpPreviewQaLiveScenario');

test('CAP-18/19 live harness requires the public QA tool surface', () => {
  assert.equal(REQUIRED_TOOLS.includes('preview.qa.capabilities'), true);
  assert.equal(REQUIRED_TOOLS.includes('preview.input.replay'), true);
  assert.equal(
    REQUIRED_TOOLS.includes('preview.visual.baseline.compare'),
    true
  );
});

test('CAP-18/19 live harness validates capability tool annotation', () => {
  const tools = REQUIRED_TOOLS.map(name => ({
    name,
    annotations:
      name === 'preview.qa.capabilities' ? { readOnlyHint: true } : {},
  }));
  assert.doesNotThrow(() => assertRequiredTools(tools));
  tools.find(
    tool => tool.name === 'preview.qa.capabilities'
  ).annotations.readOnlyHint = false;
  assert.throws(
    () => assertRequiredTools(tools),
    /preview_qa_capabilities_annotation_invalid/
  );
});

test('CAP-18/19 live harness selects a visible registered preview', () => {
  assert.equal(
    findPreviewWindow([
      { windowId: 1, editorWindow: true, visible: true },
      { windowId: 2, previewWindow: true, visible: false },
      { windowId: 3, previewWindow: true, visible: true },
    ]).windowId,
    3
  );
});
