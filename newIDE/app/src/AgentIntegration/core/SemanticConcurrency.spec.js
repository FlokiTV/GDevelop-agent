// @flow
import { SemanticConcurrency } from './SemanticConcurrency';

describe('SemanticConcurrency', () => {
  test('tracks independent monotonic revisions by semantic scope', () => {
    const concurrency = new SemanticConcurrency();
    expect(concurrency.snapshot(['scene:Game', 'resources'])).toEqual([
      { scope: 'resources', revision: 0 },
      { scope: 'scene:Game', revision: 0 },
    ]);
    concurrency.mark(['scene:Game']);
    expect(concurrency.getRevision('scene:Game')).toBe(1);
    expect(concurrency.getRevision('resources')).toBe(0);
    expect(() => concurrency.assertExpected({ 'scene:Game': 0 })).toThrow(
      /changed since it was last read/
    );
    expect(() => concurrency.assertExpected({ resources: 0 })).not.toThrow();
  });

  test('leases are bounded, owner-aware and release explicitly', () => {
    const concurrency = new SemanticConcurrency();
    const lease = concurrency.acquireLease({
      scope: 'scene:Game',
      owner: 'client-a',
      ttlMs: 5000,
    });
    expect(concurrency.listLeases()).toHaveLength(1);
    expect(() =>
      concurrency.assertLeaseAccess(['scene:Game'], 'client-b')
    ).toThrow();
    expect(() =>
      concurrency.assertLeaseAccess(['scene:Game'], 'client-a')
    ).not.toThrow();
    expect(
      concurrency.releaseLease({
        scope: 'scene:Game',
        owner: 'client-a',
        leaseId: lease.leaseId,
      })
    ).toBe(true);
    expect(concurrency.listLeases()).toEqual([]);
  });
});
