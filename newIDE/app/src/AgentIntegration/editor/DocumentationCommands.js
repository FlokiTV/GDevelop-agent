// @flow
import {
  makeCommandMetadata,
  type CommandDescriptor,
} from '../core/CommandRegistry';

const DOCS_METADATA = makeCommandMetadata({
  requiresProject: false,
  longRunning: true,
  cacheScope: 'process',
  ttlMs: 300000,
});

export const createDocumentationCommandDescriptors = ({
  documentationService,
}: {|
  documentationService: any,
|}): Array<CommandDescriptor> => [
  {
    name: 'docs.search',
    description:
      'Search the authoritative public GDevelop documentation index. Returns bounded results with canonical documentation URLs and source/version metadata.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 500 },
        limit: { type: 'integer', minimum: 1, maximum: 20, default: 8 },
        timeoutMs: {
          type: 'integer',
          minimum: 1000,
          maximum: 30000,
          default: 12000,
        },
      },
    },
    metadata: DOCS_METADATA,
    execute: ({ input, requestContext }) =>
      documentationService.search(
        input,
        requestContext && requestContext.signal
      ),
  },
  {
    name: 'docs.read',
    description:
      'Read a bounded plain-text view of one page under the official GDevelop 5 documentation root.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['url'],
      properties: {
        url: { type: 'string', minLength: 1, maxLength: 2048 },
        maxChars: {
          type: 'integer',
          minimum: 1000,
          maximum: 50000,
          default: 12000,
        },
        timeoutMs: {
          type: 'integer',
          minimum: 1000,
          maximum: 30000,
          default: 12000,
        },
      },
    },
    metadata: DOCS_METADATA,
    execute: ({ input, requestContext }) =>
      documentationService.read(input, requestContext && requestContext.signal),
  },
];
