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

## Discovering commands

MCP tools are generated from the live command registry. Useful discovery commands include:

- `agent.capabilities`
- `agent.commands.list`
- `agent.commands.describe`
- `project.status`
- `editor.functions.list`
- `editor.functions.describe`

Do not maintain a separate hard-coded tool catalog in clients. Call `tools/list` or the registry discovery commands so the client sees the exact build it is connected to.

## Current command families

The registry currently exposes command families for:

- project lifecycle: `project.*`;
- native GDevelop EditorFunctions: `editor.functions.*`;
- scene/editor visual context: `scene.open`, `editor.visual.status`, `editor.instances.select`, `editor.selection.focus`;
- deterministic events: `events.read`, `events.apply`;
- resources/assets: `resources.*`, including bounded remote URL import/replace with persisted provenance plus deterministic local image/WAV processing (`resources.processing.capabilities`, `resources.image.transform`, `resources.image.slice-spritesheet`, `resources.audio.transform`);
- checkpoints and transactions: `safety.*`;
- diagnostics and aggregate validation: `diagnostics.inspect`, `validation.run`;
- preview lifecycle: `preview.status`, `preview.start`, `preview.hot-reload`, `preview.control`, `preview.close-all`;
- runtime observation: `runtime.status`, `runtime.snapshot`, `runtime.logs`, `runtime.assert`, `runtime.wait-for`;
- desktop windows/capture: `desktop.windows.list`, `desktop.window.capture`;
- preview input: `preview.input.*`;
- preview QA: `preview.qa.capabilities`, `preview.input.record.*`, `preview.input.replay`, `preview.visual.baseline.*`;
- multiplayer preview orchestration: `preview.multiplayer.capabilities`, `preview.multiplayer.clients.*`, `preview.multiplayer.batch`, `preview.multiplayer.runtime-status`;
- bounded network diagnostics: `preview.network.capabilities`, `preview.network.capture.*`;
- build target/configuration discovery and authenticated remote build lifecycle: `build.targets.list`, `build.configuration.*`, `build.start`, `build.status`, `build.cancel`, `build.result`;
- local HTML5 output: `export.html5`.

`desktop.window.capture` is returned as MCP `image/png` content instead of embedding PNG bytes in a JSON text payload.

`preview.qa.capabilities` is capability-driven: normalized keyboard/mouse record/replay, runtime reset and exact PNG SHA-256 baselines are available. Fixed timestep, seeded randomness, decoded pixel-tolerance/ignore-region comparison and content viewport/DPR/orientation/safe-area emulation are reported as unsupported until the preview runtime exposes reliable primitives for them.

`preview.multiplayer.*` discovers the live external preview BrowserWindows already created by GDevelop (including `preview.start({ numberOfWindows: N })`), then lets a client assign bounded stable aliases such as `host`/`guest` and address ordered input/runtime-status batches by alias. Aliases are process-local orchestration state and are pruned when their preview closes; they do not modify or persist in the project.

`preview.network.capture.*` uses Electron's `webContents.debugger`/CDP `Network` domain only for an explicitly aliased preview. Capture is bounded (maximum 2000 recent events), redacts credential-bearing URL query fields and sensitive headers by default, records HTTP request/response/failure metadata and WebSocket lifecycle/handshake metadata, and intentionally omits response bodies and WebSocket frame payloads. It refuses to attach when another debugger client already owns that `webContents`. Network shaping/latency/loss simulation is reported as unsupported rather than emulated through an unreliable hidden mechanism.

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
11. call `build.targets.list` before choosing a delivery target; use `export.html5` for local HTML5 or `build.start` + `build.status` + `build.result` for an available authenticated remote build target.

Mutations never auto-hot-reload as a hidden side effect. After a hot-reload-compatible edit, the agent explicitly calls `preview.hot-reload`; ordinary iteration should keep the existing preview/debugger alive rather than closing and restarting it. `preview.start` is reserved for starting a missing preview, while restart is only used when the underlying GDevelop lifecycle genuinely requires it.

Normal authoring must not close/reopen the project as a synchronization mechanism. Full serialized project reload is reserved for explicit checkpoint/transaction restore where replacing the complete project is the intended safety operation.

## Save and destructive operations

Ordinary authoring commands do not silently save. Opening/closing another project with unsaved changes requires explicit discard input, and destructive command metadata is projected to MCP annotations so clients can present suitable confirmation UX.

Checkpoints and transactions are in-memory safety mechanisms. They are not a replacement for an explicit final save.

## Revisions, retries and recovery

Every project mutation is evaluated against the live in-memory revision. Mutating MCP schemas accept an optional `expectedRevision`; a stale precondition fails with `revision_conflict` instead of overwriting a user or another agent's intervening change. Mutations may also carry an `idempotencyKey`: retrying the same command with the same key and input returns the original result, while reusing the key with different input is rejected.

