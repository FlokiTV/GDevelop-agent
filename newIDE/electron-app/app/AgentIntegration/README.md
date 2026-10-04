# GDevelop AgentIntegration — MCP live editing

AgentIntegration exposes the **currently running GDevelop desktop editor** to MCP-capable agents. The agent works against the same in-memory project and editor UI the user is looking at: mutations are applied through GDevelop's native editor capabilities, the UI is refreshed through the existing editor callbacks, previews can be hot-reloaded and inspected, and saving remains explicit.

MCP is the only public agent protocol.

## Architecture

The feature is intentionally split by responsibility:

```text
GDevelop desktop
  │
  ├─ renderer AgentIntegration
  │    ├─ AgentHost / CommandRegistry
  │    ├─ editor services and commands
  │    ├─ safety/checkpoints/transactions
  │    └─ preview/runtime services
  │
  ├─ Electron AgentIntegration
  │    ├─ WindowRegistry
  │    ├─ RendererBridge
  │    ├─ WindowCaptureService
  │    ├─ preview input/runtime services
  │    └─ DesktopCommandRegistry
  │
  └─ protocols/mcp
       └─ Streamable HTTP adapter
```

`CommandRegistry` is the source of truth for command names, descriptions, JSON input schemas and execution metadata. The MCP adapter projects those descriptors into `tools/list`; it does not duplicate GDevelop business logic or call another HTTP API.

The upstream integration surface remains limited to three small hooks:

- `newIDE/electron-app/app/main.js` installs AgentIntegration;
- `newIDE/app/src/MainFrame/index.js` provides the renderer/editor callbacks already owned by GDevelop;
- `newIDE/electron-app/app/PreviewWindow.js` exposes preview-window identity to isolated desktop input/runtime services.

## Protocol and endpoint

The server uses MCP protocol version `2026-07-28` and Streamable HTTP at:

```text
http://127.0.0.1:<port>/mcp
```

The default port is `38473`. Set `GDEVELOP_MCP_PORT` before launching GDevelop to request another local port.

The primary protocol contract is `2026-07-28`. The same HTTP boundary also accepts MCP `2025-11-25` through the official SDK's stateless compatibility mode because current external hosts such as MCP Inspector v2.5.0 still initiate that revision. The fallback does not create a second server, session state machine or GDevelop business-logic path; loopback validation, bearer auth, targeting, admission control and the same command registry remain authoritative.

## Discovery and authentication

At startup, Electron writes two private files inside its `userData` directory:

- `gdevelop-mcp.json` — non-secret discovery metadata;
- `gdevelop-mcp-token` — the bearer token, rotated on every startup.

The discovery document has this shape:

```json
{
  "service": "gdevelop-mcp",
  "version": 1,
  "transport": "streamable-http",
  "endpoint": "http://127.0.0.1:38473/mcp",
  "host": "127.0.0.1",
  "port": 38473,
  "path": "/mcp",
  "protocolVersion": "2026-07-28",
  "pid": 12345,
  "auth": {
    "type": "bearer",
    "tokenFile": "<path to gdevelop-mcp-token>"
  }
}
```

The token itself is never embedded in the discovery JSON or logs. Clients send it as:

```text
Authorization: Bearer <token>
```

The HTTP server binds to loopback and validates local Host/Origin before MCP dispatch.

## Security model and threat boundaries

Loopback is a transport boundary, not an authorization boundary. AgentIntegration assumes that other local processes and browser content may be hostile and therefore applies independent checks before an MCP request can reach the live editor.

The threat model explicitly covers:

- **malicious local processes**: every MCP request still requires the per-startup bearer token; knowing the loopback port is insufficient;
- **DNS rebinding / forged Host**: the Node HTTP boundary accepts only localhost/loopback Host values;
- **browser CSRF / hostile Origin**: requests with a non-local `Origin` are rejected before authentication or MCP dispatch;
- **token leakage**: a new cryptographically random token is created on every startup, stored in a private token file, never embedded in discovery JSON and never intentionally written to request/result logs;
- **resource exhaustion**: authenticated HTTP bodies are capped at 4 MiB, JSON nesting at 64 levels, concurrent authenticated requests at 32 globally and 8 per admission client, local resource source files at 256 MiB, remote resource downloads at a bounded caller/default limit with a 256 MiB hard maximum, and PNG capture results at 16 MiB;
- **remote resource SSRF/content attacks**: `resources.import-url` / `resources.replace-url` allow only HTTP(S), reject credentials, localhost/single-label/internal/private/reserved targets, resolve and pin public DNS addresses for each request/redirect, bound redirects/timeouts/bytes, sniff content type, support expected SHA-256, reject unsafe MIME/kind mismatches and redact URL query/fragment data from persisted provenance;
- **filesystem traversal and unsafe deletion**: local resource imports operate only on an explicitly supplied source path and copy into the project by default; physical resource deletion is allowed only for a resolved project-local file that is not shared or still referenced;
- **stale or replayed mutations**: project/event revision preconditions reject stale writes, while `idempotencyKey` deduplicates retry-safe mutation replay and rejects reuse with different input;
- **destructive operations**: destructive metadata is projected to MCP annotations for client UX, but server-side checks remain authoritative. Opening/closing over dirty work requires explicit `discardUnsavedChanges`; resource deletion refuses in-use/shared/outside-project files; checkpoint restore/transaction rollback remain explicit destructive commands.

Malformed JSON, excessive nesting, oversized bodies and saturated request capacity are rejected at the HTTP boundary before the MCP handler or renderer bridge is invoked. Long-running gameplay/validation/export calls are not rate-limited by elapsed duration after admission; backpressure limits concurrent admitted HTTP requests rather than imposing a short operation timeout.

These controls do not attempt to sandbox a process that already has the user's OS credentials and can independently read GDevelop's private user-data files. The bearer token prevents accidental/ambient access and browser-origin attacks; operating-system account security remains outside the MCP boundary.

## Targeting an editor window

MCP calls are stateless with respect to editor selection. A client can explicitly target the live renderer with request headers:

```text
X-GDevelop-Window-Id: <Electron BrowserWindow id>
X-GDevelop-Project-Path: <absolute project path>
X-GDevelop-Client-Id: <optional stable local client id>
```

`X-GDevelop-Client-Id` is optional and used only for cooperative per-client admission fairness; it is not authentication and is never trusted as a security boundary. Invalid/missing client ids fall back to editor-window/remote identity, while the global concurrency cap remains authoritative against clients that rotate ids.

If neither editor target is supplied, `WindowRegistry` prefers the focused registered editor and otherwise accepts the only unambiguous registered editor. Use `desktop.windows.list` when multiple editor/preview windows are open.

`target.status` is the authoritative semantic identity read for the selected editor window. It separates the active project (`projectId`/UUID, name and normalized path), editor-tab targets (session-stable `editor-tab:<id>` plus scene/external-events selectors), the last-opened scene, and live preview targets. Scene selectors use `scene:<persistentUuid>` and External Events use `external-events:<persistentUuid>`; display names are returned separately and rename preserves the selector. External Events also include the associated scene where GDevelop exposes one. If multiple panes expose different active scene-bearing targets, `activeScene` is intentionally null and `activeSceneAmbiguous=true` with explicit candidates instead of guessing.

