// @flow
import { AgentError } from '../core/AgentError';
import {
  makeCommandMetadata,
  type CommandDescriptor,
} from '../core/CommandRegistry';

type ProjectLifecycleService = {|
  create: (input: any) => Promise<any>,
  open: (input: any) => Promise<any>,
  close: (input?: any) => Promise<any>,
  persistenceStatus: (input?: any) => any,
  verifyPersistence: (input?: any) => any,
  save: (input?: any, requestContext?: any) => Promise<any>,
  saveAs: (input: any, requestContext?: any) => Promise<any>,
  reload: (input?: any, requestContext?: any) => Promise<any>,
|};

const assertOptionalBoolean = (value: any, code: string) => {
  if (value !== undefined && typeof value !== 'boolean') {
    throw new AgentError({ code });
  }
};

const assertOptionalString = (value: any, code: string) => {
  if (value !== undefined && typeof value !== 'string') {
    throw new AgentError({ code });
  }
};

const assertOptionalRevision = (value: any) => {
  if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
    throw new AgentError({ code: 'invalid_expected_project_revision' });
  }
};

const persistenceGuardProperties = {
  expectedProjectId: {
    type: 'string',
    minLength: 1,
    description:
      'Optional guard matching the active project UUID before persistence work.',
  },
  expectedFileIdentifier: {
    type: 'string',
    minLength: 1,
    description:
      'Optional guard matching the active persisted project path before persistence work.',
  },
  expectedProjectRevision: {
    type: 'integer',
    minimum: 0,
    description:
      'Optional guard matching the current in-memory monotonic project revision.',
  },
};

const persistedVerificationProperties = {
  expectedPersistedHash: {
    type: 'string',
    minLength: 1,
    description:
      'Optional SHA-256 serialized-state hash expected for the persisted project JSON.',
  },
  expectedPersistedRevision: {
    type: 'integer',
    minimum: 0,
    description:
      'Optional project revision captured by the successful save being verified.',
  },
};

const assertPersistenceGuards = (input: any) => {
  assertOptionalString(input.expectedProjectId, 'invalid_expected_project_id');
  assertOptionalString(
    input.expectedFileIdentifier,
    'invalid_expected_file_identifier'
  );
  assertOptionalRevision(input.expectedProjectRevision);
  assertOptionalString(
    input.expectedPersistedHash,
    'invalid_expected_persisted_hash'
  );
  if (
    input.expectedPersistedRevision !== undefined &&
    (!Number.isInteger(input.expectedPersistedRevision) ||
      input.expectedPersistedRevision < 0)
  ) {
    throw new AgentError({ code: 'invalid_expected_persisted_revision' });
  }
};

const withGeneratedState = (result: any, environment: any) => {
  const projectStatus =
    environment && typeof environment.getProjectStatus === 'function'
      ? environment.getProjectStatus()
      : null;
  return {
    ...result,
    generatedState: {
      preview:
        projectStatus && projectStatus.preview
          ? projectStatus.preview
          : { available: false, running: false },
      export: {
        tracked: false,
        relationToPersistence: 'independent-generated-output',
        note:
          'Project persistence verifies editor memory against project JSON on disk. Preview/export generated outputs have independent lifecycle state and are not treated as persisted project JSON.',
      },
    },
  };
};

