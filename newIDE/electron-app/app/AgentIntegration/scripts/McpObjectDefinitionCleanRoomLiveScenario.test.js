const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  REQUIRED_TOOLS,
  assertDefinitionToolSchemas,
  chooseSpriteType,
  validationErrorCount,
} = require('./McpObjectDefinitionCleanRoomLiveScenario');

const makeTool = (name, inputSchema = { type: 'object', properties: {} }) => ({
  name,
  inputSchema,
});

describe('DX-34 object definition live scenario helpers', () => {
  it('requires lifecycle/safety tools and dry-run delete/move schemas', () => {
    const tools = REQUIRED_TOOLS.map(name => makeTool(name));
    const byName = new Map(tools.map(tool => [tool.name, tool]));
    byName.set(
      'objects.definitions.create',
      makeTool('objects.definitions.create', {
        type: 'object',
        properties: {
          objectType: { type: 'string' },
          initialProperties: { type: 'array' },
        },
      })
    );
    byName.set(
      'objects.definitions.delete',
      makeTool('objects.definitions.delete', {
        type: 'object',
        properties: { dryRun: { type: 'boolean', default: true } },
      })
    );
    byName.set(
      'objects.definitions.move-scope',
      makeTool('objects.definitions.move-scope', {
        type: 'object',
        properties: { dryRun: { type: 'boolean', default: true } },
      })
    );
    assert.doesNotThrow(() =>
      assertDefinitionToolSchemas(Array.from(byName.values()))
    );
  });

  it('prefers the canonical Sprite type from connected metadata', () => {
    assert.equal(
      chooseSpriteType([
        { kind: 'object', type: 'Vendor::SpriteLike', name: 'Sprite Like' },
        { kind: 'object', type: 'Sprite', name: 'Sprite' },
      ]).type,
      'Sprite'
    );
  });

  it('falls back to a discoverable sprite-like object type', () => {
    assert.equal(
      chooseSpriteType([
        { kind: 'object', type: 'Vendor::Visual', name: 'Visual' },
        { kind: 'object', type: 'Vendor::SpriteLike', name: 'Sprite Like' },
      ]).type,
      'Vendor::SpriteLike'
    );
  });

  it('normalizes validation error counts across supported envelopes', () => {
    assert.equal(validationErrorCount({ errors: [{}, {}] }), 2);
    assert.equal(validationErrorCount({ errorCount: 3 }), 3);
    assert.equal(validationErrorCount({ summary: { errors: 4 } }), 4);
    assert.equal(validationErrorCount({ summary: {} }), 0);
  });
});
