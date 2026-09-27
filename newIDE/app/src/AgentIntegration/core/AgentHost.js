// @flow
import {
  AgentError,
  AGENT_ERROR_CODES,
  normalizeAgentError,
} from './AgentError';
import { CommandRegistry, type CommandDescriptor } from './CommandRegistry';
import { IdempotencyStore } from './IdempotencyStore';

export type CommandResult = {|
  command: string,
  data: any,
  meta: {|
    traceId: ?string,
    readOnly: boolean,
    modifiesProject: boolean,
    projectRevision: ?number,
    semanticRevisions?: Array<any>,
    identity?: any,
    targetIdentity?: any,
    durationMs: number,
    idempotencyReplayed: boolean,
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
      code: AGENT_ERROR_CODES.INVALID_COMMAND_INPUT,
      message: 'Command input must be an object.',
    });
  }
  return input;
};

export const resolveSemanticScopes = (
  descriptor: CommandDescriptor,
  input: { [string]: any }
): Array<string> => {
  const scopes = new Set();
  if (descriptor.metadata.modifiesProject) scopes.add('project');
  if (Array.isArray(descriptor.metadata.semanticScopes)) {
    descriptor.metadata.semanticScopes.forEach(scope => scopes.add(scope));
  }
  const sceneName =
    (typeof input.sceneName === 'string' && input.sceneName.trim()) ||
    (typeof input.scene_name === 'string' && input.scene_name.trim()) ||
    null;
  if (sceneName) {
    scopes.add(`scene:${sceneName}`);
    if (descriptor.name.startsWith('events.')) {
      scopes.add(`events:${sceneName}`);
    }
  }
  if (
    descriptor.name.startsWith('resources.') ||
    descriptor.name.startsWith('assets.')
  ) {
    scopes.add('resources');
    const resourceName =
      (typeof input.resourceName === 'string' && input.resourceName.trim()) ||
      (typeof input.resource_name === 'string' && input.resource_name.trim()) ||
      null;
    if (resourceName) scopes.add(`resource:${resourceName}`);
  }
  return Array.from(scopes).sort();
};

const getProjectConflictContext = (environment: any) => {
  const project = environment.project || null;
  return {
    projectUuid:
      project && typeof project.getProjectUuid === 'function'
        ? project.getProjectUuid()
        : null,
    projectName:
      project && typeof project.getName === 'function'
        ? project.getName()
        : null,
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
    const startedAt = Date.now();
    const descriptor = this.registry.get(name);
    const normalizedInput = normalizeInput(input);
    const modifiesProject =
      descriptor.metadata.modifiesProject &&
      (typeof descriptor.modifiesProjectWhen !== 'function' ||
        descriptor.modifiesProjectWhen(normalizedInput));
    const environment = this._environment || {};
    const revisionTracker = environment.projectRevisionTracker || null;
    const semanticConcurrency = environment.semanticConcurrency || null;
    const semanticScopes = resolveSemanticScopes(descriptor, normalizedInput);
    const requestIdentity =
      requestContext.identity && typeof requestContext.identity === 'object'
        ? requestContext.identity
        : null;
    const identityOwner =
      requestIdentity &&
      typeof requestIdentity.ownerKey === 'string' &&
      requestIdentity.ownerKey
        ? requestIdentity.ownerKey
        : null;
    if (
      identityOwner &&
      typeof requestContext.semanticLeaseOwner === 'string' &&
      requestContext.semanticLeaseOwner &&
      requestContext.semanticLeaseOwner !== identityOwner
    ) {
      throw new AgentError({
        code: 'semantic_lease_owner_identity_mismatch',
        details: {
          suppliedOwner: requestContext.semanticLeaseOwner,
          identityOwner,
        },
      });
    }
    const semanticLeaseOwner =
      identityOwner || requestContext.semanticLeaseOwner || null;
    const readCurrentRevision = () =>
      revisionTracker ? revisionTracker.synchronize() : null;

    const executeOnce = async () => {
      const currentRevision = readCurrentRevision();

      if (descriptor.metadata.requiresProject && !environment.project) {
        throw new AgentError({
          code: AGENT_ERROR_CODES.NO_PROJECT_OPEN,
          message: 'This command requires an open GDevelop project.',
          hint: 'Open or create a project and retry the command.',
          traceId:
            typeof requestContext.traceId === 'string'
              ? requestContext.traceId
              : undefined,
        });
      }

      if (
        modifiesProject &&
        environment.project &&
        typeof environment.getTransactionStatus === 'function'
      ) {
        const transaction = environment.getTransactionStatus();
        const transactionOwner =
          transaction &&
          transaction.active &&
          transaction.owner &&
          typeof transaction.owner.ownerKey === 'string'
            ? transaction.owner.ownerKey
            : null;
        if (transactionOwner && transactionOwner !== identityOwner) {
          throw new AgentError({
            code: 'transaction_scope_locked',
            retryable: true,
            hint:
              'Wait for the owning transaction to commit/rollback, or coordinate with its owner before retrying.',
            details: {
              conflictScope: 'project',
              transactionId: transaction.transactionId,
              owner: transaction.owner,
              purpose: transaction.purpose || null,
              startedAt: transaction.startedAt || null,
              callerIdentity: requestIdentity,
            },
          });
        }
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
          code: AGENT_ERROR_CODES.REVISION_CONFLICT,
          message: 'The open project changed since it was last read.',
          retryable: true,
          hint: 'Read the project again and retry with the current revision.',
          currentRevision,
          details: {
            conflictScope: 'project',
            expectedRevision,
            actualRevision: currentRevision,
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
        if (modifiesProject && semanticConcurrency) {
          semanticConcurrency.assertExpected(
            requestContext.expectedSemanticRevisions
          );
          semanticConcurrency.assertLeaseAccess(
            semanticScopes,
            semanticLeaseOwner
          );
        }
        if (descriptor.validateInput) descriptor.validateInput(normalizedInput);
        const data = await descriptor.execute({
          environment,
          input: normalizedInput,
          requestContext,
          registry: this.registry,
        });
        const projectRevision = modifiesProject
          ? revisionTracker
            ? revisionTracker.markMutation({
                command: descriptor.name,
                identity: requestIdentity,
                semanticScopes,
              })
            : null
          : readCurrentRevision();
        const semanticRevisions =
          modifiesProject && semanticConcurrency
            ? semanticConcurrency.mark(semanticScopes)
            : semanticConcurrency
            ? semanticConcurrency.snapshot(semanticScopes)
            : [];
        return { data, projectRevision, semanticRevisions };
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

    let idempotencyReplayed = false;
    const idempotencyKey =
      modifiesProject &&
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
          onReuse: () => {
            idempotencyReplayed = true;
          },
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
        modifiesProject,
        projectRevision: execution.projectRevision,
        ...(execution.semanticRevisions && execution.semanticRevisions.length
          ? { semanticRevisions: execution.semanticRevisions }
          : {}),
        ...(requestIdentity ? { identity: requestIdentity } : {}),
        ...(typeof environment.getTargetIdentity === 'function'
          ? { targetIdentity: environment.getTargetIdentity() }
          : {}),
        durationMs: Math.max(0, Date.now() - startedAt),
        idempotencyReplayed,
      },
    };
  }
}
