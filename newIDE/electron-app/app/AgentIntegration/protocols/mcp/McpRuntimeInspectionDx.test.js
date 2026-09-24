const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..', '..');
const README = path.join(ROOT, 'README.md');
const SCENARIO = path.join(
  ROOT,
  'scripts',
  'McpRuntimeInspectionLiveScenario.js'
);

test('DX-12 documents and exercises targeted read-only runtime inspection', () => {
  const readme = fs.readFileSync(README, 'utf8');
  const scenario = fs.readFileSync(SCENARIO, 'utf8');

  [
    'runtime.inspect',
    'global-variable',
    'scene-variable',
    'object-count',
    'object-instance',
    'object-property',
    'object-variable',
    'condition.selector',
    'read-only',
  ].forEach(marker =>
    assert.equal(
      readme.toLowerCase().includes(marker.toLowerCase()),
      true,
      marker
    )
  );

  [
    "'runtime.inspect'",
    "'runtime.assert'",
    "'runtime.wait-for'",
    "path: 'Money'",
    "path: 'CurrentLanguage'",
    "property: 'text'",
    'qaJsCodeInstrumentation: false',
    'documentTitleInstrumentation: false',
    'readOnlyProjectRevision',
    'validationErrors',
    'safety.transactions.rollback',
  ].forEach(marker => assert.equal(scenario.includes(marker), true, marker));

  assert.equal(/document\.title/i.test(scenario), false);
  assert.equal(/type:\s*['\"]JsCode['\"]/.test(scenario), false);
});
