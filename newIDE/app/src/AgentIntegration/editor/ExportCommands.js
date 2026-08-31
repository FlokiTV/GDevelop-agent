// @flow
import {
  makeCommandMetadata,
  type CommandDescriptor,
} from '../core/CommandRegistry';

export const createExportCommandDescriptors = ({
  exportService,
}: {|
  exportService: any,
|}): Array<CommandDescriptor> => [
  {
    name: 'export.html5',
    description: 'Export the open GDevelop project as a local HTML5 build.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        outputDir: { type: 'string' },
      },
    },
    metadata: makeCommandMetadata({
      readOnly: true,
      idempotent: false,
      longRunning: true,
      requiresProject: true,
      defaultTimeoutMs: 10 * 60 * 1000,
    }),
    execute: ({ input }) => exportService.exportHtml5(input),
  },
];
