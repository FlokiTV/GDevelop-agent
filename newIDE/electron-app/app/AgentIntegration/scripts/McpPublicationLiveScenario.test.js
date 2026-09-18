const test = require('node:test');
const assert = require('node:assert/strict');
const {
  REQUIRED_TOOLS,
  assertPublicationCapabilities,
  assertRequiredTools,
  parseArgs,
} = require('./McpPublicationLiveScenario');

test('parseArgs keeps CAP-24 live gate read-only', () => {
  assert.deepEqual(
    parseArgs([
      '--output',
      'artifacts/cap24.json',
      '--window-id',
      '7',
      '--project-path',
      'C:/game.json',
    ]),
    {
      outputPath: 'artifacts/cap24.json',
      windowId: '7',
      projectPath: 'C:/game.json',
    }
  );
  assert.throws(() => parseArgs(['--allow-publish']), /unknown_argument/);
});

test('assertRequiredTools enforces CAP-24 publication annotations', () => {
  const tools = REQUIRED_TOOLS.map(name => ({
    name,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
  }));
  const publish = tools.find(tool => tool.name === 'publication.publish');
  publish.annotations.readOnlyHint = false;
  publish.annotations.destructiveHint = true;

  assert.doesNotThrow(() => assertRequiredTools(tools));

  publish.annotations.destructiveHint = false;
  assert.throws(
    () => assertRequiredTools(tools),
    /publication_publish_annotations_invalid/
  );
});

test('assertPublicationCapabilities links gd.games to web-online without credentials', () => {
  const result = assertPublicationCapabilities({
    integrations: [
      {
        id: 'gd-games',
        capabilities: {
          dryRunManifest: true,
          publishExistingBuild: true,
          unpublish: false,
        },
        credentialHandling: {
          source: 'editor-session',
          exposedToAgent: false,
          persistedByAgent: false,
          acceptedFromCommandInput: false,
        },
        prerequisites: {
          artifactKind: 'web-build',
          buildTargetId: 'web-online',
        },
      },
    ],
    targets: [
      {
        id: 'web-online',
        deliveryKind: 'remote-build',
        platform: 'web',
        artifactKind: 'web',
        provider: { buildType: 'web-build', target: 's3' },
      },
    ],
  });

  assert.equal(result.gdGames.id, 'gd-games');
  assert.equal(result.webTarget.id, 'web-online');
});
