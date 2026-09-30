const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  REQUIRED_TOOLS,
  assertSpriteToolSchemas,
  chooseSpriteType,
  makePngHeader,
  validationErrorCount,
} = require('./McpSpriteAnimationCleanRoomLiveScenario');

const makeTool = (name, inputSchema = { type: 'object', properties: {} }) => ({
  name,
  inputSchema,
});

describe('DX-30 Sprite animation live scenario helpers', () => {
  it('requires the full MCP-only Sprite authoring surface and safety schemas', () => {
    const tools = REQUIRED_TOOLS.map(name => makeTool(name));
    const byName = new Map(tools.map(tool => [tool.name, tool]));

    byName.set(
      'objects.sprite.animations.create',
      makeTool('objects.sprite.animations.create', {
        type: 'object',
        properties: {
          animationName: { type: 'string' },
          looping: { type: 'boolean' },
          timeBetweenFrames: { type: 'number' },
        },
      })
    );
    byName.set(
      'objects.sprite.frames.add',
      makeTool('objects.sprite.frames.add', {
        type: 'object',
        properties: {
          image: { type: 'string' },
          origin: { type: 'object' },
          center: { type: 'object' },
          points: { type: 'array' },
          collisionMask: { type: 'object' },
        },
      })
    );
    byName.set(
      'objects.sprite.frames.move',
      makeTool('objects.sprite.frames.move', {
        type: 'object',
        properties: {
          dryRun: { type: 'boolean', default: true },
          acknowledgeIndexReferenceRisk: { type: 'boolean', default: false },
        },
      })
    );
    byName.set(
      'objects.sprite.animations.delete',
      makeTool('objects.sprite.animations.delete', {
        type: 'object',
        properties: {
          dryRun: { type: 'boolean', default: true },
          acknowledgeIndexReferenceRisk: { type: 'boolean', default: false },
        },
      })
    );
    byName.set(
      'objects.sprite.collision-mask.set',
      makeTool('objects.sprite.collision-mask.set', {
        type: 'object',
        properties: {
          collisionMask: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['full-image', 'polygons'] },
            },
          },
        },
      })
    );

    assert.doesNotThrow(() =>
      assertSpriteToolSchemas(Array.from(byName.values()))
    );
  });

  it('discovers the canonical Sprite type from MCP object metadata', () => {
    const candidate = chooseSpriteType([
      { kind: 'object', type: 'PanelSpriteObject::PanelSprite', name: 'Panel' },
      { kind: 'object', type: 'Sprite', name: 'Sprite' },
      { kind: 'object', type: 'TiledSpriteObject::TiledSprite', name: 'Tiled' },
    ]);
    assert.equal(candidate.type, 'Sprite');
  });

  it('falls back to discovered Sprite-like metadata without source lookup', () => {
    const candidate = chooseSpriteType([
      {
        kind: 'object',
        type: 'Vendor::AnimatedSpriteObject',
        fullName: 'Animated Sprite object',
      },
    ]);
    assert.equal(candidate.type, 'Vendor::AnimatedSpriteObject');
  });

  it('builds deterministic PNG headers with discoverable dimensions', () => {
    const png = makePngHeader(64, 32);
    assert.equal(png.length, 33);
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
    assert.equal(png.readUInt32BE(16), 64);
    assert.equal(png.readUInt32BE(20), 32);
  });

  it('normalizes validation error counts across supported envelopes', () => {
    assert.equal(validationErrorCount({ errors: [{}, {}] }), 2);
    assert.equal(validationErrorCount({ errorCount: 3 }), 3);
    assert.equal(validationErrorCount({ summary: { errors: 4 } }), 4);
    assert.equal(validationErrorCount({ summary: {} }), 0);
  });
});
