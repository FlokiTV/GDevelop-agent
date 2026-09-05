// @flow

type Options = {|
  getChangesCount?: () => number,
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

  constructor({ getChangesCount = () => 0 }: Options = {}) {
    this._getChangesCount = getChangesCount;
    this._projectKey = null;
    this._lastChangesCount = readChangesCount(getChangesCount);
    this._revision = 0;
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
    this._lastChangesCount = readChangesCount(this._getChangesCount);
  }

  synchronize(): ?number {
    if (!this._projectKey) return null;

    const currentChangesCount = readChangesCount(this._getChangesCount);
    if (currentChangesCount > this._lastChangesCount) {
      this._revision += currentChangesCount - this._lastChangesCount;
    }
    // Saving/sealing resets the native counter. Keep the public revision
    // monotonic and simply adopt the new baseline.
    this._lastChangesCount = currentChangesCount;
    return this._revision;
  }

  markMutation(): ?number {
    if (!this._projectKey) return null;
    const before = this._revision;
    const synchronized = this.synchronize();
    if (synchronized === before) this._revision += 1;
    return this._revision;
  }
}
