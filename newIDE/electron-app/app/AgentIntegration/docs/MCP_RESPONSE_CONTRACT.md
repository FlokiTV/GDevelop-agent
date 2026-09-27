# MCP response and error contract

DX-21 defines the machine-readable contract for every GDevelop MCP `tools/call` response.

## Contract version

The current additive response contract is version `1`.

Successful calls expose:

```json
{
  "contractVersion": 1,
  "command": "project.status",
  "data": {},
  "meta": {
    "traceId": null,
    "readOnly": true,
    "modifiesProject": false,
    "projectRevision": 12,
    "semanticRevisions": [],
    "durationMs": 4,
    "idempotencyReplayed": false
  }
}
```

`structuredContent.data` is the authoritative typed result location. New clients must not probe `structuredContent`, textual `content`, or tool-specific alternate locations for ordinary data.

The MCP `content` array remains for backward compatibility and for content kinds such as images.

## Success metadata

Every success envelope normalizes these fields:

- `traceId: string | null`
- `readOnly: boolean`
- `modifiesProject: boolean`
- `projectRevision: integer | null`
- `semanticRevisions: Array<{scope, revision}>`
- `durationMs: number | null`
- `idempotencyReplayed: boolean`

Existing `identity` and `targetIdentity` metadata remain available when relevant.

Concurrency identifiers are mirrored into metadata when they are actually active/applicable:

- `transactionId` on transaction begin/commit/rollback results and on project mutations executed while that safety transaction is active;
- `leaseId` and `leaseIds` on lease acquire/renew/release results and on mutations whose semantic scopes are covered by active leases;
- `semanticLeaseOwner` on mutations protected by those leases.

Tool-specific data fields are retained for compatibility.

## Structured errors

Tool failures set `isError=true` and expose:

```json
{
  "contractVersion": 1,
  "error": {
    "code": "revision_conflict",
    "category": "conflict",
    "message": "The open project changed since it was last read.",
    "retryable": true,
    "traceId": "...",
    "field": "optionalField",
    "path": ["optional", "path"],
    "hint": "...",
    "recovery": "...",
    "details": {},
    "currentRevision": 13
  }
}
```

Optional fields are omitted when unavailable.

Stable categories:

- `validation`
- `not-found`
- `conflict`
- `availability`
- `permission`
- `cancelled`
- `timeout`
- `safety`
- `internal`
- `execution`

Renderer `AgentError` instances assign the category centrally. Electron-origin errors are classified with the same fallback taxonomy before MCP serialization.

When a domain error already reports `details.field` or `details.path`, those locations are promoted to top-level `error.field` / `error.path` while the original details remain intact.

## Output schemas

Every published MCP tool carries an output schema for the versioned success envelope, even when its command descriptor does not yet provide a narrower schema for `data`.

When a descriptor does provide a typed output schema, that schema is nested exactly at `structuredContent.data`.

This lets clients rely on one outer shape while retaining command-specific typed results.

## Input bounds

Command descriptors remain the source of truth for input constraints. MCP projection preserves bounds such as `minimum`, `maximum`, `minLength`, `maxLength`, `minItems` and `maxItems`, including generated mutation controls.

Runtime guards remain defense in depth; clients should discover limits through `tools/list` rather than intentionally failing calls.

## Pagination

Offset-paginated surfaces expose:

```json
{
  "pagination": {
    "mode": "offset",
    "offset": 0,
    "limit": 50,
    "total": 123,
    "returned": 50,
    "hasMore": true,
    "truncated": true,
    "nextOffset": 50
  }
}
```

`nextOffset` is `null` when `hasMore=false`. Legacy top-level pagination fields remain during the compatibility window.

Bounded list/search surfaces that accept a `limit` but do not support continuation expose:

```json
{
  "pagination": {
    "mode": "bounded",
    "limit": 10,
    "total": 42,
    "returned": 10,
    "hasMore": true,
    "truncated": true,
    "nextCursor": null
  }
}
```

Here `hasMore=true` means additional matching data exists, while `nextCursor:null` explicitly states that this tool does not support paging through it. Clients must not invent `nextCursor`, `nextOffset` or `nextSeq` when the tool does not publish one.

Other bounded non-page responses may expose top-level `truncated=true` without a `pagination` object when there is no meaningful list continuation contract.

## Compatibility

Contract version 1 is additive:

- existing `command`, `data`, `meta` and `error` locations remain unchanged;
- textual/image `content` remains available;
- legacy client helpers may continue fallback behavior;
- new clients should use a strict version-1 envelope parser.

The live MCP-discoverable copy is available at `gdevelop://guides/response-contract`.
