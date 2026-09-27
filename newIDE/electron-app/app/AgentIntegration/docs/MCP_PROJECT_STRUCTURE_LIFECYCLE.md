# MCP project structure lifecycle

DX-33 defines the MCP-native lifecycle contract for project scenes (`gd::Layout`) and External Events (`gd::ExternalEvents`).

## Persistent identity

Scene and External Events names are display/refactor names, not identities.

- `gd::Layout` owns a persisted `persistentUuid`.
- `gd::ExternalEvents` owns a persisted `persistentUuid`.
- New items receive UUID v4 identities.
- Serialization writes `persistentUuid`.
- Loading older projects without the field generates an identity in memory; the next explicit project save persists it.
- Rename preserves the UUID.
- Internal copies/checkpoints preserve the UUID.
- Explicit duplicate operations reset the copied UUID so source and duplicate cannot alias the same identity.

MCP selectors are `scene:<persistentUuid>` and `external-events:<persistentUuid>`. The display name is returned separately. Name fallback remains compatibility-only when the connected build does not expose persistent identity.

## Scene lifecycle

The renderer command registry exposes `project.scenes.list/get/usages/create/duplicate/rename/reorder/delete`.

List/get return persistent identity, selector, display name, order, first-scene state and bounded basic metadata. Create/reorder use explicit zero-based order. Duplicate copies scene content then assigns a new persistent UUID. Rename uses the native `WholeProjectRefactorer` and preserves the scene UUID.

Delete defaults to safe behavior. `dryRun=true` reports references/blockers without mutation. A referenced scene is rejected unless `allowReferenced=true` is explicitly supplied.

## External Events lifecycle

The existing External Events surface gains persistent identity plus `external-events.usages`, `external-events.duplicate` and `external-events.reorder`. Existing create/inspect/update/rename/delete accept persistent IDs/selectors as well as names. Rename preserves identity and runs the native refactorer. Delete supports `dryRun` and blocks referenced sheets by default.

## Usage and impact analysis

DX-33 does not use substring/regex scanning as the authority for references. It serializes the current project, clones it in memory, applies the same native `WholeProjectRefactorer` rename to a collision-free sentinel name, serializes the clone, diffs before/after, returns only refactorer-produced references, then destroys the clone. The live project is untouched.

## Conflicts and safety

Lifecycle mutations use normal AgentIntegration project revision, transaction, ownership and lease handling. Structure-specific conflicts include duplicate name, stale identity/name pair, invalid order, referenced delete and persistent-identity-unavailable errors for older libGD builds.

A request may include both persistent identity and name. If they no longer resolve to the same project element, the mutation is rejected instead of following the stale name.

## Targeting integration

`target.status` resolves editor-active, preview-running and project scene identities through the persistent UUID. MCP `expectedSceneId` / `expectedSceneSelector` preconditions resolve explicit `sceneName` command inputs against the target-status scene index before comparison. A scene selector therefore survives rename while display name remains separate.

## Acceptance expectations

DX-33 acceptance must demonstrate through MCP only: list/get stable selectors; create + duplicate with distinct UUIDs; rename preserving UUID and valid native references; reorder preserving unrelated content; dry-run delete blockers; referenced External Events deletion blocked and unreferenced deletion allowed; save/reload retaining identities; target.status/preconditions using persistent selectors; and validation with zero errors after a small multi-scene restructure.
