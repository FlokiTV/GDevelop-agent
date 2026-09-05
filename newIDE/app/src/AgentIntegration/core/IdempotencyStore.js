// @flow
import { AgentError } from './AgentError';

const DEFAULT_MAX_ENTRIES = 256;

const normalizeForFingerprint = (value: any): any => {
  if (Array.isArray(value)) return value.map(normalizeForFingerprint);
  if (!value || typeof value !== 'object') return value;

  return Object.keys(value)
    .sort()
    .reduce((normalized, key) => {
      normalized[key] = normalizeForFingerprint(value[key]);
      return normalized;
    }, {});
};

export const fingerprintInput = (input: any): string =>
  JSON.stringify(normalizeForFingerprint(input));

type Entry = {|
  fingerprint: string,
  promise: Promise<any>,
  settled: boolean,
|};

export class IdempotencyStore {
  _entries: Map<string, Entry>;
  _maxEntries: number;

  constructor({ maxEntries = DEFAULT_MAX_ENTRIES }: { maxEntries?: number } = {}) {
    this._entries = new Map();
    this._maxEntries = Math.max(1, Math.floor(maxEntries));
  }

  _trimSettledEntries() {
    if (this._entries.size <= this._maxEntries) return;
    for (const [key, entry] of this._entries) {
      if (!entry.settled) continue;
      this._entries.delete(key);
      if (this._entries.size <= this._maxEntries) return;
    }
  }

  execute({
    command,
    key,
    input,
    currentRevision,
    execute,
  }: {|
    command: string,
    key: string,
    input: any,
    currentRevision?: ?number,
    execute: () => Promise<any>,
  |}): Promise<any> {
    const cacheKey = `${command}:${key}`;
    const fingerprint = fingerprintInput(input);
    const existing = this._entries.get(cacheKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return Promise.reject(
          new AgentError({
            code: 'idempotency_conflict',
            message: 'The idempotency key was already used with different input.',
            hint: 'Reuse the same key only for an identical retry, or use a new key.',
            currentRevision,
            details: { command, idempotencyKey: key },
          })
        );
      }
      return existing.promise;
    }

    const entry: Entry = {
      fingerprint,
      settled: false,
      promise: Promise.resolve(),
    };
    entry.promise = Promise.resolve()
      .then(execute)
      .then(
        result => {
          entry.settled = true;
          this._trimSettledEntries();
          return result;
        },
        error => {
          if (this._entries.get(cacheKey) === entry) {
            this._entries.delete(cacheKey);
          }
          throw error;
        }
      );
    this._entries.set(cacheKey, entry);
    return entry.promise;
  }
}
