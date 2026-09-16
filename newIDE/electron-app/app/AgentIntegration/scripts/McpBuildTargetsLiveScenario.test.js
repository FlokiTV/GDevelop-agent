const test = require('node:test');
const assert = require('node:assert/strict');
const {
  REQUIRED_TOOLS,
  assertRequiredTools,
  findTarget,
  parseArgs,
} = require('./McpBuildTargetsLiveScenario');

test('parseArgs keeps remote installable build behind explicit opt-in', () => {
  assert.deepEqual(
    parseArgs([
      '--allow-mutate',
      '--allow-remote-build',
      '--require-installable',
      '--output',
      'artifacts/cap14',
      '--keep-project',
    ]),
    {
      rollback: true,
      cleanupProject: false,
      allowRemoteBuild: true,
      requireInstallable: true,
      allowMutate: true,
      outputDir: 'artifacts/cap14',
    }
  );
});

test('assertRequiredTools requires CAP-14 lifecycle annotations', () => {
  assert.ok(REQUIRED_TOOLS.includes('build.targets.list'));
  assert.ok(REQUIRED_TOOLS.includes('build.configuration.apply'));
  assert.ok(REQUIRED_TOOLS.includes('build.start'));
  assert.ok(REQUIRED_TOOLS.includes('build.result'));
  assert.throws(
    () => assertRequiredTools([{ name: 'project.status' }]),
    /build_target_tools_missing:/
  );

  const tools = REQUIRED_TOOLS.map(name => ({
    name,
    annotations: { readOnlyHint: true, destructiveHint: false },
  }));
  for (const name of [
    'build.configuration.apply',
    'build.start',
    'build.cancel',
  ]) {
    tools.find(tool => tool.name === name).annotations.readOnlyHint = false;
  }
  tools.find(
    tool => tool.name === 'build.start'
  ).annotations.destructiveHint = true;
  assert.doesNotThrow(() => assertRequiredTools(tools));

  tools.find(
    tool => tool.name === 'build.result'
  ).annotations.readOnlyHint = false;
  assert.throws(
    () => assertRequiredTools(tools),
    /build_readonly_annotations_invalid:build.result/
  );
});

test('findTarget resolves capability records by stable id', () => {
  const targets = [
    { id: 'html5-local', availability: { state: 'available' } },
    { id: 'windows-exe', availability: { state: 'unavailable' } },
  ];
  assert.equal(findTarget(targets, 'windows-exe'), targets[1]);
  assert.equal(findTarget(targets, 'missing'), null);
});
