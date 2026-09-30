const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  REQUIRED_TOOLS,
  assertGroupToolSchemas,
  chooseObjectTypes,
  validationErrorCount,
} = require('./McpObjectGroupCleanRoomLiveScenario');

const makeTool = (name, inputSchema = { type: 'object', properties: {} }) => ({
  name,
  inputSchema,
});

describe('DX-31 object group live scenario helpers', () => {
  it('requires the complete group/event/safety surface and dry-run delete schema', () => {
    const tools = REQUIRED_TOOLS.map(name => makeTool(name));
    const byName = new Map(tools.map(tool => [tool.name, tool]));
    byName.set(
      'objects.groups.create',
      makeTool('objects.groups.create', {
        type: 'object',
        properties: {
          groupName: { type: 'string' },
          groupScope: { type: 'string' },
        },
      })
    );
    byName.set(
      'objects.groups.members.add',
      makeTool('objects.groups.members.add', {
        type: 'object',
        properties: { objectName: { type: 'string' } },
      })
    );
    byName.set(
      'objects.groups.delete',
      makeTool('objects.groups.delete', {
        type: 'object',
        properties: { dryRun: { type: 'boolean', default: true } },
      })
    );
    assert.doesNotThrow(() =>
      assertGroupToolSchemas(Array.from(byName.values()))
    );
  });

  it('prefers two distinct discoverable 2D object types', () => {
    const chosen = chooseObjectTypes([
      { kind: 'object', type: 'Sprite', name: 'Sprite' },
      { kind: 'object', type: 'TextObject::Text', name: 'Text' },
      { kind: 'object', type: 'PanelSpriteObject::PanelSprite', name: 'Panel' },
    ]);
    assert.equal(chosen.first.type, 'Sprite');
    assert.equal(chosen.second.type, 'TextObject::Text');
  });

  it('falls back to any two distinct discovered types without source knowledge', () => {
    const chosen = chooseObjectTypes([
      { kind: 'object', type: 'Vendor::VisualA', name: 'Visual A' },
      { kind: 'object', type: 'Vendor::VisualB', name: 'Visual B' },
    ]);
    assert.equal(chosen.first.type, 'Vendor::VisualA');
    assert.equal(chosen.second.type, 'Vendor::VisualB');
  });

  it('normalizes validation error counts across supported envelopes', () => {
    assert.equal(validationErrorCount({ errors: [{}, {}] }), 2);
    assert.equal(validationErrorCount({ errorCount: 3 }), 3);
    assert.equal(validationErrorCount({ summary: { errors: 4 } }), 4);
    assert.equal(validationErrorCount({ summary: {} }), 0);
  });
});
