const test = require('node:test');
const assert = require('node:assert/strict');
const {
  Client,
  StreamableHTTPClientTransport,
} = require('@modelcontextprotocol/client');
const { PROTOCOL_VERSION } = require('./McpServerFactory');
const { startMcpHttpServer } = require('./McpHttpServer');
const { RESOURCE_DEFINITIONS, toResourceContents } = require('./McpResources');

const connectClient = async ({ url, token, windowId }) => {
  const client = new Client(
    { name: 'gdevelop-resources-test', version: '1.0.0' },
    { versionNegotiation: { mode: { pin: PROTOCOL_VERSION } } }
  );
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-GDevelop-Window-Id': String(windowId),
      },
    },
  });
  await client.connect(transport);
  return client;
};

test('resource catalog is deterministic and serializes command envelopes as JSON', () => {
  assert.deepEqual(RESOURCE_DEFINITIONS.map(resource => resource.uri), [
    'gdevelop://project/status',
    'gdevelop://editor/visual',
    'gdevelop://project/resources',
  ]);
  const result = toResourceContents(RESOURCE_DEFINITIONS[0], {
    command: 'project.status',
    data: { projectOpen: true },
    meta: { projectRevision: 4 },
  });
  assert.equal(result.contents.length, 1);
  assert.equal(result.contents[0].mimeType, 'application/json');
  assert.equal(result.contents[0].uri, 'gdevelop://project/status');
  assert.deepEqual(JSON.parse(result.contents[0].text).data, {
    projectOpen: true,
  });
});

test('official MCP client lists and reads fresh targeted GDevelop resources', async () => {
  let projectRevision = 7;
  const calls = [];
  const rendererBridge = {
    executeCommand: async options => {
      calls.push(options);
      if (options.command === 'agent.commands.list') {
        return {
          command: options.command,
          data: { commands: [] },
          meta: { readOnly: true, modifiesProject: false },
        };
      }
      if (options.command === 'project.status') {
        return {
          command: options.command,
          data: { projectOpen: true, projectName: 'Live', projectRevision },
          meta: { readOnly: true, modifiesProject: false, projectRevision },
        };
      }
      if (options.command === 'editor.visual.status') {
        return {
          command: options.command,
          data: {
            openSceneEditors: [
              { sceneName: 'Game', active: true, editorReady: true },
            ],
          },
          meta: { readOnly: true, modifiesProject: false, projectRevision },
        };
      }
      if (options.command === 'resources.list') {
        return {
          command: options.command,
          data: {
            resources: [{ name: 'player.png', usedInProject: true }],
            summary: { total: 1, used: 1 },
          },
          meta: { readOnly: true, modifiesProject: false, projectRevision },
        };
      }
      throw new Error(`unexpected_command:${options.command}`);
    },
  };
  const token = 'resource-token';
  const host = await startMcpHttpServer({
    rendererBridge,
    token,
    port: 0,
  });
  const client = await connectClient({ url: host.url, token, windowId: 17 });

  try {
    const listed = await client.listResources();
    assert.deepEqual(
      listed.resources.map(resource => resource.uri),
      RESOURCE_DEFINITIONS.map(resource => resource.uri)
    );
    listed.resources.forEach(resource => {
      assert.equal(resource.mimeType, 'application/json');
      assert.equal(resource._meta['gdevelop/cacheScope'], 'request');
      assert.equal(resource._meta['gdevelop/live'], true);
    });

    const status = await client.readResource({
      uri: 'gdevelop://project/status',
    });
    const firstStatus = JSON.parse(status.contents[0].text);
    assert.equal(firstStatus.data.projectRevision, 7);

    projectRevision = 8;
    const refreshedStatus = await client.readResource({
      uri: 'gdevelop://project/status',
    });
    const secondStatus = JSON.parse(refreshedStatus.contents[0].text);
    assert.equal(secondStatus.data.projectRevision, 8);

    const visual = await client.readResource({
      uri: 'gdevelop://editor/visual',
    });
    assert.equal(
      JSON.parse(visual.contents[0].text).data.openSceneEditors[0].sceneName,
      'Game'
    );

    const resources = await client.readResource({
      uri: 'gdevelop://project/resources',
    });
    assert.equal(JSON.parse(resources.contents[0].text).data.summary.total, 1);

    const snapshotCalls = calls.filter(call =>
      ['project.status', 'editor.visual.status', 'resources.list'].includes(
        call.command
      )
    );
    assert.equal(snapshotCalls.length, 4);
    snapshotCalls.forEach(call => assert.equal(call.windowId, '17'));
  } finally {
    await client.close();
    await host.stop();
  }
});
