const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..', '..');
const README = path.join(ROOT, 'README.md');
const SCENARIO = path.join(
  ROOT,
  'scripts',
  'McpPreviewLifecycleLiveScenario.js'
);
const EVIDENCE = path.join(
  ROOT,
  'docs',
  'evidence',
  'DX13_PREVIEW_LIFECYCLE.json'
);

test('DX-13 documents and exercises authoritative preview debugger lifecycle', () => {
  const readme = fs.readFileSync(README, 'utf8');
  const scenario = fs.readFileSync(SCENARIO, 'utf8');
  const evidence = JSON.parse(fs.readFileSync(EVIDENCE, 'utf8'));

  [
    'starting',
    'window-open',
    'debugger-attaching',
    'ready',
    'stopped',
    'failed',
    'waitUntilReady',
    'debuggerId',
    'windowId',
    'runtime.status',
    'runtime.logs',
    'runtime.snapshot',
  ].forEach(marker =>
    assert.equal(
      readme.toLowerCase().includes(marker.toLowerCase()),
      true,
      marker
    )
  );

  [
    "'preview.start'",
    'waitUntilReady: true',
    'readyTimeoutMs: 10000',
    "'preview.status'",
    "'runtime.status'",
    "'runtime.logs'",
    "'runtime.snapshot'",
    'previewWindowId',
    'lifecycleState',
    'waitForStopped',
    'projectRevision',
    'validationErrors',
    "'preview.close-all'",
  ].forEach(marker => assert.equal(scenario.includes(marker), true, marker));

  assert.equal(evidence.source.ok, true);
  assert.equal(evidence.winUnpacked.ok, true);
  assert.deepEqual(evidence.source.lifecycleStates, [
    'stopped',
    'ready',
    'stopped',
    'ready',
    'stopped',
  ]);
  assert.equal(evidence.source.projectRevision.unchanged, true);
  assert.equal(evidence.winUnpacked.projectRevision.unchanged, true);
  assert.equal(evidence.source.validationErrors, 0);
  assert.equal(evidence.winUnpacked.validationErrors, 0);
});
