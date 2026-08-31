// @flow
import * as checkpointTools from '../../AgentApi/CheckpointTools';
import { createSafetyService } from './SafetyService';

jest.mock('../../AgentApi/CheckpointTools', () => ({
  beginTransaction: jest.fn(),
  commitTransaction: jest.fn(),
  completeTransactionRollback: jest.fn(),
  createCheckpoint: jest.fn(),
  deleteCheckpoint: jest.fn(),
  diffCheckpointToProject: jest.fn(),
  getCheckpoint: jest.fn(),
  getTransactionStatus: jest.fn(),
  listCheckpoints: jest.fn(),
  prepareTransactionRollback: jest.fn(),
}));

const makeProject = () => ({ getProjectUuid: () => 'project-uuid' });

const makeService = (overrides: any = {}) => {
  const project =
    overrides.project === undefined ? makeProject() : overrides.project;
  const restoreProjectCheckpoint = jest.fn(async checkpoint => ({
    restored: true,
    checkpointId: checkpoint.id,
  }));
  return {
    project,
    restoreProjectCheckpoint,
    service: createSafetyService({
      project,
      fileIdentifier: 'C:/game.json',
      hasUnsavedChanges: true,
      restoreProjectCheckpoint,
      ...overrides,
    }),
  };
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('SafetyService', () => {
  test('creates checkpoints with file and dirty-state context', () => {
    checkpointTools.createCheckpoint.mockReturnValue({ id: 'cp-1' });
    const { service, project } = makeService();
    expect(service.createCheckpoint({ label: 'before edit' })).toEqual({
      created: true,
      checkpoint: { id: 'cp-1' },
    });
    expect(checkpointTools.createCheckpoint).toHaveBeenCalledWith({
      project,
      fileIdentifier: 'C:/game.json',
      label: 'before edit',
      hadUnsavedChanges: true,
    });
  });

  test('blocks restoring a different checkpoint during a transaction', async () => {
    checkpointTools.getTransactionStatus.mockReturnValue({
      active: true,
      checkpoint: { id: 'transaction-cp' },
    });
    const { service } = makeService();
    await expect(
      service.restoreCheckpoint({ checkpointId: 'other-cp' })
    ).rejects.toMatchObject({
      code: 'cannot_restore_other_checkpoint_during_transaction',
    });
  });

  test('restores a checkpoint together with its diff', async () => {
    checkpointTools.getTransactionStatus.mockReturnValue({ active: false });
    checkpointTools.getCheckpoint.mockReturnValue({ id: 'cp-1' });
    checkpointTools.diffCheckpointToProject.mockReturnValue({ changed: true });
    const { service, restoreProjectCheckpoint } = makeService();
    await expect(
      service.restoreCheckpoint({ checkpointId: 'cp-1' })
    ).resolves.toEqual({
      restored: true,
      checkpointId: 'cp-1',
      diff: { changed: true },
    });
    expect(restoreProjectCheckpoint).toHaveBeenCalledWith({ id: 'cp-1' });
  });

  test('rolls back and only completes transaction state after restore', async () => {
    checkpointTools.prepareTransactionRollback.mockReturnValue({
      checkpoint: { id: 'tx-cp' },
      diff: { changed: true },
    });
    const { service, restoreProjectCheckpoint } = makeService();
    const result = await service.rollbackTransaction();
    expect(restoreProjectCheckpoint).toHaveBeenCalledWith({ id: 'tx-cp' });
    expect(checkpointTools.completeTransactionRollback).toHaveBeenCalledWith(
      'project-uuid',
      'tx-cp'
    );
    expect(result).toMatchObject({
      rolledBack: true,
      checkpointId: 'tx-cp',
      diff: { changed: true },
    });
  });

  test('requires a live project for safety operations', () => {
    const { service } = makeService({ project: null });
    expect(() => service.listCheckpoints()).toThrow(
      expect.objectContaining({ code: 'no_project_open' })
    );
  });
});
