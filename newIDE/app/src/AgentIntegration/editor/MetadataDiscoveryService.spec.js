// @flow
import {
  createMetadataDiscoveryService,
  metadataDiscoveryInternals,
} from './MetadataDiscoveryService';
import { makeTestExtensions } from '../../fixtures/TestExtensions';

const gd: libGDevelop = global.gd;

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
      instructionCounts: expect.objectContaining({
        actions: expect.any(Number),
        conditions: expect.any(Number),
        expressions: expect.any(Number),
      }),
    });
    expect(JSON.parse(JSON.stringify(described))).toEqual(described);
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
