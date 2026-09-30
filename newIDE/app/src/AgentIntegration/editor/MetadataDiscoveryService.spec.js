// @flow
import {
  createMetadataDiscoveryService,
  metadataDiscoveryInternals,
} from './MetadataDiscoveryService';
import { makeTestExtensions } from '../../fixtures/TestExtensions';
import {
  reloadProjectEventsFunctionsExtensionMetadata,
  type EventsFunctionCodeWriter,
} from '../../EventsFunctionsExtensionsLoader';
import { makeFakeI18n } from '../../EditorFunctions/TestHelpers';

const gd: libGDevelop = global.gd;

const createFakeEventsFunctionCodeWriter = (): EventsFunctionCodeWriter => ({
  getIncludeFileFor: (functionName: string) => `${functionName}.js`,
  writeFunctionCode: () => Promise.resolve(),
  writeBehaviorCode: () => Promise.resolve(),
  writeObjectCode: () => Promise.resolve(),
});

describe('AgentIntegration MetadataDiscoveryService', () => {
  let project: gdProject;
  let service: any;

  beforeAll(() => {
    makeTestExtensions(gd);
  });

  beforeEach(() => {
    // $FlowFixMe[invalid-constructor]
    project = new gd.ProjectHelper.createNewGDJSProject();
    project.resetProjectUuid();
    project.setName('Metadata Discovery Test');
    project.insertNewLayout('Game', 0);
    service = createMetadataDiscoveryService({ project });
  });

  afterEach(() => {
    project.delete();
  });

  it('preserves authored project-function parameter names at generated metadata indexes', () => {
    const extension = project.insertNewEventsFunctionsExtension(
      'DX20MetadataNames',
      0
    );
    extension.setFullName('DX20 Metadata Names');
    const eventsFunction = extension
      .getEventsFunctions()
      .insertNewEventsFunction('PatchAction', 0);
    eventsFunction.setFunctionType(gd.EventsFunction.Action);
    eventsFunction.setFullName('DX20 Patch Action');
    eventsFunction.setDescription('DX20 named parameter regression');
    eventsFunction.setSentence('Patch value _PARAM0_');
    eventsFunction
      .getParameters()
      .insertNewParameter('Value', 0)
      .setType('expression');

    reloadProjectEventsFunctionsExtensionMetadata(
      project,
      extension,
      createFakeEventsFunctionCodeWriter(),
      makeFakeI18n()
    );
    service = createMetadataDiscoveryService({ project });

    const described = service.describeInstruction({
      id: 'DX20MetadataNames::PatchAction',
      kind: 'action',
      extension: 'DX20MetadataNames',
    }).item;
    const visibleParameters = described.parameters.filter(
      parameter => !parameter.codeOnly
    );

    expect(visibleParameters).toHaveLength(1);
    expect(visibleParameters[0]).toMatchObject({
      index: 1,
      name: 'Value',
      type: 'expression',
    });
    expect(described.parameters[0]).toMatchObject({
      index: 0,
      codeOnly: true,
    });
  });

  it('lists and describes canonical event node schemas from connected build defaults', () => {
    const nodes = service.listEventNodeTypes({ limit: 100 });
    expect(nodes.total).toBeGreaterThan(0);
    expect(nodes.items.map(item => item.type)).toEqual(
      expect.arrayContaining([
        'BuiltinCommonInstructions::Standard',
        'BuiltinCommonInstructions::Group',
        'BuiltinCommonInstructions::Comment',
        'BuiltinCommonInstructions::Repeat',
      ])
    );

    const standard = service.describeEventNodeType({
      type: 'BuiltinCommonInstructions::Standard',
    }).item;
    expect(standard).toMatchObject({
      kind: 'event-node',
      type: 'BuiltinCommonInstructions::Standard',
      schemaAvailable: true,
      schemaSource: 'connected-build-canonical-default',
      schemaCompleteness: 'known-default-fields',
      canHaveSubEvents: true,
      canonicalExample: {
        type: 'BuiltinCommonInstructions::Standard',
      },
      schema: {
        type: 'object',
        additionalProperties: true,
        required: ['type'],
      },
    });

    const repeat = service.describeEventNodeType({
      type: 'BuiltinCommonInstructions::Repeat',
    }).item;
    expect(repeat.schemaAvailable).toBe(true);
    expect(repeat.canHaveSubEvents).toBe(true);

    const group = service.describeEventNodeType({
      type: 'BuiltinCommonInstructions::Group',
    }).item;
    expect(group).toMatchObject({
      schemaAvailable: true,
      canHaveSubEvents: true,
      canonicalExample: {
        type: 'BuiltinCommonInstructions::Group',
        colorR: expect.any(Number),
        colorG: expect.any(Number),
        colorB: expect.any(Number),
      },
    });
    ['colorR', 'colorG', 'colorB'].forEach(path => {
      expect(group.fields).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path,
            role: 'visual',
            minimum: 0,
            maximum: 255,
          }),
        ])
      );
      expect(group.schema.properties[path]).toMatchObject({
        minimum: 0,
        maximum: 255,
      });
    });

    const comment = service.describeEventNodeType({
      type: 'BuiltinCommonInstructions::Comment',
    }).item;
    expect(comment).toMatchObject({
      schemaAvailable: true,
      canHaveSubEvents: false,
      canonicalExample: {
        type: 'BuiltinCommonInstructions::Comment',
        color: {
          r: expect.any(Number),
          g: expect.any(Number),
          b: expect.any(Number),
          textR: expect.any(Number),
          textG: expect.any(Number),
          textB: expect.any(Number),
        },
      },
    });
    [
      'color.r',
      'color.g',
      'color.b',
      'color.textR',
      'color.textG',
      'color.textB',
    ].forEach(path => {
      expect(comment.fields).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path,
            role: 'visual',
            minimum: 0,
            maximum: 255,
          }),
        ])
      );
    });

    expect(JSON.parse(JSON.stringify(group))).toEqual(group);
    expect(JSON.parse(JSON.stringify(comment))).toEqual(comment);
  });

  it('projects a connected-build discriminated union with an unknown-type fallback', () => {
    const schema = service.getEventNodeMutationSchema();
    expect(schema['x-gdevelop-schema-reference']).toMatchObject({
      listTool: 'events.nodes.list',
      describeTool: 'events.nodes.describe',
      typeField: 'type',
      strategy: 'connected-build-discriminated-union-with-unknown-fallback',
      knownTypeCount: expect.any(Number),
    });
    expect(
      schema['x-gdevelop-schema-reference'].knownTypeCount
    ).toBeGreaterThan(0);
    expect(schema.oneOf).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          properties: expect.objectContaining({
            type: expect.objectContaining({
              type: 'string',
              const: 'BuiltinCommonInstructions::Comment',
            }),
            color: expect.objectContaining({
              type: 'object',
            }),
          }),
        }),
        expect.objectContaining({
          properties: {
            type: expect.objectContaining({
              type: 'string',
              not: expect.objectContaining({
                enum: expect.arrayContaining([
                  'BuiltinCommonInstructions::Comment',
                  'BuiltinCommonInstructions::Group',
                ]),
              }),
            }),
          },
        }),
      ])
    );
  });

  it('validates known event-node fields while preserving forward compatibility', () => {
    expect(
      service.validateEventNodeJson({
        type: 'BuiltinCommonInstructions::Comment',
        color: {
          r: 255,
          g: 230,
          b: 109,
          textR: 0,
          textG: 0,
          textB: 0,
        },
        comment: 'Valid comment',
        futureField: { nested: true },
      })
    ).toMatchObject({
      knownType: true,
      eventType: 'BuiltinCommonInstructions::Comment',
      schemaAvailable: true,
      schemaCompleteness: 'known-default-fields',
      schemaReference: {
        describeTool: 'events.nodes.describe',
        typeArgument: 'BuiltinCommonInstructions::Comment',
      },
    });

    expect(() =>
      service.validateEventNodeJson({
        type: 'BuiltinCommonInstructions::Comment',
        color: {
          r: 256,
          g: 230,
          b: 109,
          textR: 0,
          textG: 0,
          textB: 0,
        },
        comment: 'Bad RGB',
      })
    ).toThrow(
      expect.objectContaining({
        code: 'invalid_event_node_field',
        details: expect.objectContaining({
          eventType: 'BuiltinCommonInstructions::Comment',
          path: 'color.r',
          maximum: 255,
          actual: 256,
        }),
      })
    );

    expect(() =>
      service.validateEventNodeJson({
        type: 'BuiltinCommonInstructions::Comment',
        color: 'not-an-object',
        comment: 'Bad type',
      })
    ).toThrow(
      expect.objectContaining({
        code: 'invalid_event_node_field',
        details: expect.objectContaining({
          eventType: 'BuiltinCommonInstructions::Comment',
          path: 'color',
          expected: 'object',
          actual: 'string',
        }),
      })
    );

    expect(
      service.validateEventNodeJson({
        type: 'FutureExtension::FutureEvent',
        futureField: { nested: true },
      })
    ).toEqual({
      knownType: false,
      eventType: 'FutureExtension::FutureEvent',
      schemaReference: {
        listTool: 'events.nodes.list',
        describeTool: 'events.nodes.describe',
        typeArgument: 'FutureExtension::FutureEvent',
      },
    });
  });

  it('lists and describes installed object types from live platform metadata', () => {
    const result = service.listObjectTypes({
      query: 'sprite',
      deprecated: 'include',
      limit: 100,
    });

    expect(result.total).toBeGreaterThan(0);
    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'object',
          type: 'Sprite',
          renderingMode: '2d',
          extension: expect.objectContaining({ name: expect.any(String) }),
        }),
      ])
    );

    const described = service.describeObjectType({ type: 'Sprite' }).item;
    expect(described).toMatchObject({
      kind: 'object',
      type: 'Sprite',
      propertySchemaAvailable: true,
      properties: expect.any(Array),
      creationSchema: expect.objectContaining({
        strategy: 'connected-build-native-object-constructor',
        requiredFields: ['objectName', 'objectType', 'objectScope'],
        requiredInitialProperties: [],
        defaultProperties: expect.any(Array),
        defaultBehaviorTypes: expect.any(Array),
      }),
      supportedBehaviors: expect.any(Array),
      supportedCapabilities: expect.any(Array),
      authoringDiscovery: expect.objectContaining({
        createCommand: 'objects.definitions.create',
        propertiesCommand: 'objects.properties.describe',
        behaviorsCommand: 'objects.behaviors.available',
      }),
      instructionCounts: expect.objectContaining({
        actions: expect.any(Number),
        conditions: expect.any(Number),
        expressions: expect.any(Number),
      }),
    });
    expect(JSON.parse(JSON.stringify(described))).toEqual(described);
  });

  it('discovers free expressions with return types and ordered parameters', () => {
    const findAndDescribe = (id: string) => {
      const search = service.searchInstructions({
        query: id,
        kind: 'expression',
        deprecated: 'include',
        limit: 100,
      });
      const expression = search.items.find(
        candidate =>
          candidate.id === id &&
          candidate.kind === 'expression' &&
          candidate.scope.kind === 'free'
      );
      expect(expression).toBeTruthy();
      return service.describeInstruction({
        id,
        kind: 'expression',
        extension: expression.extension.name,
      }).item;
    };

    const randomInRange = findAndDescribe('RandomInRange');
    expect(randomInRange).toMatchObject({
      kind: 'expression',
      id: 'RandomInRange',
      returnType: 'number',
      scope: { kind: 'free' },
      extension: expect.objectContaining({ name: expect.any(String) }),
      parameters: expect.any(Array),
      requirements: expect.objectContaining({
        objectTypes: expect.any(Array),
        behaviorTypes: expect.any(Array),
        resourceTypes: expect.any(Array),
      }),
      eventContexts: expect.objectContaining({ scene: expect.any(Boolean) }),
    });
    expect(randomInRange.parameters.length).toBeGreaterThan(0);
    randomInRange.parameters.forEach((parameter, index) => {
      expect(parameter.index).toBe(index);
      expect(parameter.type).toEqual(expect.any(String));
    });

    const toString = findAndDescribe('ToString');
    expect(toString).toMatchObject({
      kind: 'expression',
      id: 'ToString',
      returnType: 'string',
      scope: { kind: 'free' },
      parameters: expect.any(Array),
    });
    expect(toString.parameters.length).toBeGreaterThan(0);
    toString.parameters.forEach((parameter, index) =>
      expect(parameter.index).toBe(index)
    );
  });

  it('discovers a behavior condition without hard-coding its instruction id', () => {
    const behaviors = service.listBehaviorTypes({
      deprecated: 'include',
      limit: 100,
    });
    const behavior = behaviors.items.find(
      candidate => candidate.instructionCounts.conditions > 0
    );
    expect(behavior).toBeTruthy();

    const conditions = service.searchInstructions({
      kind: 'condition',
      behaviorType: behavior.type,
      deprecated: 'include',
      limit: 100,
    });
    expect(conditions.total).toBeGreaterThan(0);
    const condition = conditions.items.find(
      candidate => candidate.scope.behaviorType === behavior.type
    );
    expect(condition).toBeTruthy();

    const described = service.describeInstruction({
      id: condition.id,
      kind: 'condition',
      extension: condition.extension.name,
      behaviorType: behavior.type,
    }).item;

    expect(described).toMatchObject({
      id: condition.id,
      kind: 'condition',
      scope: { kind: 'behavior', behaviorType: behavior.type },
      extension: expect.objectContaining({ name: condition.extension.name }),
      parameters: expect.any(Array),
      requirements: expect.objectContaining({
        objectTypes: expect.any(Array),
        behaviorTypes: expect.any(Array),
        resourceTypes: expect.any(Array),
      }),
      eventContexts: expect.objectContaining({ scene: expect.any(Boolean) }),
    });
  });

  it('marks object parameters as object-or-group references with MCP discovery paths', () => {
    const actions = service.searchInstructions({
      kind: 'action',
      deprecated: 'include',
      includeHidden: true,
      limit: 100,
    });
    const candidate = actions.items.find(item =>
      (item.parameters || []).some(
        parameter => parameter.valueType && parameter.valueType.object
      )
    );
    expect(candidate).toBeTruthy();
    const parameter = candidate.parameters.find(
      item => item.valueType && item.valueType.object
    );
    expect(parameter.referenceSemantics).toEqual({
      entityKinds: ['object', 'object-group'],
      resolution: 'scene-object-or-group-then-global-object-or-group',
      groupDiscoveryCommand: 'objects.groups.list',
      groupUsageCommand: 'objects.groups.usages',
    });
  });

  it('lists and describes behavior and effect schemas', () => {
    const behaviors = service.listBehaviorTypes({
      deprecated: 'include',
      limit: 10,
    });
    expect(behaviors.total).toBeGreaterThan(0);
    const behavior = service.describeBehaviorType({
      type: behaviors.items[0].type,
      extension: behaviors.items[0].extension.name,
    }).item;
    expect(behavior).toMatchObject({
      kind: 'behavior',
      properties: expect.any(Array),
      sharedProperties: expect.any(Array),
      requiredBehaviorTypes: expect.any(Array),
      requiredBehaviors: expect.any(Array),
      requiredCapabilityTypes: expect.any(Array),
      parameters: {
        properties: expect.any(Array),
        sharedProperties: expect.any(Array),
      },
      compatibilityRules: expect.objectContaining({
        requiredBehaviorTypes: expect.any(Array),
        requiredCapabilityTypes: expect.any(Array),
        authoritativeCheck: expect.stringMatching(/ObjectTools/),
      }),
      operationDiscovery: expect.objectContaining({
        command: 'events.instructions.search',
        describeCommand: 'events.instructions.describe',
        authoringCommand: 'events.patch',
      }),
    });

    const effects = service.listEffectTypes({
      deprecated: 'include',
      limit: 10,
    });
    expect(effects.total).toBeGreaterThan(0);
    const effect = service.describeEffectType({
      type: effects.items[0].type,
      extension: effects.items[0].extension.name,
    }).item;
    expect(effect).toMatchObject({
      kind: 'effect',
      properties: expect.any(Array),
      onlyWorkingFor2D: expect.any(Boolean),
      onlyWorkingFor3D: expect.any(Boolean),
      notWorkingForObjects: expect.any(Boolean),
    });
  });

  it('returns bounded deterministic pagination and natural metadata search', () => {
    const first = service.searchInstructions({
      kind: 'action',
      deprecated: 'include',
      limit: 3,
      offset: 0,
    });
    expect(first.items).toHaveLength(3);
    expect(first.limit).toBe(3);
    expect(first.offset).toBe(0);
    expect(first.nextOffset).toBe(3);

    const second = service.searchInstructions({
      kind: 'action',
      deprecated: 'include',
      limit: 3,
      offset: first.nextOffset,
    });
    expect(second.offset).toBe(3);
    expect(second.items[0]).not.toEqual(first.items[0]);

    const selected = first.items[0];
    const queried = service.searchInstructions({
      query: selected.id,
      kind: selected.kind,
      extension: selected.extension.name,
      deprecated: 'include',
      limit: 100,
    });
    expect(queried.items.some(item => item.id === selected.id)).toBe(true);
  });

  it('parses parameter choice metadata without accepting arbitrary JSON shapes', () => {
    expect(
      metadataDiscoveryInternals.getAllowedValues('["a","b",3,true]')
    ).toEqual(['a', 'b', 3, true]);
    expect(metadataDiscoveryInternals.getAllowedValues('{"a":1}')).toEqual([]);
    expect(metadataDiscoveryInternals.getAllowedValues('not-json')).toEqual([]);
    expect(
      metadataDiscoveryInternals.normalizePagination({
        limit: 999,
        offset: -10,
      })
    ).toEqual({
      limit: 100,
      offset: 0,
    });
  });
});
