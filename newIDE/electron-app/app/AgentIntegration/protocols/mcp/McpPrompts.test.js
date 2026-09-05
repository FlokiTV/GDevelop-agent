const test = require('node:test');
const assert = require('node:assert/strict');
const {
  Client,
  StreamableHTTPClientTransport,
} = require('@modelcontextprotocol/client');
const { PROTOCOL_VERSION } = require('./McpServerFactory');
const { startMcpHttpServer } = require('./McpHttpServer');
const { PROMPTS, PROMPT_META, toPromptResult } = require('./McpPrompts');

const connectClient = async ({ url, token }) => {
  const client = new Client(
    { name: 'gdevelop-prompts-test', version: '1.0.0' },
    { versionNegotiation: { mode: { pin: PROTOCOL_VERSION } } }
  );
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: {
      headers: { Authorization: `Bearer ${token}` },
    },
  });
  await client.connect(transport);
  return client;
};

test('prompt catalog is deterministic, versioned and schema-free', () => {
  assert.deepEqual(PROMPTS.map(prompt => prompt.name), [
    'gdevelop.bootstrap',
    'gdevelop.safe-edit',
    'gdevelop.scene-authoring',
    'gdevelop.events-authoring',
    'gdevelop.preview-playtest',
    'gdevelop.validate-export',
  ]);
  assert.deepEqual(PROMPT_META, {
    'gdevelop/cacheScope': 'process',
    'gdevelop/ttlMs': 60000,
    'gdevelop/promptVersion': 1,
  });
  PROMPTS.forEach(prompt => {
    assert.ok(prompt.description.length > 0);
    assert.ok(prompt.text.length > 0);
    assert.equal('argsSchema' in prompt, false);
    assert.deepEqual(prompt._meta, PROMPT_META);
    const result = toPromptResult(prompt);
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].role, 'user');
    assert.equal(result.messages[0].content.type, 'text');
  });
});

test('official MCP client lists and gets GDevelop workflow prompts', async () => {
  const rendererBridge = {
    executeCommand: async ({ command }) => {
      if (command !== 'agent.commands.list') {
        throw new Error(`unexpected_command:${command}`);
      }
      return {
        command,
        data: { commands: [] },
        meta: { readOnly: true, modifiesProject: false },
      };
    },
  };
  const token = 'prompt-token';
  const host = await startMcpHttpServer({
    rendererBridge,
    token,
    port: 0,
  });
  const client = await connectClient({ url: host.url, token });

  try {
    const listed = await client.listPrompts();
    assert.deepEqual(
      listed.prompts.map(prompt => prompt.name),
      PROMPTS.map(prompt => prompt.name)
    );
    listed.prompts.forEach(prompt => {
      assert.deepEqual(prompt._meta, PROMPT_META);
      assert.equal(prompt.arguments, undefined);
    });

    const bootstrap = await client.getPrompt({ name: 'gdevelop.bootstrap' });
    assert.equal(bootstrap.messages.length, 1);
    assert.match(bootstrap.messages[0].content.text, /project\.status/);
    assert.match(bootstrap.messages[0].content.text, /projectRevision/);

    const safeEdit = await client.getPrompt({ name: 'gdevelop.safe-edit' });
    assert.match(safeEdit.messages[0].content.text, /checkpoint|transaction/);
    assert.match(safeEdit.messages[0].content.text, /stale-write/);
    assert.match(
      safeEdit.messages[0].content.text,
      /Saving is always an explicit/
    );

    const scene = await client.getPrompt({
      name: 'gdevelop.scene-authoring',
    });
    assert.match(scene.messages[0].content.text, /2D\/3D|3D/);
    assert.match(scene.messages[0].content.text, /editor\.instances\.select/);

    const events = await client.getPrompt({
      name: 'gdevelop.events-authoring',
    });
    assert.match(events.messages[0].content.text, /events\.read/);
    assert.match(events.messages[0].content.text, /expectedEventsRevision/);

    const preview = await client.getPrompt({
      name: 'gdevelop.preview-playtest',
    });
    assert.match(preview.messages[0].content.text, /preview\.hot-reload/);
    assert.match(preview.messages[0].content.text, /runtime\.snapshot/);

    const finish = await client.getPrompt({
      name: 'gdevelop.validate-export',
    });
    assert.match(finish.messages[0].content.text, /validation\.run/);
    assert.match(finish.messages[0].content.text, /project\.save/);
    assert.match(finish.messages[0].content.text, /export\.html5/);
  } finally {
    await client.close();
    await host.stop();
  }
});
