// @flow
import { AgentError } from '../core/AgentError';

const gd: libGDevelop = global.gd;

const MAX_ANIMATIONS = 500;
const MAX_DIRECTIONS = 32;
const MAX_FRAMES = 1000;
const MAX_POINTS = 100;
const MAX_POLYGONS = 64;
const MAX_VERTICES = 64;

const requireString = (value: any, field: string): string => {
  if (typeof value !== 'string') {
    throw new AgentError({
      code: 'invalid_object_structure_input',
      message: `${field} must be a string.`,
      details: { field },
    });
  }
  return value;
};

const finiteNumber = (value: any, field: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new AgentError({
      code: 'invalid_object_structure_input',
      message: `${field} must be a finite number.`,
      details: { field },
    });
  }
  return value;
};

const boundedArray = (
  value: any,
  field: string,
  maxItems: number
): Array<any> => {
  if (!Array.isArray(value)) {
    throw new AgentError({
      code: 'invalid_object_structure_input',
      message: `${field} must be an array.`,
      details: { field },
    });
  }
  if (value.length > maxItems) {
    throw new AgentError({
      code: 'object_structure_too_large',
      message: `${field} exceeds the maximum of ${maxItems} items.`,
      details: { field, maxItems, received: value.length },
    });
  }
  return value;
};

const vectorToArray = (vector: any, mapper: any): Array<any> =>
  Array.from({ length: vector.size() }, (_, index) =>
    mapper(vector.at(index), index)
  );

const serializePoint = (point: any) => ({ x: point.getX(), y: point.getY() });

const serializeCollisionMask = (sprite: gdSprite) => {
  if (sprite.isFullImageCollisionMask()) return { kind: 'full-image' };
  const polygons = sprite.getCustomCollisionMask();
  return {
    kind: 'polygons',
    polygons: vectorToArray(polygons, polygon =>
      vectorToArray(polygon.getVertices(), vertex => ({
        x: vertex.x,
        y: vertex.y,
      }))
    ),
  };
};

const serializeSpriteFrame = (sprite: gdSprite) => ({
  image: sprite.getImageName(),
  origin: serializePoint(sprite.getOrigin()),
  center: sprite.isDefaultCenterPoint()
    ? { default: true }
    : { default: false, ...serializePoint(sprite.getCenter()) },
  points: vectorToArray(sprite.getAllNonDefaultPoints(), point => ({
    name: point.getName(),
    ...serializePoint(point),
  })),
  collisionMask: serializeCollisionMask(sprite),
});

const serializeSpriteStructure = (object: gdObject) => {
  const configuration = gd.asSpriteConfiguration(object.getConfiguration());
  const animations = configuration.getAnimations();
  return {
    kind: 'sprite',
    objectType: object.getType(),
    adaptCollisionMaskAutomatically: animations.adaptCollisionMaskAutomatically(),
    updateIfNotVisible: configuration.getUpdateIfNotVisible(),
    preScale: configuration.getPreScale(),
    animations: Array.from(
      { length: animations.getAnimationsCount() },
      (_, animationIndex) => {
        const animation = animations.getAnimation(animationIndex);
        return {
          name: animation.getName(),
          useMultipleDirections: animation.useMultipleDirections(),
          directions: Array.from(
            { length: animation.getDirectionsCount() },
            (_, directionIndex) => {
              const direction = animation.getDirection(directionIndex);
              return {
                loop: direction.isLooping(),
                timeBetweenFrames: direction.getTimeBetweenFrames(),
                metadata: direction.getMetadata(),
                frames: Array.from(
                  { length: direction.getSpritesCount() },
                  (_, frameIndex) =>
                    serializeSpriteFrame(direction.getSprite(frameIndex))
                ),
              };
            }
          ),
        };
      }
    ),
  };
};

const applyPoint = (target: gdPoint, value: any, field: string) => {
  target.setXY(
    finiteNumber(value && value.x, `${field}.x`),
    finiteNumber(value && value.y, `${field}.y`)
  );
};

