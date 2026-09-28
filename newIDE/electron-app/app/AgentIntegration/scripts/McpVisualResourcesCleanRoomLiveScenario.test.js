const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const {
  assertVisualToolSchemas,
  chooseResourceProperty,
  extractError,
  makePng,
  usageSignature,
} = require('./McpVisualResourcesCleanRoomLiveScenario');

const REQUIRED_TOOLS = [
  'project.status',
  'project.create',
  'project.save-as',
  'project.close',
  'project.persistence.status',
  'editor.types.objects.list',
  'editor.functions.create-scene',
  'editor.functions.create-object',
  'objects.properties.describe',
  'objects.properties.set',
  'scene.instances.create',
  'scene.open',
  'resources.visual.import',
  'resources.visual.inspect',
  'resources.visual.replace',
  'resources.visual.relocate',
  'resources.visual.delete',
  'resources.packaging.inspect',
  'safety.transactions.begin',
  'safety.transactions.rollback',
  'validation.run',
  'preview.status',
  'preview.start',
  'preview.close-all',
  'desktop.windows.list',
];

const makeToolSet = () =>
  REQUIRED_TOOLS.map(name => ({
    name,
    inputSchema: { type: 'object', properties: {} },
  })).map(tool => {
    if (tool.name === 'resources.visual.import') {
      tool.inputSchema.properties = {
        contentBase64: { type: 'string' },
        kind: { type: 'string', enum: ['image', 'font'] },
      };
    } else if (tool.name === 'resources.visual.replace') {
      tool.inputSchema.properties = {
        contentBase64: { type: 'string' },
      };
    } else if (
      tool.name === 'resources.visual.relocate' ||
      tool.name === 'resources.visual.delete'
    ) {
      tool.inputSchema.properties = {
        dryRun: { type: 'boolean', default: true },
      };
    }
    return tool;
  });

test('resource-property discovery prefers live descriptor resource semantics', () => {
  const described = {
    properties: [
      {
        name: 'text',
        path: 'configuration.text',
        descriptorType: 'string',
        valueType: 'string',
        writable: true,
      },
      {
        name: 'font',
        path: 'configuration.font',
        descriptorType: 'resource',
        valueType: 'string',
        writable: true,
        constraints: { extraInfo: ['font'] },
      },
      {
        name: 'texture',
        path: 'configuration.texture',
        descriptorType: 'resource',
        valueType: 'string',
        writable: true,
        constraints: { extraInfo: ['image'] },
      },
    ],
  };

  assert.equal(
    chooseResourceProperty(described, 'font').path,
    'configuration.font'
  );
  assert.equal(
    chooseResourceProperty(described, 'image').path,
    'configuration.texture'
  );
});

test('visual MCP schema gate requires binary import/replace and dry-run safe destructive tools', () => {
  const tools = makeToolSet();
  assert.doesNotThrow(() => assertVisualToolSchemas(tools));

  const broken = makeToolSet();
  const deleted = broken.find(tool => tool.name === 'resources.visual.delete');
  deleted.inputSchema.properties.dryRun.default = false;
  assert.throws(
    () => assertVisualToolSchemas(broken),
    /dx28_delete_dry_run_default_missing/
  );
});

test('usage signatures compare semantic references independently of response object identity', () => {
  const first = {
    usages: {
      objectUsages: [
        {
          scope: 'scene-object',
          sceneName: 'Game',
          objectName: 'Tile',
          objectType: 'TiledSpriteObject::TiledSprite',
          paths: [
            {
              property: 'texture',
              path: 'texture',
              structuralConstraint: 'tiled-texture',
            },
          ],
        },
      ],
    },
  };
  const second = JSON.parse(JSON.stringify(first));
  assert.deepEqual(usageSignature(first), usageSignature(second));
  second.usages.objectUsages[0].paths[0].path = 'different';
  assert.notDeepEqual(usageSignature(first), usageSignature(second));
});

test('self-contained PNG fixture is a valid deflate-backed RGBA image', () => {
  const png = makePng(3, 2, [1, 2, 3, 255]);
  assert.deepEqual(Array.from(png.subarray(0, 8)), [
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
  ]);
  assert.equal(png.readUInt32BE(16), 3);
  assert.equal(png.readUInt32BE(20), 2);
  const idatIndex = png.indexOf(Buffer.from('IDAT'));
  const idatLength = png.readUInt32BE(idatIndex - 4);
  const raw = zlib.inflateSync(
    png.subarray(idatIndex + 4, idatIndex + 4 + idatLength)
  );
  assert.equal(raw.length, 2 * (1 + 3 * 4));
});

test('structured resource_in_use errors are extracted without string parsing', () => {
  assert.deepEqual(
    extractError({
      isError: true,
      structuredContent: {
        error: {
          code: 'resource_in_use',
          details: { resourceName: 'hero' },
        },
      },
    }),
    {
      code: 'resource_in_use',
      details: { resourceName: 'hero' },
    }
  );
});
