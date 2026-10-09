# MCP Activity Panel (DX UX-01)

## UI language and compact layout

The user requested an **English-only** activity panel, including headings, state labels, buttons, placeholders, tooltips and accessibility labels. Remove the explanatory disclaimer/footer under the operations list to reduce visual clutter. Keep protocol commands unchanged. The generic metrics client alias should display as `mcp-client`, not the former Portuguese `cliente-mcp`. This is a frontend/AgentIntegration-only change and must not touch `MainFrame`, gameplay, or MCP command dispatch.

## Visual design refresh — MCP-UX-003 (2026-10-09)

The screenshot of the English MVP revealed heavy panel borders, a generic form checkbox, unstructured result labels, an oversized empty region below one operation, and a disconnected floating launcher. Redesign the **presentation only** in `newIDE/app/src/AgentIntegration/AgentActivityPanel.js` and a prefixed, self-contained stylesheet `AgentActivityPanel.css` with the following requirements:

- Compact, lower-contrast dark panel with coherent typography, spacing and responsive width; no GDevelop-global stylesheet or theme mutation.
- Quiet heading, explicit **server** availability instead of claiming an agent is permanently connected, compact status line, icon-only dismiss action.
- Counted `Recent activity` section with accessible, stateful `Errors only` chip (`aria-pressed`), and compact per-command rows with a subtle status pill and secondary metadata. Keep the honest label `Responded` rather than implying project mutation success.
- Remove the list `minHeight: 100` that caused an unnatural blank area after a single entry. Preserve scrolling for longer histories and display a useful empty state.
- A restrained, visually related MCP launcher attached to the same lower-right anchor. Visible keyboard focus rings, sufficient contrast, reduced-motion support and tight-viewport fallback.
- Preserve existing 1500ms IPC polling, error filtering, bounded snapshot, read-only behavior, privacy and accessibility. Absolutely no MCP transport/dispatcher, core MainFrame or CoinIdle changes.
- Validate parser, Node regression tests, production React build and a separate packaged fork. Inspect the actual renderer DOM and panel dimensions before marking done.

## Goal and boundaries

Offer a read-only, in-editor summary of whether the **local MCP server is available** and which MCP tool calls completed recently. This feature is owned by `AgentIntegration`; GDevelop's underlying project/editor business logic must not be modified.

## Architecture

- `newIDE/app/src/AgentIntegration/AgentActivityPanel.js`: isolated React overlay, polling a single Electron IPC channel every 1.5 seconds. It is hidden in web/preview environments that do not expose Electron IPC.
- `newIDE/app/src/MainFrame/index.js`: **only one import and one render line** for this feature; no new editor callbacks, global business logic or state transitions.
- `newIDE/electron-app/app/AgentIntegration/McpActivityIpc.js`: read-only `gdevelop-agent-activity:snapshot` with safe offline fallback. No token or credentials in responses.
- `newIDE/electron-app/app/AgentIntegration/McpIntegrationHost.js`: owns the activity store and observes metrics from the existing started MCP HTTP host.
- `newIDE/electron-app/app/AgentIntegration/McpMetricsActivityObserver.js`: subscribes to the existing `metrics.record` after MCP server initialization. No new MCP tools, endpoint, HTTP parser, request or dispatcher changes.
- `newIDE/electron-app/app/AgentIntegration/McpActivityStore.js`: bounded (default 100) in-memory timeline, recent-activity TTL, only validated identifiers and command names, response duration, and a generic failure code. Never persist request/response bodies.

The UI distinguishes server availability from observed activity. Metrics represent **completed calls only**, and do not prove continuous connection. Because the current `McpObservability` metric contract has no client/agent identity and no tool start events, the first version labels the observer `mcp-client` (unidentified) and cannot show in-progress calls or claim that a particular save persisted. Commands with `ok=true` are labelled `Responded`, not `Saved`.

## Security

- Never transmit MCP bearer token, token path, user inputs, output payloads, private project paths, or credentials.
- IPC only exposes bounded sanitized snapshots.
- MCP request / response semantics are unchanged; passive observer errors must never interrupt normal tools.
- The activity feed resets when the editor restarts.

## Tests and acceptance

1. Test `McpActivityStore.test.js` (privacy, TTL, bounded history, observer, read-only IPC).
2. Run original `McpIntegrationHost.test.js` and `protocols/mcp/McpObservability.test.js` to check compatibility.
3. Build frontend and package a new fork build, without overwriting DX32 or DX39.
4. Launch the new fork, open `C:\Users\Floki\Documents\GDevelop projects\CoinIdle\CoinIdle.json` via MCP, inspect the badge and panel, run read-only operations and confirm timeline; validate preview and transaction safety.
5. Future improvement: emit start/end events and vetted identity from the MCP dispatcher, once safely authorized, for truly live in-flight state and agent identification.

## Notes

The MCP dispatcher and GDevelop core editor code remain unchanged apart from the two MainFrame render/import lines. All feature logic is separate and can be removed cleanly.
