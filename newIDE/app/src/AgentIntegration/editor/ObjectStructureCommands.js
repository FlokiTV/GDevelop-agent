// @flow
import {
  makeCommandMetadata,
  type CommandDescriptor,
} from '../core/CommandRegistry';

const TARGET_PROPERTIES = {
  scope: { type: 'string', enum: ['scene', 'global'], default: 'scene' },
  sceneName: { type: 'string', minLength: 1, maxLength: 500 },
  objectName: { type: 'string', minLength: 1, maxLength: 500 },
};

const READ_METADATA = makeCommandMetadata({
  requiresProject: true,
  cacheScope: 'project-revision',
  ttlMs: 30000,
});

const WRITE_METADATA = makeCommandMetadata({
  readOnly: false,
  destructive: true,
  idempotent: false,
  requiresProject: true,
  modifiesProject: true,
});

export const createObjectStructureCommandDescriptors = ({
  objectStructureService,
}: {|
  objectStructureService: any,
|}): Array<CommandDescriptor> => [
  {
    name: 'objects.structure.capabilities',
    description:
      'Describe how a GDevelop object type can be authored: first-class nested structure handler or canonical scalar object-property tools. Also returns the registered structural handler catalog.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...TARGET_PROPERTIES,
        objectType: { type: 'string', minLength: 1, maxLength: 300 },
      },
      anyOf: [{ required: ['objectType'] }, { required: ['objectName'] }],
    },
    metadata: READ_METADATA,
    execute: ({ input }) => objectStructureService.capabilities(input),
  },
  {
    name: 'objects.structure.inspect',
    description:
      'Inspect the authoritative nested structure of a supported live GDevelop object. Sprite includes animations/directions/frames/points/collision masks; Model3D includes animations and structural summary.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['objectName'],
      properties: TARGET_PROPERTIES,
    },
    metadata: READ_METADATA,
    execute: ({ input }) => objectStructureService.inspect(input),
  },
  {
    name: 'objects.structure.apply',
    description:
      'Replace the nested structure of a supported live GDevelop object using its registered protocol-agnostic handler. Use a checkpoint/transaction for destructive structural edits.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['objectName', 'structure'],
      properties: {
        ...TARGET_PROPERTIES,
        mode: { type: 'string', enum: ['replace'], default: 'replace' },
        structure: {
          type: 'object',
          minProperties: 1,
          maxProperties: 20,
          additionalProperties: true,
        },
      },
    },
    metadata: WRITE_METADATA,
    execute: ({ input }) => objectStructureService.apply(input),
  },
];
