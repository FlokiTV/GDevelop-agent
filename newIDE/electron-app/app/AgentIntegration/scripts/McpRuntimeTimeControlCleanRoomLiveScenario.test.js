const test = require('node:test');
const assert = require('node:assert/strict');

const {
  REQUIRED_TOOLS,
  assertTimeControlToolSchemas,
  extractPreviewWindowId,
  validationErrorCount,
} = require('./McpRuntimeTimeControlCleanRoomLiveScenario');

const makeTool = (name, inputSchema = { type: 'object', properties: {} }) => ({
  name,
  inputSchema,
});

test('DX-35 live runner requires the complete MCP-only time-control surface', () => {
  const tools = REQUIRED_TOOLS.map(name => makeTool(name));
  const replace = (name, inputSchema) => {
    const index = tools.findIndex(tool => tool.name === name);
    tools[index] = makeTool(name, inputSchema);
  };
  replace('runtime.time.step', {
    type: 'object',
    properties: {
      frames: { type: 'integer' },
      snapshot: { type: 'boolean' },
      assertion: { type: 'object' },
    },
  });
  replace('runtime.time.advance', {
    type: 'object',
    required: ['milliseconds'],
    properties: {
      milliseconds: { type: 'number' },
      maxFrames: { type: 'integer' },
    },
  });
  replace('runtime.time.wait-until', {
    type: 'object',
    required: ['condition'],
    properties: {
      condition: { type: 'object' },
      maxFrames: { type: 'integer' },
    },
  });
  replace('runtime.time.set-scale', {
    type: 'object',
    required: ['timeScale'],
    properties: { timeScale: { type: 'number' } },
  });

  assert.doesNotThrow(() => assertTimeControlToolSchemas(tools));
});

test('DX-35 schema guard rejects missing post-step observation support', () => {
  const tools = REQUIRED_TOOLS.map(name => makeTool(name));
  const stepIndex = tools.findIndex(tool => tool.name === 'runtime.time.step');
  tools[stepIndex] = makeTool('runtime.time.step', {
    type: 'object',
    properties: { frames: { type: 'integer' } },
  });
  assert.throws(
    () => assertTimeControlToolSchemas(tools),
    /dx35_step_schema_missing/
  );
});

test('DX-35 preview window id extraction supports lifecycle arrays and targets', () => {
  assert.equal(extractPreviewWindowId({ previewWindowIds: [42] }), 42);
  assert.equal(
    extractPreviewWindowId({
      targets: [{ debuggerId: 'preview-1', windowId: 77 }],
    }),
    77
  );
  assert.equal(extractPreviewWindowId({ targets: [] }), null);
});

test('DX-35 validation error normalization stays deterministic', () => {
  assert.equal(validationErrorCount({ errors: [{ code: 'x' }] }), 1);
  assert.equal(validationErrorCount({ errorCount: 2 }), 2);
  assert.equal(validationErrorCount({ summary: { errors: 3 } }), 3);
  assert.equal(validationErrorCount(null), 0);
});
