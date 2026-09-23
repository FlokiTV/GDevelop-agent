const fs = require('fs');
const {
  DEFAULT_CLIENT_ID,
  connectLiveGDevelopMcp,
  sanitizeForReplay,
} = require('./McpClient');

const parseJsonObject = (serialized, source) => {
  let value;
  try {
    value = JSON.parse(serialized);
  } catch (error) {
    throw new Error(`invalid_json_arguments:${source}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`invalid_json_arguments_object:${source}`);
  }
  return value;
};

const parseArgs = argv => {
  const options = {
    allowMutate: false,
    outputMode: 'raw',
  };
  let outputModeExplicit = false;

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--json') options.json = argv[++index];
    else if (argument === '--json-file') options.jsonFile = argv[++index];
    else if (argument === '--discovery') options.discoveryPath = argv[++index];
    else if (argument === '--window-id') options.windowId = argv[++index];
    else if (argument === '--project-path') options.projectPath = argv[++index];
    else if (argument === '--client-id') options.clientId = argv[++index];
    else if (argument === '--output') options.outputPath = argv[++index];
    else if (argument === '--allow-mutate') options.allowMutate = true;
    else if (argument === '--raw' || argument === '--sanitized') {
      const nextMode = argument === '--raw' ? 'raw' : 'sanitized';
      if (outputModeExplicit && options.outputMode !== nextMode) {
        throw new Error('ambiguous_output_mode');
      }
      options.outputMode = nextMode;
      outputModeExplicit = true;
    } else if (argument === '--help') options.help = true;
    else if (argument.startsWith('--')) {
      throw new Error(`unknown_argument:${argument}`);
    } else if (!options.toolName) {
      options.toolName = argument;
    } else {
      throw new Error(`unexpected_argument:${argument}`);
    }
  }

  if (options.json !== undefined && options.jsonFile !== undefined) {
    throw new Error('ambiguous_json_arguments');
  }
  return options;
};

const loadArguments = options => {
  if (options.jsonFile !== undefined) {
    const serialized = fs.readFileSync(options.jsonFile, 'utf8');
    return parseJsonObject(serialized, 'file');
  }
  if (options.json !== undefined) {
    return parseJsonObject(options.json, 'inline');
  }
  return {};
};

const toolRequiresMutationOptIn = tool => {
  if (!tool || typeof tool !== 'object') return true;
  const metadata = tool._meta || {};
  const annotations = tool.annotations || {};
  if (metadata['gdevelop/modifiesProject'] === true) return true;
  if (annotations.destructiveHint === true) return true;
  return annotations.readOnlyHint !== true;
};

const getRawStructuredOutput = result => {
  if (result && result.structuredContent != null) {
    return result.structuredContent;
  }
  return {
    isError: !!(result && result.isError),
    content: result && Array.isArray(result.content) ? result.content : [],
  };
};

const formatOutput = ({ toolName, args, result, session, outputMode }) => {
  const raw = getRawStructuredOutput(result);
  if (outputMode === 'raw') return raw;
  return sanitizeForReplay({
    kind: 'mcp-tool-call',
    name: toolName,
    arguments: args,
    protocolVersion: session.protocolVersion,
    target: session.target,
    result: raw,
  });
};

const runToolCall = async (
  options,
  { connect = connectLiveGDevelopMcp } = {}
) => {
  if (!options.toolName || typeof options.toolName !== 'string') {
    throw new Error('missing_mcp_tool_name');
  }
  const args = loadArguments(options);
  const session = await connect({
    discoveryPath: options.discoveryPath,
    windowId: options.windowId,
    projectPath: options.projectPath,
    clientId: options.clientId || DEFAULT_CLIENT_ID,
  });

  try {
    const tools = await session.listTools();
    const tool = tools.find(candidate => candidate.name === options.toolName);
    if (!tool) throw new Error(`mcp_tool_not_found:${options.toolName}`);

    if (toolRequiresMutationOptIn(tool) && !options.allowMutate) {
      throw new Error(`mutation_requires_allow_mutate:${options.toolName}`);
    }

    const result = await session.call(options.toolName, args);
    return {
      output: formatOutput({
        toolName: options.toolName,
        args,
        result,
        session,
        outputMode: options.outputMode || 'raw',
      }),
      result,
      tool,
      protocolVersion: session.protocolVersion,
    };
  } finally {
    await session.close();
  }
};

const printHelp = () => {
  process.stdout.write(
    [
      'Usage: node AgentIntegration/scripts/McpToolCall.js <tool> [options]',
      '',
      'Safe one-off client for a running GDevelop MCP endpoint.',
      'Discovery credentials are used only for transport and are never printed.',
      '',
      'Examples:',
      '  node app/AgentIntegration/scripts/McpToolCall.js project.status',
      '  node app/AgentIntegration/scripts/McpToolCall.js events.read --json "{\\"sceneName\\":\\"CoinIdle\\"}"',
      '  node app/AgentIntegration/scripts/McpToolCall.js events.read --json-file args.json --sanitized',
      '',
      'Options:',
      '  --json <object>       MCP tool arguments as a JSON object.',
      '  --json-file <path>    Read MCP tool arguments from a JSON file.',
      '  --raw                 Print authoritative structured tool output (default).',
      '  --sanitized           Print replay/evidence output with credential-like keys removed.',
      '  --allow-mutate         Explicitly allow non-read-only/destructive tool calls.',
      '  --discovery <path>     Override gdevelop-mcp.json path.',
      '  --window-id <id>       Target one editor BrowserWindow.',
      '  --project-path <path>  Target one project path.',
      '  --client-id <id>       Override admission-control client id.',
      '  --output <path>        Write JSON output to a file instead of stdout.',
      '  --help                 Show this help.',
      '',
      'Raw output is the live authoring result. Sanitized output is evidence only.',
      'Server-side destructive elicitation/confirmation still applies.',
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
    const result = await runToolCall(options);
    const serialized = `${JSON.stringify(result.output, null, 2)}\n`;
    if (options.outputPath) fs.writeFileSync(options.outputPath, serialized);
    else process.stdout.write(serialized);
  })().catch(error => {
    const message = error && error.message ? error.message : String(error);
    process.stderr.write(`MCP tool call failed: ${message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  formatOutput,
  getRawStructuredOutput,
  loadArguments,
  parseArgs,
  runToolCall,
  toolRequiresMutationOptIn,
};
