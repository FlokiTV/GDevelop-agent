// @flow
import { createSpriteAnimationService } from './SpriteAnimationService';
import { makeTestExtensions } from '../../fixtures/TestExtensions';

const gd: libGDevelop = global.gd;

const addImageResource = (project: gdProject, name: string) => {
  const resource = new gd.ImageResource();
  resource.setName(name);
  resource.setFile(name);
  project.getResourcesManager().addResource(resource);
  resource.delete();
};

const addAnimationReferenceAction = ({
  scene,
  objectName,
  animationName,
}: {|
  scene: gdLayout,
  objectName: string,
  animationName: string,
|}) => {
  const event = new gd.StandardEvent();
  const action = new gd.Instruction();
  action.setType('SetAnimationName');
  action.setParametersCount(2);
  action.setParameter(0, objectName);
  action.setParameter(1, `"${animationName}"`);
  event.getActions().insert(action, 0);
  scene.getEvents().insertEvent(event, 0);
  action.delete();
  event.delete();
  return gd
    .asStandardEvent(scene.getEvents().getEventAt(0))
    .getActions()
    .get(0);
};

describe('AgentIntegration SpriteAnimationService', () => {
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
    project.setName('DX30 Sprite Test');
    scene = project.insertNewLayout('Game', 0);
    scene.getObjects().insertNewObject(project, 'Sprite', 'Hero', 0);
    addImageResource(project, 'hero-a.png');
    addImageResource(project, 'hero-b.png');
    addImageResource(project, 'hero-c.png');

    triggerUnsavedChanges = jest.fn();
    forceUpdate = jest.fn();
    onObjectsModifiedOutsideEditor = jest.fn();
    service = createSpriteAnimationService({
      project,
      assetTools: {
        inspectVisualResource: ({ resourceName }) => ({
          image:
            resourceName === 'hero-a.png'
              ? { width: 32, height: 16 }
              : { width: 64, height: 32 },
        }),
      },
      triggerUnsavedChanges,
      forceUpdate,
      onObjectsModifiedOutsideEditor,
    });
  });

  afterEach(() => {
    project.delete();
  });

  const createRun = () =>
    service.createAnimation({
      sceneName: 'Game',
      objectName: 'Hero',
      animationName: 'Run',
      looping: true,
      timeBetweenFrames: 0.125,
    });

  it('creates and introspects multi-frame animations with timing and DX-28 resource metadata', () => {
    const created = createRun();
    expect(created.animation).toMatchObject({
      animationIndex: 0,
      animationName: 'Run',
      directions: [
        expect.objectContaining({
          looping: true,
          timeBetweenFrames: 0.125,
          timingModel: 'uniform-per-direction',
        }),
      ],
    });

    service.addFrame({
      sceneName: 'Game',
      objectName: 'Hero',
      animationName: 'Run',
      image: 'hero-a.png',
      origin: { x: 2, y: 3 },
      center: { default: false, x: 16, y: 8 },
      points: [{ name: 'Hand', x: 20, y: 7 }],
      collisionMask: {
        kind: 'polygons',
        polygons: [
          [{ x: 0, y: 0 }, { x: 32, y: 0 }, { x: 32, y: 16 }, { x: 0, y: 16 }],
        ],
      },
    });
    service.addFrame({
      sceneName: 'Game',
      objectName: 'Hero',
      animationName: 'Run',
      image: 'hero-b.png',
      origin: { x: 0, y: 0 },
      center: { default: true },
      points: [{ name: 'Hand', x: 21, y: 8 }],
      collisionMask: {
        kind: 'polygons',
        polygons: [
          [{ x: 0, y: 0 }, { x: 64, y: 0 }, { x: 64, y: 32 }, { x: 0, y: 32 }],
        ],
      },
    });

    const inspected = service.get({
      sceneName: 'Game',
      objectName: 'Hero',
      animationName: 'Run',
    });
    expect(inspected.target).toMatchObject({
      objectName: 'Hero',
      objectType: 'Sprite',
      objectScope: 'scene',
      sceneName: 'Game',
    });
    expect(inspected.animation.directions[0].frameCount).toBe(2);
    expect(inspected.animation.directions[0].frames[0]).toMatchObject({
      frameIndex: 0,
      image: 'hero-a.png',
      resource: {
        name: 'hero-a.png',
        exists: true,
        kind: 'image',
        image: { width: 32, height: 16 },
      },
      timing: {
        model: 'uniform-per-direction',
        durationSeconds: 0.125,
      },
      origin: { x: 2, y: 3 },
      center: { default: false, x: 16, y: 8 },
      points: [{ name: 'Hand', x: 20, y: 7 }],
      collisionMask: {
        kind: 'polygons',
        usesDefaultFullImageMask: false,
      },
    });
    expect(inspected.animation.diagnostics).toEqual([]);
    expect(onObjectsModifiedOutsideEditor).toHaveBeenCalledWith({
      scene,
      isNewObjectTypeUsed: false,
    });
  });

  it('updates frame image without corrupting points, masks or unrelated frames', () => {
    createRun();
    service.addFrame({
      sceneName: 'Game',
      objectName: 'Hero',
      animationName: 'Run',
      image: 'hero-a.png',
      points: [{ name: 'Grip', x: 5, y: 6 }],
      collisionMask: {
        kind: 'polygons',
        polygons: [
          [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
        ],
      },
    });
    service.addFrame({
      sceneName: 'Game',
      objectName: 'Hero',
      animationName: 'Run',
      image: 'hero-b.png',
    });

    const updated = service.updateFrame({
      sceneName: 'Game',
      objectName: 'Hero',
      animationName: 'Run',
      frameIndex: 0,
      image: 'hero-c.png',
    });

    expect(updated).toMatchObject({
      updated: true,
      change: {
        field: 'image',
        before: 'hero-a.png',
        after: 'hero-c.png',
      },
      preserved: {
        origin: true,
        center: true,
        customPoints: true,
        collisionMask: true,
        unrelatedAnimations: true,
      },
      frame: {
        image: 'hero-c.png',
        points: [{ name: 'Grip', x: 5, y: 6 }],
        collisionMask: { kind: 'polygons' },
      },
    });
    const after = service.get({
      sceneName: 'Game',
      objectName: 'Hero',
      animationName: 'Run',
    });
    expect(after.animation.directions[0].frames[1].image).toBe('hero-b.png');
  });

  it('authors points and collision masks with structured inconsistency diagnostics', () => {
    createRun();
    service.addFrame({
      sceneName: 'Game',
      objectName: 'Hero',
      animationName: 'Run',
      image: 'hero-a.png',
    });
    service.addFrame({
      sceneName: 'Game',
      objectName: 'Hero',
      animationName: 'Run',
      image: 'hero-b.png',
    });

    const point = service.setPoint({
      sceneName: 'Game',
      objectName: 'Hero',
      animationName: 'Run',
      frameIndex: 0,
      pointKind: 'custom',
      pointName: 'Muzzle',
      x: 14,
      y: 4,
    });
    expect(point.frame.points).toEqual([{ name: 'Muzzle', x: 14, y: 4 }]);
    expect(point.animationDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'sprite_point_names_inconsistent',
          severity: 'warning',
        }),
      ])
    );

    const masked = service.setCollisionMask({
      sceneName: 'Game',
      objectName: 'Hero',
      animationName: 'Run',
      frameIndex: 0,
      collisionMask: {
        kind: 'polygons',
        polygons: [
          [{ x: 0, y: 0 }, { x: 16, y: 0 }, { x: 16, y: 16 }, { x: 0, y: 16 }],
        ],
      },
    });
    expect(masked.frame.collisionMask.kind).toBe('polygons');
    expect(masked.animationDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'sprite_collision_mask_mode_inconsistent',
          severity: 'warning',
        }),
      ])
    );

    const reset = service.setCollisionMask({
      sceneName: 'Game',
      objectName: 'Hero',
      animationName: 'Run',
      frameIndex: 0,
      collisionMask: { kind: 'full-image' },
    });
    expect(reset.frame.collisionMask).toEqual({
      kind: 'full-image',
      usesDefaultFullImageMask: true,
    });
  });

  it('uses native animation-name refactor semantics and rejects duplicate names', () => {
    createRun();
    service.createAnimation({
      sceneName: 'Game',
      objectName: 'Hero',
      animationName: 'Idle',
    });
    expect(() =>
      service.updateAnimation({
        sceneName: 'Game',
        objectName: 'Hero',
        animationName: 'Run',
        newAnimationName: 'Idle',
      })
    ).toThrow('sprite_animation_name_already_exists');

    const action = addAnimationReferenceAction({
      scene,
      objectName: 'Hero',
      animationName: 'Run',
    });
    const renamed = service.updateAnimation({
      sceneName: 'Game',
      objectName: 'Hero',
      animationName: 'Run',
      newAnimationName: 'Sprint',
      looping: false,
      timeBetweenFrames: 0.2,
    });
    expect(renamed).toMatchObject({
      updated: true,
      renameRefactor: {
        nativeRefactor: true,
        valueType: 'objectAnimationName',
        scenes: ['Game'],
      },
      animation: {
        animationName: 'Sprint',
        directions: [
          expect.objectContaining({
            looping: false,
            timeBetweenFrames: 0.2,
          }),
        ],
      },
    });
    expect(action.getParameter(1).getPlainString()).toBe('"Sprint"');
  });

  it('dry-runs index-shifting mutations and requires explicit risk acknowledgement to apply', () => {
    createRun();
    service.createAnimation({
      sceneName: 'Game',
      objectName: 'Hero',
      animationName: 'Idle',
    });
    service.addFrame({
      sceneName: 'Game',
      objectName: 'Hero',
      animationName: 'Run',
      image: 'hero-a.png',
    });
    service.addFrame({
      sceneName: 'Game',
      objectName: 'Hero',
      animationName: 'Run',
      image: 'hero-b.png',
    });
    triggerUnsavedChanges.mockClear();

    const movePlan = service.moveAnimation({
      sceneName: 'Game',
      objectName: 'Hero',
      animationName: 'Run',
      toIndex: 1,
    });
    expect(movePlan).toMatchObject({
      moved: false,
      plan: {
        dryRun: true,
        referenceRisk: {
          requiresAcknowledgement: true,
          acknowledgementField: 'acknowledgeIndexReferenceRisk',
        },
      },
    });
    expect(triggerUnsavedChanges).not.toHaveBeenCalled();

    const movedAnimation = service.moveAnimation({
      sceneName: 'Game',
      objectName: 'Hero',
      animationName: 'Run',
      toIndex: 1,
      dryRun: false,
      acknowledgeIndexReferenceRisk: true,
    });
    expect(movedAnimation).toMatchObject({
      moved: true,
      animationName: 'Run',
      fromIndex: 0,
      toIndex: 1,
      referenceRisk: { requiresAcknowledgement: true },
    });
    expect(
      service
        .list({ sceneName: 'Game', objectName: 'Hero' })
        .items.map(animation => animation.animationName)
    ).toEqual(['Idle', 'Run']);

    expect(() =>
      service.moveFrame({
        sceneName: 'Game',
        objectName: 'Hero',
        animationName: 'Run',
        fromIndex: 0,
        toIndex: 1,
        dryRun: false,
      })
    ).toThrow('sprite_index_reference_risk_ack_required');

    const moved = service.moveFrame({
      sceneName: 'Game',
      objectName: 'Hero',
      animationName: 'Run',
      fromIndex: 0,
      toIndex: 1,
      dryRun: false,
      acknowledgeIndexReferenceRisk: true,
    });
    expect(moved).toMatchObject({
      moved: true,
      fromIndex: 0,
      toIndex: 1,
      referenceRisk: { requiresAcknowledgement: true },
    });

    const deletePlan = service.deleteFrame({
      sceneName: 'Game',
      objectName: 'Hero',
      animationName: 'Run',
      frameIndex: 0,
    });
    expect(deletePlan.deleted).toBe(false);
    expect(deletePlan.plan.referenceRisk.frameIndexReferences).toContain(
      'may-change-meaning'
    );

    const deletedFrame = service.deleteFrame({
      sceneName: 'Game',
      objectName: 'Hero',
      animationName: 'Run',
      frameIndex: 0,
      dryRun: false,
      acknowledgeIndexReferenceRisk: true,
    });
    expect(deletedFrame).toMatchObject({
      deleted: true,
      frameIndex: 0,
      remainingFrameCount: 1,
      referenceRisk: { requiresAcknowledgement: true },
    });
  });

  it('validates composite animation/point updates before mutating', () => {
    createRun();
    service.addFrame({
      sceneName: 'Game',
      objectName: 'Hero',
      animationName: 'Run',
      image: 'hero-a.png',
    });
    triggerUnsavedChanges.mockClear();

    expect(() =>
      service.updateAnimation({
        sceneName: 'Game',
        objectName: 'Hero',
        animationName: 'Run',
        newAnimationName: 'ShouldNotPersist',
        timeBetweenFrames: 0,
      })
    ).toThrow('invalid_sprite_frame_duration');
    expect(
      service.get({
        sceneName: 'Game',
        objectName: 'Hero',
        animationName: 'Run',
      }).animation.animationName
    ).toBe('Run');

    expect(() =>
      service.setPoint({
        sceneName: 'Game',
        objectName: 'Hero',
        animationName: 'Run',
        frameIndex: 0,
        pointKind: 'center',
        x: 'bad',
        y: 7,
      })
    ).toThrow('invalid_sprite_number');
    expect(
      service.get({
        sceneName: 'Game',
        objectName: 'Hero',
        animationName: 'Run',
      }).animation.directions[0].frames[0].center
    ).toEqual({ default: true });
    expect(triggerUnsavedChanges).not.toHaveBeenCalled();
  });

  it('rejects missing/non-image frame resources and non-convex masks before mutation', () => {
    createRun();
    expect(() =>
      service.addFrame({
        sceneName: 'Game',
        objectName: 'Hero',
        animationName: 'Run',
        image: 'missing.png',
      })
    ).toThrow('sprite_frame_resource_not_found');

    expect(() =>
      service.addFrame({
        sceneName: 'Game',
        objectName: 'Hero',
        animationName: 'Run',
        image: 'hero-a.png',
        collisionMask: {
          kind: 'polygons',
          polygons: [
            [
              { x: 0, y: 0 },
              { x: 10, y: 0 },
              { x: 2, y: 2 },
              { x: 10, y: 10 },
              { x: 0, y: 10 },
            ],
          ],
        },
      })
    ).toThrow('invalid_sprite_collision_polygon');
  });
});
