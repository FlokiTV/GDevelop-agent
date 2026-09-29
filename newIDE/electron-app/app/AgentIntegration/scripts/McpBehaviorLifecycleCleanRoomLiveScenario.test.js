const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  REQUIRED_TOOLS,
  assertBehaviorToolSchemas,
  chooseResizableCapability,
  chooseConfigurableCandidate,
  chooseIncompatibleCandidate,
  chooseSimpleWritableProperty,
  extractError,
  nextValueFor,
} = require('./McpBehaviorLifecycleCleanRoomLiveScenario');

const makeTool = (name, inputSchema = { type: 'object', properties: {} }) => ({
  name,
  inputSchema,
});

describe('DX-29 behavior lifecycle live scenario helpers', () => {
  it('requires the full MCP-only behavior lifecycle/runtime surface', () => {
    const tools = REQUIRED_TOOLS.map(name => makeTool(name));
    const byName = new Map(tools.map(tool => [tool.name, tool]));
    byName.set(
      'objects.behaviors.available',
      makeTool('objects.behaviors.available', {
        type: 'object',
        properties: {
          compatibleOnly: { type: 'boolean', default: true },
          includeCapabilities: { type: 'boolean', default: true },
        },
      })
    );
    byName.set(
      'objects.behaviors.add',
      makeTool('objects.behaviors.add', {
        type: 'object',
        required: ['objectName', 'behaviorType'],
        properties: {
          objectName: { type: 'string' },
          behaviorType: { type: 'string' },
          behaviorName: { type: 'string' },
        },
      })
    );
    byName.set(
      'objects.behaviors.update',
      makeTool('objects.behaviors.update', {
        type: 'object',
        properties: {
          changes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                value: {},
              },
            },
          },
        },
      })
    );
    byName.set(
      'objects.behaviors.remove',
      makeTool('objects.behaviors.remove', {
        type: 'object',
        properties: {
          dryRun: { type: 'boolean', default: true },
          cascadeDependents: { type: 'boolean', default: false },
          removeInstanceOverrides: { type: 'boolean', default: false },
        },
      })
    );

    assert.doesNotThrow(() =>
      assertBehaviorToolSchemas(Array.from(byName.values()))
    );
  });

  it('selects Resizable from capability metadata without relying on an object type', () => {
    const capability = chooseResizableCapability([
      {
        name: 'Other',
        type: 'OtherCapability::OtherBehavior',
        capability: true,
        operationDiscovery: { command: 'events.instructions.search' },
        metadata: { fullName: 'Other capability' },
      },
      {
        name: 'Resizable',
        type: 'ResizableCapability::ResizableBehavior',
        capability: true,
        operationDiscovery: { command: 'events.instructions.search' },
        metadata: { fullName: 'Resizable capability' },
      },
    ]);
    assert.equal(capability.name, 'Resizable');
  });

  it('selects only safe configurable add candidates', () => {
    const candidate = chooseConfigurableCandidate([
      {
        type: 'NeedsSomething',
        hidden: false,
        attachment: { addable: true },
        compatibility: { nativeCompatible: true },
        requiredBehaviorTypes: ['Required::Behavior'],
        parameters: { propertyNames: ['speed'] },
      },
      {
        type: 'NoProperties',
        hidden: false,
        attachment: { addable: true },
        compatibility: { nativeCompatible: true },
        requiredBehaviorTypes: [],
        parameters: { propertyNames: [] },
      },
      {
        type: 'Safe::Configurable',
        hidden: false,
        attachment: { addable: true },
        compatibility: { nativeCompatible: true },
        requiredBehaviorTypes: [],
        parameters: { propertyNames: ['enabled'] },
      },
    ]);
    assert.equal(candidate.type, 'Safe::Configurable');
  });

  it('selects a non-capability incompatible candidate and a schema-backed writable property', () => {
    const incompatible = chooseIncompatibleCandidate([
      {
        type: 'Capability::Hidden',
        hidden: true,
        capabilityInterface: { kind: 'hidden-behavior-capability' },
        compatibility: { nativeCompatible: false },
      },
      {
        type: 'TextOnly::Behavior',
        hidden: false,
        capabilityInterface: null,
        compatibility: { nativeCompatible: false },
      },
    ]);
    assert.equal(incompatible.type, 'TextOnly::Behavior');

    const property = chooseSimpleWritableProperty([
      {
        path: 'behaviors.Test.properties.mode',
        writable: true,
        valueType: 'string',
        currentValue: 'a',
        constraints: {
          choices: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }],
        },
      },
      {
        path: 'behaviors.Test.properties.enabled',
        writable: true,
        valueType: 'boolean',
        currentValue: true,
      },
    ]);
    assert.equal(property.path, 'behaviors.Test.properties.mode');
    assert.equal(nextValueFor(property), 'b');
  });

  it('extracts canonical structured errors without parsing text', () => {
    const error = extractError({
      isError: true,
      structuredContent: {
        error: {
          code: 'behavior_incompatible_with_object',
          field: 'behaviorType',
        },
      },
    });
    assert.deepEqual(error, {
      code: 'behavior_incompatible_with_object',
      field: 'behaviorType',
    });
  });
});