Target-aware MCP tools expose optional `expectedProjectId`, `expectedProjectPath`, `expectedEditorSelector`, `expectedSceneId`, `expectedSceneSelector` and `expectedPreviewTarget` preconditions. A mismatch fails before dispatch with structured `target_mismatch` details and a fresh `target.status` recovery hint. Explicit scene mutations compare the expected scene against the command's `sceneName`/`scene_name`; preview launch without an explicit scene compares against the editor-active scene. This lets an agent pin intent without forcing every scene mutation to follow the currently visible tab.

Preview BrowserWindows are associated with their native parent editor window. `preview.status`/`target.status` only expose previews parented to the selected editor; `desktop.windows.list` reports `parentEditorWindowId` and the parent project path for preview windows. Preview input/viewport/runtime-helper calls with a `previewWindowId` are automatically rejected if that window is not owned by the selected editor target. `desktop.window.capture` applies the same guard when the requested `windowId` is a preview, while ordinary editor-window capture remains available. When `expectedPreviewTarget` is supplied in a multi-preview run, its target/window/debugger identity must describe the same requested preview window rather than merely another valid preview of the project.

Renderer responses include `meta.targetIdentity` when the live renderer publishes the capability; desktop preview/capture responses add the same metadata best-effort. Legacy renderers that do not publish `target.status` keep existing automatic behavior, while explicit target preconditions fail as `target_identity_unavailable` instead of pretending they were enforced.

## Discovering commands

MCP tools are generated from the live command registry. Useful discovery commands include:

- `agent.capabilities`
- `agent.commands.list`
- `agent.commands.describe`
- `project.status`
- `editor.functions.list`
- `editor.functions.describe`

Do not maintain a separate hard-coded tool catalog in clients. Call `tools/list` or the registry discovery commands so the client sees the exact build it is connected to.

### EditorFunction exposure policy

`editor.functions.list` and `editor.functions.describe` project the native EditorFunction registry into one machine-readable contract. Each function reports `exposure.discovery`, `exposure.genericCall`, `exposure.typedTool`, `exposure.runScript` and `exposure.readOnlyRunScript`; unavailable surfaces include a stable `hiddenReason`. Embedded-executable functions are callable through `editor.functions.call` and receive a deterministic typed tool such as `editor.functions.create-extension`. Generation-service-only functions remain discoverable with `executableOnly: false` but are not falsely advertised as callable.

`run_script` uses the same native registry but intentionally excludes recursive script execution, project bootstrap, generation-service/orchestrator-only flows and long-running gameplay-test lifecycle calls. Read-only scripts additionally hide all functions that may mutate the project. Mutating EditorFunctions must therefore be exposed through the generated metadata/typed-tool path rather than ad hoc script allowlists, and metadata generation is checked against every exported native EditorFunction so newly added functions cannot silently disappear from the external API.

### Project extension authoring

Project-owned extensions use that same typed EditorFunction surface: `editor.functions.create-extension` and `editor.functions.change-extension-properties` create/change/rename/delete the extension, while `editor.functions.create-custom-function` and `editor.functions.change-custom-function` create/change/rename/delete free Action, Condition and expression declarations. Their MCP schemas expose extension scope, function kind, expression return type, ordered parameter types, privacy/async flags and editable settings. No direct project JSON edit or external import bootstrap is required.

After declaration mutations, generated metadata is refreshed by the native EditorFunction implementation; discover the resulting action/condition/expression with `events.instructions.search/describe` and use the returned `callForms` rather than guessing names. Author a function body through the ordinary event tools with `target: { kind: "extension-function", extensionName, functionName }` (and owner fields for behavior/object methods). These typed tools inherit the normal MCP `expectedRevision` and `idempotencyKey` preconditions; use `safety.transactions.*`, `validation.run` and explicit `project.save`/`project.save-as` exactly as for other project mutations.

### Variable rename and ordering

`editor.functions.add-or-edit-variable` supports non-destructive declaration rename and reorder in addition to create/update/delete. Use `new_variable_name` for an in-place rename; top-level and nested structure-property renames preserve the existing variable value/type/UUID, and the native `WholeProjectRefactorer` rewrites affected event references for global, scene, object and instance-owned declarations. Array indexes are values, not declaration names, and cannot be renamed.

Top-level declaration ordering is explicit and deterministic: specify exactly one of `move_before_variable`, `move_after_variable`, or `move_to_index` (a final zero-based index). Rename and reorder may be combined with each other in one operation; the reorder addresses the post-rename name. Keep create/update/delete in separate `add-or-edit-variable` calls: those legacy mutations continue through the native EditorFunction, while rename/reorder is handled by the isolated AgentIntegration path. These operations do not delete/recreate the declaration, so public-first / `__internal`-last ordering can be achieved without value/type loss. Duplicate names, missing targets, invalid paths and ambiguous positioning return stable structured `operationErrors`. Group variables remain create/update/delete-only until a concrete group refactor target can be made equally safe.

### Scene instance identity and placement

Scene-instance authoring is identity-addressed, not brush/point-addressed. Use `scene.instances.list/get` to obtain the persistent `InitialInstance` UUID and the canonical `instance:<uuid>` selector. Ordinary property, position, angle, layer and Z-order edits preserve that identity. `scene.instances.create` is the explicit creation operation; `scene.instances.update`, `scene.instances.transform`, `scene.instances.move-layer` and `scene.instances.set-render-order` never create a replacement when their target is absent or ambiguous.

`scene.instances.transform` uses absolute scene coordinates for x/y/z and rotation. The native `InitialInstance` model has no authoritative generic multiplicative `scaleX/scaleY/scaleZ` contract, so the tool does not invent one; width/height/depth requests use native custom-size overrides. Layer and Z-order remain owned by the DX-26 tools, while non-placement typed properties delegate to DX-24 `objects.properties.describe/set`.

Deletes require the current per-instance `instanceRevision` in addition to the normal DX-19 project revision/ownership safeguards. Likely duplicates can be inspected with `scene.instances.diagnose-duplicates`; diagnostics never delete automatically. Bulk update/delete require an explicit selection, default to dry-run, return a deterministic `selectionRevision`, and only apply when that revision is supplied unchanged. Duplicate cleanup therefore needs no raw project JSON editing: diagnose, review the dry-run summary, then apply the guarded bulk delete.

### Object-definition lifecycle

`objects.definitions.list/get` exposes global and scene-local object definitions with native persistent UUID identity, canonical selectors, type/scope ownership and explicit MCP discovery links for properties, behaviors, groups and usages. `editor.types.objects.list/describe` remains the connected-build type catalog; detailed records now include a creation schema, default properties/behaviors and dynamically compatible behaviors/capabilities instead of a hardcoded object catalog.

Use `objects.definitions.create` for explicit type-aware creation; optional initial property changes delegate to DX-24 typed paths. `objects.definitions.duplicate` uses the native object clone and resets the persistent object/variable UUIDs, preserving configuration, variables, effects, behaviors and Sprite animation data while returning a new definition identity. `objects.definitions.rename` uses `WholeProjectRefactorer` before changing the name, so supported InitialInstance, group and Event Sheet object references are rewritten while the object UUID remains stable.

`objects.definitions.usages` reports InitialInstances, object-group memberships, exact object-typed Event Sheet references with stable handles, potential dynamic/text matches, attached behaviors and native resource dependencies linked to DX-28 inspection. `objects.definitions.delete` defaults to dry-run and blocks apply while authoritative instance/group/event usages remain; uncertain dynamic matches require explicit acknowledgement rather than being silently treated as safe. `objects.definitions.move-scope` can promote a scene-local definition to global scope while preserving UUID and metadata; global-to-scene demotion is explicitly unsupported because the native editor cannot safely demote an object that other scenes may depend on. All mutations inherit DX-19 revision/ownership/transaction safeguards and DX-21 canonical envelopes.