Risky multi-step work should use explicit `safety.*` checkpoint/transaction handles. Handles are application state, not transport-session state, so reconnecting an MCP client does not require reopening the project. Long-running commands expose a bounded process-local `operationId` through result metadata and `gdevelop://mcp/operations`; completed/cancelled status remains queryable by a fresh client while the same GDevelop process is alive.

MCP `2026-07-28` destructive flows use `input_required` for discard/overwrite/delete decisions when the client supports the required elicitation capability. Gameplay, validation, EditorFunction batches and export propagate client cancellation cooperatively through the Electron/renderer boundary. Native editor calls already executing are not force-killed mid-call; cancellation stops subsequent work and prevents later save steps.

## Troubleshooting live sessions

When an agent cannot see or control the expected editor, first run `desktop.windows.list`, then target explicitly with `X-GDevelop-Window-Id` or `X-GDevelop-Project-Path`. Do not close/reopen the project merely to repair targeting.

If preview state looks stale, check `preview.status` and `runtime.status`. Start a preview only when none is running; after compatible project mutations use `preview.hot-reload`, then `runtime.snapshot`, `runtime.logs` or `runtime.assert` to verify the live result. A missing debugger/preview is a lifecycle issue, not a reason to serialize/reload the project.

For gameplay-test failures, inspect the structured validation result and runtime logs before retrying. Tests default to ephemeral/non-persistent execution unless persistence is explicitly requested. For export failures, keep the editor open, inspect the returned structured error (`code`, `retryable`, `hint`, `recovery`) and retry only when the error contract indicates it is safe.

If an external host cannot connect, verify that the current GDevelop process created `gdevelop-mcp.json`, that the referenced token file still belongs to the same startup, and that the host can send custom Authorization headers over Streamable HTTP. Tokens rotate on restart; stale discovery/token pairs must not be reused.

## Coverage roadmap

See [`docs/GAME_CREATION_COVERAGE_ROADMAP.md`](./docs/GAME_CREATION_COVERAGE_ROADMAP.md) for the capability roadmap from the current live-editing MCP surface to near-complete autonomous game creation coverage, including discovery, custom extensions, External Events/Layouts, asset/docs integration, typed tools, build targets, debugging, deterministic QA, multiplayer and publication boundaries.

## 3D workflows

For material 3D work, use the dedicated quality guidance:

- [`docs/MAP_BUILDER.md`](./docs/MAP_BUILDER.md) — mechanics-first level construction;
- [`docs/3D_QUALITY_GATE.md`](./docs/3D_QUALITY_GATE.md) — structural, visual and gameplay acceptance evidence.

## Live read-only gate

With the desktop editor already running, the repository includes a read-only client that connects through the same discovery/token files used by external MCP hosts and generates a sanitized replay without printing credentials:

```text
cd newIDE/electron-app
node app/AgentIntegration/scripts/McpLiveGate.js
```

Useful targeting/output options:

```text
node app/AgentIntegration/scripts/McpLiveGate.js --window-id 1 --output mcp-live-replay.json
node app/AgentIntegration/scripts/McpLiveGate.js --project-path C:\\path\\to\\game.json
```

The gate calls only read-only discovery/status surfaces: `tools/list`, `agent.capabilities`, `project.status`, `desktop.windows.list`, `editor.visual.status`, `preview.status` and `runtime.status` when each is available. It does not mutate or save the project. Use it to prove that a real external-style client can discover and inspect the currently running editor before running any canonical mutation scenario.

For CAP-11/12, a dedicated mutation acceptance scenario requires a fresh editor with no project open. It creates and saves a temporary project, imports a public image through `resources.import-url`, verifies redacted persisted provenance, performs deterministic image and PCM16 WAV transforms, uses the processed image in a Sprite preview, exports HTML5, rolls the transaction back and removes the temporary project by default:

```text
cd newIDE/electron-app
node app/AgentIntegration/scripts/McpRemoteResourcesProcessingLiveScenario.js --allow-mutate
```

The scenario writes only sanitized replay/export evidence to its output directory; use `--output <dir>` to choose that directory. `--keep-project` preserves the otherwise temporary saved project for diagnosis.

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

## Compatibility and tests

See [`docs/MCP_COMPATIBILITY.md`](./docs/MCP_COMPATIBILITY.md) for the automated client matrix, live-host acceptance gate, protocol policy and host configuration rules.

The MCP adapter is covered with the official MCP client for protocol negotiation, `tools/list`, `tools/call`, `prompts/list`, `prompts/get`, `resources/list`, `resources/read`, auth/Origin rejection, renderer dispatch, desktop capture and preview input. Renderer services retain characterization tests for project authoring, safety, runtime, resources, diagnostics and visual operations.

Until the final naming consolidation moves the guard, run from the repository root:

```text
node newIDE/electron-app/app/AgentIntegration/ArchitectureGuard.js upstream/master
```

The gate must report that changes outside AgentIntegration-owned code remain limited to the three upstream hooks listed above.
