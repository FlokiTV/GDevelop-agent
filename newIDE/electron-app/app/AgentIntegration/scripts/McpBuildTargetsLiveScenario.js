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
  sanitizeForReplay,
} = require('./McpLiveGate');

const REQUIRED_TOOLS = [
  'project.status',
  'project.create',
  'project.save-as',
  'project.close',
  'safety.transactions.begin',
  'safety.transactions.rollback',
  'build.targets.list',
  'build.configuration.inspect',
  'build.configuration.apply',
  'build.start',
  'build.status',
  'build.cancel',
  'build.result',
  'validation.run',
  'export.html5',
];

const getData = response =>
  response && response.structuredContent
    ? response.structuredContent.data != null
      ? response.structuredContent.data
      : response.structuredContent
    : null;

const getMeta = response =>
  response && response.structuredContent && response.structuredContent.meta
    ? response.structuredContent.meta
    : null;

const wait = delayMs => new Promise(resolve => setTimeout(resolve, delayMs));

const parseArgs = argv => {
  const options = {
    rollback: true,
    cleanupProject: true,
    allowRemoteBuild: false,
    requireInstallable: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--allow-mutate') options.allowMutate = true;
    else if (argument === '--allow-remote-build')
      options.allowRemoteBuild = true;
    else if (argument === '--require-installable')
      options.requireInstallable = true;
    else if (argument === '--persist') options.rollback = false;
    else if (argument === '--keep-project') options.cleanupProject = false;
    else if (argument === '--output') options.outputDir = argv[++index];
    else if (argument === '--window-id') options.windowId = argv[++index];
    else if (argument === '--project-path') options.projectPath = argv[++index];
    else if (argument === '--help') options.help = true;
    else throw new Error(`unknown_argument:${argument}`);
  }
  return options;
};

const assertRequiredTools = tools => {
  const byName = new Map((tools || []).map(tool => [tool.name, tool]));
  const missing = REQUIRED_TOOLS.filter(name => !byName.has(name));
  if (missing.length)
    throw new Error(`build_target_tools_missing:${missing.join(',')}`);

  for (const name of ['build.targets.list', 'build.status', 'build.result']) {
    const tool = byName.get(name);
    if (!tool.annotations || tool.annotations.readOnlyHint !== true) {
      throw new Error(`build_readonly_annotations_invalid:${name}`);
    }
  }
  const configurationApply = byName.get('build.configuration.apply');
  if (
    !configurationApply.annotations ||
    configurationApply.annotations.readOnlyHint !== false ||
    configurationApply.annotations.destructiveHint !== false
  ) {
    throw new Error('build_configuration_apply_annotations_invalid');
  }
  const start = byName.get('build.start');
  if (
    !start.annotations ||
    start.annotations.readOnlyHint !== false ||
    start.annotations.destructiveHint !== true
  ) {
    throw new Error('build_start_annotations_invalid');
  }
  return byName;
};

const findTarget = (targets, id) =>
  (targets || []).find(target => target && target.id === id) || null;

