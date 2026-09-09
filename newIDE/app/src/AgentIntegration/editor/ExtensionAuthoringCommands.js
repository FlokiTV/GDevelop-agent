// @flow
import {
  makeCommandMetadata,
  type CommandDescriptor,
} from '../core/CommandRegistry';

const READ_METADATA = makeCommandMetadata({
  requiresProject: true,
  cacheScope: 'project-revision',
  ttlMs: 15000,
});

const MUTATION_METADATA = makeCommandMetadata({
  readOnly: false,
  idempotent: false,
  longRunning: true,
  requiresProject: true,
  modifiesProject: true,
  defaultTimeoutMs: 180000,
});

const DESTRUCTIVE_METADATA = makeCommandMetadata({
  ...MUTATION_METADATA,
  destructive: true,
});

const stringProperty = { type: 'string' };
const functionTypeProperty = {
  type: 'string',
  enum: [
    'action',
    'condition',
    'expression',
    'expression-and-condition',
    'action-with-operator',
  ],
};
const functionOwnerProperties = {
  extensionName: { type: 'string', minLength: 1 },
  ownerKind: {
    type: 'string',
    enum: ['extension', 'behavior', 'object'],
    default: 'extension',
  },
  ownerName: { type: 'string', minLength: 1 },
};
const functionIdentityProperties = {
  ...functionOwnerProperties,
  name: { type: 'string', minLength: 1 },
};
const functionMetadataProperties = {
  type: functionTypeProperty,
  fullName: stringProperty,
  description: stringProperty,
  sentence: stringProperty,
  group: stringProperty,
  getterName: stringProperty,
  private: { type: 'boolean' },
  async: { type: 'boolean' },
  helpUrl: stringProperty,
  deprecated: { type: 'boolean' },
  deprecationMessage: stringProperty,
};
const objectMetadataProperties = {
  fullName: stringProperty,
  description: stringProperty,
  private: { type: 'boolean' },
  previewIconUrl: stringProperty,
  iconUrl: stringProperty,
  helpPath: stringProperty,
  defaultName: stringProperty,
  assetStoreTag: stringProperty,
  renderedIn3D: { type: 'boolean' },
  animatable: { type: 'boolean' },
  textContainer: { type: 'boolean' },
  innerAreaFollowingParentSize: { type: 'boolean' },
};
const variantAreaProperty = {
  type: 'object',
  additionalProperties: false,
  properties: {
    minX: { type: 'number' },
    minY: { type: 'number' },
    minZ: { type: 'number' },
    maxX: { type: 'number' },
    maxY: { type: 'number' },
    maxZ: { type: 'number' },
  },
};
const variantMetadataProperties = {
  assetStoreAssetId: stringProperty,
  assetStoreOriginalName: stringProperty,
  area: variantAreaProperty,
};
const behaviorMetadataProperties = {
  fullName: stringProperty,
  description: stringProperty,
  private: { type: 'boolean' },
  previewIconUrl: stringProperty,
  iconUrl: stringProperty,
  helpPath: stringProperty,
  objectType: stringProperty,
};
const parameterMetadataProperties = {
  type: stringProperty,
  extraInfo: stringProperty,
  optional: { type: 'boolean' },
  description: stringProperty,
  longDescription: stringProperty,
  hint: stringProperty,
  codeOnly: { type: 'boolean' },
  defaultValue: stringProperty,
};

