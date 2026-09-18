const fs = require('fs');
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
  'build.targets.list',
  'publication.integrations.list',
  'publication.prepare',
  'publication.publish',
];

const getData = response =>
  response && response.structuredContent
    ? response.structuredContent.data != null
      ? response.structuredContent.data
      : response.structuredContent
    : null;

const parseArgs = argv => {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--output') options.outputPath = argv[++index];
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
  if (missing.length) {
    throw new Error(`publication_tools_missing:${missing.join(',')}`);
  }

  for (const name of [
    'build.targets.list',
    'publication.integrations.list',
    'publication.prepare',
  ]) {
    const tool = byName.get(name);
    if (
      !tool.annotations ||
      tool.annotations.readOnlyHint !== true ||
      tool.annotations.destructiveHint !== false
    ) {
      throw new Error(`publication_readonly_annotations_invalid:${name}`);
    }
  }

  const publish = byName.get('publication.publish');
  if (
    !publish.annotations ||
    publish.annotations.readOnlyHint !== false ||
    publish.annotations.destructiveHint !== true ||
    publish.annotations.idempotentHint !== true
  ) {
    throw new Error('publication_publish_annotations_invalid');
  }

  return byName;
};

const assertPublicationCapabilities = ({ integrations, targets }) => {
  const gdGames = (integrations || []).find(
    integration => integration && integration.id === 'gd-games'
  );
  if (!gdGames) throw new Error('gd_games_integration_missing');
  if (
    !gdGames.capabilities ||
    gdGames.capabilities.dryRunManifest !== true ||
    gdGames.capabilities.publishExistingBuild !== true ||
    gdGames.capabilities.unpublish !== false
  ) {
    throw new Error('gd_games_capabilities_invalid');
  }
  if (
    !gdGames.credentialHandling ||
    gdGames.credentialHandling.source !== 'editor-session' ||
    gdGames.credentialHandling.exposedToAgent !== false ||
    gdGames.credentialHandling.persistedByAgent !== false ||
    gdGames.credentialHandling.acceptedFromCommandInput !== false
  ) {
    throw new Error('gd_games_credential_policy_invalid');
  }
  if (
    !gdGames.prerequisites ||
    gdGames.prerequisites.artifactKind !== 'web-build' ||
    gdGames.prerequisites.buildTargetId !== 'web-online'
  ) {
    throw new Error('gd_games_prerequisite_invalid');
  }

  const webTarget = (targets || []).find(
    target => target && target.id === 'web-online'
  );
  if (
    !webTarget ||
    webTarget.deliveryKind !== 'remote-build' ||
    webTarget.platform !== 'web' ||
    webTarget.artifactKind !== 'web' ||
    !webTarget.provider ||
    webTarget.provider.buildType !== 'web-build' ||
    webTarget.provider.target !== 's3'
  ) {
    throw new Error('publication_web_build_target_invalid');
  }

  return { gdGames, webTarget };
};

const runPublicationLiveScenario = async ({
  outputPath,
  windowId,
  projectPath,
  env = process.env,
}) => {
  const runtime = loadRuntimeConfig(getDefaultDiscoveryPath(env));
  const client = new Client(
    { name: 'gdevelop-publication-live-e2e', version: '1.0.0' },
    { versionNegotiation: { mode: { pin: runtime.protocolVersion } } }
  );
  const transport = new StreamableHTTPClientTransport(
    new URL(runtime.endpoint),
    {
      requestInit: {
        headers: makeRequestHeaders({
          token: runtime.token,
          clientId: 'gdevelop-publication-live-e2e',
          windowId,
          projectPath,
        }),
      },
    }
  );

  try {
    await client.connect(transport);
    const listedTools = await client.listTools();
    assertRequiredTools(listedTools.tools);

    const integrationsResponse = await client.callTool({
      name: 'publication.integrations.list',
      arguments: {},
    });
    if (integrationsResponse.isError) {
      throw new Error('publication_integrations_list_failed');
    }
    const integrationsData = getData(integrationsResponse);
    if (!integrationsData || !Array.isArray(integrationsData.integrations)) {
      throw new Error('publication_integrations_invalid');
    }

    const targetsResponse = await client.callTool({
      name: 'build.targets.list',
      arguments: {},
    });
    if (targetsResponse.isError) throw new Error('build_targets_list_failed');
    const targetsData = getData(targetsResponse);
    if (!targetsData || !Array.isArray(targetsData.targets)) {
      throw new Error('publication_build_targets_invalid');
    }

    const { gdGames, webTarget } = assertPublicationCapabilities({
      integrations: integrationsData.integrations,
      targets: targetsData.targets,
    });

    const sanitized = sanitizeForReplay({
      integration: gdGames,
      webTarget,
    });
    const serialized = JSON.stringify(sanitized);
    if (
      /Bearer\s|authorizationHeader|firebaseUser|profile\.id/i.test(serialized)
    ) {
      throw new Error('publication_discovery_leaked_credentials');
    }

    const result = {
      ok: true,
      mode: 'read-only',
      protocolVersion: client.getNegotiatedProtocolVersion(),
      toolCount: listedTools.tools.length,
      integration: sanitized.integration,
      webTarget: sanitized.webTarget,
    };

    if (outputPath) {
      fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
      fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
    }
    return result;
  } finally {
    await client.close();
  }
};

const printHelp = () => {
  process.stdout.write(
    [
      'Usage: node AgentIntegration/scripts/McpPublicationLiveScenario.js [options]',
      '',
      'Read-only CAP-24 live gate for publication capability discovery.',
      'It never creates a remote build and never publishes a game.',
      '',
      'Options:',
      '  --output <file>        Write sanitized evidence JSON.',
      '  --window-id <id>       Optional editor targeting header.',
      '  --project-path <path>  Optional project targeting header.',
      '  --help                 Show help.',
      '',
    ].join('\n')
  );
};

if (require.main === module) {
  (async () => {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) return printHelp();
    const result = await runPublicationLiveScenario(options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  })().catch(error => {
    process.stderr.write(
      `MCP publication live scenario failed: ${
        error && error.message ? error.message : String(error)
      }\n`
    );
    process.exitCode = 1;
  });
}

module.exports = {
  REQUIRED_TOOLS,
  assertPublicationCapabilities,
  assertRequiredTools,
  parseArgs,
  runPublicationLiveScenario,
};