const runBuildTargetsLiveScenario = async ({
  allowMutate,
  allowRemoteBuild = false,
  requireInstallable = false,
  rollback = true,
  cleanupProject = true,
  outputDir = path.resolve(
    process.cwd(),
    'artifacts',
    'mcp-build-targets-live-e2e'
  ),
  windowId,
  projectPath,
  env = process.env,
}) => {
  if (!allowMutate) throw new Error('mutation_requires_--allow-mutate');
  if (requireInstallable && !allowRemoteBuild) {
    throw new Error('require_installable_requires_--allow-remote-build');
  }
  fs.mkdirSync(outputDir, { recursive: true });
  const projectRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gdevelop-cap14-live-')
  );
  const projectFile = path.join(projectRoot, 'game.json');
  const exportDir = path.join(outputDir, 'html5-export');

  const runtime = loadRuntimeConfig(getDefaultDiscoveryPath(env));
  const client = new Client(
    { name: 'gdevelop-build-targets-live-e2e', version: '1.0.0' },
    {
      capabilities: { elicitation: { form: {} } },
      versionNegotiation: { mode: { pin: runtime.protocolVersion } },
    }
  );
  client.setRequestHandler('elicitation/create', async request => {
    const message = String((request.params && request.params.message) || '');
    if (/build|discard|remote|quota|credit/i.test(message)) {
      return { action: 'accept', content: { confirm: true } };
    }
    return { action: 'decline' };
  });

  const transport = new StreamableHTTPClientTransport(
    new URL(runtime.endpoint),
    {
      requestInit: {
        headers: makeRequestHeaders({
          token: runtime.token,
          clientId: 'gdevelop-build-targets-live-e2e',
          windowId,
          projectPath,
        }),
      },
    }
  );

  const replay = [];
  let revision = null;
  let transactionId = null;
  let createdProject = false;

  const record = (name, args, response) => {
    const data = sanitizeForReplay(getData(response));
    const meta = sanitizeForReplay(getMeta(response));
    replay.push({ name, args: sanitizeForReplay(args), data, meta });
    return { response, data, meta };
  };

  const call = async (name, args = {}, { allowError = false } = {}) => {
    const response = await client.callTool({ name, arguments: args });
    const result = record(name, args, response);
    if (response.isError && !allowError) {
      const toolError = result.data && result.data.error;
      const error = new Error(
        `tool_failed:${name}:${
          toolError && toolError.code ? toolError.code : 'unknown'
        }:${toolError && toolError.message ? toolError.message : 'no_message'}`
      );
      error.toolError = toolError || null;
      throw error;
    }
    return result;
  };

  const mutate = async (name, args) => {
    const result = await call(name, {
      ...args,
      ...(Number.isInteger(revision) ? { expectedRevision: revision } : {}),
      idempotencyKey: `cap14-${Date.now().toString(36)}-${replay.length}`,
    });
    if (result.meta && Number.isInteger(result.meta.projectRevision)) {
      revision = result.meta.projectRevision;
    } else {
      revision = (await call('project.status')).data.projectRevision;
    }
    return result;
  };

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assertRequiredTools(tools.tools);

    const initial = await call('project.status');
    if (initial.data && initial.data.projectOpen) {
      throw new Error(
        'live_scenario_requires_fresh_editor_without_open_project'
      );
    }

    await call('project.create', {
      name: `MCP Build Targets ${Date.now().toString(36)}`,
    });
    createdProject = true;
    await wait(1600);
    await call('project.save-as', { filePath: projectFile });
    await wait(800);
    const savedStatus = await call('project.status');
    if (!savedStatus.data || !savedStatus.data.projectOpen) {
      throw new Error('temporary_project_not_open_after_save');
    }
    revision = savedStatus.data.projectRevision;
    const originalRevision = revision;

    const targetsResult = await call('build.targets.list');
    const targets = targetsResult.data && targetsResult.data.targets;
    if (!Array.isArray(targets)) throw new Error('build_targets_invalid');
    const html5Target = findTarget(targets, 'html5-local');
    const windowsTarget = findTarget(targets, 'windows-exe');
    const iosTarget = findTarget(targets, 'ios-app-store');
    if (
      !html5Target ||
      html5Target.availability.state !== 'available' ||
      !windowsTarget ||
      !iosTarget ||
      iosTarget.availability.state !== 'unsupported' ||
      iosTarget.availability.code !== 'signing_configuration_not_exposed'
    ) {
      throw new Error('build_target_capabilities_invalid');
    }

    const transaction = await call('safety.transactions.begin', {
      label: 'CAP-14 build targets/configuration live E2E',
    });
    transactionId = transaction.data.transactionId;
    if (!transactionId) throw new Error('transaction_id_missing');

    const configApply = await mutate('build.configuration.apply', {
      packageName: 'com.gdevelop.agent.cap14acceptance',
      version: '1.4.0',
      orientation: 'landscape',
      loadingScreen: {
        backgroundColor: 16777215,
        minDuration: 50,
        showProgressBar: true,
        progressBarWidthPercent: 75,
      },
    });
    if (!configApply.data || configApply.data.changed !== true) {
      throw new Error('build_configuration_apply_failed');
    }
    const config = await call('build.configuration.inspect');
    if (
      !config.data ||
      config.data.packageName !== 'com.gdevelop.agent.cap14acceptance' ||
      config.data.version !== '1.4.0' ||
      config.data.orientation !== 'landscape' ||
      !config.data.loadingScreen ||
      config.data.loadingScreen.progressBarWidthPercent !== 75
    ) {
      throw new Error('build_configuration_roundtrip_invalid');
    }

    const validation = await call('validation.run', {
      includeNativeReport: false,
      includeAssets: true,
    });
    if (!validation.data || validation.data.ok !== true) {
      throw new Error('project_validation_failed');
    }

    fs.rmSync(exportDir, { recursive: true, force: true });
    const html5 = await call('export.html5', { outputDir: exportDir });
    if (
      !html5.data ||
      html5.data.outputDir !== exportDir ||
      !fs.existsSync(exportDir)
    ) {
      throw new Error('html5_export_failed');
    }

    let installableBuild = {
      attempted: false,
      available: windowsTarget.availability.state === 'available',
      availability: windowsTarget.availability,
    };
    if (allowRemoteBuild && windowsTarget.availability.state === 'available') {
      const started = await call('build.start', {
        targetId: 'windows-exe',
        payWithCredits: false,
      });
      const buildId =
        started.data && started.data.build && started.data.build.buildId;
      if (!buildId) throw new Error('installable_build_id_missing');

      let finalStatus = started.data.build;
      for (let attempt = 0; attempt < 120; attempt++) {
        if (finalStatus.status !== 'pending') break;
        await wait(5000);
        finalStatus = (await call('build.status', { buildId })).data.build;
      }
      if (!finalStatus || finalStatus.status === 'pending') {
        throw new Error('installable_build_timeout');
      }
      const result = await call('build.result', { buildId });
      if (
        finalStatus.status !== 'complete' ||
        !result.data ||
        result.data.ready !== true ||
        result.data.succeeded !== true ||
        !Array.isArray(result.data.artifacts) ||
        !result.data.artifacts.some(
          artifact =>
            artifact.targetId === 'windows-exe' &&
            artifact.installable === true &&
            typeof artifact.url === 'string' &&
            /^https:\/\//.test(artifact.url)
        )
      ) {
        throw new Error(
          `installable_build_failed:${JSON.stringify(
            finalStatus.detectedErrors || []
          )}`
        );
      }
      installableBuild = {
        attempted: true,
        available: true,
        buildId,
        status: finalStatus.status,
        artifactCount: result.data.artifacts.length,
        targetId: 'windows-exe',
      };
    } else if (requireInstallable) {
      throw new Error(
        `installable_target_unavailable:${
          windowsTarget.availability && windowsTarget.availability.code
            ? windowsTarget.availability.code
            : 'not_available'
        }`
      );
    }

    if (rollback) {
      await call('safety.transactions.rollback', { transactionId });
      transactionId = null;
    }
    const finalStatus = await call('project.status');
    if (rollback && finalStatus.data.projectRevision !== originalRevision) {
      throw new Error(
        `rollback_revision_mismatch:${originalRevision}:${
          finalStatus.data.projectRevision
        }`
      );
    }

    const result = {
      ok: true,
      rollback,
      protocolVersion: client.getNegotiatedProtocolVersion(),
      toolCount: tools.tools.length,
      targets: {
        html5: html5Target,
        windowsExe: windowsTarget,
        explicitUnavailable: iosTarget,
      },
      configuration: config.data,
      html5: { outputDir: exportDir },
      installableBuild,
      validation: validation.data,
      originalRevision,
      finalRevision: finalStatus.data.projectRevision,
      replay,
    };
    fs.writeFileSync(
      path.join(outputDir, 'replay.json'),
      `${JSON.stringify(result, null, 2)}\n`
    );

    if (createdProject) {
      await call('project.close', { discardUnsavedChanges: true });
      createdProject = false;
    }
    if (cleanupProject)
      fs.rmSync(projectRoot, { recursive: true, force: true });
    return result;
  } catch (error) {
    if (transactionId) {
      try {
        await call('safety.transactions.rollback', { transactionId });
      } catch (_) {}
    }
    if (createdProject) {
      try {
        await call('project.close', { discardUnsavedChanges: true });
      } catch (_) {}
    }
    if (cleanupProject)
      fs.rmSync(projectRoot, { recursive: true, force: true });
    throw error;
  } finally {
    await client.close();
  }
};

