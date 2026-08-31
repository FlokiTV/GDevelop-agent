// @flow
import { AgentHost } from '../core/AgentHost';
import { createSafetyCommandDescriptors } from './SafetyCommands';

const makeHost = (project: any = {}) => {
  const safetyService = {
    createCheckpoint: jest.fn(input => ({ created: true, input })),
    listCheckpoints: jest.fn(() => ({ checkpoints: [] })),
    diffCheckpoint: jest.fn(input => ({ diff: true, input })),
    deleteCheckpoint: jest.fn(input => ({ deleted: true, input })),
    restoreCheckpoint: jest.fn(async input => ({ restored: true, input })),
    getTransactionStatus: jest.fn(() => ({ active: false })),
    beginTransaction: jest.fn(input => ({ begun: true, input })),
    commitTransaction: jest.fn(() => ({ committed: true })),
    rollbackTransaction: jest.fn(async () => ({ rolledBack: true })),
  };
  return {
    safetyService,
    host: new AgentHost({
      environment: { project },
      descriptors: createSafetyCommandDescriptors({ safetyService }),
    }),
  };
};

describe('SafetyCommands', () => {
  test('marks restore and rollback as destructive project mutations', () => {
    const { host } = makeHost();
    expect(host.describeCommand('safety.checkpoints.restore').metadata).toMatchObject({
      destructive: true,
      modifiesProject: true,
      requiresProject: true,
    });
    expect(host.describeCommand('safety.transactions.rollback').metadata).toMatchObject({
      destructive: true,
      modifiesProject: true,
    });
  });

  test('routes checkpoint operations through the safety service', async () => {
    const { host, safetyService } = makeHost();
    await host.execute('safety.checkpoints.create', { label: 'before' });
    await host.execute('safety.checkpoints.diff', { checkpointId: 'cp-1' });
    await host.execute('safety.checkpoints.delete', { checkpointId: 'cp-1' });
    expect(safetyService.createCheckpoint).toHaveBeenCalledWith({ label: 'before' });
    expect(safetyService.diffCheckpoint).toHaveBeenCalledWith({
      checkpointId: 'cp-1',
    });
    expect(safetyService.deleteCheckpoint).toHaveBeenCalledWith({
      checkpointId: 'cp-1',
    });
  });

  test('routes transaction begin/commit/rollback through the service', async () => {
    const { host, safetyService } = makeHost();
    await host.execute('safety.transactions.begin', { label: 'tx' });
    await host.execute('safety.transactions.commit', {});
    await host.execute('safety.transactions.rollback', {});
    expect(safetyService.beginTransaction).toHaveBeenCalledWith({ label: 'tx' });
    expect(safetyService.commitTransaction).toHaveBeenCalledTimes(1);
    expect(safetyService.rollbackTransaction).toHaveBeenCalledTimes(1);
  });

  test('requires checkpoint ids and an open project', async () => {
    const { host, safetyService } = makeHost();
    await expect(
      host.execute('safety.checkpoints.restore', {})
    ).rejects.toMatchObject({ code: 'missing_checkpoint_id' });
    expect(safetyService.restoreCheckpoint).not.toHaveBeenCalled();

    const projectless = makeHost(null);
    await expect(
      projectless.host.execute('safety.transactions.status', {})
    ).rejects.toMatchObject({ code: 'no_project_open' });
  });
});
