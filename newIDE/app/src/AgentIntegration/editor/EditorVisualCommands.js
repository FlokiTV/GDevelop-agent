// @flow
import {
  makeCommandMetadata,
  type CommandDescriptor,
} from '../core/CommandRegistry';

type EditorVisualService = {|
  getStatus: () => any,
  selectInstances: (input: any) => any,
  focusSelection: (input: any) => any,
  openScene: (input: any) => any,
|};

export const createEditorVisualCommandDescriptors = ({
  editorVisualService,
}: {|
  editorVisualService: EditorVisualService,
|}): Array<CommandDescriptor> => [
  {
    name: 'editor.visual.status',
    description:
      'Inspect the currently open GDevelop scene editors and their active/pane state.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    metadata: makeCommandMetadata({ readOnly: true, requiresProject: true }),
    execute: () => editorVisualService.getStatus(),
  },
  {
    name: 'editor.instances.select',
    description:
      'Select live scene instances in an already open Scene Editor and optionally focus them.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['sceneName'],
      properties: {
        sceneName: { type: 'string', minLength: 1 },
        objectName: { type: 'string', minLength: 1 },
        instanceId: { type: 'string', minLength: 1 },
        focusMode: { enum: ['none', 'center', 'fit'] },
      },
    },
    metadata: makeCommandMetadata({
      readOnly: false,
      idempotent: true,
      requiresProject: true,
    }),
    execute: ({ input }) => editorVisualService.selectInstances(input),
  },
  {
    name: 'editor.selection.focus',
    description:
      'Focus or fit the currently selected instances in an open GDevelop Scene Editor.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['sceneName'],
      properties: {
        sceneName: { type: 'string', minLength: 1 },
        mode: { enum: ['center', 'fit'] },
      },
    },
    metadata: makeCommandMetadata({
      readOnly: false,
      idempotent: true,
      requiresProject: true,
    }),
    execute: ({ input }) => editorVisualService.focusSelection(input),
  },
  {
    name: 'scene.open',
    description:
      'Open and focus a scene, its Events Sheet, or both in the live GDevelop editor.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['sceneName'],
      properties: {
        sceneName: { type: 'string', minLength: 1 },
        mode: { enum: ['scene', 'events', 'both'] },
      },
    },
    metadata: makeCommandMetadata({
      readOnly: false,
      idempotent: true,
      requiresProject: true,
    }),
    execute: ({ input }) => editorVisualService.openScene(input),
  },
];