const printHelp = () => {
  process.stdout.write(
    [
      'Usage: node AgentIntegration/scripts/McpBuildTargetsLiveScenario.js --allow-mutate [options]',
      '',
      'Exercises CAP-14 against a fresh desktop editor: target discovery, typed unavailable target, native packaging config round-trip, HTML5 export, optional authenticated Windows EXE cloud build, rollback and cleanup.',
      '',
      'Options:',
      '  --allow-mutate          Required explicit project-mutation opt-in.',
      '  --allow-remote-build    Explicitly allow consuming one remote build quota slot (never credits).',
      '  --require-installable   Fail unless the Windows EXE target is available and completes; requires --allow-remote-build.',
      '  --persist               Do not roll back configuration mutations.',
      '  --keep-project          Keep the temporary saved project directory.',
      '  --output <dir>          Sanitized replay/export evidence directory.',
      '  --window-id <id>        Optional editor targeting header.',
      '  --project-path <path>   Optional project targeting header.',
      '  --help                  Show help.',
      '',
    ].join('\n')
  );
};

if (require.main === module) {
  (async () => {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) return printHelp();
    const result = await runBuildTargetsLiveScenario(options);
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: result.ok,
          rollback: result.rollback,
          protocolVersion: result.protocolVersion,
          toolCount: result.toolCount,
          windowsAvailability: result.targets.windowsExe.availability,
          unavailableTarget: {
            id: result.targets.explicitUnavailable.id,
            availability: result.targets.explicitUnavailable.availability,
          },
          configuration: {
            packageName: result.configuration.packageName,
            version: result.configuration.version,
            orientation: result.configuration.orientation,
          },
          html5: result.html5,
          installableBuild: result.installableBuild,
          originalRevision: result.originalRevision,
          finalRevision: result.finalRevision,
        },
        null,
        2
      )}\n`
    );
  })().catch(error => {
    process.stderr.write(
      `MCP build-targets live scenario failed: ${
        error && error.message ? error.message : String(error)
      }\n`
    );
    process.exitCode = 1;
  });
}

module.exports = {
  REQUIRED_TOOLS,
  assertRequiredTools,
  findTarget,
  parseArgs,
  runBuildTargetsLiveScenario,
};
