// @flow
import { AgentError, AGENT_ERROR_CODES } from './AgentError';

export type SemanticScopeSnapshot = {|
  scope: string,
  revision: number,
|};

type Lease = {|
  leaseId: string,
  scope: string,
  owner: string,
  expiresAt: number,
|};

const normalizeScope = (scope: any): string => {
  if (typeof scope !== 'string' || !scope.trim()) {
    throw new AgentError({ code: 'invalid_semantic_scope' });
  }
  return scope.trim();
};

export class SemanticConcurrency {
  _revisions: Map<string, number>;
  _leases: Map<string, Lease>;
  _nextLeaseId: number;

  constructor() {
    this._revisions = new Map();
    this._leases = new Map();
    this._nextLeaseId = 1;
  }

  reset() {
    this._revisions.clear();
    this._leases.clear();
  }

  getRevision(scope: string): number {
    return this._revisions.get(normalizeScope(scope)) || 0;
  }

  snapshot(scopes: Array<string>): Array<SemanticScopeSnapshot> {
    return Array.from(new Set(scopes.map(normalizeScope)))
      .sort()
      .map(scope => ({ scope, revision: this.getRevision(scope) }));
  }

  assertExpected(expected: any) {
    if (!expected || typeof expected !== 'object' || Array.isArray(expected))
      return;
    Object.keys(expected).forEach(scope => {
      const expectedRevision = expected[scope];
      if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
        throw new AgentError({ code: 'invalid_semantic_revision' });
      }
      const currentRevision = this.getRevision(scope);
      if (currentRevision !== expectedRevision) {
        throw new AgentError({
          code: AGENT_ERROR_CODES.REVISION_CONFLICT,
          message: `Semantic scope '${scope}' changed since it was last read.`,
          retryable: true,
          hint:
            'Read semantic revisions again and retry with the current scope revision.',
          details: { scope, expectedRevision, currentRevision },
        });
      }
    });
  }

  mark(scopes: Array<string>): Array<SemanticScopeSnapshot> {
    Array.from(new Set(scopes.map(normalizeScope))).forEach(scope => {
      this._revisions.set(scope, this.getRevision(scope) + 1);
    });
    return this.snapshot(scopes);
  }

  _pruneExpired(now: number = Date.now()) {
    Array.from(this._leases.entries()).forEach(([scope, lease]) => {
      if (lease.expiresAt <= now) this._leases.delete(scope);
    });
  }

  acquireLease({ scope, owner, ttlMs = 30000 }: any): Lease {
    const normalizedScope = normalizeScope(scope);
    if (typeof owner !== 'string' || !owner.trim()) {
      throw new AgentError({ code: 'invalid_lease_owner' });
    }
    if (!Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > 300000) {
      throw new AgentError({ code: 'invalid_lease_ttl' });
    }
    this._pruneExpired();
    const current = this._leases.get(normalizedScope);
    if (current && current.owner !== owner.trim()) {
      throw new AgentError({
        code: 'semantic_scope_locked',
        retryable: true,
        details: { scope: normalizedScope, expiresAt: current.expiresAt },
      });
    }
    const lease = {
      leaseId: current ? current.leaseId : `lease-${this._nextLeaseId++}`,
      scope: normalizedScope,
      owner: owner.trim(),
      expiresAt: Date.now() + ttlMs,
    };
    this._leases.set(normalizedScope, lease);
    return { ...lease };
  }

  releaseLease({ scope, owner, leaseId }: any): boolean {
    const normalizedScope = normalizeScope(scope);
    this._pruneExpired();
    const current = this._leases.get(normalizedScope);
    if (!current) return false;
    if (current.owner !== owner || current.leaseId !== leaseId) {
      throw new AgentError({ code: 'semantic_lease_mismatch' });
    }
    this._leases.delete(normalizedScope);
    return true;
  }

  listLeases(): Array<Lease> {
    this._pruneExpired();
    return Array.from(this._leases.values())
      .sort((a, b) => a.scope.localeCompare(b.scope))
      .map(lease => ({ ...lease }));
  }

  assertLeaseAccess(scopes: Array<string>, owner: ?string) {
    this._pruneExpired();
    scopes.map(normalizeScope).forEach(scope => {
      const lease = this._leases.get(scope);
      if (lease && lease.owner !== owner) {
        throw new AgentError({
          code: 'semantic_scope_locked',
          retryable: true,
          details: { scope, expiresAt: lease.expiresAt },
        });
      }
    });
  }
}
