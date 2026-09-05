// @flow
import { IdempotencyStore, fingerprintInput } from './IdempotencyStore';

describe('IdempotencyStore', () => {
  it('uses a stable fingerprint for object key order', () => {
    expect(fingerprintInput({ b: 2, a: { d: 4, c: 3 } })).toBe(
      fingerprintInput({ a: { c: 3, d: 4 }, b: 2 })
    );
  });

  it('deduplicates concurrent retries and reuses the completed result', async () => {
    const store = new IdempotencyStore();
    let resolveExecution;
    const execute = jest.fn(
      () =>
        new Promise(resolve => {
          resolveExecution = resolve;
        })
    );

    const first = store.execute({
      command: 'events.patch',
      key: 'retry-1',
      input: { sceneName: 'Game' },
      execute,
    });
    const second = store.execute({
      command: 'events.patch',
      key: 'retry-1',
      input: { sceneName: 'Game' },
      execute,
    });

    await Promise.resolve();
    expect(execute).toHaveBeenCalledTimes(1);
    resolveExecution({ ok: true });
    await expect(first).resolves.toEqual({ ok: true });
    await expect(second).resolves.toEqual({ ok: true });

    await expect(
      store.execute({
        command: 'events.patch',
        key: 'retry-1',
        input: { sceneName: 'Game' },
        execute,
      })
    ).resolves.toEqual({ ok: true });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('rejects key reuse with different input and allows retry after failure', async () => {
    const store = new IdempotencyStore();
    const execute = jest
      .fn()
      .mockRejectedValueOnce(new Error('temporary_failure'))
      .mockResolvedValueOnce({ ok: true });

    await expect(
      store.execute({
        command: 'scene.create',
        key: 'retry-2',
        input: { name: 'A' },
        currentRevision: 4,
        execute,
      })
    ).rejects.toThrow('temporary_failure');

    await expect(
      store.execute({
        command: 'scene.create',
        key: 'retry-2',
        input: { name: 'A' },
        currentRevision: 4,
        execute,
      })
    ).resolves.toEqual({ ok: true });

    await expect(
      store.execute({
        command: 'scene.create',
        key: 'retry-2',
        input: { name: 'B' },
        currentRevision: 5,
        execute,
      })
    ).rejects.toMatchObject({
      code: 'idempotency_conflict',
      currentRevision: 5,
      details: {
        command: 'scene.create',
        idempotencyKey: 'retry-2',
      },
    });
  });
});
