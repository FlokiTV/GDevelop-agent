// @flow
import {
  makeCommandMetadata,
  type CommandDescriptor,
} from '../core/CommandRegistry';

const READ_METADATA = makeCommandMetadata({
  requiresProject: true,
  cacheScope: 'project-revision',
  ttlMs: 30000,
});

const NETWORK_READ_METADATA = makeCommandMetadata({
  requiresProject: true,
  longRunning: true,
  cacheScope: 'process',
  ttlMs: 300000,
});

const INSTALL_METADATA = makeCommandMetadata({
  readOnly: false,
  idempotent: false,
  requiresProject: true,
  modifiesProject: true,
  longRunning: true,
});

const DESTRUCTIVE_METADATA = makeCommandMetadata({
  readOnly: false,
  destructive: true,
  idempotent: false,
  requiresProject: true,
  modifiesProject: true,
  longRunning: true,
});

const NAME_PROPERTY = { type: 'string', minLength: 1, maxLength: 300 };

export const createExtensionLifecycleCommandDescriptors = ({
  extensionLifecycleService,
}: {|
  extensionLifecycleService: any,
|}): Array<CommandDescriptor> => [
  {
    name: 'extensions.installed.list',
    description:
      'List installed extension surfaces and distinguish built-in platform extensions, GDevelop Extension Store extensions, and project-authored events-functions extensions.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    metadata: READ_METADATA,
    execute: () => extensionLifecycleService.listInstalled(),
  },
  {
    name: 'extensions.installed.inspect',
    description:
      'Inspect one installed extension, including its source classification and dependency/project-usage blockers when applicable.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: { name: NAME_PROPERTY },
    },
    metadata: READ_METADATA,
    execute: ({ input }) => extensionLifecycleService.inspectInstalled(input),
  },
  {
    name: 'extensions.catalog.search',
    description:
      'Search the public GDevelop Extension Store registry by name, description, category and tags; includes current project installation/version state.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', maxLength: 500 },
        tier: {
          type: 'string',
          enum: ['experimental', 'reviewed', 'installed'],
        },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
        offset: { type: 'integer', minimum: 0, default: 0 },
        refresh: { type: 'boolean', default: false },
      },
    },
    metadata: NETWORK_READ_METADATA,
    execute: ({ input }) => extensionLifecycleService.searchCatalog(input),
  },
  {
    name: 'extensions.catalog.describe',
    description:
      'Describe an exact Extension Store entry, including version, GDevelop compatibility, dependencies, tier, tags and current installation state.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: {
        name: NAME_PROPERTY,
        refresh: { type: 'boolean', default: false },
      },
    },
    metadata: NETWORK_READ_METADATA,
    execute: ({ input }) => extensionLifecycleService.describeCatalog(input),
  },
  {
    name: 'extensions.install',
    description:
      'Install a GDevelop Extension Store extension and missing dependencies into the live project using the native EventsFunctionsExtension loader. Project-authored name conflicts are rejected.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: {
        name: NAME_PROPERTY,
        refreshCatalog: { type: 'boolean', default: false },
        allowBreakingChanges: { type: 'boolean', default: false },
      },
    },
    metadata: INSTALL_METADATA,
    execute: ({ input }) => extensionLifecycleService.install(input),
  },
  {
    name: 'extensions.update',
    description:
      'Update a managed Extension Store extension and dependency closure to current catalog versions. Breaking changelog entries require explicit allowBreakingChanges=true.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: {
        name: NAME_PROPERTY,
        refreshCatalog: { type: 'boolean', default: false },
        allowBreakingChanges: { type: 'boolean', default: false },
      },
    },
    metadata: DESTRUCTIVE_METADATA,
    execute: ({ input }) => extensionLifecycleService.update(input),
  },
  {
    name: 'extensions.remove',
    description:
      'Remove a managed Extension Store extension. Built-ins cannot be removed here; project-authored extensions use extensions.project.delete. Project usages/dependent extensions block removal unless explicitly overridden.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: {
        name: NAME_PROPERTY,
        allowReferenced: { type: 'boolean', default: false },
      },
    },
    metadata: DESTRUCTIVE_METADATA,
    execute: ({ input }) => extensionLifecycleService.remove(input),
  },
];
