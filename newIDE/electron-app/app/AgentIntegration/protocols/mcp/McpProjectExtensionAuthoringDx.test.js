const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('DX-10 documents and exercises typed project-extension authoring through the unified MCP surface', () => {
  const readme = read('README.md');
  const scenario = read('scripts/McpProjectExtensionAuthoringLiveScenario.js');

  assert.match(readme, /Project extension authoring/);
  assert.match(readme, /editor\.functions\.create-extension/);
  assert.match(readme, /editor\.functions\.change-extension-properties/);
  assert.match(readme, /editor\.functions\.create-custom-function/);
  assert.match(readme, /editor\.functions\.change-custom-function/);
  assert.match(readme, /kind: "extension-function"/);
  assert.match(readme, /expectedRevision/);
  assert.match(readme, /idempotencyKey/);
  assert.match(
    readme,
    /No direct project JSON edit or external import bootstrap/
  );

  assert.match(scenario, /editor\.functions\.create-extension/);
  assert.match(scenario, /editor\.functions\.change-extension-properties/);
  assert.match(scenario, /editor\.functions\.create-custom-function/);
  assert.match(scenario, /editor\.functions\.change-custom-function/);
  assert.match(scenario, /editor\.functions\.inspect-extension/);
  assert.match(scenario, /kind: 'extension-function'/);
  assert.match(scenario, /events\.instructions\.search/);
  assert.match(scenario, /returnType === 'string'/);
  assert.match(scenario, /returnType === 'number'/);
  assert.match(scenario, /idempotencyReplayed === true/);
  assert.match(scenario, /safety\.transactions\.rollback/);
  assert.match(scenario, /validation\.run/);
  assert.match(scenario, /project\.save-as/);
  assert.match(scenario, /directProjectJsonEdit: false/);
  assert.match(scenario, /externalImportBootstrap: false/);
});