### Behavior and capability lifecycle

Behavior authoring is registry-backed rather than catalogue-backed. Use `editor.types.behaviors.list/describe` for global discovery; records include extension ownership, typed property/shared-property parameters, required behavior/capability types, compatibility rules and `events.instructions.*` operation discovery. Use `objects.behaviors.list/available/describe` for object-specific state: attached names/types, default capability interfaces, dependencies, DX-24 property schemas, unlocked actions/conditions/expressions and native `ObjectTools.isBehaviorCompatibleWithObject` preflight.

`objects.behaviors.add` validates the attached name and native compatibility before mutation, then uses `WholeProjectRefactorer.addBehaviorAndRequiredBehaviors`. Hidden capability behaviors are object-type managed: an already attached capability is resolved idempotently, and a missing capability can only be restored when connected object-type metadata explicitly declares that behavior type as a default capability; unsupported force-attachment is rejected. `objects.behaviors.update` accepts exact machine-readable property paths and delegates typed validation/mutation to DX-24 `objects.properties.set`. `objects.behaviors.remove` defaults to dry-run and blocks default capabilities, required-behavior dependents and `InitialInstance` behavior overrides unless the supported explicit cascade/override options are requested. The current libGD binding exposes authoritative required-behavior dependencies and initial-instance overrides, but not an exact project-wide index of event references to an attached behavior name; responses state that coverage rather than inventing it. Connected metadata exposes dependency constraints but no configurable behavior-order contract, so no synthetic ordering rule is enforced.

Capability operations remain ordinary event instructions. `objects.behaviors.describe` reports `operationDiscovery` and resolved behavior-scoped actions/conditions/expressions; discover details through `events.instructions.search/describe` and author them through `events.patch`. This composes with DX-24's authoritative property/capability tracing and inherits DX-19 revision/lease/ownership checks plus DX-21 canonical envelopes/errors.

### Sprite animation, frame, point and collision-mask authoring

`objects.sprite.animations.list/get` exposes Sprite animation names/indices, ordered directions and frames, looping, native timing, image resources, Origin/Center/custom points and collision masks without raw object JSON. GDevelop Sprite timing is uniform per direction (`timeBetweenFrames`), so frame records report that shared duration explicitly rather than inventing unsupported per-frame timing. Each frame links its image back to `resources.visual.inspect`, including DX-28 image/resource metadata when available.

Use `objects.sprite.animations.create/update/move/delete`, `objects.sprite.frames.add/update/move/delete`, `objects.sprite.points.set/delete` and `objects.sprite.collision-mask.set` for typed mutations. Animation rename uses native `WholeProjectRefactorer.renameObjectAnimationInScene`, preserving `objectAnimationName` references in the scene and associated External Events. Frame-image replacement changes only the resource reference and preserves Origin, Center, custom points, collision mask and unrelated animations. Polygon collision masks require finite convex polygons with at least three vertices; `{ kind: "full-image" }` is the explicit reset path. Introspection emits structured warnings when custom point-name sets or collision-mask modes are inconsistent across frames.

Animation/frame numeric indices are positional identities. The current libGD contract does not expose an authoritative rewrite for event references that encode numeric animation or frame indices, so reorder/delete operations default to dry-run, return `referenceRisk`, and require `acknowledgeIndexReferenceRisk=true` before apply. Appending animations/frames preserves existing numeric indices; rename-by-name uses the native refactor path. All mutations inherit DX-19 revisions/leases/ownership and DX-21 canonical envelopes/errors.

### Object groups / families

`objects.groups.list/get` exposes scene/global object groups as explicit entities with scope-aware selectors, ordered concrete membership, resolved member object types/scopes and diagnostics. `objects.groups.for-object` provides reverse membership lookup. Event-instruction metadata marks object-valued parameters with `referenceSemantics.entityKinds = ["object", "object-group"]`, so callers can distinguish the possible entity classes and follow `objects.groups.list` / `objects.groups.usages` rather than treating every object parameter as a concrete object.

Use `objects.groups.create/rename/delete` and `objects.groups.members.add/remove/move` for typed lifecycle and membership changes. Names are checked against the visible object/group namespace; invalid members and duplicates fail with structured diagnostics. Rename delegates to GDevelop's native `WholeProjectRefactorer` for the matching scene/global group scope. `objects.groups.usages` maps exact object-typed Event Sheet parameters back to stable event/instruction handles and parameter indices; expression/text matches that cannot be proven as group references are reported separately as potential references. Delete defaults to dry-run and blocks while authoritative Event Sheet references remain, so an in-use group cannot be silently orphaned. These mutations inherit DX-19 revision/lease/ownership checks and DX-21 canonical envelopes/errors.

### Project-wide reference graph and impact analysis

`references.graph.capabilities/query/usages/impact` unify the type-specific dependency scanners into one project-wide graph. Stable/native selectors are preserved for scenes, External Events, object definitions and scene instances; Event Sheet events/actions/conditions use the stable DX-3/DX-20 handles; groups, variables, resources, behaviors and extension/functions use canonical scope/name/path selectors. Each edge includes source/target summaries, a reference kind, scope, exact Event Sheet handle/parameter or resource/object path where discoverable, and an explicit `hard`, `soft` or `dynamic` strength. Dynamic lexical evidence is returned as a warning and is never promoted to a safe-refactor claim.

`references.graph.query` traverses inbound/outbound/both directions with bounded depth, visited-node/cycle reporting, filters for scene/External Events/extension/resource/reference type, deterministic pagination and a `graphRevision`. `references.graph.usages` is the inbound-only convenience surface. `references.graph.impact` analyzes rename/move/delete without mutating the project: it separates hard references, auto-refactorable edges, blockers and unresolved soft/dynamic warnings, and returns `safeToApply` only when no known blocker or uncertainty remains. Agents should perform impact analysis immediately before destructive/refactor mutations and re-query if the graph revision may have changed. The graph composes DX-11 variables, DX-28 resources, DX-31 groups, DX-33 scene/External Events lifecycle, DX-34 object definitions, DX-10 extension/functions, DX-19 ownership/revisions and the DX-21 canonical error envelope.

### Cross-tool mutation planning and dry-run

`mutations.capabilities/plan/commit` provide one stale-safe planning contract for destructive/refactor operations that already have authoritative dry-run semantics. `mutations.plan` currently supports `objects.definitions.rename/delete/move-scope` and `resources.visual.delete`. It executes the underlying mutation in dry-run mode only, merges DX-37 reference impact, and returns a localized `changeSet` (`creates`, `updates`, `deletes`, `moves`, `renames`, `referenceRewrites`) with entity identities/scopes, compact before/after summaries, blockers, warnings, unresolved dynamic references and captured project/graph/Event Sheet revisions. Planning explicitly reports `projectModified=false`, `filesystemModified=false` and `runtimeModified=false`.

A valid plan can return a short-lived single-use `planToken` and deterministic `planHash`. `mutations.commit` rechecks the current project revision and regenerates the plan before applying; any intervening mutation, changed graph/diff or token expiry is rejected as a structured stale/expired-plan error before the underlying operation runs. Blocked or dynamically uncertain plans cannot be committed. When preconditions remain unchanged, the response returns both the reviewed `plannedChangeSet` and the applied `committedDiff`, with `committedDiffMatchesPlan=true`. DX-19 transactions/ownership/leases and DX-21 envelopes remain enforced by the normal AgentHost mutation wrapper around the commit command; callers should still use the common revision/ownership envelope at commit time.

