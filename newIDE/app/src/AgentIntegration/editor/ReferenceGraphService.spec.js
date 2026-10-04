// @flow
import { createReferenceGraphService } from './ReferenceGraphService';

const gd: libGDevelop = global.gd;

const makeFixture = () => {
  const project = gd.ProjectHelper.createNewGDJSProject();
  project.setName('Reference Graph Test');
  const scene = project.insertNewLayout('Game', 0);

  const objectItem = {
    identity: {
      kind: 'persistent-uuid',
      objectId: 'obj-player',
      selector: 'object-definition:obj-player',
      stableAcrossRename: true,
    },
    name: 'Player',
    type: 'Sprite',
    scope: 'scene',
    sceneName: 'Game',
  };

  const objectDefinitionService = {
    list: jest.fn(input => ({
      items:
        input.objectScope === 'scene' && input.sceneName === 'Game'
          ? [objectItem]
          : [],
      total:
        input.objectScope === 'scene' && input.sceneName === 'Game' ? 1 : 0,
      offset: input.offset || 0,
      limit: input.limit || 100,
      truncated: false,
    })),
    get: jest.fn(() => ({
      object: {
        ...objectItem,
        behaviors: [
          {
            name: 'Platformer',
            type: 'PlatformBehavior::PlatformerObjectBehavior',
          },
        ],
        resources: [
          {
            resourceName: 'hero.png',
            discovery: {
              command: 'resources.visual.inspect',
              arguments: { resourceName: 'hero.png' },
            },
          },
        ],
      },
    })),
  };

  const objectGroupService = {
    list: jest.fn(input => ({
      items:
        input.groupScope === 'scene' && input.sceneName === 'Game'
          ? [
              {
                identity: {
                  kind: 'canonical-scope-name',
                  selector: 'object-group:scene:Game:Actors',
                  renameChangesSelector: true,
                },
                name: 'Actors',
                scope: 'scene',
                sceneName: 'Game',
                members: [
                  {
                    position: 0,
                    objectName: 'Player',
                    objectType: 'Sprite',
                    objectScope: 'scene',
                    exists: true,
                  },
                ],
              },
            ]
          : [],
    })),
  };

  const sceneInstanceService = {
    list: jest.fn(({ sceneName }) => ({
      items:
        sceneName === 'Game'
          ? [
              {
                instanceId: 'inst-player',
                selector: 'instance:inst-player',
                objectName: 'Player',
                objectType: 'Sprite',
                position: { x: 10, y: 20, z: 0 },
                layer: { name: '', index: 0 },
              },
            ]
          : [],
    })),
  };

  const assetTools = {
    listResources: jest.fn(() => ({
      resources: [
        {
          name: 'hero.png',
          kind: 'image',
          usedInProject: true,
          orphaned: false,
        },
      ],
    })),
    inspectVisualResource: jest.fn(() => ({
      usages: {
        objectUsages: [
          {
            scope: 'scene-object',
            sceneName: 'Game',
            objectName: 'Player',
            objectType: 'Sprite',
            paths: [
              {
                animationName: 'Idle',
                directionIndex: 0,
                frameIndex: 0,
                property: 'image',
              },
            ],
          },
        ],
      },
    })),
  };

  const eventTools = {
    readEventsJson: jest.fn(({ target }) => {
      if (target.kind !== 'scene' || target.sceneName !== 'Game') {
        return {
          eventsRevision: 'events:empty',
          events: [],
        };
      }
      return {
        eventsRevision: 'events:test',
        events: [
          {
            handle: 'event:fp:event-one',
            type: 'BuiltinCommonInstructions::Standard',
            path: [0],
            conditions: [],
            whileConditions: [],
            actions: [
              {
                handle: 'action:fp:set-x',
                type: 'SetX',
                path: [0],
                parameters: ['Player', '=', '5'],
                children: [],
              },
              {
                handle: 'action:fp:log',
                type: 'Log',
                path: [1],
                parameters: ['Player should move'],
                children: [],
              },
            ],
            children: [],
          },
        ],
      };
    }),
  };

  const metadataDiscoveryService = {
    searchInstructions: jest.fn(({ kind, query }) => {
      if (kind === 'action' && query === 'SetX') {
        return {
          items: [
            {
              id: 'SetX',
              parameters: [
                {
                  name: 'Object',
                  type: 'object',
                  valueType: {
                    object: true,
                    resource: false,
                    variable: false,
                    behavior: false,
                  },
                  referenceSemantics: {
                    entityKinds: ['object', 'object-group'],
                  },
                },
                {
                  name: 'Operator',
                  type: 'operator',
                  valueType: {},
                },
                {
                  name: 'Value',
                  type: 'expression',
                  valueType: { number: true },
                },
              ],
            },
          ],
        };
      }
      if (kind === 'action' && query === 'Log') {
        return {
          items: [
            {
              id: 'Log',
              parameters: [
                {
                  name: 'Text',
                  type: 'string',
                  valueType: { string: true },
                },
              ],
            },
          ],
        };
      }
      return { items: [] };
    }),
  };

  const sceneLifecycleService = {
    usages: jest.fn(() => ({ references: [], total: 0 })),
  };

  const externalProjectItemsService = {
    externalEventsUsages: jest.fn(() => ({
      references: [],
      total: 0,
    })),
  };

  const service = createReferenceGraphService({
    project,
    eventTools,
    metadataDiscoveryService,
    objectDefinitionService,
    objectGroupService,
    sceneInstanceService,
    assetTools,
    sceneLifecycleService,
    externalProjectItemsService,
  });

  return { project, scene, service };
};

