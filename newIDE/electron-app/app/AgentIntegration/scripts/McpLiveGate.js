const fs = require('fs');
const path = require('path');
const {
  Client,
  StreamableHTTPClientTransport,
} = require('@modelcontextprotocol/client');

const DEFAULT_CLIENT_ID = 'gdevelop-live-gate';
const READ_ONLY_PROBE_TOOLS = [
  'agent.capabilities',
  'project.status',
  'desktop.windows.list',
  'editor.visual.status',
  'preview.status',
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

const getDefaultDiscoveryPath = env => {
  if (env.GDEVELOP_MCP_DISCOVERY) return env.GDEVELOP_MCP_DISCOVERY;
  if (!env.APPDATA) throw new Error('missing_appdata_for_mcp_discovery');
  return path.join(env.APPDATA, 'GDevelop 5', 'gdevelop-mcp.json');
};

const loadRuntimeConfig = discoveryPath => {
  const discovery = JSON.parse(fs.readFileSync(discoveryPath, 'utf8'));
  if (!discovery || discovery.service !== 'gdevelop-mcp') {
    throw new Error('invalid_gdevelop_mcp_discovery');
  }
  if (!discovery.endpoint || !discovery.protocolVersion) {
    throw new Error('incomplete_gdevelop_mcp_discovery');
  }
  const tokenFile = discovery.auth && discovery.auth.tokenFile;
  if (!tokenFile || typeof tokenFile !== 'string') {
    throw new Error('missing_gdevelop_mcp_token_file');
  }
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  if (!token) throw new Error('empty_gdevelop_mcp_token');
  return {
    endpoint: discovery.endpoint,
    protocolVersion: discovery.protocolVersion,
    token,
  };
};

const sanitizeForReplay = value => {
  if (Array.isArray(value)) return value.map(sanitizeForReplay);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !/authorization|bearer|token/i.test(key))
      .map(([key, child]) => [key, sanitizeForReplay(child)])
  );
};

const makeRequestHeaders = ({ token, clientId, windowId, projectPath }) => ({
  Authorization: `Bearer ${token}`,
  'X-GDevelop-Client-Id': clientId || DEFAULT_CLIENT_ID,
  ...(windowId ? { 'X-GDevelop-Window-Id': String(windowId) } : {}),
  ...(projectPath ? { 'X-GDevelop-Project-Path': projectPath } : {}),
});

const getToolData = response =>
  response && response.structuredContent
    ? response.structuredContent.data != null
      ? response.structuredContent.data
      : response.structuredContent
    : null;

const runLiveGate = async ({
  discoveryPath,
  outputPath,
  windowId,
  projectPath,
  clientId = DEFAULT_CLIENT_ID,
  env = process.env,
}) => {
  const runtime = loadRuntimeConfig(
    discoveryPath || getDefaultDiscoveryPath(env)
  );
  const client = new Client(
    { name: clientId, version: '1.0.0' },
    { versionNegotiation: { mode: { pin: runtime.protocolVersion } } }
  );
  const transport = new StreamableHTTPClientTransport(
    new URL(runtime.endpoint),
    {
      requestInit: {
        headers: makeRequestHeaders({
          token: runtime.token,
          clientId,
          windowId,
          projectPath,
        }),
      },
    }
  );

  const replay = [];
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const toolNames = new Set(tools.tools.map(tool => tool.name));
    replay.push({
      kind: 'tools/list',
      toolCount: tools.tools.length,
      tools: tools.tools.map(tool => tool.name).sort(),
    });

    for (const name of READ_ONLY_PROBE_TOOLS) {
      if (!toolNames.has(name)) {
        replay.push({ kind: 'tool', name, status: 'missing' });
        continue;
      }
      const response = await client.callTool({ name, arguments: {} });
      replay.push({
        kind: 'tool',
        name,
        status: 'ok',
        data: sanitizeForReplay(getToolData(response)),
      });
    }

    const result = {
      ok: true,
      mode: 'read-only',
      protocolVersion: client.getNegotiatedProtocolVersion(),
      replay,
    };
    const serialized = `${JSON.stringify(result, null, 2)}\n`;
    if (outputPath) fs.writeFileSync(outputPath, serialized);
    return result;
  } finally {
    await client.close();
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
