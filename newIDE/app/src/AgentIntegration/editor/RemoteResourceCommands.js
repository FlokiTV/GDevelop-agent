// @flow
import {
  makeCommandMetadata,
  type CommandDescriptor,
} from '../core/CommandRegistry';

const REMOTE_PROPERTIES = {
  url: { type: 'string', minLength: 8, maxLength: 8192 },
  kind: {
    type: 'string',
    enum: [
      'image',
      'audio',
      'font',
      'video',
      'json',
      'tilemap',
      'tileset',
      'bitmapFont',
      'model3D',
      'atlas',
      'spine',
      'javascript',
    ],
  },
  expectedSha256: {
    type: 'string',
    pattern: '^[a-fA-F0-9]{64}$',
  },
  maxBytes: {
    type: 'integer',
    minimum: 1,
    maximum: 268435456,
    default: 67108864,
  },
  timeoutMs: {
    type: 'integer',
    minimum: 100,
    maximum: 120000,
    default: 30000,
  },
  maxRedirects: {
    type: 'integer',
    minimum: 0,
    maximum: 10,
    default: 5,
  },
  license: { type: 'string', maxLength: 500 },
  author: { type: 'string', maxLength: 500 },
  attribution: { type: 'string', maxLength: 2000 },
};

export const createRemoteResourceCommandDescriptors = ({
  remoteResourceService,
}: {|
  remoteResourceService: any,
|}): Array<CommandDescriptor> => [
  {
    name: 'resources.import-url',
    description:
      'Securely download an HTTP(S) resource, validate DNS/redirects/size/MIME/checksum, copy it into a saved local project, and persist redacted provenance plus content hash.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['url'],
      properties: {
        ...REMOTE_PROPERTIES,
        resourceName: { type: 'string', minLength: 1, maxLength: 500 },
        overwrite: { type: 'boolean', default: false },
      },
    },
    metadata: makeCommandMetadata({
      readOnly: false,
      idempotent: false,
      longRunning: true,
      requiresProject: true,
      modifiesProject: true,
      defaultTimeoutMs: 180000,
    }),
    execute: ({ input }) => remoteResourceService.importUrl(input),
  },
  {
    name: 'resources.replace-url',
    description:
      'Securely download HTTP(S) bytes and replace the file backing an existing resource while preserving resource identity and recording the new redacted provenance/hash.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['url', 'resourceName'],
      properties: {
        ...REMOTE_PROPERTIES,
        resourceName: { type: 'string', minLength: 1, maxLength: 500 },
        deletePreviousFile: { type: 'boolean', default: false },
      },
    },
    metadata: makeCommandMetadata({
      readOnly: false,
      destructive: true,
      idempotent: false,
      longRunning: true,
      requiresProject: true,
      modifiesProject: true,
      defaultTimeoutMs: 180000,
    }),
    execute: ({ input }) => remoteResourceService.replaceUrl(input),
  },
];
