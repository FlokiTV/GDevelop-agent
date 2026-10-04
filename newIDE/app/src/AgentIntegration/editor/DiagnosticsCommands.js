// @flow
import {
  makeCommandMetadata,
  type CommandDescriptor,
} from '../core/CommandRegistry';

const STATIC_READ_METADATA = makeCommandMetadata({
  readOnly: true,
  requiresProject: true,
  cacheScope: 'project-revision',
  ttlMs: 5000,
});

export const createDiagnosticsCommandDescriptors = ({
  diagnosticsTools,
  staticDiagnosticsService,
}: {|
  diagnosticsTools: any,
  staticDiagnosticsService: any,
|}): Array<CommandDescriptor> => [
  {
    name: 'diagnostics.inspect',
    description:
      'Inspect project properties, events, required behaviors, native diagnostics and resource health.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        includeNativeReport: { type: 'boolean' },
        includeAssets: { type: 'boolean' },
      },
    },
    metadata: makeCommandMetadata({
      requiresProject: true,
    }),
    execute: ({ input }) => diagnosticsTools.inspect(input),
  },
  {
    name: 'diagnostics.capabilities',
    description:
      'Describe the unified static/editor/project diagnostics contract, source mapping guarantees, filters and revision semantics. Runtime logs/traces are explicitly excluded.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    metadata: STATIC_READ_METADATA,
    execute: () => staticDiagnosticsService.capabilities(),
  },
  {
    name: 'diagnostics.query',
    description:
      'Query machine-readable static/editor/project diagnostics with stable diagnostic identities, scene/external/function selectors, Event Sheet event/instruction handles, parameter paths, related entities and actionable inspect/edit targets.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        severities: {
          type: 'array',
          uniqueItems: true,
          maxItems: 3,
          items: {
            type: 'string',
            enum: ['error', 'warning', 'info'],
          },
        },
        codes: {
          type: 'array',
          uniqueItems: true,
          maxItems: 100,
          items: { type: 'string', minLength: 1 },
        },
        scopes: {
          type: 'array',
          uniqueItems: true,
          maxItems: 4,
          items: {
            type: 'string',
            enum: ['project', 'scene', 'external-events', 'extension-function'],
          },
        },
        sceneName: { type: 'string', minLength: 1 },
        entityKinds: {
          type: 'array',
          uniqueItems: true,
          maxItems: 20,
          items: { type: 'string', minLength: 1 },
        },
        sinceProjectRevision: { type: 'integer', minimum: 0 },
        includeNativeReport: { type: 'boolean' },
        includeAssets: { type: 'boolean' },
        offset: { type: 'integer', minimum: 0, default: 0 },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 1000,
          default: 200,
        },
      },
    },
    metadata: STATIC_READ_METADATA,
    execute: ({ input }) => staticDiagnosticsService.query(input),
  },
];
