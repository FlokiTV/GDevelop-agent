// @flow
import { serializeToJSObject } from '../Utils/Serializer';

const DEFAULT_MAX_CHECKPOINTS = 10;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

let sequence = 0;

export type ProjectCheckpoint = {|
  id: string,
  label: string | null,
  createdAt: number,
  projectUuid: string,
  projectName: string,
  fileIdentifier: string | null,
  hadUnsavedChanges: boolean,
  byteSize: number,
  snapshot: Object,
|};

type ProjectCheckpointStore = {|
  checkpoints: Array<ProjectCheckpoint>,
  activeTransactionId: string | null,
|};

type CheckpointSummary = {|
  id: string,
  label: string | null,
  createdAt: number,
  projectUuid: string,
  projectName: string,
  fileIdentifier: string | null,
  hadUnsavedChanges: boolean,
  byteSize: number,
  activeTransaction: boolean,
|};

const storesByProjectUuid: Map<string, ProjectCheckpointStore> = new Map();

const getProjectKey = (project: gdProject): string => {
  const uuid = project.getProjectUuid();
  if (!uuid) throw new Error('project_uuid_missing');
  return uuid;
};

const getStore = (project: gdProject): ProjectCheckpointStore => {
  const key = getProjectKey(project);
  let store = storesByProjectUuid.get(key);
  if (!store) {
    store = { checkpoints: [], activeTransactionId: null };
    storesByProjectUuid.set(key, store);
  }
  return store;
};

const makeId = (): string => {
  sequence += 1;
  return `checkpoint-${Date.now()}-${sequence}`;
};

const serializeProject = (project: gdProject): Object =>
  serializeToJSObject(project, 'serializeTo', {
    canonicalEventSerialization: true,
  });

const estimateByteSize = (snapshot: Object): number =>
  // UTF-8 JSON is a close approximation of the memory pressure we care about,
  // while keeping the stored value as an object ready for gd.Serializer.
  unescape(encodeURIComponent(JSON.stringify(snapshot))).length;

const getCheckpointSummary = (
  checkpoint: ProjectCheckpoint,
  activeTransactionId: string | null
): CheckpointSummary => ({
  id: checkpoint.id,
  label: checkpoint.label,
  createdAt: checkpoint.createdAt,
  projectUuid: checkpoint.projectUuid,
  projectName: checkpoint.projectName,
  fileIdentifier: checkpoint.fileIdentifier,
  hadUnsavedChanges: checkpoint.hadUnsavedChanges,
  byteSize: checkpoint.byteSize,
  activeTransaction: checkpoint.id === activeTransactionId,
});

const enforceLimits = (
  store: ProjectCheckpointStore,
  maxCheckpoints: number,
  maxBytes: number
) => {
  const getTotalBytes = () =>
    store.checkpoints.reduce(
      (total, checkpoint) => total + checkpoint.byteSize,
      0
    );

  while (
    store.checkpoints.length > maxCheckpoints ||
    getTotalBytes() > maxBytes
  ) {
    const removableIndex = store.checkpoints.findIndex(
      checkpoint => checkpoint.id !== store.activeTransactionId
    );
    if (removableIndex === -1) {
      throw new Error('checkpoint_limits_exceeded_by_active_transaction');
    }
    store.checkpoints.splice(removableIndex, 1);
  }
};

export const createCheckpoint = ({
  project,
  fileIdentifier,
  label,
  hadUnsavedChanges,
  maxCheckpoints = DEFAULT_MAX_CHECKPOINTS,
  maxBytes = DEFAULT_MAX_BYTES,
}: {|
  project: gdProject,
  fileIdentifier: string | null,
  label?: string | null,
  hadUnsavedChanges: boolean,
  maxCheckpoints?: number,
  maxBytes?: number,
|}): CheckpointSummary => {
  const store = getStore(project);
  const snapshot = serializeProject(project);
  const checkpoint: ProjectCheckpoint = {
    id: makeId(),
    label: label || null,
    createdAt: Date.now(),
    projectUuid: getProjectKey(project),
    projectName: project.getName(),
    fileIdentifier,
    hadUnsavedChanges,
    byteSize: estimateByteSize(snapshot),
    snapshot,
  };
  store.checkpoints.push(checkpoint);
  enforceLimits(store, maxCheckpoints, maxBytes);
  return getCheckpointSummary(checkpoint, store.activeTransactionId);
};

