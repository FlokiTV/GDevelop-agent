// @flow
import { AgentError } from '../core/AgentError';
import {
  beginTransaction,
  commitTransaction,
  completeTransactionRollback,
  createCheckpoint,
  deleteCheckpoint,
  diffCheckpointToProject,
  getCheckpoint,
  getTransactionStatus,
  listCheckpoints,
  prepareTransactionRollback,
} from '../CheckpointTools';

type Options = {|
  project: ?gdProject,
  fileIdentifier: ?string,
  hasUnsavedChanges: boolean,
  restoreProjectCheckpoint: (checkpoint: any) => Promise<any>,
|};

const requireProject = (project: ?gdProject): gdProject => {
  if (!project) throw new AgentError({ code: 'no_project_open' });
  return project;
};

const requireCheckpointId = (checkpointId: any): string => {
  if (!checkpointId || typeof checkpointId !== 'string') {
    throw new AgentError({ code: 'missing_checkpoint_id' });
  }
  return checkpointId;
};

const requireTransactionId = (transactionId: any): string => {
  if (!transactionId || typeof transactionId !== 'string') {
    throw new AgentError({ code: 'missing_transaction_id' });
  }
  return transactionId;
};

const getRequestIdentity = requestContext =>
  requestContext &&
  requestContext.identity &&
  typeof requestContext.identity === 'object'
    ? requestContext.identity
    : null;

const assertTransactionHandle = (
  project: gdProject,
  transactionId: string,
  requestContext?: any
) => {
  const status = getTransactionStatus(project);
  if (!status.active || !status.transactionId) {
    throw new AgentError({ code: 'no_active_transaction' });
  }
  if (status.transactionId !== transactionId) {
    throw new AgentError({
      code: 'transaction_handle_mismatch',
      details: {
        transactionId,
        activeTransactionId: status.transactionId,
      },
    });
  }
  const callerIdentity = getRequestIdentity(requestContext);
  const activeOwner = status.owner;
  if (
    activeOwner &&
    typeof activeOwner.ownerKey === 'string' &&
    activeOwner.ownerKey &&
    (!callerIdentity || callerIdentity.ownerKey !== activeOwner.ownerKey)
  ) {
    throw new AgentError({
      code: 'transaction_owner_mismatch',
      retryable: false,
      details: {
        transactionId,
        owner: activeOwner,
        callerIdentity,
        purpose: status.purpose || null,
        startedAt: status.startedAt || null,
      },
    });
  }
};

export const createSafetyService = ({
  project,
  fileIdentifier,
  hasUnsavedChanges,
  restoreProjectCheckpoint,
}: Options) => ({
  createCheckpoint: ({ label }: any = {}) => {
    const currentProject = requireProject(project);
    const checkpoint = createCheckpoint({
      project: currentProject,
      fileIdentifier: fileIdentifier || null,
      label: typeof label === 'string' && label ? label : null,
      hadUnsavedChanges: hasUnsavedChanges,
    });
    return { created: true, checkpoint };
  },

  listCheckpoints: () => listCheckpoints(requireProject(project)),

  diffCheckpoint: ({ checkpointId }: any) => {
    const currentProject = requireProject(project);
    const id = requireCheckpointId(checkpointId);
    return {
      checkpointId: id,
      diff: diffCheckpointToProject(currentProject, id),
    };
  },

  deleteCheckpoint: ({ checkpointId }: any) => {
    const currentProject = requireProject(project);
    const id = requireCheckpointId(checkpointId);
    return {
      deleted: true,
      checkpoint: deleteCheckpoint(currentProject, id),
    };
  },

  restoreCheckpoint: async ({ checkpointId }: any) => {
    const currentProject = requireProject(project);
    const id = requireCheckpointId(checkpointId);
    const transaction = getTransactionStatus(currentProject);
    if (
      transaction.active &&
      transaction.checkpoint &&
      transaction.checkpoint.id !== id
    ) {
      throw new AgentError({
        code: 'cannot_restore_other_checkpoint_during_transaction',
      });
    }
    const checkpoint = getCheckpoint(currentProject, id);
    const diff = diffCheckpointToProject(currentProject, id);
    const restored = await restoreProjectCheckpoint(checkpoint);
    return { ...restored, diff };
  },

  getTransactionStatus: (requestContext?: any) => ({
    ...getTransactionStatus(requireProject(project)),
    callerIdentity: getRequestIdentity(requestContext),
  }),

  beginTransaction: ({ label }: any = {}, requestContext?: any) => {
    const currentProject = requireProject(project);
    const checkpoint = beginTransaction({
      project: currentProject,
      fileIdentifier: fileIdentifier || null,
      label: typeof label === 'string' && label ? label : null,
      hadUnsavedChanges: hasUnsavedChanges,
      owner: getRequestIdentity(requestContext),
      purpose: typeof label === 'string' && label ? label : null,
    });
    return {
      begun: true,
      transactionId: checkpoint.transactionId,
      checkpoint,
    };
  },

  commitTransaction: ({ transactionId }: any = {}, requestContext?: any) => {
    const currentProject = requireProject(project);
    const id = requireTransactionId(transactionId);
    assertTransactionHandle(currentProject, id, requestContext);
    return commitTransaction(currentProject, id);
  },

  rollbackTransaction: async (
    { transactionId }: any = {},
    requestContext?: any
  ) => {
    const currentProject = requireProject(project);
    const id = requireTransactionId(transactionId);
    assertTransactionHandle(currentProject, id, requestContext);
    const projectUuid = currentProject.getProjectUuid();
    const { checkpoint, diff } = prepareTransactionRollback(currentProject, id);
    if (!diff.changed) {
      completeTransactionRollback(projectUuid, checkpoint.id);
      return {
        rolledBack: true,
        transactionId: id,
        restored: false,
        checkpointId: checkpoint.id,
        diff,
        restoreStrategy: 'no-op-no-changes',
      };
    }

    const restored = await restoreProjectCheckpoint(checkpoint);
    completeTransactionRollback(projectUuid, checkpoint.id);
    return { rolledBack: true, transactionId: id, ...restored, diff };
  },
});
