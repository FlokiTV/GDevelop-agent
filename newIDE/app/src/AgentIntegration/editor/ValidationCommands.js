// @flow
import {
  makeCommandMetadata,
  type CommandDescriptor,
} from '../core/CommandRegistry';

export const createValidationCommandDescriptors = ({
  validationService,
}: {|
  validationService: any,
|}): Array<CommandDescriptor> => [
  {
    name: 'validation.run',
    description:
      'Run aggregate project validation with optional checkpoint diff, gameplay tests, runtime assertions, logs and HTML5 export.',
    inputSchema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        checkpointId: { type: 'string' },
        gameplayTests: { type: 'array', maxItems: 20 },
        runtimeAssertions: { type: 'array', maxItems: 50 },
        includeRuntimeLogs: { type: 'boolean' },
        runtimeLogLimit: { type: 'number' },
        debuggerId: { type: 'string' },
        export: {},
        includeNativeReport: { type: 'boolean' },
        includeAssets: { type: 'boolean' },
      },
    },
    metadata: makeCommandMetadata({
      readOnly: true,
      idempotent: false,
      longRunning: true,
      requiresProject: true,
      defaultTimeoutMs: 10 * 60 * 1000,
    }),
    execute: ({ input }) => validationService.run(input),
  },
];
