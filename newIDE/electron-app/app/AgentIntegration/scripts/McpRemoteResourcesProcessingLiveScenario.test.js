const test = require('node:test');
const assert = require('node:assert/strict');
const {
  REQUIRED_TOOLS,
  assertRequiredTools,
  createPcm16Wav,
  parseArgs,
} = require('./McpRemoteResourcesProcessingLiveScenario');

test('parseArgs defaults to rollback/cleanup and accepts CAP-11/12 targeting options', () => {
  assert.deepEqual(
    parseArgs([
      '--allow-mutate',
      '--output',
      'artifacts/cap11-12',
      '--window-id',
      '7',
      '--project-path',
      'C:/game.json',
      '--keep-project',
    ]),
    {
      rollback: true,
      cleanupProject: false,
      allowMutate: true,
      outputDir: 'artifacts/cap11-12',
      windowId: '7',
      projectPath: 'C:/game.json',
    }
  );
});

test('assertRequiredTools requires remote ingestion and processing mutation annotations', () => {
  assert.ok(REQUIRED_TOOLS.includes('resources.import-url'));
  assert.ok(REQUIRED_TOOLS.includes('resources.image.transform'));
  assert.ok(REQUIRED_TOOLS.includes('resources.audio.transform'));
  assert.ok(REQUIRED_TOOLS.includes('export.html5'));
  assert.throws(
    () => assertRequiredTools([{ name: 'project.status' }]),
    /remote_processing_tools_missing:/
  );

  const tools = REQUIRED_TOOLS.map(name => ({
    name,
    annotations: { readOnlyHint: true },
  }));
  for (const name of [
    'resources.import-url',
    'resources.image.transform',
    'resources.audio.transform',
  ]) {
    tools.find(tool => tool.name === name).annotations.readOnlyHint = false;
  }
  assert.doesNotThrow(() => assertRequiredTools(tools));

  tools.find(
    tool => tool.name === 'resources.image.transform'
  ).annotations.readOnlyHint = true;
  assert.throws(
    () => assertRequiredTools(tools),
    /remote_processing_mutation_annotations_invalid:resources.image.transform/
  );
});

test('createPcm16Wav produces a valid mono PCM16 RIFF/WAVE fixture', () => {
  const wav = createPcm16Wav({ sampleRate: 8000, durationMs: 100 });
  assert.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(wav.subarray(8, 12).toString('ascii'), 'WAVE');
  assert.equal(wav.readUInt16LE(20), 1);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 8000);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.readUInt32LE(40), 800 * 2);
});
