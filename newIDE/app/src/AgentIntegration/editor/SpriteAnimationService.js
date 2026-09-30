// @flow
import { AgentError } from '../core/AgentError';

const gd: libGDevelop = global.gd;

const MAX_ANIMATIONS = 512;
const MAX_DIRECTIONS = 32;
const MAX_POINTS = 128;
const MAX_POLYGONS = 32;
const MAX_VERTICES = 128;

const requireString = (value: any, field: string): string => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AgentError({
      code: 'missing_sprite_authoring_field',
      field,
      details: { field },
    });
  }
  return value.trim();
};

const finiteNumber = (value: any, field: string): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new AgentError({
      code: 'invalid_sprite_number',
      field,
      details: { field, value },
    });
  }
  return parsed;
};

const boundedInteger = (
  value: any,
  field: string,
  minimum: number,
  maximum: number
): number => {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new AgentError({
      code: 'invalid_sprite_index',
      field,
      details: { field, value, minimum, maximum },
    });
  }
  return value;
};

const vectorToArray = (vector: any, mapper: (any, number) => any): Array<any> =>
  vector && typeof vector.size === 'function'
    ? Array.from({ length: vector.size() }, (_, index) =>
        mapper(vector.at(index), index)
      )
    : [];

const serializePoint = (point: any): any => ({
  x: point.getX(),
  y: point.getY(),
});

const serializeCollisionMask = (sprite: any): any => {
  if (sprite.isFullImageCollisionMask()) {
    return { kind: 'full-image', usesDefaultFullImageMask: true };
  }
  return {
    kind: 'polygons',
    usesDefaultFullImageMask: false,
    polygons: vectorToArray(sprite.getCustomCollisionMask(), polygon =>
      vectorToArray(polygon.getVertices(), vertex => ({
        x: vertex.x,
        y: vertex.y,
      }))
    ),
  };
};

const customPointNames = (sprite: any): Array<string> =>
  vectorToArray(sprite.getAllNonDefaultPoints(), point => point.getName())
    .map(String)
    .sort((left, right) => left.localeCompare(right));

const pointNameSetKey = (sprite: any): string =>
  customPointNames(sprite).join('\u0000');

const makeIndexRisk = (kind: 'animation' | 'frame'): any =>
  kind === 'animation'
    ? {
        animationNameReferences:
          'preserved-when-name-is-unchanged; native refactor is used by rename',
        numericAnimationIndexReferences:
          'may-change-meaning-after-reorder-or-delete; no authoritative native rewrite contract is exposed',
        requiresAcknowledgement: true,
        acknowledgementField: 'acknowledgeIndexReferenceRisk',
      }
    : {
        frameIndexReferences:
          'may-change-meaning-after-reorder-or-delete; no authoritative native rewrite contract is exposed',
        animationNameReferences: 'unaffected',
        requiresAcknowledgement: true,
        acknowledgementField: 'acknowledgeIndexReferenceRisk',
      };

