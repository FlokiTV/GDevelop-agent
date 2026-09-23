const fs = require('fs');
const {
  connectLiveGDevelopMcp,
  getDefaultDiscoveryPath,
  loadRuntimeConfig,
  makeRequestHeaders,
  sanitizeForReplay,
} = require('./McpClient');

const DEFAULT_CLIENT_ID = 'gdevelop-live-gate';
const READ_ONLY_PROBE_TOOLS = [
  'agent.capabilities',
  'project.status',
  'desktop.windows.list',
  'editor.visual.status',
  'preview.status',
  'publication.integrations.list',
  'runtime.status',
];

const parseArgs = argv => {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--discovery') options.discoveryPath = argv[++index];
    else if (argument === '--output') options.outputPath = argv[++index];
    else if (argument === '--window-id') options.windowId = argv[++index];
    else if (argument === '--project-path') options.projectPath = argv[++index];
    else if (argument === '--client-id') options.clientId = argv[++index];
    else if (argument === '--help') options.help = true;
    else throw new Error(`unknown_argument:${argument}`);
  }
  return options;
};

const runLiveGate = async ({
  discoveryPath,
  outputPath,
  windowId,
  projectPath,
  clientId = DEFAULT_CLIENT_ID,
  env = process.env,
}) => {
  const session = await connectLiveGDevelopMcp({
    discoveryPath,
    windowId,
    projectPath,
    clientId,
    env,
  });

  const replay = [];
  try {
    const tools = await session.listTools();
    const toolNames = new Set(tools.map(tool => tool.name));
    replay.push({
      kind: 'tools/list',
      toolCount: tools.length,
      tools: tools.map(tool => tool.name).sort(),
    });

    for (const name of READ_ONLY_PROBE_TOOLS) {
      if (!toolNames.has(name)) {
        replay.push({ kind: 'tool', name, status: 'missing' });
        continue;
      }
      const response = await session.call(name, {});
      replay.push({
        kind: 'tool',
        name,
        status: response.isError ? 'error' : 'ok',
        data: sanitizeForReplay(response.data),
      });
    }

    const result = {
      ok: true,
      mode: 'read-only',
      protocolVersion: session.protocolVersion,
      replay,
    };
    const serialized = `${JSON.stringify(result, null, 2)}\n`;
    if (outputPath) fs.writeFileSync(outputPath, serialized);
    return result;
  } finally {
    await session.close();
  }
};

const printHelp = () => {
  process.stdout.write(
    [
      'Usage: node AgentIntegration/scripts/McpLiveGate.js [options]',
      '',
      'Read-only live MCP gate for a running GDevelop desktop editor.',
      'Credentials are loaded from discovery/token files and never printed.',
      '',
      'Options:',
      '  --discovery <path>   Override gdevelop-mcp.json path.',
      '  --output <path>      Write sanitized replay JSON.',
      '  --window-id <id>     Target one editor BrowserWindow.',
      '  --project-path <p>   Target one project path.',
      '  --client-id <id>     Override admission-control client id.',
      '  --help               Show this help.',
      '',
    ].join('\n')
  );
};

if (require.main === module) {
  (async () => {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      printHelp();
      return;
    }
    const result = await runLiveGate(options);
    if (!options.outputPath) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    }
  })().catch(error => {
    const code = error && error.code ? ` code=${String(error.code)}` : '';
    const message = error && error.message ? error.message : String(error);
    process.stderr.write(`MCP live gate failed:${code} ${message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_CLIENT_ID,
  READ_ONLY_PROBE_TOOLS,
  getDefaultDiscoveryPath,
  loadRuntimeConfig,
  makeRequestHeaders,
  parseArgs,
  runLiveGate,
  sanitizeForReplay,
};
