// @flow
import { AgentError } from '../core/AgentError';
import {
  makeCommandMetadata,
  type CommandDescriptor,
} from '../core/CommandRegistry';

const EMPTY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {},
};

const RESOURCE_NAME_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['resourceName'],
  properties: { resourceName: { type: 'string', minLength: 1 } },
};

const TEXT_RESOURCE_KINDS = [
  'json',
  'javascript',
  'tilemap',
  'tileset',
  'bitmapFont',
  'atlas',
  'spine',
];

const TEXT_RESOURCE_WRITE_PROPERTIES = {
  resourceName: { type: 'string', minLength: 1 },
  relativePath: { type: 'string', minLength: 1 },
  format: { type: 'string', enum: ['json', 'text'] },
  resourceKind: { type: 'string', enum: TEXT_RESOURCE_KINDS },
  content: { type: 'string' },
};

const VISUAL_RESOURCE_WRITE_PROPERTIES = {
  resourceName: { type: 'string', minLength: 1 },
  relativePath: { type: 'string', minLength: 1 },
  kind: { type: 'string', enum: ['image', 'font'] },
  contentBase64: { type: 'string', minLength: 4 },
};

const assertResourceName = (value: any) => {
  if (!value || typeof value !== 'string') {
    throw new AgentError({ code: 'missing_resource_name' });
  }
};

const assertFilePath = (value: any) => {
  if (!value || typeof value !== 'string') {
    throw new AgentError({ code: 'missing_resource_file_path' });
  }
};

const assertTextContent = (value: any) => {
  if (typeof value !== 'string') {
    throw new AgentError({ code: 'missing_resource_text_content' });
  }
};

const assertVisualContent = (value: any) => {
  if (!value || typeof value !== 'string') {
    throw new AgentError({ code: 'missing_visual_resource_content' });
  }
};

