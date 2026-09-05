// @flow
import { ProjectRevisionTracker } from './ProjectRevisionTracker';

describe('ProjectRevisionTracker', () => {
  it('accumulates external native change deltas and stays monotonic across save resets', () => {
    let changesCount = 0;
    const tracker = new ProjectRevisionTracker({
      getChangesCount: () => changesCount,
    });
    tracker.setSource({ projectKey: 'project-a' });

    expect(tracker.synchronize()).toBe(0);
    expect(tracker.getLastChangeContext()).toBe(null);

    changesCount = 2;
    expect(tracker.synchronize()).toBe(2);
    expect(tracker.getLastChangeContext()).toEqual({
      source: 'external',
      revision: 2,
      revisionDelta: 2,
    });

    changesCount = 0;
    expect(tracker.synchronize()).toBe(2);
    expect(tracker.getLastChangeContext()).toEqual({
      source: 'external',
      revision: 2,
      revisionDelta: 2,
    });

    changesCount = 1;
    expect(tracker.synchronize()).toBe(3);
    expect(tracker.getLastChangeContext()).toEqual({
      source: 'external',
      revision: 3,
      revisionDelta: 1,
    });
  });

  it('resets revision context when the open project identity changes', () => {
    let changesCount = 3;
    const tracker = new ProjectRevisionTracker({
      getChangesCount: () => changesCount,
    });
    tracker.setSource({ projectKey: 'project-a' });
    changesCount = 4;
    expect(tracker.synchronize()).toBe(1);
    expect(tracker.getLastChangeContext()).not.toBe(null);

    changesCount = 0;
    tracker.setSource({ projectKey: 'project-b' });
    expect(tracker.synchronize()).toBe(0);
    expect(tracker.getLastChangeContext()).toBe(null);
  });

  it('marks successful mutations as agent changes using the native delta when available', () => {
    let changesCount = 0;
    const tracker = new ProjectRevisionTracker({
      getChangesCount: () => changesCount,
    });
    tracker.setSource({ projectKey: 'project-a' });

    changesCount = 2;
    expect(tracker.markMutation()).toBe(2);
    expect(tracker.getLastChangeContext()).toEqual({
      source: 'agent',
      revision: 2,
      revisionDelta: 2,
    });

    expect(tracker.markMutation()).toBe(3);
    expect(tracker.getLastChangeContext()).toEqual({
      source: 'agent',
      revision: 3,
      revisionDelta: 1,
    });
  });
});
