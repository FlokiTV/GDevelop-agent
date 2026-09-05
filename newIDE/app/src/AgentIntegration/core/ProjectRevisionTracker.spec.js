// @flow
import { ProjectRevisionTracker } from './ProjectRevisionTracker';

describe('ProjectRevisionTracker', () => {
  it('accumulates native change deltas and stays monotonic across save resets', () => {
    let changesCount = 0;
    const tracker = new ProjectRevisionTracker({
      getChangesCount: () => changesCount,
    });
    tracker.setSource({ projectKey: 'project-a' });

    expect(tracker.synchronize()).toBe(0);
    changesCount = 2;
    expect(tracker.synchronize()).toBe(2);

    changesCount = 0;
    expect(tracker.synchronize()).toBe(2);
    changesCount = 1;
    expect(tracker.synchronize()).toBe(3);
  });

  it('resets when the open project identity changes', () => {
    let changesCount = 3;
    const tracker = new ProjectRevisionTracker({
      getChangesCount: () => changesCount,
    });
    tracker.setSource({ projectKey: 'project-a' });
    changesCount = 4;
    expect(tracker.synchronize()).toBe(1);

    changesCount = 0;
    tracker.setSource({ projectKey: 'project-b' });
    expect(tracker.synchronize()).toBe(0);
  });

  it('forces one revision advance when a successful mutation does not touch the native counter', () => {
    const tracker = new ProjectRevisionTracker({ getChangesCount: () => 0 });
    tracker.setSource({ projectKey: 'project-a' });

    expect(tracker.markMutation()).toBe(1);
    expect(tracker.synchronize()).toBe(1);
  });
});
