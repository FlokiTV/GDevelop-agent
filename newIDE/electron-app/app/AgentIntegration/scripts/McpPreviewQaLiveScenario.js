const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  Client,
  StreamableHTTPClientTransport,
} = require('@modelcontextprotocol/client');
const {
  getDefaultDiscoveryPath,
  loadRuntimeConfig,
  makeRequestHeaders,
} = require('./McpLiveGate');

const REQUIRED_TOOLS = [
  'project.status',
  'project.create',
  'project.save-as',
  'project.close',
  'editor.functions.create-scene',
  'preview.start',
  'preview.close-all',
  'desktop.windows.list',
  'preview.qa.capabilities',
  'preview.input.record.start',
  'preview.input.record.send',
  'preview.input.record.stop',
  'preview.input.replay',
  'preview.visual.baseline.capture',
  'preview.visual.baseline.compare',
  'safety.transactions.begin',
  'safety.transactions.rollback',
];

const getData = response =>
  response && response.structuredContent
    ? response.structuredContent.data != null
      ? response.structuredContent.data
      : response.structuredContent
    : null;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const assertRequiredTools = tools => {
  const byName = new Map((tools || []).map(tool => [tool.name, tool]));
  const missing = REQUIRED_TOOLS.filter(name => !byName.has(name));
  if (missing.length)
    throw new Error(`preview_qa_tools_missing:${missing.join(',')}`);
  if (
    !byName.get('preview.qa.capabilities').annotations ||
    byName.get('preview.qa.capabilities').annotations.readOnlyHint !== true
  )
    throw new Error('preview_qa_capabilities_annotation_invalid');
  return byName;
};

const findPreviewWindow = windows =>
  (windows || []).find(
    window => window && window.previewWindow && window.visible
  );