export const listCheckpoints = (project: gdProject) => {
  const store = getStore(project);
  return {
    activeTransactionId: store.activeTransactionId,
    totalBytes: store.checkpoints.reduce(
      (total, checkpoint) => total + checkpoint.byteSize,
      0
    ),
    maxCheckpoints: DEFAULT_MAX_CHECKPOINTS,
    maxBytes: DEFAULT_MAX_BYTES,
    checkpoints: store.checkpoints.map(checkpoint =>
      getCheckpointSummary(checkpoint, store.activeTransactionId)
    ),
  };
};

export const getCheckpoint = (
  project: gdProject,
  checkpointId: string
): ProjectCheckpoint => {
  const store = getStore(project);
  const checkpoint = store.checkpoints.find(({ id }) => id === checkpointId);
  if (!checkpoint) throw new Error(`checkpoint_not_found:${checkpointId}`);
  return checkpoint;
};

export const deleteCheckpoint = (
  project: gdProject,
  checkpointId: string
): CheckpointSummary => {
  const store = getStore(project);
  if (store.activeTransactionId === checkpointId) {
    throw new Error('cannot_delete_active_transaction_checkpoint');
  }
  const index = store.checkpoints.findIndex(({ id }) => id === checkpointId);
  if (index === -1) throw new Error(`checkpoint_not_found:${checkpointId}`);
  const [checkpoint] = store.checkpoints.splice(index, 1);
  return getCheckpointSummary(checkpoint, store.activeTransactionId);
};

const getNamedItems = (
  snapshot: Object,
  path: Array<string>
): Map<string, any> => {
  let value: any = snapshot;
  for (const part of path) {
    if (!value || typeof value !== 'object') return new Map();
    value = value[part];
  }
  if (!Array.isArray(value)) return new Map();
  const entries = value
    .map((item, index) => {
      if (!item || typeof item !== 'object') return null;
      const name =
        (typeof item.name === 'string' && item.name) ||
        (typeof item.id === 'string' && item.id) ||
        (typeof item.identifier === 'string' && item.identifier) ||
        `#${index}`;
      return [name, item];
    })
    .filter(Boolean);
  // $FlowFixMe[incompatible-call]
  return new Map(entries);
};

const stableValue = (value: any): string => JSON.stringify(value);

const diffNamedCollection = (
  before: Object,
  after: Object,
  path: Array<string>
) => {
  const beforeItems = getNamedItems(before, path);
  const afterItems = getNamedItems(after, path);
  const added = Array.from(afterItems.keys()).filter(
    name => !beforeItems.has(name)
  );
  const removed = Array.from(beforeItems.keys()).filter(
    name => !afterItems.has(name)
  );
  const changed = Array.from(afterItems.keys()).filter(
    name =>
      beforeItems.has(name) &&
      stableValue(beforeItems.get(name)) !== stableValue(afterItems.get(name))
  );
  return {
    beforeCount: beforeItems.size,
    afterCount: afterItems.size,
    added,
    removed,
    changed,
  };
};