export const createProjectLifecycleCommandDescriptors = ({
  projectLifecycleService,
}: {|
  projectLifecycleService: ProjectLifecycleService,
|}): Array<CommandDescriptor> => [
  {
    name: 'project.create',
    description:
      'Create a new GDevelop project in the live editor, optionally from an example template. Saving is always explicit.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: {
        name: { type: 'string', minLength: 1 },
        templateSlug: { type: 'string' },
      },
    },
    metadata: makeCommandMetadata({
      readOnly: false,
      idempotent: false,
      modifiesProject: true,
    }),
    validateInput: input => {
      if (!input.name || typeof input.name !== 'string') {
        throw new AgentError({ code: 'missing_project_name' });
      }
      if (
        input.templateSlug !== undefined &&
        typeof input.templateSlug !== 'string'
      ) {
        throw new AgentError({ code: 'invalid_template_slug' });
      }
    },
    execute: ({ input }) => projectLifecycleService.create(input),
  },
  {
    name: 'project.open',
    description:
      'Open a local GDevelop project. Unsaved changes are never discarded unless explicitly requested.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['filePath'],
      properties: {
        filePath: { type: 'string', minLength: 1 },
        discardUnsavedChanges: { type: 'boolean' },
      },
    },
    metadata: makeCommandMetadata({
      readOnly: false,
      destructive: true,
      idempotent: false,
      modifiesProject: true,
    }),
    validateInput: input => {
      if (!input.filePath || typeof input.filePath !== 'string') {
        throw new AgentError({ code: 'missing_project_file_path' });
      }
      assertOptionalBoolean(
        input.discardUnsavedChanges,
        'invalid_discard_unsaved_changes'
      );
    },
    execute: ({ input }) => projectLifecycleService.open(input),
  },
  {
    name: 'project.close',
    description:
      'Close the current project. Unsaved changes are never discarded unless explicitly requested.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { discardUnsavedChanges: { type: 'boolean' } },
    },
    metadata: makeCommandMetadata({
      readOnly: false,
      destructive: true,
      idempotent: true,
      modifiesProject: true,
    }),
    validateInput: input =>
      assertOptionalBoolean(
        input.discardUnsavedChanges,
        'invalid_discard_unsaved_changes'
      ),
    execute: ({ input }) => projectLifecycleService.close(input),
  },
  {
    name: 'project.persistence.status',
    description:
      'Read authoritative editor dirty state, in-memory revision/hash, persisted project path/hash, external disk-change detection and the last successful save/reload metadata.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...persistenceGuardProperties,
      },
    },
    metadata: makeCommandMetadata({
      requiresProject: true,
    }),
    validateInput: assertPersistenceGuards,
    execute: ({ input, environment }) =>
      withGeneratedState(
        projectLifecycleService.persistenceStatus(input),
        environment
      ),
  },
  {
    name: 'project.persistence.verify',
    description:
      'Read the persisted project JSON back from disk and verify its stable serialized-state hash/revision against the last successful save or explicit expected values.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...persistenceGuardProperties,
        ...persistedVerificationProperties,
      },
    },
    metadata: makeCommandMetadata({
      requiresProject: true,
    }),
    validateInput: assertPersistenceGuards,
    execute: ({ input, environment }) =>
      withGeneratedState(
        projectLifecycleService.verifyPersistence(input),
        environment
      ),
  },
  {
    name: 'project.save',
    description:
      'Explicitly save the currently open GDevelop project to its existing storage location, rejecting active safety transactions, foreign project leases and external disk changes unless overwrite is explicit.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...persistenceGuardProperties,
        overwriteExternalChanges: { type: 'boolean' },
      },
    },
    metadata: makeCommandMetadata({
      readOnly: false,
      idempotent: true,
      requiresProject: true,
    }),
    validateInput: input => {
      assertPersistenceGuards(input);
      assertOptionalBoolean(
        input.overwriteExternalChanges,
        'invalid_overwrite_external_changes'
      );
    },
    execute: ({ input, requestContext }) =>
      projectLifecycleService.save(input, requestContext),
  },
  {
    name: 'project.save-as',
    description:
      'Explicitly save the currently open GDevelop project to a local file path with optional active-project identity/revision guardrails.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['filePath'],
      properties: {
        filePath: { type: 'string', minLength: 1 },
        name: { type: 'string' },
        ...persistenceGuardProperties,
        overwriteExternalChanges: { type: 'boolean' },
      },
    },
    metadata: makeCommandMetadata({
      readOnly: false,
      idempotent: false,
      requiresProject: true,
    }),
    validateInput: input => {
      if (!input.filePath || typeof input.filePath !== 'string') {
        throw new AgentError({ code: 'missing_project_file_path' });
      }
      assertPersistenceGuards(input);
      assertOptionalBoolean(
        input.overwriteExternalChanges,
        'invalid_overwrite_external_changes'
      );
    },
    execute: ({ input, requestContext }) =>
      projectLifecycleService.saveAs(input, requestContext),
  },
  {
    name: 'project.reload',
    description:
      'Reload/reopen the current local project from its persisted JSON. Dirty in-memory changes are never discarded unless explicitly requested. Returns the persisted hash to verify after the renderer reload.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...persistenceGuardProperties,
        expectedPersistedHash:
          persistedVerificationProperties.expectedPersistedHash,
        discardUnsavedChanges: { type: 'boolean' },
      },
    },
    metadata: makeCommandMetadata({
      readOnly: false,
      destructive: true,
      idempotent: false,
      requiresProject: true,
      modifiesProject: true,
    }),
    validateInput: input => {
      assertPersistenceGuards(input);
      assertOptionalBoolean(
        input.discardUnsavedChanges,
        'invalid_discard_unsaved_changes'
      );
    },
    execute: ({ input, requestContext }) =>
      projectLifecycleService.reload(input, requestContext),
  },
];
