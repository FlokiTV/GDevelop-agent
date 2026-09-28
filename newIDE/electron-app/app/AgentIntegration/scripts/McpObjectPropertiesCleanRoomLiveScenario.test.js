const test = require('node:test');
const assert = require('node:assert/strict');
const {
  assertPropertyToolSchemas,
  chooseStringProperty,
  extractError,
} = require('./McpObjectPropertiesCleanRoomLiveScenario');

test('clean-room property selector uses only discovered writable schema data', () => {
  const selected = chooseStringProperty({
    data: {
      properties: [
        {
          path: 'configuration.choice',
          valueType: 'string',
          descriptorType: 'choice',
          writable: true,
          constraints: { choices: [{ value: 'a', label: 'A' }] },
        },
        {
          path: 'configuration.discovered',
          valueType: 'string',
          descriptorType: 'multilinestring',
          writable: true,
          constraints: {},
        },
      ],
    },
  });
  assert.equal(selected.path, 'configuration.discovered');
});

test('clean-room schema gate requires typed path/value changes on the MCP mutation tool', () => {
  const tools = [
    {
      name: 'objects.properties.describe',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'objects.properties.set',
      inputSchema: {
        type: 'object',
        properties: {
          changes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                value: { anyOf: [{ type: 'string' }, { type: 'number' }] },
              },
            },
          },
        },
      },
      annotations: { readOnlyHint: false },
    },
  ];
  assert.doesNotThrow(() => assertPropertyToolSchemas(tools));

  const broken = JSON.parse(JSON.stringify(tools));
  delete broken[1].inputSchema.properties.changes.items.properties.path;
  assert.throws(
    () => assertPropertyToolSchemas(broken),
    /property_set_change_item_schema_missing/
  );
});

test('clean-room error extraction preserves structured field/path diagnostics', () => {
  const error = extractError({
    isError: true,
    structuredContent: {
      error: {
        code: 'invalid_property_type',
        field: 'changes[0].value',
        path: 'configuration.text',
      },
    },
  });
  assert.deepEqual(error, {
    code: 'invalid_property_type',
    field: 'changes[0].value',
    path: 'configuration.text',
  });
});
