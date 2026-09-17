const test = require('node:test');
const assert = require('node:assert/strict');
const {
  REQUIRED_TOOLS,
  assertRequiredTools,
  findNestedEvent,
  parseArgs,
} = require('./McpRuntimeDiagnosticsLiveScenario');

test('parseArgs requires explicit mutation opt-in and parses bounded options', () => {
  assert.deepEqual(
    parseArgs([
      '--allow-mutate',
      '--persist',
      '--keep-project',
      '--output',
      'evidence',
      '--window-id',
      '7',
    ]),
    {
      allowMutate: true,
      rollback: false,
      cleanupProject: false,
      outputDir: 'evidence',
      windowId: '7',
    }
  );
  assert.throws(() => parseArgs(['--wat']), /unknown_argument:--wat/);
});

test('assertRequiredTools requires the complete CAP-16/17 live surface', () => {
  for (const name of [
    'runtime.debugger.capabilities',
    'runtime.profiler.start',
    'runtime.profiler.status',
    'runtime.profiler.stop',
    'runtime.profile.run',
    'runtime.event-trace.capture',
  ]) {
    assert.ok(REQUIRED_TOOLS.includes(name));
  }
  const tools = REQUIRED_TOOLS.map(name => ({
    name,
    annotations: { readOnlyHint: true },
  }));
  assert.ok(assertRequiredTools(tools) instanceof Map);
  assert.throws(
    () =>
      assertRequiredTools(
        tools.filter(tool => tool.name !== 'runtime.profile.run')
      ),
    /runtime_diagnostics_tools_missing:runtime.profile.run/
  );
});

test('findNestedEvent resolves stable-handle events recursively', () => {
  const child = {
    handle: 'event:child',
    type: 'BuiltinCommonInstructions::Standard',
    children: [],
  };
  const events = [
    {
      handle: 'event:group',
      type: 'BuiltinCommonInstructions::Group',
      children: [child],
    },
  ];
  assert.equal(
    findNestedEvent(events, event => event.handle === 'event:child'),
    child
  );
  assert.equal(
    findNestedEvent(events, event => event.handle === 'missing'),
    null
  );
});
