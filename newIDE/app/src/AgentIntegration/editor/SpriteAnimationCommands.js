// @flow
import {
  makeCommandMetadata,
  type CommandDescriptor,
} from '../core/CommandRegistry';

const OBJECT_TARGET = {
  objectName: { type: 'string', minLength: 1 },
  sceneName: {
    type: 'string',
    minLength: 1,
    description:
      'Scene name for scene-scoped Sprite objects. With objectScope=auto, a matching scene object is preferred before a global object.',
  },
  objectScope: {
    type: 'string',
    enum: ['auto', 'global', 'scene'],
    default: 'auto',
  },
};

const ANIMATION_SELECTOR = {
  animationIndex: { type: 'integer', minimum: 0 },
  animationName: { type: 'string', minLength: 1 },
};

const DIRECTION_SELECTOR = {
  directionIndex: { type: 'integer', minimum: 0, default: 0 },
};

const FRAME_SELECTOR = {
  frameIndex: { type: 'integer', minimum: 0 },
};

const POINT_COORDINATE = {
  type: 'object',
  additionalProperties: false,
  required: ['x', 'y'],
  properties: {
    x: { type: 'number' },
    y: { type: 'number' },
  },
};

const CENTER_POINT = {
  type: 'object',
  additionalProperties: false,
  required: ['default'],
  properties: {
    default: { type: 'boolean' },
    x: { type: 'number' },
    y: { type: 'number' },
  },
};

const CUSTOM_POINT = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'x', 'y'],
  properties: {
    name: { type: 'string', minLength: 1 },
    x: { type: 'number' },
    y: { type: 'number' },
  },
};

const VERTEX = {
  type: 'object',
  additionalProperties: false,
  required: ['x', 'y'],
  properties: {
    x: { type: 'number' },
    y: { type: 'number' },
  },
};

const COLLISION_MASK = {
  type: 'object',
  additionalProperties: false,
  required: ['kind'],
  properties: {
    kind: {
      type: 'string',
      enum: ['full-image', 'polygons'],
    },
    polygons: {
      type: 'array',
      maxItems: 32,
      items: {
        type: 'array',
        minItems: 3,
        maxItems: 128,
        items: VERTEX,
      },
    },
  },
};

const READ_METADATA = makeCommandMetadata({
  requiresProject: true,
  cacheScope: 'project-revision',
  ttlMs: 15000,
});

const MUTATION_METADATA = makeCommandMetadata({
  readOnly: false,
  idempotent: false,
  requiresProject: true,
  modifiesProject: true,
});

const INDEX_RISK = {
  dryRun: {
    type: 'boolean',
    default: true,
    description:
      'Defaults to true because animation/frame reorder or delete can change numeric index references.',
  },
  acknowledgeIndexReferenceRisk: {
    type: 'boolean',
    default: false,
    description:
      'Required with dryRun=false. Confirms the caller reviewed the returned referenceRisk because libGD exposes no authoritative rewrite contract for numeric animation/frame indices.',
  },
};

