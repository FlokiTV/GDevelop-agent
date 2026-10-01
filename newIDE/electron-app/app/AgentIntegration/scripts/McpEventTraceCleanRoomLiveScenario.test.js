const assert = require('node:assert/strict');
const test = require('node:test');
const { REQUIRED_TOOLS } = require('./McpEventTraceCleanRoomLiveScenario');

test('DX-36 live runner requires complete tracing/time/input/safety surface', () => {
  const required = [
    'runtime.event-trace.configure',
    'runtime.event-trace.read',
    'runtime.event-trace.clear',
    'runtime.event-trace.watch',
    'runtime.debugger.capabilities',
    'runtime.time.pause',
    'runtime.time.step',
    'runtime.inspect',
    'preview.input.send',
    'events.read',
    'events.insert',
    'events.instructions.search',
    'agent.jobs.capabilities',
    'safety.transactions.begin',
    'safety.transactions.rollback',
  ];
  for (const name of required) {
    assert.ok(REQUIRED_TOOLS.includes(name), 'missing:' + name);
  }
});

test('DX-36 live runner tool contract is deterministic and duplicate-free', () => {
  assert.equal(new Set(REQUIRED_TOOLS).size, REQUIRED_TOOLS.length);
  assert.deepEqual(
    [...REQUIRED_TOOLS].sort(),
    [...new Set(REQUIRED_TOOLS)].sort()
  );
});
