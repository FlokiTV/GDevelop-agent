// @flow
import {
  makeCommandMetadata,
  type CommandDescriptor,
} from '../core/CommandRegistry';

const INTEGRATION_ID = { type: 'string', minLength: 1, maxLength: 100 };
const BUILD_ID = { type: 'string', minLength: 1, maxLength: 200 };

export const createPublicationCommandDescriptors = ({
  publicationService,
}: {|
  publicationService: any,
|}): Array<CommandDescriptor> => [
  {
    name: 'publication.integrations.list',
    description:
      'List publication integrations exposed by the running editor, including availability and credential-handling policy without returning credentials.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    metadata: makeCommandMetadata({
      cacheScope: 'request',
      ttlMs: 0,
    }),
    execute: () => publicationService.listIntegrations(),
  },
  {
    name: 'publication.prepare',
    description:
      'Dry-run publication of an existing completed web build. Verifies project/build ownership and returns a manifest with the immutable build identity and external effect, without mutating gd.games.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['integrationId', 'buildId'],
      properties: {
        integrationId: INTEGRATION_ID,
        buildId: BUILD_ID,
      },
    },
    metadata: makeCommandMetadata({
      longRunning: true,
      requiresProject: true,
      defaultTimeoutMs: 30000,
    }),
    execute: ({ input }) => publicationService.prepare(input),
  },
  {
    name: 'publication.publish',
    description:
      'Publish a verified completed web build to gd.games using only the editor authenticated session. Requires explicit command intent and protocol-level destructive confirmation; credentials are never accepted or returned.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['integrationId', 'buildId', 'confirmPublication'],
      properties: {
        integrationId: INTEGRATION_ID,
        buildId: BUILD_ID,
        confirmPublication: {
          type: 'boolean',
          description:
            'Must be true after reviewing publication.prepare. This is an explicit intent guard and does not replace MCP human confirmation.',
        },
      },
    },
    metadata: makeCommandMetadata({
      readOnly: false,
      destructive: true,
      idempotent: true,
      longRunning: true,
      requiresProject: true,
      modifiesProject: false,
      defaultTimeoutMs: 30000,
    }),
    execute: ({ input }) => publicationService.publish(input),
  },
];