export const createExtensionAuthoringCommandDescriptors = ({
  extensionAuthoringService,
}: {|
  extensionAuthoringService: any,
|}): Array<CommandDescriptor> => [
  {
    name: 'extensions.project.list',
    description:
      'List project-owned events-functions extensions, with deterministic counts for free functions, custom behaviors and custom objects.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    metadata: READ_METADATA,
    execute: () => extensionAuthoringService.listProjectExtensions(),
  },
  {
    name: 'extensions.project.inspect',
    description:
      'Inspect one project-owned events-functions extension, including metadata, dependencies, free functions, events-based behaviors, events-based objects and variants.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: {
        name: { type: 'string', minLength: 1 },
      },
    },
    metadata: READ_METADATA,
    execute: ({ input }) =>
      extensionAuthoringService.inspectProjectExtension(input),
  },
  {
    name: 'extensions.project.create',
    description:
      'Create an empty project-owned events-functions extension using the live GDevelop extension lifecycle and generated metadata reload path.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: {
        name: { type: 'string', minLength: 1 },
        fullName: stringProperty,
        namespace: stringProperty,
        version: stringProperty,
        shortDescription: stringProperty,
        description: stringProperty,
        dimension: stringProperty,
        category: stringProperty,
        author: stringProperty,
        previewIconUrl: stringProperty,
        iconUrl: stringProperty,
        helpPath: stringProperty,
      },
    },
    metadata: MUTATION_METADATA,
    execute: ({ input }) =>
      extensionAuthoringService.createProjectExtension(input),
  },
  {
    name: 'extensions.project.rename',
    description:
      'Rename a project-owned events-functions extension using WholeProjectRefactorer so extension instruction/type references are updated before reloading generated metadata.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'newName'],
      properties: {
        name: { type: 'string', minLength: 1 },
        newName: { type: 'string', minLength: 1 },
      },
    },
    metadata: MUTATION_METADATA,
    execute: ({ input }) =>
      extensionAuthoringService.renameProjectExtension(input),
  },
  {
    name: 'extensions.project.delete',
    description:
      'Delete a project-owned events-functions extension. By default this rejects project usages and dependent extensions; allowReferenced=true is an explicit destructive override.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: {
        name: { type: 'string', minLength: 1 },
        allowReferenced: { type: 'boolean', default: false },
      },
    },
    metadata: DESTRUCTIVE_METADATA,
    execute: ({ input }) =>
      extensionAuthoringService.deleteProjectExtension(input),
  },
  {
    name: 'extensions.behaviors.list',
    description:
      'List events-based behaviors owned by one project extension, including declaration metadata, function summaries and property counts.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['extensionName'],
      properties: {
        extensionName: { type: 'string', minLength: 1 },
      },
    },
    metadata: READ_METADATA,
    execute: ({ input }) =>
      extensionAuthoringService.listEventsBasedBehaviors(input),
  },
  {
    name: 'extensions.behaviors.inspect',
    description:
      'Inspect one events-based behavior from a project extension, including object applicability, methods and property counts.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['extensionName', 'name'],
      properties: {
        extensionName: { type: 'string', minLength: 1 },
        name: { type: 'string', minLength: 1 },
      },
    },
    metadata: READ_METADATA,
    execute: ({ input }) =>
      extensionAuthoringService.inspectEventsBasedBehavior(input),
  },
  {
    name: 'extensions.behaviors.create',
    description:
      'Create one events-based behavior in a project extension and synchronize native required method parameters before generated metadata reload.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['extensionName', 'name'],
      properties: {
        extensionName: { type: 'string', minLength: 1 },
        name: { type: 'string', minLength: 1 },
        ...behaviorMetadataProperties,
      },
    },
    metadata: MUTATION_METADATA,
    execute: ({ input }) =>
      extensionAuthoringService.createEventsBasedBehavior(input),
  },
  {
    name: 'extensions.behaviors.update',
    description:
      'Update events-based behavior metadata/object applicability, re-synchronize required method parameters and repair invalid required-behavior properties after reload.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['extensionName', 'name'],
      properties: {
        extensionName: { type: 'string', minLength: 1 },
        name: { type: 'string', minLength: 1 },
        ...behaviorMetadataProperties,
      },
    },
    metadata: MUTATION_METADATA,
    execute: ({ input }) =>
      extensionAuthoringService.updateEventsBasedBehavior(input),
  },
  {
    name: 'extensions.behaviors.rename',
    description:
      'Rename an events-based behavior with WholeProjectRefactorer so behavior-type references are rewritten before reloading generated metadata.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['extensionName', 'name', 'newName'],
      properties: {
        extensionName: { type: 'string', minLength: 1 },
        name: { type: 'string', minLength: 1 },
        newName: { type: 'string', minLength: 1 },
      },
    },
    metadata: MUTATION_METADATA,
    execute: ({ input }) =>
      extensionAuthoringService.renameEventsBasedBehavior(input),
  },
  {
    name: 'extensions.behaviors.delete',
    description:
      'Delete an events-based behavior. Because GDevelop has no authoritative project-wide one-behavior usage finder, deletion requires explicit allowReferenced=true.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['extensionName', 'name'],
      properties: {
        extensionName: { type: 'string', minLength: 1 },
        name: { type: 'string', minLength: 1 },
        allowReferenced: { type: 'boolean', default: false },
      },
    },
    metadata: DESTRUCTIVE_METADATA,
    execute: ({ input }) =>
      extensionAuthoringService.deleteEventsBasedBehavior(input),
  },
  {
    name: 'extensions.objects.list',
    description:
      'List events-based custom objects owned by one project extension, including rendering flags, methods, property counts and named variants.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['extensionName'],
      properties: {
        extensionName: { type: 'string', minLength: 1 },
      },
    },
    metadata: READ_METADATA,
    execute: ({ input }) =>
      extensionAuthoringService.listEventsBasedObjects(input),
  },
  {
    name: 'extensions.objects.inspect',
    description:
      'Inspect one events-based custom object from a project extension, including methods, rendering flags, property count and variants.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['extensionName', 'name'],
      properties: {
        extensionName: { type: 'string', minLength: 1 },
        name: { type: 'string', minLength: 1 },
      },
    },
    metadata: READ_METADATA,
    execute: ({ input }) =>
      extensionAuthoringService.inspectEventsBasedObject(input),
  },
  {
    name: 'extensions.objects.create',
    description:
      'Create one events-based custom object and reload its generated metadata using the native extension lifecycle.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['extensionName', 'name'],
      properties: {
        extensionName: { type: 'string', minLength: 1 },
        name: { type: 'string', minLength: 1 },
        ...objectMetadataProperties,
      },
    },
    metadata: MUTATION_METADATA,
    execute: ({ input }) =>
      extensionAuthoringService.createEventsBasedObject(input),
  },
  {
    name: 'extensions.objects.update',
    description:
      'Update custom-object declaration metadata and rendering/container flags, then synchronize owner-method parameters and generated metadata.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['extensionName', 'name'],
      properties: {
        extensionName: { type: 'string', minLength: 1 },
        name: { type: 'string', minLength: 1 },
        ...objectMetadataProperties,
      },
    },
    metadata: MUTATION_METADATA,
    execute: ({ input }) =>
      extensionAuthoringService.updateEventsBasedObject(input),
  },
  {
    name: 'extensions.objects.rename',
    description:
      'Rename an events-based custom object with WholeProjectRefactorer so custom-object type references are rewritten before generated metadata reload.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['extensionName', 'name', 'newName'],
      properties: {
        extensionName: { type: 'string', minLength: 1 },
        name: { type: 'string', minLength: 1 },
        newName: { type: 'string', minLength: 1 },
      },
    },
    metadata: MUTATION_METADATA,
    execute: ({ input }) =>
      extensionAuthoringService.renameEventsBasedObject(input),
  },
  {
    name: 'extensions.objects.delete',
    description:
      'Delete an events-based custom object. Native project-usage and custom-object dependency checks reject referenced deletes unless allowReferenced=true.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['extensionName', 'name'],
      properties: {
        extensionName: { type: 'string', minLength: 1 },
        name: { type: 'string', minLength: 1 },
        allowReferenced: { type: 'boolean', default: false },
      },
    },
    metadata: DESTRUCTIVE_METADATA,
    execute: ({ input }) =>
      extensionAuthoringService.deleteEventsBasedObject(input),
  },
  {
    name: 'extensions.objects.variants.list',
    description:
      'List named variants for one events-based custom object and include its separate default variant.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['extensionName', 'name'],
      properties: {
        extensionName: { type: 'string', minLength: 1 },
        name: { type: 'string', minLength: 1 },
      },
    },
    metadata: READ_METADATA,
    execute: ({ input }) =>
      extensionAuthoringService.listEventsBasedObjectVariants(input),
  },
  {
    name: 'extensions.objects.variants.inspect',
    description:
      'Inspect one named custom-object variant, including asset provenance fields and editable area bounds.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['extensionName', 'name', 'variantName'],
      properties: {
        extensionName: { type: 'string', minLength: 1 },
        name: { type: 'string', minLength: 1 },
        variantName: { type: 'string', minLength: 1 },
      },
    },
    metadata: READ_METADATA,
    execute: ({ input }) =>
      extensionAuthoringService.inspectEventsBasedObjectVariant(input),
  },
  {
    name: 'extensions.objects.variants.create',
    description:
      'Create one named custom-object variant at an optional deterministic index.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['extensionName', 'name', 'variantName'],
      properties: {
        extensionName: { type: 'string', minLength: 1 },
        name: { type: 'string', minLength: 1 },
        variantName: { type: 'string', minLength: 1 },
        index: { type: 'integer', minimum: 0 },
        ...variantMetadataProperties,
      },
    },
    metadata: MUTATION_METADATA,
    execute: ({ input }) =>
      extensionAuthoringService.createEventsBasedObjectVariant(input),
  },
  {
    name: 'extensions.objects.variants.update',
    description:
      'Update metadata and area bounds for one named custom-object variant without replacing its internal object/layer/instance structure.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['extensionName', 'name', 'variantName'],
      properties: {
        extensionName: { type: 'string', minLength: 1 },
        name: { type: 'string', minLength: 1 },
        variantName: { type: 'string', minLength: 1 },
        ...variantMetadataProperties,
      },
    },
    metadata: MUTATION_METADATA,
    execute: ({ input }) =>
      extensionAuthoringService.updateEventsBasedObjectVariant(input),
  },
  {
    name: 'extensions.objects.variants.rename',
    description:
      'Rename a named custom-object variant. Because GDevelop has no project-wide variant-reference refactorer, allowReferenced=true is required.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['extensionName', 'name', 'variantName', 'newName'],
      properties: {
        extensionName: { type: 'string', minLength: 1 },
        name: { type: 'string', minLength: 1 },
        variantName: { type: 'string', minLength: 1 },
        newName: { type: 'string', minLength: 1 },
        allowReferenced: { type: 'boolean', default: false },
      },
    },
    metadata: MUTATION_METADATA,
    execute: ({ input }) =>
      extensionAuthoringService.renameEventsBasedObjectVariant(input),
  },
  {
    name: 'extensions.objects.variants.delete',
    description:
      'Delete one named custom-object variant. Variant references have no authoritative project-wide finder, so allowReferenced=true is required.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['extensionName', 'name', 'variantName'],
      properties: {
        extensionName: { type: 'string', minLength: 1 },
        name: { type: 'string', minLength: 1 },
        variantName: { type: 'string', minLength: 1 },
        allowReferenced: { type: 'boolean', default: false },
      },
    },
    metadata: DESTRUCTIVE_METADATA,
    execute: ({ input }) =>
      extensionAuthoringService.deleteEventsBasedObjectVariant(input),
  },
  {
    name: 'extensions.objects.variants.move',
    description:
      'Move one named custom-object variant by index while preserving variant identity/content.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['extensionName', 'name', 'oldIndex', 'newIndex'],
      properties: {
        extensionName: { type: 'string', minLength: 1 },
        name: { type: 'string', minLength: 1 },
        oldIndex: { type: 'integer', minimum: 0 },
        newIndex: { type: 'integer', minimum: 0 },
      },
    },
    metadata: MUTATION_METADATA,
    execute: ({ input }) =>
      extensionAuthoringService.moveEventsBasedObjectVariant(input),
  },
  {
    name: 'extensions.functions.list',
    description:
      'List free functions or methods owned by one project extension, events-based behavior or events-based custom object.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['extensionName'],
      properties: functionOwnerProperties,
    },
    metadata: READ_METADATA,
    execute: ({ input }) =>
      extensionAuthoringService.listEventsFunctions(input),
  },
  {
    name: 'extensions.functions.inspect',
    description:
      'Inspect one custom function or method, including function kind, declaration metadata, event count and parameter metadata.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['extensionName', 'name'],
      properties: functionIdentityProperties,
    },
    metadata: READ_METADATA,
    execute: ({ input }) =>
      extensionAuthoringService.inspectEventsFunction(input),
  },
  {
    name: 'extensions.functions.create',
    description:
      'Create a free function or behavior/object method with a canonical GDevelop function kind and native condition/expression skeletons when applicable.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['extensionName', 'name', 'type'],
      properties: {
        ...functionIdentityProperties,
        ...functionMetadataProperties,
      },
    },
    metadata: MUTATION_METADATA,
    execute: ({ input }) =>
      extensionAuthoringService.createEventsFunction(input),
  },
  {
    name: 'extensions.functions.update',
    description:
      'Update declaration metadata for one custom function. Changing action/condition/expression kind requires explicit allowBreakingTypeChange=true.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['extensionName', 'name'],
      properties: {
        ...functionIdentityProperties,
        ...functionMetadataProperties,
        allowBreakingTypeChange: { type: 'boolean', default: false },
      },
    },
    metadata: MUTATION_METADATA,
    execute: ({ input }) =>
      extensionAuthoringService.updateEventsFunction(input),
  },
  {
    name: 'extensions.functions.rename',
    description:
      'Rename a custom function or method with WholeProjectRefactorer so existing references are rewritten. Lifecycle function names are protected.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['extensionName', 'name', 'newName'],
      properties: {
        ...functionIdentityProperties,
        newName: { type: 'string', minLength: 1 },
      },
    },
    metadata: MUTATION_METADATA,
    execute: ({ input }) =>
      extensionAuthoringService.renameEventsFunction(input),
  },
  {
    name: 'extensions.functions.delete',
    description:
      'Delete one custom function or method. Because GDevelop has no authoritative one-function call-site finder, deletion requires explicit allowReferenced=true.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['extensionName', 'name'],
      properties: {
        ...functionIdentityProperties,
        allowReferenced: { type: 'boolean', default: false },
      },
    },
    metadata: DESTRUCTIVE_METADATA,
    execute: ({ input }) =>
      extensionAuthoringService.deleteEventsFunction(input),
  },
  {
    name: 'extensions.functions.parameters.create',
    description:
      'Insert one editable parameter into a custom function declaration. Required behavior/object method parameters and frozen lifecycle/operator signatures are protected.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['extensionName', 'name', 'parameterName'],
      properties: {
        ...functionIdentityProperties,
        parameterName: { type: 'string', minLength: 1 },
        index: { type: 'integer', minimum: 0 },
        ...parameterMetadataProperties,
      },
    },
    metadata: MUTATION_METADATA,
    execute: ({ input }) =>
      extensionAuthoringService.createEventsFunctionParameter(input),
  },
  {
    name: 'extensions.functions.parameters.update',
    description:
      'Update one editable custom-function parameter. Type/behavior metadata changes run WholeProjectRefactorer.changeParameterType against a native function scope.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['extensionName', 'name', 'parameterName'],
      properties: {
        ...functionIdentityProperties,
        parameterName: { type: 'string', minLength: 1 },
        ...parameterMetadataProperties,
      },
    },
    metadata: MUTATION_METADATA,
    execute: ({ input }) =>
      extensionAuthoringService.updateEventsFunctionParameter(input),
  },
  {
    name: 'extensions.functions.parameters.rename',
    description:
      'Rename one editable custom-function parameter with native scoped refactoring so references inside its event sheet are updated.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['extensionName', 'name', 'parameterName', 'newName'],
      properties: {
        ...functionIdentityProperties,
        parameterName: { type: 'string', minLength: 1 },
        newName: { type: 'string', minLength: 1 },
      },
    },
    metadata: MUTATION_METADATA,
    execute: ({ input }) =>
      extensionAuthoringService.renameEventsFunctionParameter(input),
  },
  {
    name: 'extensions.functions.parameters.delete',
    description:
      'Delete one editable custom-function parameter while preserving required owner parameters and frozen signatures.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['extensionName', 'name', 'parameterName'],
      properties: {
        ...functionIdentityProperties,
        parameterName: { type: 'string', minLength: 1 },
      },
    },
    metadata: DESTRUCTIVE_METADATA,
    execute: ({ input }) =>
      extensionAuthoringService.deleteEventsFunctionParameter(input),
  },
  {
    name: 'extensions.functions.parameters.move',
    description:
      'Move one editable custom-function parameter while using the owner-specific WholeProjectRefactorer index semantics for call sites.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['extensionName', 'name', 'oldIndex', 'newIndex'],
      properties: {
        ...functionIdentityProperties,
        oldIndex: { type: 'integer', minimum: 0 },
        newIndex: { type: 'integer', minimum: 0 },
      },
    },
    metadata: MUTATION_METADATA,
    execute: ({ input }) =>
      extensionAuthoringService.moveEventsFunctionParameter(input),
  },
];
