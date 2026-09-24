const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const read = relativePath =>
  fs.readFileSync(path.join(root, relativePath), 'utf8');

test('DX-15 documents and preserves EditorFunction exposure parity acceptance', () => {
  const readme = read('README.md');
  const scenario = read(
    path.join('scripts', 'McpEditorFunctionExposureLiveScenario.js')
  );

  [
    /EditorFunction exposure policy/,
    /exposure\.genericCall/,
    /exposure\.typedTool/,
    /exposure\.runScript/,
    /hiddenReason/,
    /generation-service-only/i,
  ].forEach(pattern => assert.match(readme, pattern));

  [
    /editor\.functions\.list/,
    /create_extension/,
    /create_custom_function/,
    /add_or_edit_variable/,
    /generation-service-only/i,
    /recursive-script-execution-disabled/,
    /project-bootstrap-outside-script/,
    /mutating-function-in-read-only-script/,
    /typed_tool_inventory_mismatch/,
  ].forEach(pattern => assert.match(scenario, pattern));
});