export const createSpriteAnimationCommandDescriptors = ({
  spriteAnimationService,
}: {|
  spriteAnimationService: any,
|}): Array<CommandDescriptor> => [
  {
    name: 'objects.sprite.animations.list',
    description:
      'List typed Sprite animations, ordered directions/frames, uniform frame timing, points, collision masks, resource metadata and consistency diagnostics without raw object JSON.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['objectName'],
      properties: {
        ...OBJECT_TARGET,
        offset: { type: 'integer', minimum: 0, default: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
        includeFrames: { type: 'boolean', default: true },
        frameLimit: {
          type: 'integer',
          minimum: 1,
          maximum: 1000,
          default: 200,
        },
      },
    },
    metadata: READ_METADATA,
    execute: ({ input }) => spriteAnimationService.list(input),
  },
  {
    name: 'objects.sprite.animations.get',
    description:
      'Describe one Sprite animation by name or index with ordered frames, DX-28 resource metadata, points, collision masks, timing and reference semantics.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['objectName'],
      properties: {
        ...OBJECT_TARGET,
        ...ANIMATION_SELECTOR,
        includeFrames: { type: 'boolean', default: true },
        frameLimit: {
          type: 'integer',
          minimum: 1,
          maximum: 1000,
          default: 200,
        },
      },
      anyOf: [
        { required: ['animationIndex'] },
        { required: ['animationName'] },
      ],
    },
    metadata: READ_METADATA,
    execute: ({ input }) => spriteAnimationService.get(input),
  },
  {
    name: 'objects.sprite.animations.create',
    description:
      'Append a typed Sprite animation. Appending preserves existing numeric animation indices. Frames are added separately with objects.sprite.frames.add.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['objectName', 'animationName'],
      properties: {
        ...OBJECT_TARGET,
        animationName: { type: 'string', minLength: 1 },
        directionCount: {
          type: 'integer',
          minimum: 1,
          maximum: 32,
          default: 1,
        },
        useMultipleDirections: { type: 'boolean', default: false },
        looping: { type: 'boolean', default: false },
        timeBetweenFrames: {
          type: 'number',
          exclusiveMinimum: 0,
          default: 0.08,
          description:
            'Uniform duration in seconds for each frame in the created direction(s). GDevelop Sprite directions do not expose per-frame durations.',
        },
      },
    },
    metadata: MUTATION_METADATA,
    execute: ({ input }) => spriteAnimationService.createAnimation(input),
  },
  {
    name: 'objects.sprite.animations.update',
    description:
      'Rename an animation with native Event Sheet refactoring and/or update direction looping/uniform frame timing. Renaming by name uses WholeProjectRefactorer; numeric index semantics are unchanged.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['objectName'],
      properties: {
        ...OBJECT_TARGET,
        ...ANIMATION_SELECTOR,
        ...DIRECTION_SELECTOR,
        newAnimationName: { type: 'string', minLength: 1 },
        useMultipleDirections: { type: 'boolean' },
        looping: { type: 'boolean' },
        timeBetweenFrames: { type: 'number', exclusiveMinimum: 0 },
      },
      anyOf: [
        { required: ['animationIndex'] },
        { required: ['animationName'] },
      ],
    },
    metadata: MUTATION_METADATA,
    execute: ({ input }) => spriteAnimationService.updateAnimation(input),
  },
  {
    name: 'objects.sprite.animations.move',
    description:
      'Plan or apply a Sprite animation reorder. Defaults to dry-run because numeric animation-index references can change meaning and cannot be authoritatively rewritten by the current native contract.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['objectName', 'toIndex'],
      properties: {
        ...OBJECT_TARGET,
        ...ANIMATION_SELECTOR,
        toIndex: { type: 'integer', minimum: 0 },
        ...INDEX_RISK,
      },
      anyOf: [
        { required: ['animationIndex'] },
        { required: ['animationName'] },
      ],
    },
    metadata: {
      ...MUTATION_METADATA,
      destructive: true,
    },
    modifiesProjectWhen: input => input.dryRun === false,
    execute: ({ input }) => spriteAnimationService.moveAnimation(input),
  },
  {
    name: 'objects.sprite.animations.delete',
    description:
      'Plan or delete one Sprite animation. Defaults to dry-run and requires explicit index-reference risk acknowledgement before apply.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['objectName'],
      properties: {
        ...OBJECT_TARGET,
        ...ANIMATION_SELECTOR,
        ...INDEX_RISK,
      },
      anyOf: [
        { required: ['animationIndex'] },
        { required: ['animationName'] },
      ],
    },
    metadata: {
      ...MUTATION_METADATA,
      destructive: true,
    },
    modifiesProjectWhen: input => input.dryRun === false,
    execute: ({ input }) => spriteAnimationService.deleteAnimation(input),
  },
  {
    name: 'objects.sprite.frames.add',
    description:
      'Append a Sprite frame with validated image resource plus optional origin, center, custom points and collision mask. Appending preserves existing frame indices.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['objectName', 'image'],
      properties: {
        ...OBJECT_TARGET,
        ...ANIMATION_SELECTOR,
        ...DIRECTION_SELECTOR,
        image: { type: 'string', minLength: 1 },
        origin: POINT_COORDINATE,
        center: CENTER_POINT,
        points: {
          type: 'array',
          maxItems: 128,
          items: CUSTOM_POINT,
        },
        collisionMask: COLLISION_MASK,
      },
      anyOf: [
        { required: ['animationIndex'] },
        { required: ['animationName'] },
      ],
    },
    metadata: MUTATION_METADATA,
    execute: ({ input }) => spriteAnimationService.addFrame(input),
  },
  {
    name: 'objects.sprite.frames.update',
    description:
      'Replace only the image resource of an existing Sprite frame while preserving origin, center, custom points, collision mask and unrelated animations.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['objectName', 'frameIndex', 'image'],
      properties: {
        ...OBJECT_TARGET,
        ...ANIMATION_SELECTOR,
        ...DIRECTION_SELECTOR,
        ...FRAME_SELECTOR,
        image: { type: 'string', minLength: 1 },
      },
      anyOf: [
        { required: ['animationIndex'] },
        { required: ['animationName'] },
      ],
    },
    metadata: MUTATION_METADATA,
    execute: ({ input }) => spriteAnimationService.updateFrame(input),
  },
  {
    name: 'objects.sprite.frames.move',
    description:
      'Plan or apply a frame reorder inside one Sprite animation direction. Defaults to dry-run because frame-index references can change meaning.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['objectName', 'fromIndex', 'toIndex'],
      properties: {
        ...OBJECT_TARGET,
        ...ANIMATION_SELECTOR,
        ...DIRECTION_SELECTOR,
        fromIndex: { type: 'integer', minimum: 0 },
        toIndex: { type: 'integer', minimum: 0 },
        ...INDEX_RISK,
      },
      anyOf: [
        { required: ['animationIndex'] },
        { required: ['animationName'] },
      ],
    },
    metadata: {
      ...MUTATION_METADATA,
      destructive: true,
    },
    modifiesProjectWhen: input => input.dryRun === false,
    execute: ({ input }) => spriteAnimationService.moveFrame(input),
  },
  {
    name: 'objects.sprite.frames.delete',
    description:
      'Plan or delete one Sprite frame. Defaults to dry-run and requires explicit index-reference risk acknowledgement before apply.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['objectName', 'frameIndex'],
      properties: {
        ...OBJECT_TARGET,
        ...ANIMATION_SELECTOR,
        ...DIRECTION_SELECTOR,
        ...FRAME_SELECTOR,
        ...INDEX_RISK,
      },
      anyOf: [
        { required: ['animationIndex'] },
        { required: ['animationName'] },
      ],
    },
    metadata: {
      ...MUTATION_METADATA,
      destructive: true,
    },
    modifiesProjectWhen: input => input.dryRun === false,
    execute: ({ input }) => spriteAnimationService.deleteFrame(input),
  },
  {
    name: 'objects.sprite.points.set',
    description:
      'Create/update a frame Origin, Center or custom named point with typed coordinates. Custom point names are frame metadata; consistency diagnostics report when point-name sets differ across frames.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['objectName', 'frameIndex', 'pointKind'],
      properties: {
        ...OBJECT_TARGET,
        ...ANIMATION_SELECTOR,
        ...DIRECTION_SELECTOR,
        ...FRAME_SELECTOR,
        pointKind: {
          type: 'string',
          enum: ['origin', 'center', 'custom'],
        },
        pointName: { type: 'string', minLength: 1 },
        x: { type: 'number' },
        y: { type: 'number' },
        useDefaultCenter: { type: 'boolean', default: false },
      },
      anyOf: [
        { required: ['animationIndex'] },
        { required: ['animationName'] },
      ],
    },
    metadata: MUTATION_METADATA,
    execute: ({ input }) => spriteAnimationService.setPoint(input),
  },
  {
    name: 'objects.sprite.points.delete',
    description:
      'Delete a custom point from one Sprite frame. Origin and Center are intrinsic and cannot be deleted.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['objectName', 'frameIndex', 'pointName'],
      properties: {
        ...OBJECT_TARGET,
        ...ANIMATION_SELECTOR,
        ...DIRECTION_SELECTOR,
        ...FRAME_SELECTOR,
        pointName: { type: 'string', minLength: 1 },
      },
      anyOf: [
        { required: ['animationIndex'] },
        { required: ['animationName'] },
      ],
    },
    metadata: {
      ...MUTATION_METADATA,
      destructive: true,
    },
    execute: ({ input }) => spriteAnimationService.deletePoint(input),
  },
  {
    name: 'objects.sprite.collision-mask.set',
    description:
      'Set/reset one Sprite frame collision mask. Polygon mode validates finite convex polygons with at least three vertices; full-image explicitly resets to the default mask.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['objectName', 'frameIndex', 'collisionMask'],
      properties: {
        ...OBJECT_TARGET,
        ...ANIMATION_SELECTOR,
        ...DIRECTION_SELECTOR,
        ...FRAME_SELECTOR,
        collisionMask: COLLISION_MASK,
      },
      anyOf: [
        { required: ['animationIndex'] },
        { required: ['animationName'] },
      ],
    },
    metadata: MUTATION_METADATA,
    execute: ({ input }) => spriteAnimationService.setCollisionMask(input),
  },
];