const applyCollisionMask = (sprite: gdSprite, value: any, field: string) => {
  const kind = value && value.kind;
  if (kind === 'full-image') {
    sprite.setFullImageCollisionMask(true);
    return;
  }
  if (kind !== 'polygons') {
    throw new AgentError({
      code: 'invalid_object_structure_input',
      message: `${field}.kind must be "full-image" or "polygons".`,
      details: { field },
    });
  }
  const polygonsInput = boundedArray(
    value.polygons,
    `${field}.polygons`,
    MAX_POLYGONS
  );
  const polygons = new gd.VectorPolygon2d();
  try {
    polygonsInput.forEach((verticesInput, polygonIndex) => {
      const vertices = boundedArray(
        verticesInput,
        `${field}.polygons[${polygonIndex}]`,
        MAX_VERTICES
      );
      if (vertices.length < 3) {
        throw new AgentError({
          code: 'invalid_object_structure_input',
          message: `${field}.polygons[${polygonIndex}] must have at least 3 vertices.`,
        });
      }
      const polygon = new gd.Polygon2d();
      try {
        const targetVertices = polygon.getVertices();
        vertices.forEach((vertexValue, vertexIndex) => {
          const vertex = new gd.Vector2f();
          try {
            vertex.x = finiteNumber(
              vertexValue && vertexValue.x,
              `${field}.polygons[${polygonIndex}][${vertexIndex}].x`
            );
            vertex.y = finiteNumber(
              vertexValue && vertexValue.y,
              `${field}.polygons[${polygonIndex}][${vertexIndex}].y`
            );
            targetVertices.push_back(vertex);
          } finally {
            vertex.delete();
          }
        });
        if (!polygon.isConvex()) {
          throw new AgentError({
            code: 'invalid_sprite_collision_polygon',
            message: `${field}.polygons[${polygonIndex}] must be convex.`,
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

const buildSprite = (value: any, field: string): gdSprite => {
  const sprite = new gd.Sprite();
  try {
    sprite.setImageName(requireString(value && value.image, `${field}.image`));
    applyPoint(sprite.getOrigin(), value && value.origin, `${field}.origin`);

    const center = value && value.center;
    if (!center || typeof center.default !== 'boolean') {
      throw new AgentError({
        code: 'invalid_object_structure_input',
        message: `${field}.center.default must be a boolean.`,
      });
    }
    sprite.setDefaultCenterPoint(center.default);
    if (!center.default)
      applyPoint(sprite.getCenter(), center, `${field}.center`);

    boundedArray(value && value.points, `${field}.points`, MAX_POINTS).forEach(
      (pointValue, pointIndex) => {
        const name = requireString(
          pointValue && pointValue.name,
          `${field}.points[${pointIndex}].name`
        );
        if (!name || name === 'Origin' || name === 'Center') {
          throw new AgentError({
            code: 'invalid_sprite_point_name',
            message: `Custom Sprite point name is invalid: ${name ||
              '(empty)'}.`,
          });
        }
        const point = new gd.Point(name);
        try {
          applyPoint(point, pointValue, `${field}.points[${pointIndex}]`);
          sprite.addPoint(point);
        } finally {
          point.delete();
        }
      }
    );
    applyCollisionMask(
      sprite,
      value && value.collisionMask,
      `${field}.collisionMask`
    );
    return sprite;
  } catch (error) {
    sprite.delete();
    throw error;
  }
};

const replaceSpriteStructure = (object: gdObject, structure: any) => {
  const configuration = gd.asSpriteConfiguration(object.getConfiguration());
  const animationsInput = boundedArray(
    structure && structure.animations,
    'structure.animations',
    MAX_ANIMATIONS
  );
  const replacementAnimations = new gd.SpriteAnimationList();
  try {
    replacementAnimations.setAdaptCollisionMaskAutomatically(
      structure.adaptCollisionMaskAutomatically !== false
    );
    animationsInput.forEach((animationValue, animationIndex) => {
      const animation = new gd.Animation();
      try {
        animation.setName(
          requireString(
            animationValue && animationValue.name,
            `structure.animations[${animationIndex}].name`
          )
        );
        animation.setUseMultipleDirections(
          !!(animationValue && animationValue.useMultipleDirections)
        );
        const directionsInput = boundedArray(
          animationValue && animationValue.directions,
          `structure.animations[${animationIndex}].directions`,
          MAX_DIRECTIONS
        );
        if (!directionsInput.length) {
          throw new AgentError({
            code: 'invalid_object_structure_input',
            message: `structure.animations[${animationIndex}].directions must not be empty.`,
          });
        }
        animation.setDirectionsCount(directionsInput.length);
        directionsInput.forEach((directionValue, directionIndex) => {
          const direction = animation.getDirection(directionIndex);
          direction.setLoop(!!(directionValue && directionValue.loop));
          direction.setTimeBetweenFrames(
            finiteNumber(
              directionValue && directionValue.timeBetweenFrames,
              `structure.animations[${animationIndex}].directions[${directionIndex}].timeBetweenFrames`
            )
          );
          direction.setMetadata(
            typeof (directionValue && directionValue.metadata) === 'string'
              ? directionValue.metadata
              : ''
          );
          direction.removeAllSprites();
          boundedArray(
            directionValue && directionValue.frames,
            `structure.animations[${animationIndex}].directions[${directionIndex}].frames`,
            MAX_FRAMES
          ).forEach((frameValue, frameIndex) => {
            const sprite = buildSprite(
              frameValue,
              `structure.animations[${animationIndex}].directions[${directionIndex}].frames[${frameIndex}]`
            );
            try {
              direction.addSprite(sprite);
            } finally {
              sprite.delete();
            }
          });
        });
        replacementAnimations.addAnimation(animation);
      } finally {
        animation.delete();
      }
    });

    const targetAnimations = configuration.getAnimations();
    targetAnimations.removeAllAnimations();
    for (
      let index = 0;
      index < replacementAnimations.getAnimationsCount();
      index++
    ) {
      targetAnimations.addAnimation(replacementAnimations.getAnimation(index));
    }
    targetAnimations.setAdaptCollisionMaskAutomatically(
      replacementAnimations.adaptCollisionMaskAutomatically()
    );
    if (typeof structure.updateIfNotVisible === 'boolean') {
      configuration.setUpdateIfNotVisible(structure.updateIfNotVisible);
    }
    if (structure.preScale !== undefined) {
      configuration.setPreScale(
        finiteNumber(structure.preScale, 'structure.preScale')
      );
    }
  } finally {
    replacementAnimations.delete();
  }
};

const serializeModel3DStructure = (object: gdObject) => {
  const configuration = gd.asModel3DConfiguration(object.getConfiguration());
  return {
    kind: 'model3d',
    objectType: object.getType(),
    modelResourceName: configuration.getModelResourceName(),
    materialType: configuration.getMaterialType(),
    originLocation: configuration.getOriginLocation(),
    centerLocation: configuration.getCenterLocation(),
    keepAspectRatio: configuration.shouldKeepAspectRatio(),
    size: {
      width: configuration.getWidth(),
      height: configuration.getHeight(),
      depth: configuration.getDepth(),
    },
    rotation: {
      x: configuration.getRotationX(),
      y: configuration.getRotationY(),
      z: configuration.getRotationZ(),
    },
    animations: Array.from(
      { length: configuration.getAnimationsCount() },
      (_, index) => {
        const animation = configuration.getAnimation(index);
        return {
          name: animation.getName(),
          source: animation.getSource(),
          loop: animation.shouldLoop(),
        };
      }
    ),
  };
};

const replaceModel3DStructure = (object: gdObject, structure: any) => {
  const configuration = gd.asModel3DConfiguration(object.getConfiguration());
  const animations = boundedArray(
    structure && structure.animations,
    'structure.animations',
    MAX_ANIMATIONS
  );
  configuration.removeAllAnimations();
  animations.forEach((value, index) => {
    const animation = new gd.Model3DAnimation();
    try {
      animation.setName(
        requireString(
          value && value.name,
          `structure.animations[${index}].name`
        )
      );
      animation.setSource(
        requireString(
          value && value.source,
          `structure.animations[${index}].source`
        )
      );
      animation.setShouldLoop(!!(value && value.loop));
      configuration.addAnimation(animation);
    } finally {
      animation.delete();
    }
  });
};

const createHandlerRegistry = () => [
  {
    id: 'sprite',
    objectTypes: ['Sprite'],
    structural: true,
    description:
      'Sprite animations, directions, frames, points, origin/center and collision masks.',
    inspect: serializeSpriteStructure,
    replace: replaceSpriteStructure,
  },
  {
    id: 'model3d',
    objectTypes: ['Scene3D::Model3DObject'],
    structural: true,
    description:
      '3D model animation list. Scalar model/material/size/origin properties remain editable through object property commands.',
    inspect: serializeModel3DStructure,
    replace: replaceModel3DStructure,
  },
  {
    id: 'particle-emitter-properties',
    objectTypes: ['ParticleSystem::ParticleEmitter'],
    structural: false,
    description:
      'ParticleEmitter has no nested ObjectConfiguration structure in libGD; renderer, texture, flow, force, gravity, lifetime, colors and sizes are native scalar properties.',
    coveredBy: 'editor.functions.change-object-property',
  },
  {
    id: 'tilemap-properties',
    objectTypes: ['TileMap::TileMap', 'TileMap::SimpleTileMap'],
    structural: false,
    description:
      'Tilemap object/atlas configuration is property-based. SimpleTileMap cell data is instance-level and not exposed here without an authoritative editor mutation API.',
    coveredBy: 'editor.functions.change-object-property',
  },
];

const findHandlerForType = (objectType: string) =>
  createHandlerRegistry().find(handler =>
    handler.objectTypes.includes(objectType)
  ) || null;

const isObjectTypeInstalled = (objectType: string): boolean => {
  const extensionAndMetadata = gd.MetadataProvider.getExtensionAndObjectMetadata(
    gd.JsPlatform.get(),
    objectType
  );
  return (
    !!extensionAndMetadata &&
    !gd.MetadataProvider.isBadObjectMetadata(extensionAndMetadata.getMetadata())
  );
};

export const createObjectStructureService = ({
  project,
  triggerUnsavedChanges,
  forceUpdate,
  onObjectsModifiedOutsideEditor,
}: {|
  project: gdProject,
  triggerUnsavedChanges: () => void,
  forceUpdate: () => void,
  onObjectsModifiedOutsideEditor?: any,
|}) => {
  const resolveObject = (input: any) => {
    const objectName = requireString(input && input.objectName, 'objectName');
    const scope = input && input.scope === 'global' ? 'global' : 'scene';
    let scene = null;
    const objects =
      scope === 'global'
        ? project.getObjects()
        : (() => {
            const sceneName = requireString(
              input && input.sceneName,
              'sceneName'
            );
            if (!project.hasLayoutNamed(sceneName)) {
              throw new AgentError({
                code: 'scene_not_found',
                message: `Scene not found: ${sceneName}`,
              });
            }
            scene = project.getLayout(sceneName);
            return scene.getObjects();
          })();
    if (!objects.hasObjectNamed(objectName)) {
      throw new AgentError({
        code: 'object_not_found',
        message: `Object not found: ${objectName}`,
        details: { objectName, scope, sceneName: input && input.sceneName },
      });
    }
    return { object: objects.getObject(objectName), scope, scene };
  };

  const capabilities = (input: any = {}) => {
    const objectType = input.objectType
      ? requireString(input.objectType, 'objectType')
      : resolveObject(input).object.getType();
    const handler = findHandlerForType(objectType);
    const installed = isObjectTypeInstalled(objectType);
    return {
      objectType,
      installed,
      capability: handler
        ? {
            id: handler.id,
            structural: handler.structural && installed,
            registeredStructural: handler.structural,
            description: handler.description,
            coveredBy: handler.coveredBy || 'objects.structure.apply',
          }
        : {
            id: 'generic-properties',
            structural: false,
            description:
              'No specialized nested structure handler is registered for this object type.',
            coveredBy: 'editor.functions.change-object-property',
          },
      registeredHandlers: createHandlerRegistry().map(handlerRecord => ({
        id: handlerRecord.id,
        objectTypes: handlerRecord.objectTypes,
        structural: handlerRecord.structural,
        description: handlerRecord.description,
        coveredBy: handlerRecord.coveredBy || 'objects.structure.apply',
      })),
    };
  };

  const inspect = (input: any) => {
    const { object, scope } = resolveObject(input);
    const handler = findHandlerForType(object.getType());
    if (
      !handler ||
      !handler.structural ||
      !handler.inspect ||
      !isObjectTypeInstalled(object.getType())
    ) {
      throw new AgentError({
        code: 'object_structure_not_supported',
        message: `Object type does not expose a nested structure handler: ${object.getType()}`,
        details: {
          objectType: object.getType(),
          capability: capabilities(input).capability,
        },
      });
    }
    return {
      target: {
        scope,
        sceneName: scope === 'scene' ? input.sceneName : null,
        objectName: object.getName(),
        objectType: object.getType(),
      },
      structure: handler.inspect(object),
    };
  };

  const apply = (input: any) => {
    if (input.mode !== undefined && input.mode !== 'replace') {
      throw new AgentError({
        code: 'unsupported_object_structure_mode',
        message:
          'Only mode="replace" is supported for nested object structures.',
      });
    }
    const { object, scope, scene } = resolveObject(input);
    const handler = findHandlerForType(object.getType());
    if (
      !handler ||
      !handler.structural ||
      !handler.replace ||
      !isObjectTypeInstalled(object.getType())
    ) {
      throw new AgentError({
        code: 'object_structure_not_supported',
        message: `Object type does not expose a nested structure handler: ${object.getType()}`,
      });
    }
    const structure = input && input.structure;
    if (
      !structure ||
      typeof structure !== 'object' ||
      Array.isArray(structure)
    ) {
      throw new AgentError({
        code: 'invalid_object_structure_input',
        message: 'structure must be an object.',
      });
    }
    if (structure.kind && structure.kind !== handler.id) {
      throw new AgentError({
        code: 'object_structure_kind_mismatch',
        message: `Structure kind "${
          structure.kind
        }" does not match object handler "${handler.id}".`,
      });
    }
    handler.replace(object, structure);
    triggerUnsavedChanges();
    forceUpdate();
    if (scope === 'scene' && scene && onObjectsModifiedOutsideEditor) {
      onObjectsModifiedOutsideEditor({ scene, isNewObjectTypeUsed: false });
    }
    return {
      applied: true,
      mode: 'replace',
      target: {
        scope,
        sceneName: scope === 'scene' ? input.sceneName : null,
        objectName: object.getName(),
        objectType: object.getType(),
      },
      structure: handler.inspect(object),
    };
  };

  return { capabilities, inspect, apply };
};

export const objectStructureInternals = {
  createHandlerRegistry,
  serializeSpriteStructure,
  replaceSpriteStructure,
  serializeModel3DStructure,
  replaceModel3DStructure,
};
