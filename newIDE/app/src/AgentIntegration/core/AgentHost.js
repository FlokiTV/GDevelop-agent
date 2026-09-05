// @flow
import { AgentError, normalizeAgentError } from './AgentError';
import {
  CommandRegistry,
  type CommandDescriptor,
} from './CommandRegistry';
import { IdempotencyStore } from './IdempotencyStore';

export type CommandResult = {|
  command: string,
  data: any,
  meta: {|
    traceId: ?string,
    readOnly: boolean,
    modifiesProject: boolean,
    projectRevision: ?number,
  |},
|};

type AgentHostOptions = {|
  environment?: any,
  descriptors?: Array<CommandDescriptor>,
  registry?: CommandRegistry,
  idempotencyStore?: IdempotencyStore,
|};

const normalizeInput = (input: any): { [string]: any } => {
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new AgentError({
      code: 'invalid_command_input',
      message: 'Command input must be an object.',
    });
  }
  return input;
};

const getProjectConflictContext = (environment: any) => {
  const project = environment.project || null;
  return {
    projectUuid:
      project && typeof project.getProjectUuid === 'function'
        ? project.getProjectUuid()
        : null,
    projectName:
      project && typeof project.getName === 'function' ? project.getName() : null,
    fileIdentifier: environment.fileIdentifier || null,
    hasUnsavedChanges: !!environment.hasUnsavedChanges,
  };
};

export class AgentHost {
  _environment: any;
  _idempotencyStore: IdempotencyStore;
  registry: CommandRegistry;

  constructor({
    environment = {},
    descriptors = [],
    registry,
    idempotencyStore,
  }: AgentHostOptions = {}) {
    this._environment = environment;
    this._idempotencyStore = idempotencyStore || new IdempotencyStore();
    this.registry = registry || new CommandRegistry(descriptors);
  }

  setEnvironment(environment: any) {
    this._environment = environment || {};
  }

  getEnvironment(): any {
    return this._environment;
  }

  register(descriptor: CommandDescriptor) {
    this.registry.register(descriptor);
    return this;
  }

  listCommands(options?: { query?: ?string }) {
    return this.registry.list(options);
  }

  describeCommand(name: string) {
    return this.registry.describe(name);
  }

  async execute(
    name: string,
    input?: any,
    requestContext?: { [string]: any } = {}
  ): Promise<CommandResult> {
    const descriptor = this.registry.get(name);
    const normalizedInput = normalizeInput(input);
    const environment = this._environment || {};
    const revisionTracker = environment.projectRevisionTracker || null;
    const readCurrentRevision = () =>
      revisionTracker ? revisionTracker.synchronize() : null;

    const executeOnce = async () => {
      const currentRevision = readCurrentRevision();

      if (descriptor.metadata.requiresProject && !environment.project) {
        throw new AgentError({
          code: 'no_project_open',
          message: 'This command requires an open GDevelop project.',
          hint: 'Open or create a project and retry the command.',
          traceId:
            typeof requestContext.traceId === 'string'
              ? requestContext.traceId
              : undefined,
        });
      }

      if (
        descriptor.metadata.modifiesProject &&
        requestContext.expectedRevision !== undefined &&
        requestContext.expectedRevision !== null &&
        requestContext.expectedRevision !== currentRevision
      ) {
        const expectedRevision = requestContext.expectedRevision;
        const lastChange =
          revisionTracker &&
          typeof revisionTracker.getLastChangeContext === 'function'
            ? revisionTracker.getLastChangeContext()
            : null;
        throw new AgentError({
          code: 'revision_conflict',
          message: 'The open project changed since it was last read.',
          retryable: true,
          hint: 'Read the project again and retry with the current revision.',
          currentRevision,
          details: {
            expectedRevision,
            currentRevision,
            revisionDelta:
              typeof currentRevision === 'number' &&
              typeof expectedRevision === 'number'
                ? Math.max(0, currentRevision - expectedRevision)
                : null,
            project: getProjectConflictContext(environment),
            ...(lastChange ? { lastChange } : {}),
          },
          traceId:
            typeof requestContext.traceId === 'string'
              ? requestContext.traceId
              : undefined,
        });
      }

      try {
        if (descriptor.validateInput) descriptor.validateInput(normalizedInput);
        const data = await descriptor.execute({
          environment,
          input: normalizedInput,
          requestContext,
          registry: this.registry,
        });
        const projectRevision = descriptor.metadata.modifiesProject
          ? revisionTracker
            ? revisionTracker.markMutation()
            : null
          : readCurrentRevision();
        return { data, projectRevision };
      } catch (error) {
        const normalizedError = normalizeAgentError(error);
        if (
          !normalizedError.traceId &&
          typeof requestContext.traceId === 'string'
        ) {
          normalizedError.traceId = requestContext.traceId;
        }
        throw normalizedError;
      }
    };

    const idempotencyKey =
      descriptor.metadata.modifiesProject &&
      typeof requestContext.idempotencyKey === 'string' &&
      requestContext.idempotencyKey
        ? requestContext.idempotencyKey
        : null;
    const execution = idempotencyKey
      ? await this._idempotencyStore.execute({
          command: descriptor.name,
          key: idempotencyKey,
          input: normalizedInput,
          currentRevision: readCurrentRevision(),
          execute: executeOnce,
        })
      : await executeOnce();

    return {
      command: descriptor.name,
      data: execution.data,
      meta: {
        traceId:
          typeof requestContext.traceId === 'string'
            ? requestContext.traceId
            : null,
        readOnly: descriptor.metadata.readOnly,
        modifiesProject: descriptor.metadata.modifiesProject,
        projectRevision: execution.projectRevision,
      },
    };
  }
}