export const createResourceCommandDescriptors = ({
  assetTools,
}: {|
  assetTools: any,
|}): Array<CommandDescriptor> => [
  {
    name: 'resources.list',
    description:
      'List project resources with usage, missing-file and project-folder health information.',
    inputSchema: EMPTY_SCHEMA,
    metadata: makeCommandMetadata({ requiresProject: true }),
    execute: () => assetTools.listResources(),
  },
  {
    name: 'resources.inspect',
    description:
      'Inspect one project resource, including its file status and objects that use it.',
    inputSchema: RESOURCE_NAME_SCHEMA,
    metadata: makeCommandMetadata({ requiresProject: true }),
    validateInput: input => assertResourceName(input.resourceName),
    execute: ({ input }) => assetTools.inspectResource(input.resourceName),
  },
  {
    name: 'resources.text.read',
    description:
      'Read one project-local UTF-8 resource file. JSON resources are parsed and report syntax validity.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['resourceName'],
      properties: {
        resourceName: { type: 'string', minLength: 1 },
        parseJson: { type: 'boolean' },
      },
    },
    metadata: makeCommandMetadata({ requiresProject: true }),
    validateInput: input => assertResourceName(input.resourceName),
    execute: ({ input }) => assetTools.readTextResource(input),
  },
  {
    name: 'resources.text.create',
    description:
      'Create a project-local UTF-8/JSON file and register it as a project resource in one atomic operation. JSON defaults to resource kind json; plain text requires an explicit compatible resourceKind.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['resourceName', 'content'],
      properties: TEXT_RESOURCE_WRITE_PROPERTIES,
    },
    metadata: makeCommandMetadata({
      readOnly: false,
      idempotent: false,
      requiresProject: true,
      modifiesProject: true,
    }),
    validateInput: input => {
      assertResourceName(input.resourceName);
      assertTextContent(input.content);
    },
    execute: ({ input }) =>
      assetTools.writeTextResource({ ...input, createOnly: true }),
  },
  {
    name: 'resources.text.update',
    description:
      'Atomically update the project-local UTF-8/JSON file backing an existing compatible resource, optionally moving it to another project-relative path.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['resourceName', 'content'],
      properties: TEXT_RESOURCE_WRITE_PROPERTIES,
    },
    metadata: makeCommandMetadata({
      readOnly: false,
      destructive: true,
      idempotent: true,
      requiresProject: true,
      modifiesProject: true,
    }),
    validateInput: input => {
      assertResourceName(input.resourceName);
      assertTextContent(input.content);
    },
    execute: ({ input }) =>
      assetTools.writeTextResource({ ...input, updateOnly: true }),
  },
  {
    name: 'resources.packaging.inspect',
    description:
      'Explain how registered file-backed resources map from source paths to flattened preview/export filenames and portable runtime paths.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        resourceName: { type: 'string', minLength: 1 },
      },
    },
    metadata: makeCommandMetadata({ requiresProject: true }),
    execute: ({ input }) => assetTools.inspectResourcePackaging(input),
  },
  {
    name: 'resources.visual.inspect',
    description:
      'Inspect one registered image/font resource with project-relative path, MIME, byte size, SHA-256, image/font metadata, usage paths, structural constraints and packaging/runtime resolution.',
    inputSchema: RESOURCE_NAME_SCHEMA,
    metadata: makeCommandMetadata({ requiresProject: true }),
    validateInput: input => assertResourceName(input.resourceName),
    execute: ({ input }) => assetTools.inspectVisualResource(input),
  },
  {
    name: 'resources.visual.import',
    description:
      'Create a project-local raster/SVG/font file from base64 bytes and register it atomically without requiring callers to know the project filesystem layout.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['resourceName', 'contentBase64'],
      properties: VISUAL_RESOURCE_WRITE_PROPERTIES,
    },
    metadata: makeCommandMetadata({
      readOnly: false,
      idempotent: false,
      requiresProject: true,
      modifiesProject: true,
    }),
    validateInput: input => {
      assertResourceName(input.resourceName);
      assertVisualContent(input.contentBase64);
    },
    execute: ({ input }) => assetTools.importVisualResource(input),
  },
  {
    name: 'resources.visual.replace',
    description:
      'Atomically replace the bytes backing a registered image/font resource while preserving its resource identity and every existing project reference.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['resourceName', 'contentBase64'],
      properties: VISUAL_RESOURCE_WRITE_PROPERTIES,
    },
    metadata: makeCommandMetadata({
      readOnly: false,
      destructive: true,
      idempotent: true,
      requiresProject: true,
      modifiesProject: true,
    }),
    validateInput: input => {
      assertResourceName(input.resourceName);
      assertVisualContent(input.contentBase64);
    },
    execute: ({ input }) => assetTools.replaceVisualResource(input),
  },
  {
    name: 'resources.visual.relocate',
    description:
      'Safely rename a visual resource and/or move its project-local backing file while preserving all resource references. Dry-run is available for review.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['resourceName'],
      properties: {
        resourceName: { type: 'string', minLength: 1 },
        newResourceName: { type: 'string', minLength: 1 },
        newRelativePath: { type: 'string', minLength: 1 },
        dryRun: { type: 'boolean', default: true },
      },
    },
    metadata: makeCommandMetadata({
      readOnly: false,
      destructive: true,
      idempotent: false,
      requiresProject: true,
      modifiesProject: true,
    }),
    modifiesProjectWhen: input => input.dryRun === false,
    validateInput: input => {
      assertResourceName(input.resourceName);
      if (!input.newResourceName && !input.newRelativePath) {
        throw new AgentError({ code: 'missing_visual_resource_relocation' });
      }
    },
    execute: ({ input }) => assetTools.relocateVisualResource(input),
  },
  {
    name: 'resources.visual.delete',
    description:
      'Dry-run or delete an unused visual resource. In-use resources are blocked with a structured usage summary and are never silently removed.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['resourceName'],
      properties: {
        resourceName: { type: 'string', minLength: 1 },
        deleteFile: { type: 'boolean', default: false },
        dryRun: { type: 'boolean', default: true },
      },
    },
    metadata: makeCommandMetadata({
      readOnly: false,
      destructive: true,
      idempotent: false,
      requiresProject: true,
      modifiesProject: true,
    }),
    modifiesProjectWhen: input => input.dryRun === false,
    validateInput: input => assertResourceName(input.resourceName),
    execute: ({ input }) => assetTools.deleteVisualResource(input),
  },
  {
    name: 'resources.import-local',
    description:
      'Import a local file as a project resource, optionally copying it into the project folder.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['filePath'],
      properties: {
        filePath: { type: 'string', minLength: 1 },
        resourceName: { type: 'string' },
        kind: { type: 'string' },
        copyToProject: { type: 'boolean' },
        overwrite: { type: 'boolean' },
        preserveOrigin: { type: 'boolean' },
      },
    },
    metadata: makeCommandMetadata({
      readOnly: false,
      idempotent: false,
      requiresProject: true,
      modifiesProject: true,
      longRunning: true,
    }),
    validateInput: input => assertFilePath(input.filePath),
    execute: ({ input }) => assetTools.importLocalResource(input),
  },
  {
    name: 'resources.replace-local',
    description:
      'Replace the file backing an existing project resource while preserving resource identity and safety checks.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['resourceName', 'filePath'],
      properties: {
        resourceName: { type: 'string', minLength: 1 },
        filePath: { type: 'string', minLength: 1 },
        kind: { type: 'string' },
        copyToProject: { type: 'boolean' },
        preserveOrigin: { type: 'boolean' },
        deletePreviousFile: { type: 'boolean' },
      },
    },
    metadata: makeCommandMetadata({
      readOnly: false,
      destructive: true,
      idempotent: false,
      requiresProject: true,
      modifiesProject: true,
      longRunning: true,
    }),
    validateInput: input => {
      assertResourceName(input.resourceName);
      assertFilePath(input.filePath);
    },
    execute: ({ input }) => assetTools.replaceLocalResource(input),
  },
  {
    name: 'resources.rename',
    description:
      'Rename a project resource and update its references throughout the live project.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['resourceName', 'newResourceName'],
      properties: {
        resourceName: { type: 'string', minLength: 1 },
        newResourceName: { type: 'string', minLength: 1 },
      },
    },
    metadata: makeCommandMetadata({
      readOnly: false,
      idempotent: false,
      requiresProject: true,
      modifiesProject: true,
    }),
    validateInput: input => {
      assertResourceName(input.resourceName);
      if (!input.newResourceName || typeof input.newResourceName !== 'string') {
        throw new AgentError({ code: 'missing_new_resource_name' });
      }
    },
    execute: ({ input }) => assetTools.renameResource(input),
  },
  {
    name: 'resources.remove',
    description:
      'Remove an unused project resource. Optional physical file deletion remains restricted to safe project-local files.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['resourceName'],
      properties: {
        resourceName: { type: 'string', minLength: 1 },
        deleteFile: { type: 'boolean' },
      },
    },
    metadata: makeCommandMetadata({
      readOnly: false,
      destructive: true,
      idempotent: false,
      requiresProject: true,
      modifiesProject: true,
    }),
    validateInput: input => assertResourceName(input.resourceName),
    execute: ({ input }) => assetTools.removeResource(input),
  },
];
