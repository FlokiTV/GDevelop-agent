// @flow
import {
  makeCommandMetadata,
  type CommandDescriptor,
} from '../core/CommandRegistry';

const NAME = { type: 'string', minLength: 1, maxLength: 500 };
const IMAGE_FORMAT = {
  type: 'string',
  enum: ['png', 'jpeg', 'webp'],
  default: 'png',
};
const MUTATION_METADATA = makeCommandMetadata({
  readOnly: false,
  destructive: true,
  idempotent: false,
  longRunning: true,
  requiresProject: true,
  modifiesProject: true,
  defaultTimeoutMs: 180000,
});

export const createAssetProcessingCommandDescriptors = ({
  assetProcessingService,
}: {|
  assetProcessingService: any,
|}): Array<CommandDescriptor> => [
  {
    name: 'resources.processing.capabilities',
    description:
      'Describe locally available deterministic asset-processing capabilities and explicit unsupported media/toolchain gaps.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    metadata: makeCommandMetadata({
      requiresProject: true,
      cacheScope: 'process',
      ttlMs: 60000,
    }),
    execute: () => assetProcessingService.capabilities(),
  },
  {
    name: 'resources.image.transform',
    description:
      'Create or replace an image resource from a local project image using deterministic crop, resize and padding in that order; output provenance and hash are persisted.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['sourceResourceName', 'outputResourceName'],
      properties: {
        sourceResourceName: NAME,
        outputResourceName: NAME,
        crop: {
          type: 'object',
          additionalProperties: false,
          required: ['width', 'height'],
          properties: {
            x: { type: 'integer', minimum: 0, default: 0 },
            y: { type: 'integer', minimum: 0, default: 0 },
            width: { type: 'integer', minimum: 1, maximum: 16384 },
            height: { type: 'integer', minimum: 1, maximum: 16384 },
          },
        },
        resize: {
          type: 'object',
          additionalProperties: false,
          properties: {
            width: { type: 'integer', minimum: 1, maximum: 16384 },
            height: { type: 'integer', minimum: 1, maximum: 16384 },
          },
          anyOf: [{ required: ['width'] }, { required: ['height'] }],
        },
        pad: {
          type: 'object',
          additionalProperties: false,
          properties: {
            top: { type: 'integer', minimum: 0, maximum: 16384, default: 0 },
            right: { type: 'integer', minimum: 0, maximum: 16384, default: 0 },
            bottom: { type: 'integer', minimum: 0, maximum: 16384, default: 0 },
            left: { type: 'integer', minimum: 0, maximum: 16384, default: 0 },
            backgroundColor: { type: 'string', maxLength: 100 },
          },
        },
        outputFormat: IMAGE_FORMAT,
        quality: { type: 'number', minimum: 0.05, maximum: 1, default: 0.92 },
        overwrite: { type: 'boolean', default: false },
      },
    },
    metadata: MUTATION_METADATA,
    execute: ({ input }) => assetProcessingService.transformImage(input),
  },
  {
    name: 'resources.image.slice-spritesheet',
    description:
      'Slice a local image resource into a bounded row-major grid of individual image resources with deterministic names and transform provenance.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: [
        'sourceResourceName',
        'outputPrefix',
        'frameWidth',
        'frameHeight',
      ],
      properties: {
        sourceResourceName: NAME,
        outputPrefix: { type: 'string', minLength: 1, maxLength: 450 },
        frameWidth: { type: 'integer', minimum: 1, maximum: 16384 },
        frameHeight: { type: 'integer', minimum: 1, maximum: 16384 },
        columns: { type: 'integer', minimum: 1, maximum: 256 },
        rows: { type: 'integer', minimum: 1, maximum: 256 },
        margin: { type: 'integer', minimum: 0, maximum: 16384, default: 0 },
        spacing: { type: 'integer', minimum: 0, maximum: 16384, default: 0 },
        outputFormat: IMAGE_FORMAT,
        overwrite: { type: 'boolean', default: false },
      },
    },
    metadata: MUTATION_METADATA,
    execute: ({ input }) => assetProcessingService.sliceSpritesheet(input),
  },
  {
    name: 'resources.audio.transform',
    description:
      'Trim and peak-normalize a local PCM 16-bit WAV resource and write a WAV output with deterministic transform provenance. Compressed transcode is reported unsupported by capabilities.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['sourceResourceName', 'outputResourceName'],
      properties: {
        sourceResourceName: NAME,
        outputResourceName: NAME,
        trimStartMs: { type: 'number', minimum: 0, default: 0 },
        trimEndMs: { type: 'number', minimum: 0 },
        normalize: { type: 'boolean', default: true },
        targetPeakDb: { type: 'number', minimum: -60, maximum: 0, default: -1 },
        overwrite: { type: 'boolean', default: false },
      },
    },
    metadata: MUTATION_METADATA,
    execute: ({ input }) => assetProcessingService.transformAudio(input),
  },
];