export const createSpriteAnimationService = ({
  project,
  assetTools,
  triggerUnsavedChanges,
  forceUpdate,
  onObjectsModifiedOutsideEditor,
}: {|
  project: gdProject,
  assetTools?: any,
  triggerUnsavedChanges: () => void,
  forceUpdate: () => void,
  onObjectsModifiedOutsideEditor?: any,
|}) => {
  const resourcesManager = project.getResourcesManager();

  const resolveObject = (input: any): any => {
    const objectName = requireString(input && input.objectName, 'objectName');
    const objectScope =
      input && typeof input.objectScope === 'string'
        ? input.objectScope
        : 'auto';
    if (!['auto', 'global', 'scene'].includes(objectScope)) {
      throw new AgentError({
        code: 'invalid_sprite_object_scope',
        field: 'objectScope',
        details: {
          allowedValues: ['auto', 'global', 'scene'],
          value: objectScope,
        },
      });
    }

    const sceneName =
      input && typeof input.sceneName === 'string' && input.sceneName
        ? input.sceneName
        : null;
    let scene = null;
    if (sceneName) {
      if (!project.hasLayoutNamed(sceneName)) {
        throw new AgentError({
          code: 'scene_not_found',
          field: 'sceneName',
          details: { sceneName },
        });
      }
      scene = project.getLayout(sceneName);
      if (
        objectScope !== 'global' &&
        scene.getObjects().hasObjectNamed(objectName)
      ) {
        const object = scene.getObjects().getObject(objectName);
        if (object.getType() !== 'Sprite') {
          throw new AgentError({
            code: 'object_not_sprite',
            field: 'objectName',
            details: {
              objectName,
              objectType: object.getType(),
              expectedObjectType: 'Sprite',
            },
          });
        }
        return {
          object,
          objectScope: 'scene',
          scene,
          configuration: gd.asSpriteConfiguration(object.getConfiguration()),
        };
      }
      if (objectScope === 'scene') {
        throw new AgentError({
          code: 'object_not_found',
          field: 'objectName',
          details: { objectName, objectScope: 'scene', sceneName },
        });
      }
    } else if (objectScope === 'scene') {
      throw new AgentError({
        code: 'missing_sprite_authoring_field',
        field: 'sceneName',
        details: { field: 'sceneName', objectScope: 'scene' },
      });
    }

    if (project.getObjects().hasObjectNamed(objectName)) {
      const object = project.getObjects().getObject(objectName);
      if (object.getType() !== 'Sprite') {
        throw new AgentError({
          code: 'object_not_sprite',
          field: 'objectName',
          details: {
            objectName,
            objectType: object.getType(),
            expectedObjectType: 'Sprite',
          },
        });
      }
      return {
        object,
        objectScope: 'global',
        scene: null,
        configuration: gd.asSpriteConfiguration(object.getConfiguration()),
      };
    }

    throw new AgentError({
      code: 'object_not_found',
      field: 'objectName',
      details: {
        objectName,
        objectScope,
        ...(sceneName ? { sceneName } : {}),
      },
    });
  };

  const targetOf = (resolved: any): any => ({
    objectName: resolved.object.getName(),
    objectType: resolved.object.getType(),
    objectScope: resolved.objectScope,
    ...(resolved.scene ? { sceneName: resolved.scene.getName() } : {}),
  });

  const notifyMutation = (resolved: any) => {
    triggerUnsavedChanges();
    forceUpdate();
    if (
      resolved.objectScope === 'scene' &&
      resolved.scene &&
      onObjectsModifiedOutsideEditor
    ) {
      onObjectsModifiedOutsideEditor({
        scene: resolved.scene,
        isNewObjectTypeUsed: false,
      });
    }
  };

  const assertImageResource = (imageName: string) => {
    if (!resourcesManager.hasResource(imageName)) {
      throw new AgentError({
        code: 'sprite_frame_resource_not_found',
        field: 'image',
        details: { resourceName: imageName },
      });
    }
    const resource = resourcesManager.getResource(imageName);
    if (resource.getKind() !== 'image') {
      throw new AgentError({
        code: 'sprite_frame_resource_not_image',
        field: 'image',
        details: {
          resourceName: imageName,
          resourceKind: resource.getKind(),
        },
      });
    }
  };

  const compactResourceMetadata = (imageName: string): any => {
    if (!imageName) return null;
    if (!resourcesManager.hasResource(imageName)) {
      return {
        name: imageName,
        exists: false,
        diagnostic: {
          code: 'sprite_frame_resource_not_found',
          severity: 'error',
        },
      };
    }
    const resource = resourcesManager.getResource(imageName);
    let visual = null;
    if (assetTools && typeof assetTools.inspectVisualResource === 'function') {
      try {
        visual = assetTools.inspectVisualResource({ resourceName: imageName });
      } catch (error) {
        visual = null;
      }
    }
    return {
      name: imageName,
      exists: true,
      kind: resource.getKind(),
      file: resource.useFile() ? resource.getFile() : null,
      ...(visual && visual.image ? { image: visual.image } : {}),
      ...(visual && visual.physical
        ? {
            physical: {
              mimeType: visual.physical.mimeType,
              byteSize: visual.physical.byteSize,
              projectRelativePath: visual.physical.projectRelativePath,
            },
          }
        : {}),
      discovery: {
        command: 'resources.visual.inspect',
        arguments: { resourceName: imageName },
      },
    };
  };

  const getAnimations = (resolved: any): any =>
    resolved.configuration.getAnimations();

  const findAnimationIndexByName = (
    animations: any,
    animationName: string
  ): number => {
    for (let index = 0; index < animations.getAnimationsCount(); index++) {
      if (animations.getAnimation(index).getName() === animationName) {
        return index;
      }
    }
    return -1;
  };

  const resolveAnimation = (resolved: any, input: any): any => {
    const animations = getAnimations(resolved);
    const count = animations.getAnimationsCount();
    let animationIndex = -1;
    if (Number.isInteger(input && input.animationIndex)) {
      animationIndex = boundedInteger(
        input.animationIndex,
        'animationIndex',
        0,
        Math.max(0, count - 1)
      );
    } else if (
      input &&
      typeof input.animationName === 'string' &&
      input.animationName
    ) {
      animationIndex = findAnimationIndexByName(
        animations,
        input.animationName
      );
      if (animationIndex < 0) {
        throw new AgentError({
          code: 'sprite_animation_not_found',
          field: 'animationName',
          details: { animationName: input.animationName },
        });
      }
    } else {
      throw new AgentError({
        code: 'missing_sprite_animation_selector',
        details: {
          requiredOneOf: ['animationIndex', 'animationName'],
        },
      });
    }
    if (animationIndex < 0 || animationIndex >= count) {
      throw new AgentError({
        code: 'sprite_animation_not_found',
        field: 'animationIndex',
        details: { animationIndex, animationCount: count },
      });
    }
    return {
      animations,
      animationIndex,
      animation: animations.getAnimation(animationIndex),
    };
  };

  const resolveDirection = (animationRecord: any, input: any): any => {
    const count = animationRecord.animation.getDirectionsCount();
    const directionIndex =
      input && Number.isInteger(input.directionIndex)
        ? input.directionIndex
        : 0;
    if (
      !Number.isInteger(directionIndex) ||
      directionIndex < 0 ||
      directionIndex >= count
    ) {
      throw new AgentError({
        code: 'sprite_direction_not_found',
        field: 'directionIndex',
        details: {
          directionIndex,
          directionCount: count,
          animationIndex: animationRecord.animationIndex,
        },
      });
    }
    return {
      ...animationRecord,
      directionIndex,
      direction: animationRecord.animation.getDirection(directionIndex),
    };
  };

  const resolveFrame = (directionRecord: any, input: any): any => {
    const count = directionRecord.direction.getSpritesCount();
    const frameIndex = boundedInteger(
      input && input.frameIndex,
      'frameIndex',
      0,
      Math.max(0, count - 1)
    );
    if (frameIndex >= count) {
      throw new AgentError({
        code: 'sprite_frame_not_found',
        field: 'frameIndex',
        details: {
          frameIndex,
          frameCount: count,
          animationIndex: directionRecord.animationIndex,
          directionIndex: directionRecord.directionIndex,
        },
      });
    }
    return {
      ...directionRecord,
      frameIndex,
      sprite: directionRecord.direction.getSprite(frameIndex),
    };
  };

  const animationDiagnostics = (animation: any): Array<any> => {
    const frames = [];
    for (
      let directionIndex = 0;
      directionIndex < animation.getDirectionsCount();
      directionIndex++
    ) {
      const direction = animation.getDirection(directionIndex);
      for (
        let frameIndex = 0;
        frameIndex < direction.getSpritesCount();
        frameIndex++
      ) {
        frames.push({
          directionIndex,
          frameIndex,
          sprite: direction.getSprite(frameIndex),
        });
      }
    }

    const diagnostics = [];
    const pointSets = new Map();
    const maskKinds = new Map();
    frames.forEach(record => {
      const pointKey = pointNameSetKey(record.sprite);
      if (!pointSets.has(pointKey)) pointSets.set(pointKey, []);
      pointSets.get(pointKey).push({
        directionIndex: record.directionIndex,
        frameIndex: record.frameIndex,
      });
      const maskKind = record.sprite.isFullImageCollisionMask()
        ? 'full-image'
        : 'polygons';
      if (!maskKinds.has(maskKind)) maskKinds.set(maskKind, []);
      maskKinds.get(maskKind).push({
        directionIndex: record.directionIndex,
        frameIndex: record.frameIndex,
      });
      const imageName = record.sprite.getImageName();
      if (imageName && !resourcesManager.hasResource(imageName)) {
        diagnostics.push({
          code: 'sprite_frame_resource_not_found',
          severity: 'error',
          resourceName: imageName,
          directionIndex: record.directionIndex,
          frameIndex: record.frameIndex,
        });
      }
    });

    if (pointSets.size > 1) {
      diagnostics.push({
        code: 'sprite_point_names_inconsistent',
        severity: 'warning',
        message:
          'Custom point-name sets differ across frames. Runtime point lookups can therefore resolve differently by frame.',
        variants: Array.from(pointSets.entries()).map(([key, locations]) => ({
          pointNames: key ? key.split('\u0000') : [],
          locations,
        })),
      });
    }
    if (maskKinds.size > 1) {
      diagnostics.push({
        code: 'sprite_collision_mask_mode_inconsistent',
        severity: 'warning',
        message: 'Frames mix full-image and custom polygon collision masks.',
        variants: Array.from(maskKinds.entries()).map(([kind, locations]) => ({
          kind,
          locations,
        })),
      });
    }
    return diagnostics;
  };

  const serializeFrame = ({
    resolved,
    animationIndex,
    directionIndex,
    frameIndex,
    direction,
    sprite,
  }: any): any => {
    const imageName = sprite.getImageName();
    return {
      frameIndex,
      identity: {
        kind: 'positional',
        selector: {
          animationIndex,
          directionIndex,
          frameIndex,
        },
        stability: 'changes-on-frame-reorder-or-delete',
      },
      image: imageName,
      resource: compactResourceMetadata(imageName),
      timing: {
        model: 'uniform-per-direction',
        durationSeconds: direction.getTimeBetweenFrames(),
        durationMilliseconds: direction.getTimeBetweenFrames() * 1000,
      },
      origin: serializePoint(sprite.getOrigin()),
      center: sprite.isDefaultCenterPoint()
        ? { default: true }
        : { default: false, ...serializePoint(sprite.getCenter()) },
      points: vectorToArray(sprite.getAllNonDefaultPoints(), point => ({
        name: point.getName(),
        ...serializePoint(point),
      })),
      collisionMask: serializeCollisionMask(sprite),
      mutation: {
        image: 'objects.sprite.frames.update',
        points: 'objects.sprite.points.set / objects.sprite.points.delete',
        collisionMask: 'objects.sprite.collision-mask.set',
      },
    };
  };

  const serializeAnimation = (
    resolved: any,
    animationIndex: number,
    options: any = {}
  ): any => {
    const animation = getAnimations(resolved).getAnimation(animationIndex);
    const frameLimit =
      Number.isInteger(options.frameLimit) && options.frameLimit > 0
        ? Math.min(options.frameLimit, 1000)
        : 200;
    const includeFrames = options.includeFrames !== false;
    const directions = Array.from(
      { length: animation.getDirectionsCount() },
      (_, directionIndex) => {
        const direction = animation.getDirection(directionIndex);
        const frameCount = direction.getSpritesCount();
        const includedCount = includeFrames
          ? Math.min(frameCount, frameLimit)
          : 0;
        return {
          directionIndex,
          looping: direction.isLooping(),
          timeBetweenFrames: direction.getTimeBetweenFrames(),
          frameDurationSeconds: direction.getTimeBetweenFrames(),
          frameDurationMilliseconds: direction.getTimeBetweenFrames() * 1000,
          timingModel: 'uniform-per-direction',
          metadata: direction.getMetadata(),
          frameCount,
          frames: includeFrames
            ? Array.from({ length: includedCount }, (_, frameIndex) =>
                serializeFrame({
                  resolved,
                  animationIndex,
                  directionIndex,
                  frameIndex,
                  direction,
                  sprite: direction.getSprite(frameIndex),
                })
              )
            : [],
          truncated: includeFrames && includedCount < frameCount,
        };
      }
    );

    const animationName = animation.getName();
    return {
      animationIndex,
      animationName,
      identity: animationName
        ? {
            kind: 'name-and-index',
            preferredSelector: { animationName },
            positionalSelector: { animationIndex },
          }
        : {
            kind: 'positional',
            preferredSelector: { animationIndex },
          },
      useMultipleDirections: animation.useMultipleDirections(),
      directionCount: animation.getDirectionsCount(),
      directions,
      diagnostics: animationDiagnostics(animation),
      referenceSemantics: {
        nameReferences:
          'rename uses native WholeProjectRefactorer for scene/external-event references',
        numericAnimationIndices:
          'not refactorable authoritatively on reorder/delete',
        frameIndices: 'not refactorable authoritatively on reorder/delete',
      },
    };
  };

  const list = (input: any = {}): any => {
    const resolved = resolveObject(input);
    const animations = getAnimations(resolved);
    const count = animations.getAnimationsCount();
    const offset =
      Number.isInteger(input.offset) && input.offset >= 0 ? input.offset : 0;
    const limit =
      Number.isInteger(input.limit) && input.limit > 0
        ? Math.min(input.limit, 100)
        : 25;
    const end = Math.min(count, offset + limit);
    return {
      target: targetOf(resolved),
      count,
      offset,
      limit,
      items: Array.from({ length: Math.max(0, end - offset) }, (_, index) =>
        serializeAnimation(resolved, offset + index, input)
      ),
      truncated: end < count,
      adaptCollisionMaskAutomatically: animations.adaptCollisionMaskAutomatically(),
      resourceDiscovery: {
        command: 'resources.visual.inspect',
        linkedFrom: 'frame.resource.discovery',
      },
    };
  };

  const get = (input: any): any => {
    const resolved = resolveObject(input);
    const animationRecord = resolveAnimation(resolved, input);
    return {
      target: targetOf(resolved),
      animation: serializeAnimation(
        resolved,
        animationRecord.animationIndex,
        input
      ),
    };
  };

  const ensureUniqueAnimationName = (
    animations: any,
    name: string,
    exceptIndex: ?number
  ) => {
    const existingIndex = findAnimationIndexByName(animations, name);
    if (existingIndex >= 0 && existingIndex !== exceptIndex) {
      throw new AgentError({
        code: 'sprite_animation_name_already_exists',
        field: 'animationName',
        details: { animationName: name, existingIndex },
      });
    }
  };

  const createAnimation = (input: any): any => {
    const resolved = resolveObject(input);
    const animations = getAnimations(resolved);
    if (animations.getAnimationsCount() >= MAX_ANIMATIONS) {
      throw new AgentError({
        code: 'sprite_animation_limit_exceeded',
        details: { maximum: MAX_ANIMATIONS },
      });
    }
    const animationName = requireString(input.animationName, 'animationName');
    ensureUniqueAnimationName(animations, animationName, null);
    const directionCount =
      input.directionCount === undefined
        ? 1
        : boundedInteger(
            input.directionCount,
            'directionCount',
            1,
            MAX_DIRECTIONS
          );
    const timeBetweenFrames =
      input.timeBetweenFrames === undefined
        ? 0.08
        : finiteNumber(input.timeBetweenFrames, 'timeBetweenFrames');
    if (timeBetweenFrames <= 0) {
      throw new AgentError({
        code: 'invalid_sprite_frame_duration',
        field: 'timeBetweenFrames',
        details: { value: timeBetweenFrames, minimumExclusive: 0 },
      });
    }
    const animation = new gd.Animation();
    try {
      animation.setName(animationName);
      animation.setDirectionsCount(directionCount);
      animation.setUseMultipleDirections(
        input.useMultipleDirections === true || directionCount > 1
      );
      for (let index = 0; index < directionCount; index++) {
        const direction = animation.getDirection(index);
        direction.setLoop(input.looping === true);
        direction.setTimeBetweenFrames(timeBetweenFrames);
      }
      animations.addAnimation(animation);
    } finally {
      animation.delete();
    }
    notifyMutation(resolved);
    const animationIndex = animations.getAnimationsCount() - 1;
    return {
      created: true,
      target: targetOf(resolved),
      animation: serializeAnimation(resolved, animationIndex, input),
      indexSafety: {
        existingNumericAnimationIndicesPreserved: true,
        reason: 'new animations are appended',
      },
    };
  };

  const refactorAnimationName = (
    resolved: any,
    oldName: string,
    newName: string
  ): any => {
    const scenes = [];
    if (resolved.objectScope === 'scene' && resolved.scene) {
      gd.WholeProjectRefactorer.renameObjectAnimationInScene(
        project,
        resolved.scene,
        resolved.object,
        oldName,
        newName
      );
      scenes.push(resolved.scene.getName());
    } else {
      for (let index = 0; index < project.getLayoutsCount(); index++) {
        const scene = project.getLayoutAt(index);
        gd.WholeProjectRefactorer.renameObjectAnimationInScene(
          project,
          scene,
          resolved.object,
          oldName,
          newName
        );
        scenes.push(scene.getName());
      }
    }
    return {
      nativeRefactor: true,
      valueType: 'objectAnimationName',
      scenes,
      coverage:
        resolved.objectScope === 'scene'
          ? 'scene-events-and-linked-external-events'
          : 'all-project-scenes-and-linked-external-events',
      eventsBasedObjectScopes:
        'not targeted by this scene/global object-definition operation',
    };
  };

  const updateAnimation = (input: any): any => {
    const resolved = resolveObject(input);
    const record = resolveAnimation(resolved, input);
    const animation = record.animation;
    const oldName = animation.getName();
    const newName =
      input.newAnimationName !== undefined
        ? requireString(input.newAnimationName, 'newAnimationName')
        : oldName;
    if (newName !== oldName) {
      ensureUniqueAnimationName(
        record.animations,
        newName,
        record.animationIndex
      );
    }

    const wantsDirectionTiming =
      input.looping !== undefined || input.timeBetweenFrames !== undefined;
    const directionRecord = wantsDirectionTiming
      ? resolveDirection(record, input)
      : null;
    const validatedTimeBetweenFrames =
      input.timeBetweenFrames !== undefined
        ? finiteNumber(input.timeBetweenFrames, 'timeBetweenFrames')
        : null;
    if (
      validatedTimeBetweenFrames !== null &&
      validatedTimeBetweenFrames <= 0
    ) {
      throw new AgentError({
        code: 'invalid_sprite_frame_duration',
        field: 'timeBetweenFrames',
        details: {
          value: validatedTimeBetweenFrames,
          minimumExclusive: 0,
        },
      });
    }

    const changes = [];
    let renameRefactor = null;

    if (newName !== oldName) {
      if (oldName && newName) {
        renameRefactor = refactorAnimationName(resolved, oldName, newName);
      }
      animation.setName(newName);
      changes.push({ field: 'animationName', before: oldName, after: newName });
    }

    if (input.useMultipleDirections !== undefined) {
      const before = animation.useMultipleDirections();
      const after = input.useMultipleDirections === true;
      if (before !== after) {
        animation.setUseMultipleDirections(after);
        changes.push({
          field: 'useMultipleDirections',
          before,
          after,
        });
      }
    }

    if (directionRecord) {
      const direction = directionRecord.direction;
      if (input.looping !== undefined) {
        const before = direction.isLooping();
        const after = input.looping === true;
        if (before !== after) {
          direction.setLoop(after);
          changes.push({
            field: `directions[${directionRecord.directionIndex}].looping`,
            before,
            after,
          });
        }
      }
      if (validatedTimeBetweenFrames !== null) {
        const before = direction.getTimeBetweenFrames();
        if (before !== validatedTimeBetweenFrames) {
          direction.setTimeBetweenFrames(validatedTimeBetweenFrames);
          changes.push({
            field: `directions[${
              directionRecord.directionIndex
            }].timeBetweenFrames`,
            before,
            after: validatedTimeBetweenFrames,
          });
        }
      }
    }

    if (!changes.length) {
      return {
        updated: false,
        nothingChanged: true,
        target: targetOf(resolved),
        animation: serializeAnimation(resolved, record.animationIndex, input),
      };
    }
    notifyMutation(resolved);
    return {
      updated: true,
      target: targetOf(resolved),
      changes,
      renameRefactor,
      animation: serializeAnimation(resolved, record.animationIndex, input),
    };
  };

  const mutationPlan = (
    kind: 'animation' | 'frame',
    operation: string,
    details: any
  ): any => ({
    dryRun: true,
    operation,
    ...details,
    referenceRisk: makeIndexRisk(kind),
    apply: {
      dryRun: false,
      acknowledgeIndexReferenceRisk: true,
    },
  });

  const requireIndexRiskAcknowledgement = (input: any) => {
    if (input.acknowledgeIndexReferenceRisk !== true) {
      throw new AgentError({
        code: 'sprite_index_reference_risk_ack_required',
        field: 'acknowledgeIndexReferenceRisk',
        details: {
          value: input.acknowledgeIndexReferenceRisk,
          reason:
            'Reorder/delete can change numeric animation/frame index meaning and current libGD exposes no authoritative rewrite contract for those references.',
        },
        hint:
          'Run the operation as dry-run, review referenceRisk, then repeat with dryRun=false and acknowledgeIndexReferenceRisk=true if the impact is acceptable.',
      });
    }
  };

  const moveAnimation = (input: any): any => {
    const resolved = resolveObject(input);
    const record = resolveAnimation(resolved, input);
    const count = record.animations.getAnimationsCount();
    const toIndex = boundedInteger(
      input.toIndex,
      'toIndex',
      0,
      Math.max(0, count - 1)
    );
    const details = {
      target: targetOf(resolved),
      animationName: record.animation.getName(),
      fromIndex: record.animationIndex,
      toIndex,
    };
    if (input.dryRun !== false) {
      return {
        moved: false,
        plan: mutationPlan('animation', 'move', details),
      };
    }
    requireIndexRiskAcknowledgement(input);
    record.animations.moveAnimation(record.animationIndex, toIndex);
    notifyMutation(resolved);
    return {
      moved: true,
      ...details,
      animation: serializeAnimation(resolved, toIndex, input),
      referenceRisk: makeIndexRisk('animation'),
    };
  };

  const deleteAnimation = (input: any): any => {
    const resolved = resolveObject(input);
    const record = resolveAnimation(resolved, input);
    const details = {
      target: targetOf(resolved),
      animationName: record.animation.getName(),
      animationIndex: record.animationIndex,
      frameCount: Array.from(
        { length: record.animation.getDirectionsCount() },
        (_, index) => record.animation.getDirection(index).getSpritesCount()
      ).reduce((sum, value) => sum + value, 0),
    };
    if (input.dryRun !== false) {
      return {
        deleted: false,
        plan: mutationPlan('animation', 'delete', details),
      };
    }
    requireIndexRiskAcknowledgement(input);
    record.animations.removeAnimation(record.animationIndex);
    notifyMutation(resolved);
    return {
      deleted: true,
      ...details,
      remainingAnimationCount: record.animations.getAnimationsCount(),
      referenceRisk: makeIndexRisk('animation'),
    };
  };

  const applyPointCoordinates = (
    point: any,
    input: any,
    fieldPrefix: string
  ) => {
    point.setXY(
      finiteNumber(input && input.x, `${fieldPrefix}.x`),
      finiteNumber(input && input.y, `${fieldPrefix}.y`)
    );
  };

  const applyCollisionMask = (sprite: any, mask: any) => {
    const kind = mask && mask.kind;
    if (kind === 'full-image') {
      sprite.setFullImageCollisionMask(true);
      return;
    }
    if (kind !== 'polygons') {
      throw new AgentError({
        code: 'invalid_sprite_collision_mask',
        field: 'collisionMask.kind',
        details: { allowedValues: ['full-image', 'polygons'], value: kind },
      });
    }
    if (!Array.isArray(mask.polygons) || !mask.polygons.length) {
      throw new AgentError({
        code: 'invalid_sprite_collision_mask',
        field: 'collisionMask.polygons',
        details: { minimumItems: 1 },
      });
    }
    if (mask.polygons.length > MAX_POLYGONS) {
      throw new AgentError({
        code: 'invalid_sprite_collision_mask',
        field: 'collisionMask.polygons',
        details: { maximumItems: MAX_POLYGONS },
      });
    }

    const polygons = new gd.VectorPolygon2d();
    try {
      mask.polygons.forEach((verticesInput, polygonIndex) => {
        if (
          !Array.isArray(verticesInput) ||
          verticesInput.length < 3 ||
          verticesInput.length > MAX_VERTICES
        ) {
          throw new AgentError({
            code: 'invalid_sprite_collision_polygon',
            field: `collisionMask.polygons[${polygonIndex}]`,
            details: {
              minimumVertices: 3,
              maximumVertices: MAX_VERTICES,
            },
          });
        }
        const polygon = new gd.Polygon2d();
        try {
          const vertices = polygon.getVertices();
          verticesInput.forEach((vertexInput, vertexIndex) => {
            const vertex = new gd.Vector2f();
            try {
              vertex.x = finiteNumber(
                vertexInput && vertexInput.x,
                `collisionMask.polygons[${polygonIndex}][${vertexIndex}].x`
              );
              vertex.y = finiteNumber(
                vertexInput && vertexInput.y,
                `collisionMask.polygons[${polygonIndex}][${vertexIndex}].y`
              );
              vertices.push_back(vertex);
            } finally {
              vertex.delete();
            }
          });
          if (!polygon.isConvex()) {
            throw new AgentError({
              code: 'invalid_sprite_collision_polygon',
              field: `collisionMask.polygons[${polygonIndex}]`,
              details: { reason: 'polygon_must_be_convex' },
            });
          }
          polygons.push_back(polygon);
        } finally {
          polygon.delete();
        }
      });
      sprite.setCustomCollisionMask(polygons);
      sprite.setFullImageCollisionMask(false);
    } finally {
      polygons.delete();
    }
  };

  const buildFrame = (input: any): any => {
    const image = requireString(input.image, 'image');
    assertImageResource(image);
    const sprite = new gd.Sprite();
    try {
      sprite.setImageName(image);
      if (input.origin) {
        applyPointCoordinates(sprite.getOrigin(), input.origin, 'origin');
      }
      if (input.center && input.center.default === false) {
        sprite.setDefaultCenterPoint(false);
        applyPointCoordinates(sprite.getCenter(), input.center, 'center');
      } else {
        sprite.setDefaultCenterPoint(true);
      }
      const points = Array.isArray(input.points) ? input.points : [];
      if (points.length > MAX_POINTS) {
        throw new AgentError({
          code: 'sprite_point_limit_exceeded',
          field: 'points',
          details: { maximum: MAX_POINTS },
        });
      }
      const seen = new Set();
      points.forEach((pointInput, pointIndex) => {
        const name = requireString(
          pointInput && pointInput.name,
          `points[${pointIndex}].name`
        );
        if (name === 'Origin' || name === 'Center' || seen.has(name)) {
          throw new AgentError({
            code: 'invalid_sprite_point_name',
            field: `points[${pointIndex}].name`,
            details: { name, reserved: ['Origin', 'Center'] },
          });
        }
        seen.add(name);
        const point = new gd.Point(name);
        try {
          applyPointCoordinates(point, pointInput, `points[${pointIndex}]`);
          sprite.addPoint(point);
        } finally {
          point.delete();
        }
      });
      applyCollisionMask(sprite, input.collisionMask || { kind: 'full-image' });
      return sprite;
    } catch (error) {
      sprite.delete();
      throw error;
    }
  };

  const addFrame = (input: any): any => {
    const resolved = resolveObject(input);
    const directionRecord = resolveDirection(
      resolveAnimation(resolved, input),
      input
    );
    const sprite = buildFrame(input);
    try {
      directionRecord.direction.addSprite(sprite);
    } finally {
      sprite.delete();
    }
    notifyMutation(resolved);
    const frameIndex = directionRecord.direction.getSpritesCount() - 1;
    return {
      added: true,
      target: targetOf(resolved),
      animationIndex: directionRecord.animationIndex,
      animationName: directionRecord.animation.getName(),
      directionIndex: directionRecord.directionIndex,
      frame: serializeFrame({
        resolved,
        animationIndex: directionRecord.animationIndex,
        directionIndex: directionRecord.directionIndex,
        frameIndex,
        direction: directionRecord.direction,
        sprite: directionRecord.direction.getSprite(frameIndex),
      }),
      indexSafety: {
        existingFrameIndicesPreserved: true,
        reason: 'new frames are appended',
      },
    };
  };

  const updateFrame = (input: any): any => {
    const resolved = resolveObject(input);
    const frameRecord = resolveFrame(
      resolveDirection(resolveAnimation(resolved, input), input),
      input
    );
    const image = requireString(input.image, 'image');
    assertImageResource(image);
    const before = frameRecord.sprite.getImageName();
    if (before === image) {
      return {
        updated: false,
        nothingChanged: true,
        target: targetOf(resolved),
        frame: serializeFrame({
          ...frameRecord,
          resolved,
        }),
      };
    }
    frameRecord.sprite.setImageName(image);
    notifyMutation(resolved);
    return {
      updated: true,
      target: targetOf(resolved),
      change: { field: 'image', before, after: image },
      preserved: {
        frameIdentityPosition: true,
        origin: true,
        center: true,
        customPoints: true,
        collisionMask: true,
        unrelatedAnimations: true,
      },
      frame: serializeFrame({
        ...frameRecord,
        resolved,
      }),
    };
  };

  const moveFrame = (input: any): any => {
    const resolved = resolveObject(input);
    const directionRecord = resolveDirection(
      resolveAnimation(resolved, input),
      input
    );
    const count = directionRecord.direction.getSpritesCount();
    const fromIndex = boundedInteger(
      input.fromIndex,
      'fromIndex',
      0,
      Math.max(0, count - 1)
    );
    const toIndex = boundedInteger(
      input.toIndex,
      'toIndex',
      0,
      Math.max(0, count - 1)
    );
    const details = {
      target: targetOf(resolved),
      animationIndex: directionRecord.animationIndex,
      animationName: directionRecord.animation.getName(),
      directionIndex: directionRecord.directionIndex,
      fromIndex,
      toIndex,
    };
    if (input.dryRun !== false) {
      return {
        moved: false,
        plan: mutationPlan('frame', 'move', details),
      };
    }
    requireIndexRiskAcknowledgement(input);
    directionRecord.direction.moveSprite(fromIndex, toIndex);
    notifyMutation(resolved);
    return {
      moved: true,
      ...details,
      referenceRisk: makeIndexRisk('frame'),
    };
  };

  const deleteFrame = (input: any): any => {
    const resolved = resolveObject(input);
    const frameRecord = resolveFrame(
      resolveDirection(resolveAnimation(resolved, input), input),
      input
    );
    const details = {
      target: targetOf(resolved),
      animationIndex: frameRecord.animationIndex,
      animationName: frameRecord.animation.getName(),
      directionIndex: frameRecord.directionIndex,
      frameIndex: frameRecord.frameIndex,
      image: frameRecord.sprite.getImageName(),
    };
    if (input.dryRun !== false) {
      return {
        deleted: false,
        plan: mutationPlan('frame', 'delete', details),
      };
    }
    requireIndexRiskAcknowledgement(input);
    frameRecord.direction.removeSprite(frameRecord.frameIndex);
    notifyMutation(resolved);
    return {
      deleted: true,
      ...details,
      remainingFrameCount: frameRecord.direction.getSpritesCount(),
      referenceRisk: makeIndexRisk('frame'),
    };
  };

  const setPoint = (input: any): any => {
    const resolved = resolveObject(input);
    const frameRecord = resolveFrame(
      resolveDirection(resolveAnimation(resolved, input), input),
      input
    );
    const kind = requireString(input.pointKind, 'pointKind');
    if (!['origin', 'center', 'custom'].includes(kind)) {
      throw new AgentError({
        code: 'invalid_sprite_point_kind',
        field: 'pointKind',
        details: { allowedValues: ['origin', 'center', 'custom'], value: kind },
      });
    }

    const needsCoordinates =
      kind !== 'center' || input.useDefaultCenter !== true;
    const x = needsCoordinates ? finiteNumber(input.x, 'point.x') : null;
    const y = needsCoordinates ? finiteNumber(input.y, 'point.y') : null;

    if (kind === 'origin') {
      frameRecord.sprite.getOrigin().setXY(x, y);
    } else if (kind === 'center') {
      if (input.useDefaultCenter === true) {
        frameRecord.sprite.setDefaultCenterPoint(true);
      } else {
        frameRecord.sprite.setDefaultCenterPoint(false);
        frameRecord.sprite.getCenter().setXY(x, y);
      }
    } else {
      const name = requireString(input.pointName, 'pointName');
      if (name === 'Origin' || name === 'Center') {
        throw new AgentError({
          code: 'invalid_sprite_point_name',
          field: 'pointName',
          details: { name, reserved: ['Origin', 'Center'] },
        });
      }
      if (frameRecord.sprite.hasPoint(name)) {
        frameRecord.sprite.getPoint(name).setXY(x, y);
      } else {
        if (frameRecord.sprite.getAllNonDefaultPoints().size() >= MAX_POINTS) {
          throw new AgentError({
            code: 'sprite_point_limit_exceeded',
            details: { maximum: MAX_POINTS },
          });
        }
        const point = new gd.Point(name);
        try {
          point.setXY(x, y);
          frameRecord.sprite.addPoint(point);
        } finally {
          point.delete();
        }
      }
    }
    notifyMutation(resolved);
    return {
      updated: true,
      target: targetOf(resolved),
      pointKind: kind,
      pointName: kind === 'custom' ? input.pointName : null,
      frame: serializeFrame({
        ...frameRecord,
        resolved,
      }),
      animationDiagnostics: animationDiagnostics(frameRecord.animation),
    };
  };

  const deletePoint = (input: any): any => {
    const resolved = resolveObject(input);
    const frameRecord = resolveFrame(
      resolveDirection(resolveAnimation(resolved, input), input),
      input
    );
    const name = requireString(input.pointName, 'pointName');
    if (name === 'Origin' || name === 'Center') {
      throw new AgentError({
        code: 'sprite_default_point_cannot_be_deleted',
        field: 'pointName',
        details: { pointName: name },
      });
    }
    const names = customPointNames(frameRecord.sprite);
    if (!names.includes(name)) {
      throw new AgentError({
        code: 'sprite_point_not_found',
        field: 'pointName',
        details: { pointName: name, availablePointNames: names },
      });
    }
    frameRecord.sprite.delPoint(name);
    notifyMutation(resolved);
    return {
      deleted: true,
      target: targetOf(resolved),
      pointName: name,
      frame: serializeFrame({
        ...frameRecord,
        resolved,
      }),
      animationDiagnostics: animationDiagnostics(frameRecord.animation),
    };
  };

  const setCollisionMask = (input: any): any => {
    const resolved = resolveObject(input);
    const frameRecord = resolveFrame(
      resolveDirection(resolveAnimation(resolved, input), input),
      input
    );
    applyCollisionMask(frameRecord.sprite, input.collisionMask);
    notifyMutation(resolved);
    return {
      updated: true,
      target: targetOf(resolved),
      frame: serializeFrame({
        ...frameRecord,
        resolved,
      }),
      animationDiagnostics: animationDiagnostics(frameRecord.animation),
    };
  };

  return {
    list,
    get,
    createAnimation,
    updateAnimation,
    moveAnimation,
    deleteAnimation,
    addFrame,
    updateFrame,
    moveFrame,
    deleteFrame,
    setPoint,
    deletePoint,
    setCollisionMask,
  };
};
