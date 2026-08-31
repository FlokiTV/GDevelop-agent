// @flow
import {
  makeCommandMetadata,
  type CommandDescriptor,
} from '../core/CommandRegistry';

export const createDiagnosticsCommandDescriptors = ({
  diagnosticsTools,
}: {|
  diagnosticsTools: any,
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
];