### Visual resources: import, metadata, usages and safe replacement

Visual image/font resources use `resources.visual.*` rather than requiring callers to create files manually and then register paths. `resources.visual.import` accepts base64 bytes (or a base64 data URL), sniffs the actual content before trusting the filename, writes a project-local file atomically and registers the native GDevelop resource in the same operation. The default target is `assets/<resource-name>.<detected-extension>`, while an explicit `relativePath` remains project-root constrained. Supported image metadata is PNG/JPEG/WebP plus SVG; fonts use the native project font kinds TTF/OTF. Sprite-sheet image assets remain ordinary image resources and compose with `resources.image.slice-spritesheet` when slicing is needed.

`resources.visual.inspect` returns the registered kind/name, project-relative backing path, detected MIME type, byte size, SHA-256, raster/vector dimensions and alpha semantics, or font family/subfamily/full/PostScript names where present. It also reports `usedInProject`/`orphaned`/`userAdded`, packaging and runtime resolution, and native usage discovery. Sprite frame usages include scene/object/animation/direction/frame paths; Text font, TiledSprite texture and PanelSprite/9-patch texture usages are identified explicitly. PanelSprite results include margins/tiled state as structural constraints. Custom/extension objects discovered through native resource exposure are marked as such and point callers to `objects.properties.describe`; event/effect/project-setting references remain aggregate-only when libGD does not expose an exact property path.

`resources.visual.replace` keeps the resource name and all project references stable while atomically replacing its backing bytes. `resources.visual.relocate` can rename the registered resource and/or move its project-local backing file, uses native project-wide resource refactoring for a name change, rejects collisions/shared-file hazards, and defaults to dry-run unless `dryRun=false` is explicit. `resources.visual.delete` also defaults to dry-run: an in-use resource returns a structured usage summary and an apply attempt is rejected as `resource_in_use`; optional physical deletion is limited to an unshared project-local file. These mutations inherit DX-19 project/semantic revision, lease, owner and transaction checks plus the DX-21 canonical response/error envelope. Operation-level file writes roll back their own bytes/resource registration on failure; a later `safety.transactions.rollback` still restores project data only and does not rewind already-written physical bytes.

## Current command families

The registry currently exposes command families for:

- project lifecycle: `project.*`;
- native GDevelop EditorFunctions: `editor.functions.*`;
- scene/editor visual context: `scene.open`, `editor.visual.status`, `editor.instances.select`, `editor.selection.focus`;
- deterministic events: `events.read`, granular `events.patch`, localized `events.insert/update/style.update/move/delete`, and bulk `events.apply`;
- resources/assets: `resources.*`, including project-aware UTF-8/JSON authoring (`resources.text.create/read/update`, `resources.packaging.inspect`), bounded remote URL import/replace with persisted provenance, and deterministic local image/WAV processing (`resources.processing.capabilities`, `resources.image.transform`, `resources.image.slice-spritesheet`, `resources.audio.transform`);
- checkpoints and transactions: `safety.*`;
- diagnostics and aggregate validation: `diagnostics.inspect`, `validation.run`;
- preview lifecycle: `preview.status`, `preview.start`, `preview.hot-reload`, `preview.control`, `preview.close-all`;
- runtime observation/time control: `runtime.status`, `runtime.snapshot`, targeted `runtime.inspect`, `runtime.logs`, `runtime.assert`, `runtime.wait-for`, plus `runtime.time.status/pause/resume/set-scale/step/advance/wait-until`;
- desktop windows/capture: `desktop.windows.list`, `desktop.window.capture`; preview content viewport: `preview.viewport.status`, `preview.viewport.set`;
- preview structural layout QA: `preview.layout.capabilities`, `preview.layout.inspect`, `preview.layout.assert`, `preview.capture.region`;
- preview input: `preview.input.*`;
- preview QA: `preview.qa.capabilities`, `preview.input.record.*`, `preview.input.replay`, `preview.visual.baseline.*`;
- multiplayer preview orchestration: `preview.multiplayer.capabilities`, `preview.multiplayer.clients.*`, `preview.multiplayer.batch`, `preview.multiplayer.runtime-status`;
- bounded network diagnostics: `preview.network.capabilities`, `preview.network.capture.*`;
- granular concurrency and multi-agent isolation: `agent.concurrency.capabilities`, `agent.concurrency.status`, `agent.concurrency.lease.*`, plus owner-scoped managed temporary workspaces under `agent.workspace.temp.*`;
- finite host-managed async QA jobs: `agent.jobs.capabilities`, `agent.jobs.start`, `agent.jobs.status`, `agent.jobs.result`, `agent.jobs.cancel`;
- rich live MCP resources for project/editor/resources/types/runtime/concurrency, with `notifications/resources/updated` after relevant successful mutations;
- build target/configuration discovery and authenticated remote build lifecycle: `build.targets.list`, `build.configuration.*`, `build.start`, `build.status`, `build.cancel`, `build.result`, including the separate `web-online` artifact target;
- opt-in publication: `publication.integrations.list`, `publication.prepare`, `publication.publish`; the gd.games adapter uses only the editor session, requires explicit publication intent plus MCP destructive confirmation, and never accepts or returns credentials;
- local HTML5 output: `export.html5`.

`resources.text.create` and `resources.text.update` write project-local UTF-8 files atomically and register/update the matching native GDevelop resource in the same operation. JSON is parsed before any file/resource mutation; invalid JSON therefore leaves both project revision and file bytes unchanged. Generic `.txt` is not a native GDevelop resource kind, so plain-text authoring requires an explicit compatible native kind such as `javascript`, `atlas` or `bitmapFont`. `resources.packaging.inspect` distinguishes registration from actual object/event usage: a registered file-backed resource can be `userAdded=true`, `usedInProject=false`/`orphaned=true` and still be packaged because the native exporter exposes all registered file-backed resources. Runtime APIs address the registered resource name; export flattens the backing path to a game-root-relative filename with deterministic collision suffixes (`name.ext`, `name2.ext`, ...). The write operation itself can roll back its file/resource change on failure, but a later `safety.transactions.rollback` restores project data only and does not restore physical file bytes.

`desktop.window.capture` is returned as MCP `image/png` content instead of embedding PNG bytes in a JSON text payload. Capture waits boundedly for page loading to settle, retries empty captures a small bounded number of times, and falls back from Electron `capturePage()` to `desktopCapturer` by media source id/title. Success metadata reports `captureMethod`, `attempts`, readiness, window state and source/output dimensions. Persistent empty captures keep the stable `window_capture_empty` error code but include an actionable reason such as `window_minimized`, `window_hidden`, `loading`, `desktop_source_not_found` or `persistent_empty_capture`; retries never hide a persistent failure.

