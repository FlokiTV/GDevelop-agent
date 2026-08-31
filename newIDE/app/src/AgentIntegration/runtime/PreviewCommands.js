// @flow
import {
  makeCommandMetadata,
  type CommandDescriptor,
} from '../core/CommandRegistry';

export const createPreviewCommandDescriptors = ({
  previewService,
}: {|
  previewService: any,
|}): Array<CommandDescriptor> => [
  {
    name: 'preview.status',
    description: 'Return debugger and running state for the current preview.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    metadata: makeCommandMetadata(),
    execute: () => previewService.getStatus(),
  },
  {
    name: 'preview.start',
    description: 'Start a preview for the currently open project.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { numberOfWindows: { type: 'number' } },
    },
    metadata: makeCommandMetadata({
      readOnly: true,
      idempotent: false,
      requiresProject: true,
    }),
    execute: ({ input }) => previewService.start(input),
  },
  {
    name: 'preview.hot-reload',
    description: 'Hot reload all running previews for the open project.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    metadata: makeCommandMetadata({
      readOnly: true,
      idempotent: false,
      requiresProject: true,
    }),
    execute: () => previewService.hotReload(),
  },
  {
    name: 'preview.control',
    description: 'Play, pause or refresh one or all preview debugger targets.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['play', 'pause', 'refresh'] },
        debuggerId: { type: 'string' },
      },
    },
    metadata: makeCommandMetadata({ readOnly: true, idempotent: false }),
    execute: ({ input }) => previewService.control(input),
  },
  {
    name: 'preview.close-all',
    description: 'Close external preview windows without stopping the editor debugger server.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    metadata: makeCommandMetadata({ readOnly: true, idempotent: true }),
    execute: () => previewService.closeAll(),
  },
];