export const diffSnapshots = (before: Object, after: Object) => {
  const allTopLevelKeys = Array.from(
    new Set([...Object.keys(before || {}), ...Object.keys(after || {})])
  ).sort();
  const changedTopLevelKeys = allTopLevelKeys.filter(
    key =>
      stableValue(before && before[key]) !== stableValue(after && after[key])
  );

  return {
    changed: changedTopLevelKeys.length > 0,
    changedTopLevelKeys,
    byteSizeBefore: estimateByteSize(before),
    byteSizeAfter: estimateByteSize(after),
    scenes: diffNamedCollection(before, after, ['layouts']),
    globalObjects: diffNamedCollection(before, after, ['objects']),
    resources: diffNamedCollection(before, after, ['resources', 'resources']),
    globalVariables: diffNamedCollection(before, after, ['variables']),
    externalEvents: diffNamedCollection(before, after, ['externalEvents']),
    externalLayouts: diffNamedCollection(before, after, ['externalLayouts']),
    gameplayTests: diffNamedCollection(before, after, ['tests']),
    extensions: diffNamedCollection(before, after, [
      'eventsFunctionsExtensions',
    ]),
  };
};

export const diffCheckpointToProject = (
  project: gdProject,
  checkpointId: string
) => {
  const checkpoint = getCheckpoint(project, checkpointId);
  return diffSnapshots(checkpoint.snapshot, serializeProject(project));
};

export const beginTransaction = ({
  project,
  fileIdentifier,
  label,
  hadUnsavedChanges,
}: {|
  project: gdProject,
  fileIdentifier: string | null,
  label?: string | null,
  hadUnsavedChanges: boolean,
|}) => {
  const store = getStore(project);
  if (store.activeTransactionId) {
    throw new Error(`transaction_already_active:${store.activeTransactionId}`);
  }
  const checkpoint = createCheckpoint({
    project,
    fileIdentifier,
    label: label || 'transaction-begin',
    hadUnsavedChanges,
  });
  store.activeTransactionId = checkpoint.id;
  return {
    ...checkpoint,
    transactionId: checkpoint.id,
    activeTransaction: true,
  };
};

export const getTransactionStatus = (project: gdProject) => {
  const store = getStore(project);
  if (!store.activeTransactionId) {
    return { active: false, transactionId: null, checkpoint: null };
  }
  const checkpoint = getCheckpoint(project, store.activeTransactionId);
  return {
    active: true,
    transactionId: store.activeTransactionId,
    checkpoint: getCheckpointSummary(checkpoint, store.activeTransactionId),
  };
};

const requireActiveTransaction = (
  project: gdProject,
  transactionId: string
): { store: ProjectCheckpointStore, checkpoint: ProjectCheckpoint } => {
  const store = getStore(project);
  if (!store.activeTransactionId) throw new Error('no_active_transaction');
  if (store.activeTransactionId !== transactionId) {
    throw new Error(`transaction_handle_mismatch:${store.activeTransactionId}`);
  }
  return {
    store,
    checkpoint: getCheckpoint(project, store.activeTransactionId),
  };
};

export const commitTransaction = (
  project: gdProject,
  transactionId: string
) => {
  const { store, checkpoint } = requireActiveTransaction(project, transactionId);
  const diff = diffSnapshots(checkpoint.snapshot, serializeProject(project));
  store.activeTransactionId = null;
  return {
    committed: true,
    transactionId,
    checkpoint: getCheckpointSummary(checkpoint, null),
    diff,
  };
};

export const prepareTransactionRollback = (
  project: gdProject,
  transactionId: string
) => {
  const { checkpoint } = requireActiveTransaction(project, transactionId);
  const diff = diffSnapshots(checkpoint.snapshot, serializeProject(project));
  return { transactionId, checkpoint, diff };
};

export const completeTransactionRollback = (
  projectUuid: string,
  checkpointId: string
) => {
  const store = storesByProjectUuid.get(projectUuid);
  if (!store || store.activeTransactionId !== checkpointId) {
    throw new Error('transaction_changed_during_rollback');
  }
  store.activeTransactionId = null;
};

export const clearProjectCheckpoints = (project: gdProject) => {
  storesByProjectUuid.delete(getProjectKey(project));
};

export const __resetCheckpointStoresForTests = () => {
  storesByProjectUuid.clear();
  sequence = 0;
};
