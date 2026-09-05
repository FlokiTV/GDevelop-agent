# GDevelop Agent Integration Architecture

## Goal

Expose the currently open GDevelop editor to AI agents through MCP while keeping the feature easy to review, remove, and maintain upstream.

The integration is one product feature: **AgentIntegration**. MCP is its public protocol, not its implementation core.

## Upstream boundary

Only these existing GDevelop files may contain integration hooks:

- `newIDE/app/src/MainFrame/index.js`
- `newIDE/electron-app/app/main.js`
- `newIDE/electron-app/app/PreviewWindow.js`

All substantive implementation must remain under the AgentIntegration-owned directories. Removing AgentIntegration and reverting these three hooks must restore the upstream editor without residual behavior changes.

## Target structure

Renderer:

```text
newIDE/app/src/AgentIntegration/
  core/          # protocol-agnostic command model and host
  editor/        # project, scene, object, event and asset operations
  runtime/       # preview lifecycle, debugger telemetry, gameplay tests
  safety/        # revisions, checkpoints, transactions and diagnostics
  adapters/      # renderer composition/IPC adapter only
```

Electron:

```text
newIDE/electron-app/app/AgentIntegration/
  desktop/       # window registry, renderer bridge, capture and preview input
  mcp/           # MCP 2026-07-28 transport and protocol projection
```

The renderer and Electron integration now live exclusively under `AgentIntegration`; no parallel legacy feature tree is kept.

## Dependency rule

Dependencies point inward:

```text
MCP / Electron / React adapters
             |
             v
        AgentHost
             |
             v
      CommandRegistry
             |
             v
 editor/runtime/safety services
```

The core must not import MCP, HTTP, Electron or React. Environment-specific capabilities are injected explicitly.

The MCP layer must never call an HTTP compatibility API. The legacy `/v1` Agent API is removed during migration.

## AgentHost and CommandRegistry

`CommandRegistry` is the single source of truth for executable agent capabilities. A command descriptor owns:

- stable internal name;
- description;
- input schema;
- result contract;
- `readOnly`;
- `destructive`;
- `idempotent`;
- `longRunning`;
- `requiresProject`;
- `modifiesProject`;
- timeout policy when applicable;
- deprecation metadata when applicable;
- execution handler.

`AgentHost` receives the live GDevelop environment and executes registry commands. It does not know which protocol requested the command.

EditorFunctions are projected into the registry from generated metadata rather than copied into a second hand-maintained catalog.

## Naming

Internal command names use stable domain names such as:

```text
project.status
project.save
scene.inspect
scene.open
events.read
events.patch
preview.start
runtime.snapshot
```

MCP tool names are a deterministic projection: `gdevelop_` plus the internal command name with dots converted to underscores. Example: `scene.inspect` -> `gdevelop_scene_inspect`.

A command name is not reused for a behaviorally incompatible operation. Breaking changes require a new command/version; deprecated names remain discoverable for a bounded migration window only when necessary.

## State and handles

MCP transport state is not authoritative application state. Each request targets the live editor explicitly through project/window handles supplied or resolved by the desktop integration.

Mutable reads return revision information. Critical mutations accept an expected revision/precondition so a stale agent cannot silently overwrite a user's intervening edit.

Handles must refer to semantic entities, never fragile array indices. Revisions are content/lifecycle fingerprints and must detect edits regardless of whether they came from an agent or the user.

Transactions/checkpoints are explicit handles owned by AgentIntegration, not hidden MCP sessions.

## Errors

Core errors use a structured shape with at least:

```text
code
message
retryable
hint?
details?
currentRevision?
traceId?
```

Protocols may translate framing, but must preserve the core error code and actionable recovery information.

## Live-editing invariants

Normal authoring must satisfy all of the following:

1. the project stays open;
2. mutations modify the live `Project*` in memory;
3. relevant editor UI invalidation is triggered immediately;
4. open tabs, selection and camera are preserved when possible;
5. save is explicit, never an implicit side effect of ordinary mutation;
6. preview uses hot reload when technically valid;
7. close/open project is not a recovery mechanism for normal edits.

Whole-project reload remains acceptable only for operations whose semantics explicitly require it, such as a full serialized checkpoint restore, and must not become a general synchronization strategy.

## MCP protocol

Public protocol target:

- MCP specification `2026-07-28`;
- TypeScript SDK v2 (`@modelcontextprotocol/server`);
- Streamable HTTP on loopback;
- request-scoped/stateless serving where possible;
- explicit authentication and Host/Origin validation;
- MCP tools/resources/prompts generated from AgentIntegration contracts;
- no public REST `/v1` API.

## Acceptance gates

The architecture is not considered complete until:

- ArchitectureGuard reports only the three allowed upstream hooks;
- AgentIntegration core boundary tests reject imports from MCP/HTTP/Electron/React;
- the renderer hook contains composition/registration only, not request routing/business rules;
- the Electron main hook contains installation only, not protocol/business rules;
- the legacy `/v1` server is gone;
- a real MCP client can edit a project already open in GDevelop without close/reopen;
- the same client can inspect, mutate, hot reload, drive preview, observe runtime, validate, save and export;
- removing AgentIntegration plus reverting the three hooks restores the upstream tree cleanly.