`preview.qa.capabilities` is capability-driven: normalized keyboard/mouse record/replay, runtime reset, exact/pixel-tolerance/perceptual PNG baseline comparison, optional PNG heatmaps, MCP-native structural layout inspection/assertions with bounds-based region capture, and exact content-viewport resize are available. `preview.layout.inspect`/`preview.layout.assert` use live runtime object geometry for clipping, containment, overlap, gap, alignment, safe-area and text-fit checks; `preview.capture.region` can crop by explicit rectangle or resolved runtime object bounds. Structural checks complement rather than replace pixel/perceptual screenshot review; see [`docs/RUNTIME_LAYOUT_INSPECTION.md`](./docs/RUNTIME_LAYOUT_INSPECTION.md). `preview.visual.baseline.compare` preserves `exact` as the default compatibility mode, adds configurable per-channel/pixel-ratio/mean-difference thresholds, and adds a pure-JavaScript block-luminance perceptual mode with configurable internal block/downscale size. Results include similarity, different-pixel ratio, mean/max difference and bounded divergent regions (`x/y/width/height`, difference ratio and severity); `includeDiffImage=true` returns a PNG heatmap through normal MCP image content. PNG decoding/encoding uses Node zlib only—no Python, OpenCV or external service. Ignore-region masks are still unsupported. `preview.viewport.set` uses Electron `setContentSize()` and verifies `getContentBounds()` plus renderer `window.innerWidth/innerHeight` when available, so callers specify logical content size directly in device-independent pixels without compensating for title bars, DPI scaling or OS chrome. It can restore minimized/maximized/fullscreen/hidden previews before sizing, waits boundedly for the requested viewport, and returns requested/actual content viewport separately from outer bounds. Fixed timestep, seeded randomness, devicePixelRatio emulation, orientation emulation and safe-area emulation remain reported as unsupported until reliable primitives exist.

`preview.multiplayer.*` discovers the live external preview BrowserWindows already created by GDevelop (including `preview.start({ numberOfWindows: N })`), then lets a client assign bounded stable aliases such as `host`/`guest` and address ordered input/runtime-status batches by alias. Aliases are process-local orchestration state and are pruned when their preview closes; they do not modify or persist in the project.

`preview.network.capture.*` uses Electron's `webContents.debugger`/CDP `Network` domain only for an explicitly aliased preview. Capture is bounded (maximum 2000 recent events), redacts credential-bearing URL query fields and sensitive headers by default, records HTTP request/response/failure metadata and WebSocket lifecycle/handshake metadata, and intentionally omits response bodies and WebSocket frame payloads. It refuses to attach when another debugger client already owns that `webContents`. Network shaping/latency/loss simulation is reported as unsupported rather than emulated through an unreliable hidden mechanism.

### Preview debugger lifecycle

`preview.status` reports one authoritative lifecycle instead of treating a visible preview window and an attached runtime debugger as the same thing. The states are `starting`, `window-open`, `debugger-attaching`, `ready`, `stopped` and `failed`. Its `targets` array maps each preview `windowId` to its `debuggerId` when the runtime identity handshake is complete and reports whether that target is runtime-ready. If there is exactly one preview window and exactly one status-ready debugger, that 1:1 pair is deterministic even when the identity announcement arrives late; multiple preview targets are never guessed.

`preview.start` accepts `waitUntilReady: true` plus bounded `readyTimeoutMs` (100–30000 ms) when the caller needs a runtime-ready target before continuing. Without the wait option it remains backward-compatible and may return while the lifecycle is still progressing. Timeout/failure diagnostics include the current lifecycle state, preview window ids, debugger ids and target mappings.

`runtime.status`, `runtime.logs` and `runtime.snapshot` use the same preview-debugger authority. If a preview window exists but the debugger is still attaching, runtime calls report `preview_runtime_not_ready` instead of `preview_not_running`. Once ready, runtime responses expose the same `debuggerId`, mapped `previewWindowId` and `lifecycleState`; desktop snapshots are directed to the BrowserWindow associated with that debugger target. `preview.close-all` does not synchronously re-inspect windows while Electron is destroying them; the next `preview.status` refresh establishes the stopped state. This lifecycle remains read-only from the project perspective.

### Targeted runtime inspection

`runtime.inspect` reads one value from the live preview without modifying the project or injecting QA events. Selectors cover `global-variable`, `scene-variable`, `scene-time`, `object-count`, `object-instance`, `object-property` and `object-variable`. `scene-time` exposes `time-from-start-ms`, `elapsed-time-ms` and `time-scale` from the runtime scene TimeManager. Object selectors can target an instance by zero-based `instanceIndex` or runtime `instanceId`; variable selectors accept dotted/array paths such as `Config.Locale` or `Inventory[0].Count`. Common object properties include position/layer/visibility plus `text`, `opacity`, animation and flip state when the runtime object exposes those getters.

`runtime.assert` and `runtime.wait-for` accept the same selector in `condition.selector`; the older snapshot `condition.path` form remains supported. Missing scene/object/instance/variable/property state returns typed diagnostics rather than requiring JavaScript instrumentation, and selector-based inspection remains read-only from the project perspective.

### Deterministic runtime time control

`runtime.time.status` reports the authoritative debugger pause/running state, active scene, current scene `timeScale`, scene simulated time and whether deterministic stepping is ready. `runtime.time.pause`/`resume` operate only on the active preview runtime. `runtime.time.set-scale` changes the live scene TimeManager only; it does not edit Event Sheets/project JSON and a newly started preview returns to the project/default time scale.

`runtime.time.step` requires the runtime to be paused and advances exactly one or N frames by calling the same `SceneStack.step(dt)` + input-frame-ending path used by GDevelop's official gameplay-test harness. `runtime.time.advance` advances a bounded amount of **simulated game time**, accounting for the active time scale and returning the actual simulated milliseconds plus frames advanced. Both can request an immediate post-step snapshot and/or `runtime.assert` condition without a sleep between advancement and observation. Results explicitly distinguish `elapsedSimulatedTimeMs` from `wallClockElapsedMs` and report `wallClockWaitUsed: false` for simulation advancement.

`runtime.time.wait-until` replaces ad-hoc polling sleeps for deterministic QA: it evaluates the normal runtime selector/path condition, steps one paused frame when false, and repeats up to `maxFrames`. The final snapshot is the exact simulated checkpoint where the predicate passed or the deterministic bound was reached. For time-based predicates use selector `{kind:"scene-time", metric:"time-from-start-ms"}`.

DX-22 input remains a separate explicit surface: send/sequence input while paused with `preview.input.*`, then call `runtime.time.step`; `InputManager.onFrameEnded()` is executed after the stepped game frame, preserving deterministic input/frame ordering. DX-25 finite jobs include `runtime.time.*` in their eligible step commands, so bounded observation sequences can outlive one MCP transport request without introducing an unmanaged background loop.

### Event execution tracing and breakpoint-style diagnostics

`runtime.event-trace.configure` enables a bounded, preview-local trace buffer without changing the project or Event Sheets. Generated GDJS code emits lightweight runtime hooks carrying structural event/instruction paths; the MCP service resolves those paths against the current `events.read` revision to return the same stable event/action/condition handles used by DX-3/DX-20. Filters can target one or more handles, scene, instruction kind, descendants, generated `sourceNamespace`, typed authoring object/group names, runtime instance ids where the hook exposes target context, maximum records, maximum frames and maximum simulated milliseconds. Object-name filtering uses instruction metadata rather than arbitrary string matching. Instance filtering never infers identity from object order: hooks without instance context report `event_trace_instance_context_unavailable`/filter counts instead. `mode=summary` omits instruction-before noise and raw authoring parameters; `mode=detailed` retains before/after instruction records. `runtime.event-trace.read` maps records back to stable handles, parent/subevent branch paths and condition/action order, and reports disabled events, filtered-record reasons and deterministic short-circuit reasons where they can be proven from source and observed false conditions.