const runPreviewQaLiveScenario = async ({ allowMutate, env = process.env }) => {
  if (!allowMutate) throw new Error('mutation_requires_--allow-mutate');
  const projectRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gdevelop-cap18-19-live-')
  );
  const projectFile = path.join(projectRoot, 'game.json');
  const runtime = loadRuntimeConfig(getDefaultDiscoveryPath(env));
  const client = new Client(
    { name: 'gdevelop-preview-qa-live-e2e', version: '1.0.0' },
    {
      capabilities: { elicitation: { form: {} } },
      versionNegotiation: { mode: { pin: runtime.protocolVersion } },
    }
  );
  client.setRequestHandler('elicitation/create', async request => {
    const message = String((request.params && request.params.message) || '');
    return /discard|close|rollback/i.test(message)
      ? { action: 'accept', content: { confirm: true } }
      : { action: 'decline' };
  });
  const transport = new StreamableHTTPClientTransport(
    new URL(runtime.endpoint),
    {
      requestInit: {
        headers: makeRequestHeaders({
          token: runtime.token,
          clientId: 'gdevelop-preview-qa-live-e2e',
        }),
      },
    }
  );
  let revision = null;
  let transactionId = null;
  let createdProject = false;
  let previewStarted = false;
  const call = async (name, args = {}) => {
    const response = await client.callTool(
      { name, arguments: args },
      { timeout: 120000 }
    );
    const data = getData(response);
    if (response.isError) {
      const error = data && data.error;
      throw new Error(
        `tool_failed:${name}:${error && error.code ? error.code : 'unknown'}`
      );
    }
    return data;
  };
  const mutate = async (name, args) => {
    const data = await call(name, {
      ...args,
      ...(Number.isInteger(revision) ? { expectedRevision: revision } : {}),
      idempotencyKey: `cap18-19-${Date.now().toString(36)}`,
    });
    const status = await call('project.status');
    revision = status.projectRevision;
    return data;
  };

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assertRequiredTools(tools.tools);
    const initial = await call('project.status');
    if (initial.projectOpen)
      throw new Error(
        'live_scenario_requires_fresh_editor_without_open_project'
      );
    await call('project.create', {
      name: `MCP Preview QA ${Date.now().toString(36)}`,
    });
    createdProject = true;
    await wait(1000);
    await call('project.save-as', { filePath: projectFile });
    revision = (await call('project.status')).projectRevision;
    const originalRevision = revision;
    transactionId = (await call('safety.transactions.begin', {
      label: 'CAP-18/19 preview QA live E2E',
    })).transactionId;
    const sceneName = `Preview QA ${Date.now().toString(36)}`;
    await mutate('editor.functions.create-scene', { scene_name: sceneName });

    const capabilities = await call('preview.qa.capabilities');
    if (
      capabilities.deterministicGameplay.inputReplay.supported !== true ||
      capabilities.deterministicGameplay.fixedTimestep.supported !== false ||
      capabilities.deterministicGameplay.seededRandomness.supported !== false ||
      capabilities.visualRegression.exactPngHashComparison.supported !== true ||
      capabilities.visualRegression.pixelToleranceComparison.supported !==
        false ||
      capabilities.deviceSimulation.viewportResize.supported !== false
    )
      throw new Error('preview_qa_capabilities_invalid');

    await call('preview.start');
    previewStarted = true;
    let previewWindow = null;
    for (let attempt = 0; attempt < 40 && !previewWindow; attempt++) {
      previewWindow = findPreviewWindow(await call('desktop.windows.list'));
      if (!previewWindow) await wait(250);
    }
    if (!previewWindow) throw new Error('preview_window_timeout');
    const previewWindowId = previewWindow.windowId;

    await call('preview.input.record.start', {
      previewWindowId,
      recordingId: 'qa-key',
    });
    await call('preview.input.record.send', {
      previewWindowId,
      event: { type: 'keyDown', keyCode: 'Space' },
    });
    await call('preview.input.record.send', {
      previewWindowId,
      event: { type: 'keyUp', keyCode: 'Space' },
    });
    const recording = await call('preview.input.record.stop', {
      recordingId: 'qa-key',
    });
    if (
      recording.format !== 'gdevelop-preview-input-sequence-v1' ||
      recording.steps.length !== 2
    )
      throw new Error('preview_input_recording_invalid');
    const replay = await call('preview.input.replay', {
      previewWindowId,
      recordingId: 'qa-key',
    });
    if (!replay.sent || replay.steps !== 2 || replay.resetBefore !== true)
      throw new Error('preview_input_replay_invalid');

    const baseline = await call('preview.visual.baseline.capture', {
      previewWindowId,
      baselineId: 'qa-stable',
      maxWidth: 640,
      maxHeight: 480,
    });
    if (!/^[a-f0-9]{64}$/.test(baseline.sha256) || baseline.bytes <= 0)
      throw new Error('preview_visual_baseline_invalid');
    const comparison = await call('preview.visual.baseline.compare', {
      previewWindowId,
      baselineId: 'qa-stable',
      maxWidth: 640,
      maxHeight: 480,
    });
    if (
      comparison.comparison !== 'exact-png-sha256' ||
      comparison.passed !== true
    )
      throw new Error('preview_visual_compare_invalid');

    await call('preview.close-all');
    previewStarted = false;
    await call('safety.transactions.rollback', { transactionId });
    transactionId = null;
    const finalRevision = (await call('project.status')).projectRevision;
    if (finalRevision !== originalRevision)
      throw new Error(
        `rollback_revision_mismatch:${originalRevision}:${finalRevision}`
      );
    await call('project.close', { discardUnsavedChanges: true });
    createdProject = false;
    return {
      ok: true,
      protocolVersion: client.getNegotiatedProtocolVersion(),
      toolCount: tools.tools.length,
      previewWindowId,
      recordingSteps: recording.steps.length,
      visualComparison: comparison.comparison,
      baselineSha256: baseline.sha256,
      capabilities,
      originalRevision,
      finalRevision,
    };
  } finally {
    if (previewStarted)
      try {
        await call('preview.close-all');
      } catch (_) {}
    if (transactionId)
      try {
        await call('safety.transactions.rollback', { transactionId });
      } catch (_) {}
    if (createdProject)
      try {
        await call('project.close', { discardUnsavedChanges: true });
      } catch (_) {}
    fs.rmSync(projectRoot, { recursive: true, force: true });
    await client.close();
  }
};

if (require.main === module) {
  runPreviewQaLiveScenario({
    allowMutate: process.argv.includes('--allow-mutate'),
  })
    .then(result =>
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    )
    .catch(error => {
      process.stderr.write(
        `MCP preview-QA live scenario failed: ${error.message}\n`
      );
      process.exitCode = 1;
    });
}

module.exports = {
  REQUIRED_TOOLS,
  assertRequiredTools,
  findPreviewWindow,
  runPreviewQaLiveScenario,
};