describe('ReferenceGraphService', () => {
  test('indexes stable node kinds and traces object inbound usages across instance, group and Event Sheet handles', () => {
    const { project, service } = makeFixture();
    const capabilities = service.capabilities();
    expect(capabilities.nodeKinds.map(item => item.kind)).toEqual(
      expect.arrayContaining([
        'scene',
        'object-definition',
        'scene-instance',
        'object-group',
        'resource',
        'behavior',
        'event',
        'event-action',
      ])
    );

    const result = service.usages({
      selector: 'object-definition:obj-player',
      maxDepth: 1,
      limit: 100,
    });

    expect(result.root).toMatchObject({
      selector: 'object-definition:obj-player',
      kind: 'object-definition',
      name: 'Player',
    });
    expect(result.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          referenceKind: 'instance-of-object',
          source: expect.objectContaining({
            selector: 'instance:inst-player',
          }),
          strength: 'hard',
          autoRefactorable: true,
        }),
        expect.objectContaining({
          referenceKind: 'group-member',
          source: expect.objectContaining({
            selector: 'object-group:scene:Game:Actors',
          }),
          strength: 'hard',
        }),
        expect.objectContaining({
          referenceKind: 'event-parameter-object',
          source: expect.objectContaining({
            selector: 'action:fp:set-x',
          }),
          location: expect.objectContaining({
            eventHandle: 'event:fp:event-one',
            instructionHandle: 'action:fp:set-x',
            parameterIndex: 0,
          }),
        }),
        expect.objectContaining({
          referenceKind: 'expression-or-text-potential-reference',
          source: expect.objectContaining({
            selector: 'action:fp:log',
          }),
          strength: 'dynamic',
        }),
      ])
    );
    expect(result.graphRevision).toMatch(/^reference-graph:/);
    expect(result.projectModified).toBe(false);
    project.delete();
  });

  test('traces visual resource usages to exact object animation/property paths', () => {
    const { project, service } = makeFixture();
    const result = service.usages({
      selector: 'resource:hero.png',
      maxDepth: 1,
    });

    expect(result.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          referenceKind: 'object-resource',
          source: expect.objectContaining({
            selector: 'object-definition:obj-player',
          }),
          target: expect.objectContaining({
            selector: 'resource:hero.png',
          }),
          location: expect.objectContaining({
            sceneName: 'Game',
            objectName: 'Player',
            resourcePath: expect.objectContaining({
              animationName: 'Idle',
              property: 'image',
            }),
          }),
        }),
      ])
    );
    project.delete();
  });

  test('reports delete blockers and unresolved dynamic references without claiming safety', () => {
    const { project, service } = makeFixture();
    const impact = service.impact({
      selector: 'object-definition:obj-player',
      operation: 'delete',
      maxDepth: 1,
    });

    expect(impact.blockerCount).toBeGreaterThanOrEqual(3);
    expect(impact.safelyRewritableCount).toBeGreaterThanOrEqual(3);
    expect(impact.dynamicReferenceCount).toBeGreaterThanOrEqual(1);
    expect(impact.unresolvedWarnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'reference_graph_dynamic_reference',
        }),
      ])
    );
    expect(impact.safeToApply).toBe(false);
    expect(impact.projectModified).toBe(false);
    project.delete();
  });

  test('does not treat structural ownership or transitive containment as rename blockers', () => {
    const { project, service } = makeFixture();
    const impact = service.impact({
      selector: 'object-definition:obj-player',
      operation: 'rename',
      maxDepth: 2,
    });

    expect(impact.blockerCount).toBe(0);
    expect(impact.blockers).toHaveLength(0);
    expect(impact.safelyRewritableCount).toBeGreaterThanOrEqual(3);
    expect(impact.unresolvedWarnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'reference_graph_dynamic_reference' }),
      ])
    );
    project.delete();
  });

  test('supports bounded transitive traversal, deterministic pagination and name ambiguity diagnostics', () => {
    const { project, service } = makeFixture();
    const first = service.query({
      selector: 'object-definition:obj-player',
      direction: 'both',
      maxDepth: 2,
      limit: 2,
      offset: 0,
    });
    const second = service.query({
      selector: 'object-definition:obj-player',
      direction: 'both',
      maxDepth: 2,
      limit: 2,
      offset: 2,
    });

    expect(first.totalEdges).toBeGreaterThan(2);
    expect(first.edges).toHaveLength(2);
    expect(first.truncated).toBe(true);
    expect(second.graphRevision).toBe(first.graphRevision);
    expect(
      second.edges
        .map(edge => edge.id)
        .some(id => first.edges.map(edge => edge.id).includes(id))
    ).toBe(false);
    expect(first.traversal.visitedNodeCount).toBeGreaterThan(1);

    expect(() =>
      service.query({
        name: 'Player',
        maxDepth: 1,
      })
    ).toThrow(
      expect.objectContaining({
        code: 'reference_graph_node_ambiguous',
      })
    );
    project.delete();
  });
});