Condition records include true/false results. Parameter reporting is side-effect-safe: authoring parameter strings are returned, and numeric/boolean/quoted literals are additionally decoded; dynamic expressions are **not** re-evaluated just for tracing. Action records include their authoring parameters, which preserves target object/group names when those are present in the instruction contract. External-event links can be flattened by GDevelop preprocessing, and generated extension functions use their own source namespaces; the runtime preserves `sourceNamespace`, but MCP does not fabricate an external/function stable handle when the generated structural path cannot be authoritatively matched to that source sheet.

Breakpoint entries accepted by `runtime.event-trace.configure` target stable event/action/condition handles and `before`/`after`/`branch` phases. Because generated JavaScript execution is synchronous, a matching hook requests `RuntimeGame.pause(true)` and execution pauses at the **next frame boundary** rather than suspending halfway through the current Event Sheet frame; `runtime.debugger.capabilities` reports this precision explicitly. `runtime.event-trace.watch` composes DX-35 pause/step with `runtime.inspect`: it steps simulated frames until the selected variable/property changes or the bound is reached, then returns before/after values together with the correlated Event Sheet trace. `runtime.event-trace.clear` discards the ephemeral buffer. The legacy `runtime.event-trace.capture` profiler-group correlation remains as a coarse fallback when live hooks are unavailable. DX-25 finite jobs allow the bounded `runtime.event-trace.watch` and fallback capture commands.

## Native Event Sheet authoring

External MCP clients can discover the native Event Sheet workflow without repository access through prompt `gdevelop.events-authoring` or resource `gdevelop://guides/native-event-authoring` (`text/markdown`, guide version 3). Both expose the same MCP-native guidance for canonical `eventsJson` versus handles, instruction/expression/node discovery, smallest safe mutations, revisions/transactions, validation/preview/save and live raw responses versus sanitized replay evidence.\n\nFor the repository copy and expanded examples, follow [`docs/MCP_NATIVE_EVENT_AUTHORING.md`](./docs/MCP_NATIVE_EVENT_AUTHORING.md). The key contract is that `events.read.data.eventsJson` is the authoritative canonical serialized payload, while `events.read.data.events` is a normalized handle/navigation tree used with `eventsRevision` for localized addressing. Discover unfamiliar event-node types/fields through `events.nodes.list` + `events.nodes.describe`; discover conditions, actions and expressions through `events.instructions.search` + `events.instructions.describe` (`kind: "expression"` returns expression return types, ordered parameters, ownership and event-context applicability). For one action/condition insert/move/delete, one instruction parameter/flag, or a supported small event field, prefer `events.patch`: it targets stable handles, requires `expectedEventsRevision`, and does not require resending the parent `eventJson`. For visual-only Group/Comment color changes, prefer `events.style.update` so clients send only an abstract `background`/`text` RGB patch rather than resending event logic or subevents. Prefer generated typed `editor.functions.<function-name>` MCP tools over generic `editor.functions.call` for normal single-function calls.

## Recommended live-editing loop

A safe agent workflow is:

1. `project.status` and command discovery;
2. inspect the relevant scene/events/resources;
3. create a checkpoint or begin a transaction for risky work;
4. mutate the live in-memory project through commands/EditorFunctions;
5. open/focus the affected scene and inspect `desktop.window.capture` when visual evidence matters;
6. `preview.start` once, then prefer `preview.hot-reload` during iteration;
7. use `preview.input.*` and `runtime.*` to exercise and observe the actual game;
8. correct the project while keeping the editor/project open;
9. run `diagnostics.inspect` / `validation.run` and review checkpoint diff when appropriate;
10. call `project.save` or `project.save-as` only when saving is explicitly intended;
11. call `build.targets.list` before choosing a delivery target; use `export.html5` for local HTML5 or `build.start` + `build.status` + `build.result` for an available authenticated remote build target;
12. when public gd.games publication is explicitly intended, call `publication.integrations.list`, create/resolve a completed `web-online` build separately, review `publication.prepare`, then call `publication.publish` only after the user confirms the external publication effect.

Mutations never auto-hot-reload as a hidden side effect. After a hot-reload-compatible edit, the agent explicitly calls `preview.hot-reload`; ordinary iteration should keep the existing preview/debugger alive rather than closing and restarting it. `preview.start` is reserved for starting a missing preview, while restart is only used when the underlying GDevelop lifecycle genuinely requires it.

Normal authoring must not close/reopen the project as a synchronization mechanism. Full serialized project reload is reserved for explicit checkpoint/transaction restore where replacing the complete project is the intended safety operation.

## Save and destructive operations

Ordinary authoring commands do not silently save. Opening/closing another project with unsaved changes requires explicit discard input, and destructive command metadata is projected to MCP annotations so clients can present suitable confirmation UX.

Project persistence has an explicit MCP contract. Use `project.persistence.status` to distinguish editor memory from the persisted project JSON: it reports dirty state, the current monotonic project revision, a stable serialized-memory SHA-256, the active local project path, current disk hashes, external-disk-change detection and the last successful save/reload metadata. Preview/export generated output is reported separately and is never treated as persisted project JSON.

Use `project.save`/`project.save-as` only when persistence is intended. They can be guarded with `expectedProjectId`, `expectedFileIdentifier` and `expectedProjectRevision`; a detected external disk change fails with `project_disk_conflict` unless `overwriteExternalChanges=true` is explicit. A successful save reads the project JSON back, returns the persisted hash/revision and reports resource flush state. Follow it with `project.persistence.verify` when acceptance needs proof that the serialized state can be read back and matches an expected persisted hash/revision.

`project.reload` reopens the currently persisted local project and returns the disk hash that must survive the reopen. It never discards dirty editor state unless `discardUnsavedChanges=true` is explicit. Save/reload are blocked while a safety transaction is active, and they honor the project semantic lease/owner identity, so rollback-only or foreign-owned work cannot be persisted accidentally.

Checkpoints and transactions are in-memory safety mechanisms. They are not a replacement for an explicit final save.

## Revisions, retries and recovery

Every project mutation is evaluated against the live in-memory revision. Mutating MCP schemas accept an optional `expectedRevision`; a stale precondition fails with `revision_conflict` instead of overwriting a user or another agent's intervening change. Mutations may also carry an `idempotencyKey`: retrying the same command with the same key and input returns the original result, while reusing the key with different input is rejected.

CAP-22/23 adds optional semantic concurrency without weakening that project-wide safety net. DX-19 binds MCP callers to stable request identity derived from `X-GDevelop-Client-Id`, `X-GDevelop-Agent-Id`, `X-GDevelop-Session-Id` and optional `X-GDevelop-Task-Id`; mutations record that identity in result/audit context. Mutating tools accept `expectedSemanticRevisions` keyed by descriptor-declared scope (falling back to `project`); successful mutations advance only their semantic scopes and return the resulting revisions in command metadata. `agent.concurrency.lease.acquire/renew/release` provides process-local owner-aware leases with bounded TTL (1–300 seconds), acquired/heartbeat/expiry metadata and caller-identity ownership. Leases are cooperative concurrency controls, never persisted in the project, and a foreign mutation against a leased scope fails with `semantic_scope_locked`. Active safety transactions expose owner/purpose/start time; foreign commit/rollback is rejected and foreign project mutations fail with `transaction_scope_locked`. Project-wide stale writes return `revision_conflict` with `conflictScope`, expected/actual revision and the last mutation identity so the caller can reconcile and retry safely.

