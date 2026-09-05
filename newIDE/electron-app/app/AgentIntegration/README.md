# GDevelop AgentIntegration — MCP live editing

AgentIntegration exposes the **currently running GDevelop desktop editor** to MCP-capable agents. The agent works against the same in-memory project and editor UI the user is looking at: mutations are applied through GDevelop's native editor capabilities, the UI is refreshed through the existing editor callbacks, previews can be hot-reloaded and inspected, and saving remains explicit.

MCP is the only public agent protocol. The former REST `/v1` surface has been removed.

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

The server is modern-only: legacy MCP protocol traffic is rejected rather than silently changing the contract.

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
- **resource exhaustion**: authenticated HTTP bodies are capped at 4 MiB, JSON nesting at 64 levels, concurrent authenticated requests at 32 globally and 8 per admission client, local resource source files at 256 MiB and PNG capture results at 16 MiB;
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
- resources/assets: `resources.*`;
- checkpoints and transactions: `safety.*`;
- diagnostics and aggregate validation: `diagnostics.inspect`, `validation.run`;
- preview lifecycle: `preview.status`, `preview.start`, `preview.hot-reload`, `preview.control`, `preview.close-all`;
- runtime observation: `runtime.status`, `runtime.snapshot`, `runtime.logs`, `runtime.assert`, `runtime.wait-for`;
- desktop windows/capture: `desktop.windows.list`, `desktop.window.capture`;
- preview input: `preview.input.*`;
- HTML5 output: `export.html5`.

`desktop.window.capture` is returned as MCP `image/png` content instead of embedding PNG bytes in a JSON text payload.

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
11. use `export.html5` when an output build is required.

Normal authoring must not close/reopen the project as a synchronization mechanism. Full serialized project reload is reserved for explicit checkpoint/transaction restore where replacing the complete project is the intended safety operation.

## Save and destructive operations

Ordinary authoring commands do not silently save. Opening/closing another project with unsaved changes requires explicit discard input, and destructive command metadata is projected to MCP annotations so clients can present suitable confirmation UX.

Checkpoints and transactions are in-memory safety mechanisms. They are not a replacement for an explicit final save.

## 3D workflows

For material 3D work, use the dedicated quality guidance:

- [`docs/MAP_BUILDER.md`](./docs/MAP_BUILDER.md) — mechanics-first level construction;
- [`docs/3D_QUALITY_GATE.md`](./docs/3D_QUALITY_GATE.md) — structural, visual and gameplay acceptance evidence.

## Tests and upstream isolation

The MCP adapter is covered with the official MCP client for protocol negotiation, `tools/list`, `tools/call`, auth/Origin rejection, renderer dispatch, desktop capture and preview input. Renderer services retain characterization tests for project authoring, safety, runtime, resources, diagnostics and visual operations.

Until the final naming consolidation moves the guard, run from the repository root:

```text
node newIDE/electron-app/app/AgentIntegration/ArchitectureGuard.js upstream/master
```

The gate must report that changes outside AgentIntegration-owned code remain limited to the three upstream hooks listed above.
