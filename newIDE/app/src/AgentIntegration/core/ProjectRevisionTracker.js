// @flow

type Options = {|
  getChangesCount?: () => number,
|};

export type ProjectRevisionChange = {|
  source: 'external' | 'agent',
  revision: number,
  revisionDelta: number,
|};

const readChangesCount = (getChangesCount: () => number): number => {
  const value = Number(getChangesCount());
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
};

export class ProjectRevisionTracker {
  _getChangesCount: () => number;
  _projectKey: ?string;
  _lastChangesCount: number;
  _revision: number;
  _lastChange: ?ProjectRevisionChange;

  constructor({ getChangesCount = () => 0 }: Options = {}) {
    this._getChangesCount = getChangesCount;
    this._projectKey = null;
    this._lastChangesCount = readChangesCount(getChangesCount);
    this._revision = 0;
    this._lastChange = null;
  }

  setSource({
    projectKey,
    getChangesCount,
  }: {|
    projectKey: ?string,
    getChangesCount?: () => number,
  |}) {
    if (getChangesCount) this._getChangesCount = getChangesCount;
    if (projectKey === this._projectKey) return;

    this._projectKey = projectKey;
    this._revision = 0;
    this._lastChange = null;
    this._lastChangesCount = readChangesCount(this._getChangesCount);
  }

  synchronize(): ?number {
    if (!this._projectKey) return null;

    const currentChangesCount = readChangesCount(this._getChangesCount);
    if (currentChangesCount > this._lastChangesCount) {
      const revisionDelta = currentChangesCount - this._lastChangesCount;
      this._revision += revisionDelta;
      this._lastChange = {
        source: 'external',
        revision: this._revision,
        revisionDelta,
      };
    }
    // Saving/sealing resets the native counter. Keep the public revision
    // monotonic and simply adopt the new baseline.
    this._lastChangesCount = currentChangesCount;
    return this._revision;
  }

  markMutation(): ?number {
    if (!this._projectKey) return null;

    const currentChangesCount = readChangesCount(this._getChangesCount);
    const nativeDelta =
      currentChangesCount > this._lastChangesCount
        ? currentChangesCount - this._lastChangesCount
        : 0;
    const revisionDelta = nativeDelta || 1;
    this._revision += revisionDelta;
    this._lastChangesCount = currentChangesCount;
    this._lastChange = {
      source: 'agent',
      revision: this._revision,
      revisionDelta,
    };
    return this._revision;
  }

  getLastChangeContext(): ?ProjectRevisionChange {
    return this._lastChange ? { ...this._lastChange } : null;
  }
}
