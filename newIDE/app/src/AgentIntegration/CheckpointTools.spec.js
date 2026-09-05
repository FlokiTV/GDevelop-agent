// @flow
import {
  __resetCheckpointStoresForTests,
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
} from './CheckpointTools';

const gd: libGDevelop = global.gd;

const createProject = () => {
  const project = gd.ProjectHelper.createNewGDJSProject();
  project.resetProjectUuid();
  project.setName('Checkpoint Test');
  project.insertNewLayout('Level1', 0);
  return project;
};

describe('AgentApi CheckpointTools', () => {
  beforeEach(() => {
    __resetCheckpointStoresForTests();
  });

  it('creates, lists and deletes checkpoints without exposing snapshots', () => {
    const project = createProject();
    const created = createCheckpoint({
      project,
      fileIdentifier: 'C:\\games\\test.json',
      label: 'before edit',
      hadUnsavedChanges: true,
    });

    expect(created.label).toBe('before edit');
    expect(created.hadUnsavedChanges).toBe(true);
    expect(created.byteSize).toBeGreaterThan(0);

    const list = listCheckpoints(project);
    expect(list.checkpoints).toHaveLength(1);
    expect(list.checkpoints[0].id).toBe(created.id);
    expect(list.checkpoints[0].snapshot).toBeUndefined();

    const removed = deleteCheckpoint(project, created.id);
    expect(removed.id).toBe(created.id);
    expect(listCheckpoints(project).checkpoints).toHaveLength(0);
    project.delete();
  });

  it('produces a structural diff against the current project', () => {
    const project = createProject();
    const checkpoint = createCheckpoint({
      project,
      fileIdentifier: null,
      hadUnsavedChanges: false,
    });

    project.setName('Changed Name');
    project.insertNewLayout('Level2', 1);

    const diff = diffCheckpointToProject(project, checkpoint.id);
    expect(diff.changed).toBe(true);
    expect(diff.changedTopLevelKeys).toContain('properties');
    expect(diff.scenes.added).toContain('Level2');
    expect(diff.scenes.beforeCount).toBe(1);
    expect(diff.scenes.afterCount).toBe(2);
    project.delete();
  });

  it('keeps the active transaction checkpoint and computes commit diff', () => {
    const project = createProject();
    const transaction = beginTransaction({
      project,
      fileIdentifier: null,
      label: 'agent edit',
      hadUnsavedChanges: false,
    });
    expect(getTransactionStatus(project).active).toBe(true);

    project.insertNewLayout('AddedDuringTransaction', 1);
    const committed = commitTransaction(project);
    expect(committed.committed).toBe(true);
    expect(committed.checkpoint.id).toBe(transaction.id);
    expect(committed.diff.scenes.added).toContain('AddedDuringTransaction');
    expect(getTransactionStatus(project).active).toBe(false);
    project.delete();
  });

  it('prepares rollback without clearing transaction until restore succeeds', () => {
    const project = createProject();
    const transaction = beginTransaction({
      project,
      fileIdentifier: null,
      hadUnsavedChanges: true,
    });
    project.setName('Broken Edit');

    const prepared = prepareTransactionRollback(project);
    expect(prepared.checkpoint.id).toBe(transaction.id);
    expect(prepared.diff.changed).toBe(true);
    expect(getTransactionStatus(project).active).toBe(true);

    completeTransactionRollback(project.getProjectUuid(), transaction.id);
    expect(getTransactionStatus(project).active).toBe(false);
    project.delete();
  });

  it('stores snapshots that can recreate a project with native unserialization', () => {
    const project = createProject();
    project.insertNewLayout('SecondScene', 1);
    const checkpointSummary = createCheckpoint({
      project,
      fileIdentifier: null,
      hadUnsavedChanges: false,
    });
    const checkpoint = getCheckpoint(project, checkpointSummary.id);

    const serialized = gd.Serializer.fromJSObject(checkpoint.snapshot);
    const restoredProject = gd.ProjectHelper.createNewGDJSProject();
    try {
      restoredProject.unserializeFrom(serialized);
    } finally {
      serialized.delete();
    }

    expect(restoredProject.getName()).toBe('Checkpoint Test');
    expect(restoredProject.hasLayoutNamed('Level1')).toBe(true);
    expect(restoredProject.hasLayoutNamed('SecondScene')).toBe(true);
    project.delete();
    restoredProject.delete();
  });

  it('evicts the oldest non-transaction checkpoint when count is limited', () => {
    const project = createProject();
    const first = createCheckpoint({
      project,
      fileIdentifier: null,
      label: 'first',
      hadUnsavedChanges: false,
      maxCheckpoints: 2,
    });
    const second = createCheckpoint({
      project,
      fileIdentifier: null,
      label: 'second',
      hadUnsavedChanges: false,
      maxCheckpoints: 2,
    });
    const third = createCheckpoint({
      project,
      fileIdentifier: null,
      label: 'third',
      hadUnsavedChanges: false,
      maxCheckpoints: 2,
    });

    const ids = listCheckpoints(project).checkpoints.map(({ id }) => id);
    expect(ids).not.toContain(first.id);
    expect(ids).toContain(second.id);
    expect(ids).toContain(third.id);
    project.delete();
  });
});