`agent.workspace.temp.*` provides MCP-managed temporary namespaces under the host temp directory. Each namespace is bound to the caller's agent/session owner key and optional task id; two agents can use the same relative artifact path without collision, cross-owner access is rejected, and overwriting an existing artifact requires an explicit `overwrite=true`. Cleanup is deterministic through explicit release on normal completion/rollback workflows, bounded TTL/heartbeat expiry for stalled or disconnected clients, and host-dispose cleanup. Namespace paths reject traversal and writes are bounded/atomic. These temporary artifacts are host-local helper state and never mutate or persist in the GDevelop project.

Risky multi-step work should use explicit `safety.*` checkpoint/transaction handles. Handles are application state, not transport-session state, so reconnecting an MCP client does not require reopening the project. Long-running commands expose a bounded process-local `operationId` through result metadata and `gdevelop://mcp/operations`; completed/cancelled status remains queryable by a fresh client while the same GDevelop process is alive.

`agent.jobs.*` is the MCP-native control plane for finite expensive QA that must outlive one transport request. `agent.jobs.start` validates a bounded allowlist of non-project-mutating QA/runtime commands, records the DX-19 agent/session owner plus optional task id and selected editor targeting, schedules the steps on the editor host event loop, and returns immediately with a stable `jobId` plus host `serverSessionId`. The initiating request signal is deliberately not reused by the job: each subcommand keeps its ordinary command/request timeout while `jobTimeoutMs` is an independent aggregate deadline. A reconnect using the same agent/session/task can continue with `agent.jobs.status` or `agent.jobs.result`; cross-owner or wrong-task access is rejected through the canonical DX-21 error envelope.

Async job progress is structured as `completed`, `total`, `phase` and lifecycle timestamps. Every lifecycle/progress/result/diagnostic record carries a monotonically increasing `sequence`; `afterSequence` plus `limit` provides incremental cursor polling. `agent.jobs.result` returns structured per-step canonical envelopes and normalized diagnostics, so callers never need to parse logs. `fail-fast` stops after the first failed step and reports the remainder as skipped; `continue-on-error` runs all eligible steps and finishes failed if any step failed. On success, failure, timeout, cancellation or host disposal, host cleanup stops network captures and input recordings started by the job, releases pressed input and restores each touched preview viewport to its pre-job size. One-shot capture payloads are reduced in job results to bounded structured artifact metadata (`mimeType`, byte length and SHA-256) rather than retaining unbounded image bytes; use ordinary capture tools when the image payload itself is required. No shell process or unmanaged background worker participates in the supported job flow.

MCP `2026-07-28` destructive flows use `input_required` for discard/overwrite/delete decisions when the client supports the required elicitation capability. Gameplay, validation, EditorFunction batches and export propagate client cancellation cooperatively through the Electron/renderer boundary. Native editor calls already executing are not force-killed mid-call; cancellation stops subsequent work and prevents later save steps.

## Troubleshooting live sessions

When an agent cannot see or control the expected editor, first run `desktop.windows.list`, then target explicitly with `X-GDevelop-Window-Id` or `X-GDevelop-Project-Path`. Do not close/reopen the project merely to repair targeting.

If preview state looks stale, check `preview.status` and `runtime.status`. Start a preview only when none is running; after compatible project mutations use `preview.hot-reload`, then `runtime.snapshot`, `runtime.logs` or `runtime.assert` to verify the live result. A missing debugger/preview is a lifecycle issue, not a reason to serialize/reload the project.

For gameplay-test failures, inspect the structured validation result and runtime logs before retrying. Tests default to ephemeral/non-persistent execution unless persistence is explicitly requested. For export failures, keep the editor open, inspect the returned structured error (`code`, `retryable`, `hint`, `recovery`) and retry only when the error contract indicates it is safe.

If an external host cannot connect, verify that the current GDevelop process created `gdevelop-mcp.json`, that the referenced token file still belongs to the same startup, and that the host can send custom Authorization headers over Streamable HTTP. Tokens rotate on restart; stale discovery/token pairs must not be reused.

## Coverage roadmap

See [`docs/GAME_CREATION_COVERAGE_ROADMAP.md`](./docs/GAME_CREATION_COVERAGE_ROADMAP.md) for the capability roadmap from the current live-editing MCP surface to near-complete autonomous game creation coverage, including discovery, custom extensions, External Events/Layouts, asset/docs integration, typed tools, build targets, debugging, deterministic QA, multiplayer and publication boundaries.

For the post-roadmap developer-experience gaps exposed by real autonomous authoring — especially canonical `eventsJson` versus normalized handles, event-node schema introspection, instruction/expression discovery, visual Event Sheet styling and external-client connection ergonomics — see [`docs/MCP_INTROSPECTION_AGENT_DX.md`](./docs/MCP_INTROSPECTION_AGENT_DX.md).

For persistent scene/External Events identity and refactor-safe project structure lifecycle (`project.scenes.*`, External Events usages/duplicate/reorder/dry-run delete), see [`docs/MCP_PROJECT_STRUCTURE_LIFECYCLE.md`](./docs/MCP_PROJECT_STRUCTURE_LIFECYCLE.md).

For the canonical versioned `tools/call` success/error envelope, stable metadata, pagination semantics and external-client parsing contract, see [`docs/MCP_RESPONSE_CONTRACT.md`](./docs/MCP_RESPONSE_CONTRACT.md) or the live resource `gdevelop://guides/response-contract`.

## 3D workflows

For material 3D work, use the dedicated quality guidance:

- [`docs/MAP_BUILDER.md`](./docs/MAP_BUILDER.md) — mechanics-first level construction;
- [`docs/3D_QUALITY_GATE.md`](./docs/3D_QUALITY_GATE.md) — structural, visual and gameplay acceptance evidence.

## External MCP client helper and one-off CLI

External Node clients should use `scripts/McpClient.js` instead of duplicating discovery/auth/transport bootstrap. `connectLiveGDevelopMcp` re-reads `gdevelop-mcp.json` on each connection, reads the bearer credential only for the transport, pins the advertised protocol version, supports optional window/project targeting and returns a session with `listTools()`, `listPrompts()`, `getPrompt()`, `listResources()`, `readResource()`, `call(name, args)` and `close()`. The session result never exposes the bearer token and does not retry failed calls implicitly. `scripts/McpCleanRoomEventAuthoringLiveScenario.js` is the clean-room acceptance: during the scenario it blocks repository reads, derives authoring contracts from MCP only, and persists sanitized evidence to `docs/evidence/DX9_CLEAN_ROOM_ACCEPTANCE.json` after live authoring is complete.

```js
const {
  connectLiveGDevelopMcp,
} = require('./app/AgentIntegration/scripts/McpClient');

const session = await connectLiveGDevelopMcp({ clientId: 'my-agent' });
try {
  const status = await session.call('project.status', {});
  console.log(status.data);
} finally {
  await session.close();
}
```

For one-off inspection, `McpToolCall.js` provides the same targeting/discovery contract without writing an ad hoc client:

```text
cd newIDE/electron-app
node app/AgentIntegration/scripts/McpToolCall.js project.status
node app/AgentIntegration/scripts/McpToolCall.js events.read --json "{\"sceneName\":\"CoinIdle\"}"
node app/AgentIntegration/scripts/McpToolCall.js events.read --json-file args.json --sanitized
```

