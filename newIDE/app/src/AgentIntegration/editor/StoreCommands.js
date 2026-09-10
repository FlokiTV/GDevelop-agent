// @flow
import {
  makeCommandMetadata,
  type CommandDescriptor,
} from '../core/CommandRegistry';

const SEARCH_PROPERTIES = {
  query: { type: 'string', minLength: 1, maxLength: 500 },
  limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
  timeoutMs: {
    type: 'integer',
    minimum: 1000,
    maximum: 45000,
    default: 15000,
  },
};

const READ_METADATA = makeCommandMetadata({
  requiresProject: false,
  longRunning: true,
  cacheScope: 'process',
  ttlMs: 300000,
});

const WRITE_METADATA = makeCommandMetadata({
  readOnly: false,
  idempotent: false,
  requiresProject: true,
  modifiesProject: true,
  longRunning: true,
});

export const createStoreCommandDescriptors = ({
  storeService,
}: {|
  storeService: any,
|}): Array<CommandDescriptor> => [
  {
    name: 'store.objects.search',
    description:
      'Search the public GDevelop object asset catalog locally by name, tags, description, id and object type. Returns provenance and license metadata without generation-service orchestration.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        ...SEARCH_PROPERTIES,
        objectType: { type: 'string', minLength: 1, maxLength: 300 },
      },
    },
    metadata: READ_METADATA,
    execute: ({ input, requestContext }) =>
      storeService.searchObjects(
        input,
        requestContext && requestContext.signal
      ),
  },
  {
    name: 'store.objects.inspect',
    description:
      'Inspect one public GDevelop object asset, including object type, versions, extension dependencies, authors, license and provenance.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['assetId'],
      properties: {
        assetId: { type: 'string', minLength: 1, maxLength: 500 },
        timeoutMs: SEARCH_PROPERTIES.timeoutMs,
      },
    },
    metadata: READ_METADATA,
    execute: ({ input, requestContext }) =>
      storeService.inspectObject(
        input,
        requestContext && requestContext.signal
      ),
  },
  {
    name: 'store.objects.import',
    description:
      'Import one public GDevelop object asset by exact asset id through the canonical create_object editor mutation path.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['assetId', 'sceneName', 'objectName'],
      properties: {
        assetId: { type: 'string', minLength: 1, maxLength: 500 },
        sceneName: { type: 'string', minLength: 1, maxLength: 500 },
        objectName: { type: 'string', minLength: 1, maxLength: 500 },
        targetScope: {
          type: 'string',
          enum: ['scene', 'global'],
          default: 'scene',
        },
        replaceExistingObject: { type: 'boolean', default: false },
        timeoutMs: SEARCH_PROPERTIES.timeoutMs,
      },
    },
    metadata: WRITE_METADATA,
    execute: ({ input, requestContext }) =>
      storeService.importObject(input, requestContext && requestContext.signal),
  },
  {
    name: 'store.resources.search',
    description:
      'Search the public GDevelop Resource Store locally by name, tags, authors, license and resource kind.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        ...SEARCH_PROPERTIES,
        kind: { type: 'string', minLength: 1, maxLength: 100 },
      },
    },
    metadata: READ_METADATA,
    execute: ({ input, requestContext }) =>
      storeService.searchResources(
        input,
        requestContext && requestContext.signal
      ),
  },
  {
    name: 'store.resources.inspect',
    description:
      'Inspect one public GDevelop Resource Store entry by canonical URL, including authors, license and provenance.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['resourceUrl'],
      properties: {
        resourceUrl: { type: 'string', minLength: 1, maxLength: 4096 },
        timeoutMs: SEARCH_PROPERTIES.timeoutMs,
      },
    },
    metadata: READ_METADATA,
    execute: ({ input, requestContext }) =>
      storeService.inspectResource(
        input,
        requestContext && requestContext.signal
      ),
  },
  {
    name: 'store.resources.import',
    description:
      'Add one public Resource Store entry to the live project while preserving the canonical gdevelop-asset-store origin and resource defaults.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['resourceUrl'],
      properties: {
        resourceUrl: { type: 'string', minLength: 1, maxLength: 4096 },
        resourceName: { type: 'string', minLength: 1, maxLength: 500 },
        overwrite: { type: 'boolean', default: false },
        timeoutMs: SEARCH_PROPERTIES.timeoutMs,
      },
    },
    metadata: WRITE_METADATA,
    execute: ({ input, requestContext }) =>
      storeService.importResource(
        input,
        requestContext && requestContext.signal
      ),
  },
];
