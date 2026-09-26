// @flow
import {
  makeCommandMetadata,
  type CommandDescriptor,
} from '../core/CommandRegistry';

export const createTargetIdentityCommandDescriptors = ({
  targetIdentityService,
}: {|
  targetIdentityService: any,
|}): Array<CommandDescriptor> => [
  {
    name: 'target.status',
    description:
      'Return authoritative project, editor target and preview target identity for the selected GDevelop editor window.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    outputSchema: {
      type: 'object',
      additionalProperties: true,
      required: ['project', 'editor', 'preview'],
      properties: {
        project: { type: 'object' },
        editor: { type: 'object' },
        preview: { type: 'object' },
      },
    },
    metadata: makeCommandMetadata({ readOnly: true, idempotent: true }),
    execute: () => targetIdentityService.refreshStatus(),
  },
];
