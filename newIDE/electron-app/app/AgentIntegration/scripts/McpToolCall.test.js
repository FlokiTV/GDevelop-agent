const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  formatOutput,
  loadArguments,
  parseArgs,
  runToolCall,
  toolRequiresMutationOptIn,
} = require('./McpToolCall');

const readOnlyTool = {
  name: 'project.status',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
  },
  _meta: {
    'gdevelop/modifiesProject': false,
  },
};

const mutatingTool = {
  name: 'events.update',
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
  },
  _meta: {
    'gdevelop/modifiesProject': true,
  },
};

const destructiveTool = {
  name: 'project.open',
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
  },
  _meta: {
    'gdevelop/modifiesProject': true,
  },
};

const makeSession = ({
  tools = [readOnlyTool, mutatingTool],
  result,
  throwOnCall,
} = {}) => {
  const state = {
    callCount: 0,
    closeCount: 0,
  };
  const session = {
    protocolVersion: '2026-07-28',
    target: { windowId: '17' },
    async listTools() {
      return tools;
    },
    async call(name, args) {
      state.callCount++;
      if (throwOnCall) throw throwOnCall;
      return (
        result || {
          name,
          isError: false,
          data: { projectOpen: true, args },
          meta: { readOnly: true, modifiesProject: false },
          structuredContent: {
            command: name,
            data: { projectOpen: true, args },
            meta: { readOnly: true, modifiesProject: false },
          },
          content: [],
        }
      );
    },
    async close() {
      state.closeCount++;
    },
  };
  return { session, state };
};

test('parses one-off CLI targeting, output and mutation options', () => {
  assert.deepEqual(
    parseArgs([
      'events.read',
      '--json',
      '{"sceneName":"CoinIdle"}',
      '--project-path',
      'C:/game/game.json',
      '--window-id',
      '17',
      '--client-id',
      'dx6-cli',
      '--sanitized',
      '--allow-mutate',
      '--output',
      'result.json',
    ]),
    {
      allowMutate: true,
      outputMode: 'sanitized',
      toolName: 'events.read',
      json: '{"sceneName":"CoinIdle"}',
      projectPath: 'C:/game/game.json',
      windowId: '17',
      clientId: 'dx6-cli',
      outputPath: 'result.json',
    }
  );
  assert.throws(
    () => parseArgs(['project.status', '--raw', '--sanitized']),
    /ambiguous_output_mode/
  );
  assert.throws(
    () =>
      parseArgs(['project.status', '--json', '{}', '--json-file', 'args.json']),
    /ambiguous_json_arguments/
  );
  assert.throws(() => parseArgs(['--unknown']), /unknown_argument/);
});

test('loads inline and file JSON arguments as objects only', () => {
  assert.deepEqual(loadArguments({ json: '{"sceneName":"CoinIdle"}' }), {
    sceneName: 'CoinIdle',
  });

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-mcp-cli-'));
  const argsPath = path.join(tempDir, 'args.json');
  fs.writeFileSync(argsPath, '{"sceneName":"CoinIdle","limit":10}');
  try {
    assert.deepEqual(loadArguments({ jsonFile: argsPath }), {
      sceneName: 'CoinIdle',
      limit: 10,
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  assert.throws(
    () => loadArguments({ json: '["not-an-object"]' }),
    /invalid_json_arguments_object/
  );
  assert.throws(
    () => loadArguments({ json: '{"broken"' }),
    /invalid_json_arguments/
  );
});

test('classifies read-only, mutating, destructive and unknown tools conservatively', () => {
  assert.equal(toolRequiresMutationOptIn(readOnlyTool), false);
  assert.equal(toolRequiresMutationOptIn(mutatingTool), true);
  assert.equal(toolRequiresMutationOptIn(destructiveTool), true);
  assert.equal(toolRequiresMutationOptIn({ name: 'future.tool' }), true);
});

test('runs a read-only call without opt-in and returns authoritative raw structured output', async () => {
  const { session, state } = makeSession();
  const result = await runToolCall(
    {
      toolName: 'project.status',
      outputMode: 'raw',
      allowMutate: false,
    },
    { connect: async () => session }
  );

  assert.equal(state.callCount, 1);
  assert.equal(state.closeCount, 1);
  assert.deepEqual(result.output, {
    command: 'project.status',
    data: { projectOpen: true, args: {} },
    meta: { readOnly: true, modifiesProject: false },
  });
});

test('blocks mutation without --allow-mutate before tools/call and always closes', async () => {
  const { session, state } = makeSession();
  await assert.rejects(
    runToolCall(
      {
        toolName: 'events.update',
        outputMode: 'raw',
        allowMutate: false,
      },
      { connect: async () => session }
    ),
    /mutation_requires_allow_mutate:events\.update/
  );
  assert.equal(state.callCount, 0);
  assert.equal(state.closeCount, 1);
});

test('allows opted-in mutation exactly once without hidden retry', async () => {
  const { session, state } = makeSession();
  const result = await runToolCall(
    {
      toolName: 'events.update',
      json: '{"handle":"event:1"}',
      outputMode: 'raw',
      allowMutate: true,
    },
    { connect: async () => session }
  );
  assert.equal(state.callCount, 1);
  assert.equal(state.closeCount, 1);
  assert.equal(result.output.command, 'events.update');
});

test('does not retry a failed tool call', async () => {
  const { session, state } = makeSession({
    throwOnCall: new Error('renderer_failed'),
  });
  await assert.rejects(
    runToolCall(
      {
        toolName: 'project.status',
        outputMode: 'raw',
        allowMutate: false,
      },
      { connect: async () => session }
    ),
    /renderer_failed/
  );
  assert.equal(state.callCount, 1);
  assert.equal(state.closeCount, 1);
});

test('sanitized mode is replay evidence while raw mode preserves canonical fields', () => {
  const result = {
    structuredContent: {
      command: 'events.read',
      data: {
        eventsJson: [
          {
            type: 'BuiltinCommonInstructions::Comment',
            color: {
              r: 255,
              g: 230,
              b: 109,
              textR: 0,
              textG: 0,
              textB: 0,
            },
          },
        ],
        authToken: 'must-not-persist',
      },
      meta: { readOnly: true, modifiesProject: false },
    },
  };
  const session = {
    protocolVersion: '2026-07-28',
    target: { projectPath: 'C:/game/game.json' },
  };

  const raw = formatOutput({
    toolName: 'events.read',
    args: { sceneName: 'CoinIdle' },
    result,
    session,
    outputMode: 'raw',
  });
  assert.equal(raw.data.eventsJson[0].color.textB, 0);
  assert.equal(raw.data.authToken, 'must-not-persist');

  const sanitized = formatOutput({
    toolName: 'events.read',
    args: { sceneName: 'CoinIdle', token: 'remove-me' },
    result,
    session,
    outputMode: 'sanitized',
  });
  assert.equal(sanitized.result.data.authToken, undefined);
  assert.equal(sanitized.arguments.token, undefined);
  assert.equal(sanitized.result.data.eventsJson[0].color.textB, 0);
  assert.equal(sanitized.kind, 'mcp-tool-call');
});