The CLI defaults to **raw structured output**: this is the live authoritative MCP result to use for authoring decisions, including complete `events.read.data.eventsJson`. `--sanitized` instead emits replay/evidence JSON with credential-like keys removed; sanitized evidence is not an authoring contract. `--json-file` avoids command-line-length problems for larger inputs. Any tool that is not explicitly read-only, is destructive, or modifies the project is blocked unless `--allow-mutate` is supplied. This local opt-in does not bypass MCP elicitation/confirmation for destructive operations. Discovery credentials and Authorization headers are never printed.

## Live read-only gate

With the desktop editor already running, the repository includes a read-only gate built on `connectLiveGDevelopMcp` that generates a sanitized replay without printing credentials:

```text
cd newIDE/electron-app
node app/AgentIntegration/scripts/McpLiveGate.js
```

Useful targeting/output options:

```text
node app/AgentIntegration/scripts/McpLiveGate.js --window-id 1 --output mcp-live-replay.json
node app/AgentIntegration/scripts/McpLiveGate.js --project-path C:\\path\\to\\game.json
```

The gate calls only read-only discovery/status surfaces: `tools/list`, `agent.capabilities`, `project.status`, `desktop.windows.list`, `editor.visual.status`, `preview.status`, `publication.integrations.list` and `runtime.status` when each is available. It does not mutate or save the project. Use it to prove that a real external-style client can discover and inspect the currently running editor before running any canonical mutation scenario.

For CAP-11/12, a dedicated mutation acceptance scenario requires a fresh editor with no project open. It creates and saves a temporary project, imports a public image through `resources.import-url`, verifies redacted persisted provenance, performs deterministic image and PCM16 WAV transforms, uses the processed image in a Sprite preview, exports HTML5, rolls the transaction back and removes the temporary project by default:

```text
cd newIDE/electron-app
node app/AgentIntegration/scripts/McpRemoteResourcesProcessingLiveScenario.js --allow-mutate
```

The scenario writes only sanitized replay/export evidence to its output directory; use `--output <dir>` to choose that directory. `--keep-project` preserves the otherwise temporary saved project for diagnosis.

For DX-18, `McpVisualDiffLiveScenario.js` is a clean-room visual-regression acceptance. It creates three temporary scenes entirely through MCP with baseline (`#808080`), visually close (`#828282`) and materially different (`#f00000`) backgrounds, captures one stored baseline, proves exact identity, proves the close render passes pixel-tolerance and perceptual thresholds, proves the material change fails with quantitative metrics and divergent regions, and verifies that `includeDiffImage=true` returns a real PNG heatmap through MCP. The comparison path is pure JavaScript/Node zlib and uses no PowerShell, Python, OpenCV or external service.

```text
cd newIDE/electron-app
node app/AgentIntegration/scripts/McpVisualDiffLiveScenario.js --label live
```

For DX-23, `McpPreviewLayoutLiveScenario.js` creates a temporary text-object fixture without Event Sheet instrumentation, starts one real preview at an exact 1280x720 content viewport, resolves live runtime identity/transformed bounds/visibility, proves deliberate viewport clipping plus text overflow are returned as structured violations, captures only the resolved object's visible screen bounds through `preview.capture.region`, and verifies that the project revision is unchanged across the inspect/assert/capture phase.

```text
cd newIDE/electron-app
node app/AgentIntegration/scripts/McpPreviewLayoutLiveScenario.js --label live
```

For DX-16, `McpTextResourcesLiveScenario.js` is a clean-room project-resource acceptance. It creates a saved temporary project, adds `locales/es.json` entirely through MCP, reads and updates it, proves invalid JSON changes neither revision nor file bytes, verifies the actual flattened resource in a live preview and local HTML5 export, saves the clean project, and removes the temporary project directory after the editor closes it. The scenario does not use direct filesystem orchestration to create or register the locale file.

```text
cd newIDE/electron-app
node app/AgentIntegration/scripts/McpTextResourcesLiveScenario.js --label live
```

For CAP-14, `McpBuildTargetsLiveScenario.js` validates capability-driven target discovery, an explicit machine-readable unsupported iOS target, native package/version/orientation/loading-screen round-trip and local HTML5 export. Remote installable builds are deliberately separate: `--allow-remote-build` opts in to consuming one available build quota slot with `payWithCredits=false`, and `--require-installable` turns a completed Windows EXE into a mandatory acceptance gate. Provider credentials, user ids, upload bucket keys and log keys are sanitized from tool results/replays.

```text
cd newIDE/electron-app
node app/AgentIntegration/scripts/McpBuildTargetsLiveScenario.js --allow-mutate
node app/AgentIntegration/scripts/McpBuildTargetsLiveScenario.js --allow-mutate --allow-remote-build --require-installable
```

`build.cancel` is intentionally truthful: the current GDevelop Build API does not expose a cancellation endpoint, so a provider-started build returns `supported: false` / `reasonCode: "provider_cancel_not_supported"`; AgentIntegration does not misuse build deletion as cancellation.

For CAP-20/21, `McpMultiplayerNetworkLiveScenario.js` creates a temporary project, starts two real external preview windows in one call, assigns `host`/`guest` aliases, checks cross-client runtime state, sends an ordered aliased input/status batch, exercises bounded network-capture start/status/read/stop on one preview, then closes previews and proves transaction rollback without reopening the project. An offline empty scene can legitimately produce zero captured network events; the acceptance verifies the real CDP lifecycle and does not fabricate traffic.

```text
cd newIDE/electron-app
node app/AgentIntegration/scripts/McpMultiplayerNetworkLiveScenario.js --allow-mutate
```

For CAP-22/23, `McpConcurrencyResourcesLiveScenario.js` verifies the packaged editor's granular concurrency and rich-resource contract: it acquires a project-scope lease, proves a foreign mutation is rejected, performs a mutation with both project-wide and semantic revision preconditions as the lease owner, verifies the semantic revision advances, reads every rich resource through the official MCP client, releases the lease and rolls the project transaction back without reopening the project.

```text
cd newIDE/electron-app
node app/AgentIntegration/scripts/McpConcurrencyResourcesLiveScenario.js --allow-mutate
```

For CAP-24, `McpPublicationLiveScenario.js` is deliberately read-only. It proves the packaged editor exposes the `gd-games` adapter, credential policy, dry-run/publish annotations and the separate `web-online` build prerequisite without creating a remote build or changing a public game. Real publication remains behind `publication.prepare`, `confirmPublication=true` and MCP destructive elicitation.

```text
cd newIDE/electron-app
node app/AgentIntegration/scripts/McpPublicationLiveScenario.js --output artifacts/cap24-publication.json
```

## Compatibility and tests

See [`docs/MCP_COMPATIBILITY.md`](./docs/MCP_COMPATIBILITY.md) for the automated client matrix, live-host acceptance gate, protocol policy and host configuration rules.

The MCP adapter is covered with the official MCP client for protocol negotiation, `tools/list`, `tools/call`, `prompts/list`, `prompts/get`, `resources/list`, `resources/read`, auth/Origin rejection, renderer dispatch, desktop capture and preview input. Renderer services retain characterization tests for project authoring, safety, runtime, resources, diagnostics and visual operations.

Until the final naming consolidation moves the guard, run from the repository root:

```text
node newIDE/electron-app/app/AgentIntegration/ArchitectureGuard.js upstream/master
```

The gate must report that changes outside AgentIntegration-owned code remain limited to the three upstream hooks listed above.
