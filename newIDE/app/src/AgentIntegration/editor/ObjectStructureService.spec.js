// @flow
import {
  createObjectStructureService,
  objectStructureInternals,
} from './ObjectStructureService';
import { makeTestExtensions } from '../../fixtures/TestExtensions';

const gd: libGDevelop = global.gd;

const makeSpriteStructure = () => ({
  kind: 'sprite',
  adaptCollisionMaskAutomatically: false,
  updateIfNotVisible: true,
  preScale: 2,
  animations: [
    {
      name: 'Run',
      useMultipleDirections: false,
      directions: [
        {
          loop: true,
          timeBetweenFrames: 0.125,
          metadata: 'agent-test',
          frames: [
            {
              image: 'hero.png',
              origin: { x: 4, y: 5 },
              center: { default: false, x: 16, y: 17 },
              points: [{ name: 'Hand', x: 22, y: 8 }],
              collisionMask: {
                kind: 'polygons',
                polygons: [
                  [
                    { x: 0, y: 0 },
                    { x: 32, y: 0 },
                    { x: 32, y: 32 },
                    { x: 0, y: 32 },
                  ],
                ],
              },
            },
            {
              image: 'hero-2.png',
              origin: { x: 0, y: 0 },
              center: { default: true },
              points: [],
              collisionMask: { kind: 'full-image' },
            },
          ],
        },
      ],
    },
  ],
});

describe('AgentIntegration ObjectStructureService', () => {
  let project: gdProject;
  let scene: gdLayout;
  let service: any;
  let triggerUnsavedChanges: jest.Mock<any, any>;
  let forceUpdate: jest.Mock<any, any>;
  let onObjectsModifiedOutsideEditor: jest.Mock<any, any>;

  beforeAll(() => {
    makeTestExtensions(gd);
  });

  beforeEach(() => {
    // $FlowFixMe[invalid-constructor]
    project = new gd.ProjectHelper.createNewGDJSProject();
    project.resetProjectUuid();
    project.setName('Object Structure Test');
    scene = project.insertNewLayout('Game', 0);
    scene.getObjects().insertNewObject(project, 'Sprite', 'Player', 0);
    triggerUnsavedChanges = jest.fn();
    forceUpdate = jest.fn();
    onObjectsModifiedOutsideEditor = jest.fn();
    service = createObjectStructureService({
      project,
      triggerUnsavedChanges,
      forceUpdate,
      onObjectsModifiedOutsideEditor,
    });
  });

  afterEach(() => {
    project.delete();
  });

  it('reports an extensible handler catalog without pretending scalar types are nested structures', () => {
    expect(service.capabilities({ objectType: 'Sprite' })).toMatchObject({
      objectType: 'Sprite',
      capability: { id: 'sprite', structural: true },
      registeredHandlers: expect.arrayContaining([
        expect.objectContaining({ id: 'model3d', structural: true }),
        expect.objectContaining({
          id: 'particle-emitter-properties',
          structural: false,
          coveredBy: 'editor.functions.change-object-property',
        }),
        expect.objectContaining({
          id: 'tilemap-properties',
          structural: false,
        }),
      ]),
    });

    expect(
      service.capabilities({ objectType: 'ParticleSystem::ParticleEmitter' })
        .capability
    ).toMatchObject({
      structural: false,
      coveredBy: 'editor.functions.change-object-property',
    });
  });

  it('replaces and round-trips Sprite animations, frames, points and collision masks', () => {
    const structure = makeSpriteStructure();
    const applied = service.apply({
      sceneName: 'Game',
      objectName: 'Player',
      mode: 'replace',
      structure,
    });

    expect(applied.applied).toBe(true);
    expect(applied.structure).toMatchObject(structure);
    expect(triggerUnsavedChanges).toHaveBeenCalledTimes(1);
    expect(forceUpdate).toHaveBeenCalledTimes(1);
    expect(onObjectsModifiedOutsideEditor).toHaveBeenCalledWith({
      scene,
      isNewObjectTypeUsed: false,
    });

    const inspected = service.inspect({
      sceneName: 'Game',
      objectName: 'Player',
    });
    expect(inspected.target).toMatchObject({
      scope: 'scene',
      sceneName: 'Game',
      objectName: 'Player',
      objectType: 'Sprite',
    });
    expect(inspected.structure).toMatchObject(structure);
    expect(inspected.structure.animations[0].directions[0].frames[0]).toEqual({
      image: 'hero.png',
      origin: { x: 4, y: 5 },
      center: { default: false, x: 16, y: 17 },
      points: [{ name: 'Hand', x: 22, y: 8 }],
      collisionMask: {
        kind: 'polygons',
        polygons: [
          [{ x: 0, y: 0 }, { x: 32, y: 0 }, { x: 32, y: 32 }, { x: 0, y: 32 }],
        ],
      },
    });
  });

  it('supports global Sprite objects with the same structural handler', () => {
    project.getObjects().insertNewObject(project, 'Sprite', 'GlobalHero', 0);
    service.apply({
      scope: 'global',
      objectName: 'GlobalHero',
      structure: makeSpriteStructure(),
    });
    const inspected = service.inspect({
      scope: 'global',
      objectName: 'GlobalHero',
    });
    expect(inspected.target.scope).toBe('global');
    expect(inspected.structure.animations[0].name).toBe('Run');
    expect(onObjectsModifiedOutsideEditor).not.toHaveBeenCalled();
  });

  it('round-trips the native Model3D animation structure without requiring the test platform extension', () => {
    const configuration = new gd.Model3DObjectConfiguration();
    const object: any = {
      getConfiguration: () => configuration,
      getType: () => 'Scene3D::Model3DObject',
    };
    try {
      objectStructureInternals.replaceModel3DStructure(object, {
        kind: 'model3d',
        animations: [
          { name: 'Idle', source: 'Idle', loop: true },
          { name: 'Attack', source: 'Attack', loop: false },
        ],
      });
      expect(
        objectStructureInternals.serializeModel3DStructure(object)
      ).toMatchObject({
        kind: 'model3d',
        animations: [
          { name: 'Idle', source: 'Idle', loop: true },
          { name: 'Attack', source: 'Attack', loop: false },
        ],
      });
    } finally {
      configuration.delete();
    }

    expect(
      service.capabilities({ objectType: 'Scene3D::Model3DObject' })
    ).toMatchObject({
      installed: false,
      capability: {
        id: 'model3d',
        structural: false,
        registeredStructural: true,
      },
    });
  });

  it('rejects unsupported structures and malformed collision polygons before marking project dirty', () => {
    expect(() =>
      service.inspect({ sceneName: 'Game', objectName: 'Missing' })
    ).toThrow('Object not found');

    const bad = makeSpriteStructure();
    bad.animations[0].directions[0].frames[0].collisionMask = {
      kind: 'polygons',
      polygons: [[{ x: 0, y: 0 }, { x: 1, y: 1 }]],
    };
    expect(() =>
      service.apply({ sceneName: 'Game', objectName: 'Player', structure: bad })
    ).toThrow('at least 3 vertices');
    expect(triggerUnsavedChanges).not.toHaveBeenCalled();
  });
});
