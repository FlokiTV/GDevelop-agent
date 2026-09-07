# AgentIntegration / MCP upstream review

## Scope

This change adds an MCP adapter around a self-contained `AgentIntegration` implementation for live GDevelop desktop editing. MCP is the only public agent protocol; the legacy `/v1` REST surface was removed rather than kept as a parallel compatibility API.

The renderer owns GDevelop project semantics through `AgentHost`, `CommandRegistry` and editor/runtime services. Electron owns window targeting, capture, preview input and the local MCP transport. The MCP layer projects registry descriptors; it does not duplicate project mutation logic.

## Upstream integration boundary

`ArchitectureGuard` permits changes outside AgentIntegration-owned trees only at three existing integration hooks:

1. `newIDE/app/src/MainFrame/index.js` — supplies renderer/editor callbacks.
2. `newIDE/electron-app/app/main.js` — installs the desktop AgentIntegration lifecycle.
3. `newIDE/electron-app/app/PreviewWindow.js` — exposes preview identity to isolated desktop/runtime services.

Normal authoring never reloads the full serialized project to synchronize state. Full replacement is reserved for explicit checkpoint/transaction restore.

## Protocol policy

The primary MCP revision is `2026-07-28` over loopback Streamable HTTP. The same endpoint accepts `2025-11-25` using the official SDK's stateless fallback because current MCP Inspector v2.5.0 initiates that revision. This compatibility path has no separate server, state machine or GDevelop logic.

Tool schemas, descriptions and execution metadata originate in `CommandRegistry`. MCP adds transport concerns only: protocol projection, bearer auth, targeting headers, cache hints, tracing, structured error projection, progress/input-required handling and compatibility encoding.

There is no stdio shim today. It should be added only if a required host cannot use Streamable HTTP, and must remain a stateless transport bridge with no editor business logic.

## Concurrency and mutation safety

- project and event revisions provide optimistic concurrency preconditions;
- `idempotencyKey` makes safe retries deterministic and rejects key reuse with different input;
- explicit checkpoint/transaction handles scope risky multi-step work;
- event authoring uses stable/canonical handles plus expected event revision rather than array-index-only mutation;
- long-running operation status is bounded, process-local and input-free;
- reconnect does not imply project reopen or transport-session-owned editor state.

## Threat model

The local boundary assumes browser content and other local processes may be hostile. Controls include:

- loopback bind plus Host and Origin validation;
- a cryptographically random bearer rotated every startup and stored separately from discovery metadata;
- body, JSON-depth, file, image and concurrency limits;
- per-client admission backpressure without trusting client id as authorization;
- project-local filesystem deletion checks and source-file size limits;
- stale/replayed mutation rejection;
- MCP destructive annotations plus authoritative server-side checks and modern `input_required` confirmation for discard/overwrite/delete intent;
- redacted tracing/debug state that excludes bearer tokens, tool input, baggage payloads and binary captures.

The bearer does not attempt to sandbox a process already running with the user's OS credentials; OS-account compromise is outside this boundary.

## Compatibility evidence

Automated coverage uses the official MCP v2 client for modern negotiation, tools, prompts, resources, targeting, auth, reconnect, images, long-running cancellation/recovery and the canonical MCP-only authoring replay. A separate official-client regression proves the `2025-11-25` stateless fallback.

MCP Inspector v2.5.0 was run over Streamable HTTP against the real `startMcpHttpServer` implementation: `tools/list --strict` passed with zero schema findings and `tools/call project.status` returned structured output. Inspector feedback also led to nullable output-schema fields being represented with portable `anyOf` branches rather than `type` arrays.

Stress coverage includes 50 edit → hot-reload → runtime snapshot cycles without process restart and reconnect continuity without project reopen.

## Release gates still external

Do not treat protocol fixtures as proof of the packaged GUI. Final release remains conditioned on:

- a packaged/live GDevelop instance producing discovery and accepting the external live gate;
- visible inspect → focus → capture evidence;
- canonical GUI E2E covering scene/object/event/asset mutation, preview/runtime, validation, save/export and visual replay;
- two independent external Streamable HTTP host implementations against a supported live build;
- production build/package installation regression.

## Review commands

From the repository root:

```text
node newIDE/electron-app/app/AgentIntegration/ArchitectureGuard.js
```

From `newIDE/electron-app`:

```text
node --test app/AgentIntegration/protocols/mcp/McpHttpServer.test.js app/AgentIntegration/protocols/mcp/McpLegacyCompatibility.test.js app/AgentIntegration/protocols/mcp/McpPrompts.test.js app/AgentIntegration/protocols/mcp/McpResources.test.js app/AgentIntegration/protocols/mcp/McpLongRunning.integration.test.js app/AgentIntegration/protocols/mcp/McpCanonicalE2E.test.js
```

Renderer characterization remains in `newIDE/app/src/AgentIntegration/**/*.spec.js` and should be run with the existing React/Jest test runner.
