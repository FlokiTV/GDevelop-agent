// @flow
import {
  makeCommandMetadata,
  type CommandDescriptor,
} from '../core/CommandRegistry';

const RESOURCE_NAME = { type: 'string', maxLength: 500 };
const ICON_ENTRY = {
  type: 'object',
  additionalProperties: false,
  required: ['size', 'resourceName'],
  properties: {
    size: { type: 'integer', minimum: 1, maximum: 2048 },
    resourceName: RESOURCE_NAME,
  },
};
const BUILD_ID = { type: 'string', minLength: 1, maxLength: 200 };

const BUILD_CONFIGURATION_PROPERTIES = {
  packageName: {
    type: 'string',
    minLength: 1,
    maxLength: 254,
    pattern: '^([A-Za-z][A-Za-z0-9_]*\\.)+[A-Za-z][A-Za-z0-9_]*$',
  },
  version: { type: 'string', minLength: 1, maxLength: 100 },
  orientation: {
    type: 'string',
    enum: ['default', 'landscape', 'portrait'],
  },
  icons: {
    type: 'object',
    additionalProperties: false,
    properties: {
      desktop: { type: 'array', maxItems: 1, items: ICON_ENTRY },
      android: { type: 'array', maxItems: 6, items: ICON_ENTRY },
      ios: { type: 'array', maxItems: 19, items: ICON_ENTRY },
    },
  },
  splash: {
    type: 'object',
    additionalProperties: false,
    properties: {
      androidWindowSplashScreenAnimatedIconResourceName: RESOURCE_NAME,
    },
  },
  loadingScreen: {
    type: 'object',
    additionalProperties: false,
    properties: {
      showGDevelopLogo: { type: 'boolean' },
      gdevelopLogoStyle: { type: 'string', maxLength: 100 },
      backgroundImageResourceName: RESOURCE_NAME,
      backgroundColor: { type: 'integer', minimum: 0, maximum: 16777215 },
      backgroundFadeInDuration: { type: 'number', minimum: 0, maximum: 600000 },
      minDuration: { type: 'number', minimum: 0, maximum: 600000 },
      logoAndProgressFadeInDuration: {
        type: 'number',
        minimum: 0,
        maximum: 600000,
      },
      logoAndProgressLogoFadeInDelay: {
        type: 'number',
        minimum: 0,
        maximum: 600000,
      },
      showProgressBar: { type: 'boolean' },
      progressBarMaxWidth: { type: 'number', minimum: 0, maximum: 100000 },
      progressBarMinWidth: { type: 'number', minimum: 0, maximum: 100000 },
      progressBarWidthPercent: { type: 'number', minimum: 0, maximum: 100 },
      progressBarHeight: { type: 'number', minimum: 0, maximum: 100000 },
      progressBarColor: { type: 'integer', minimum: 0, maximum: 16777215 },
    },
  },
};

export const createBuildCommandDescriptors = ({
  buildService,
}: {|
  buildService: any,
|}): Array<CommandDescriptor> => [
  {
    name: 'build.targets.list',
    description:
      'List local export and remote build targets with capability-driven availability, installability and typed unsupported reasons for the running editor environment.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    metadata: makeCommandMetadata({
      cacheScope: 'request',
      ttlMs: 0,
    }),
    execute: () => buildService.listTargets(),
  },
  {
    name: 'build.configuration.inspect',
    description:
      'Inspect package name, version, orientation, platform icon assignments, splash asset and loading-screen configuration from the live project.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    metadata: makeCommandMetadata({
      requiresProject: true,
      cacheScope: 'project-revision',
    }),
    execute: () => buildService.inspectConfiguration(),
  },
  {
    name: 'build.configuration.apply',
    description:
      'Apply supported native GDevelop packaging configuration fields to the live project. Resource references must point to existing image resources.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      minProperties: 1,
      properties: BUILD_CONFIGURATION_PROPERTIES,
    },
    metadata: makeCommandMetadata({
      readOnly: false,
      destructive: false,
      idempotent: true,
      requiresProject: true,
      modifiesProject: true,
    }),
    execute: ({ input }) => buildService.applyConfiguration(input),
  },
  {
    name: 'build.start',
    description:
      'Prepare the live project through the official GDevelop Electron/Cordova export pipeline, upload the sanitized game archive and start one authenticated remote build target. Returns after the provider build is accepted; poll with build.status.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['targetId'],
      properties: {
        targetId: { type: 'string', minLength: 1, maxLength: 100 },
        payWithCredits: { type: 'boolean', default: false },
        androidKeystore: {
          type: 'string',
          enum: ['new', 'old'],
          default: 'new',
        },
      },
    },
    metadata: makeCommandMetadata({
      readOnly: false,
      destructive: true,
      idempotent: false,
      longRunning: true,
      requiresProject: true,
      modifiesProject: false,
      defaultTimeoutMs: 10 * 60 * 1000,
    }),
    execute: ({ input, requestContext }) =>
      buildService.start(input, requestContext && requestContext.signal),
  },
  {
    name: 'build.status',
    description:
      'Read sanitized status for an authenticated remote GDevelop build without exposing user ids, authorization headers, bucket keys or provider secrets.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['buildId'],
      properties: { buildId: BUILD_ID },
    },
    metadata: makeCommandMetadata({
      longRunning: true,
      defaultTimeoutMs: 30000,
    }),
    execute: ({ input }) => buildService.status(input),
  },
  {
    name: 'build.cancel',
    description:
      'Request cancellation semantics for a remote build. The current GDevelop Build API has no provider cancellation endpoint, so active provider builds return a typed unsupported result rather than being deleted or misreported as cancelled.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['buildId'],
      properties: { buildId: BUILD_ID },
    },
    metadata: makeCommandMetadata({
      readOnly: false,
      destructive: false,
      idempotent: true,
      longRunning: true,
      defaultTimeoutMs: 30000,
    }),
    execute: ({ input }) => buildService.cancel(input),
  },
  {
    name: 'build.result',
    description:
      'Resolve a remote build into sanitized completion state and public artifact URLs when available. Provider storage keys, logs keys and credentials are never returned.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['buildId'],
      properties: { buildId: BUILD_ID },
    },
    metadata: makeCommandMetadata({
      longRunning: true,
      defaultTimeoutMs: 30000,
    }),
    execute: ({ input }) => buildService.result(input),
  },
];
