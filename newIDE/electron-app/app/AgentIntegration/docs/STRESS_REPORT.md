# AgentIntegration MCP stress and fault-injection report

Date: 2026-09-05

This report records the automated stress gates used for the embedded GDevelop MCP integration. The goal is to prove that a long live-editing session can continue without restarting GDevelop, reopening the project, leaking gameplay-test watchers, or allowing malformed/failing requests to leave the integration unusable.

## Acceptance thresholds

- At least 100 mixed MCP `tools/call` operations on one server instance.
- At least 50 consecutive `mutate -> hot-reload -> snapshot` cycles without restart.
- Soak duration below 15 seconds in the Node test environment.
- Heap growth below 64 MiB during the 150-call soak.
- HTTP server `request` and `connection` listener counts unchanged across the soak.
- Preview debugger ID stable across all 50 hot-reload/snapshot cycles.
- At most one active gameplay-test frame watcher at a time and zero after completion.
- Revision conflicts must be recoverable without project close/open.
- Malformed payload, auth failure, timeout, cancellation and reconnect must not require server/editor restart.
- Large reads must remain bounded: paginated event reads and truncated runtime instance snapshots.

## Soak results

`McpStress.test.js` performs 50 cycles of:

1. `events.update` with revision/idempotency preconditions;
2. `preview.hot-reload`;
3. `runtime.snapshot`.

This is 150 `tools/call` operations over the same MCP server and connection. The test asserts:

- project revision advances from 0 to 50;
- exactly 50 hot reloads and 50 snapshots complete;
- debugger ID remains `preview-stress-1`;
- no `project.open`, `project.close`, `preview.start` or `preview.close-all` recovery call occurs;
- heap delta stays below 64 MiB;
- HTTP request/connection listener counts do not grow;
- total duration stays below 15 seconds.

A second soak reconnects a fresh official MCP client after ten mutations and continues the same project revision through revision 20 without reopening the project.

## Fault injection

The regression suite covers:

- renderer request timeout followed by a successful request on the same bridge;
- MCP client reconnect with revision continuity;
- missing/invalid authentication;
- forged `Host` and non-local `Origin` rejection;
- malformed JSON;
- oversized request bodies;
- excessive JSON nesting;
- global and per-client admission-control saturation;
- stale project revisions interleaved with simulated external/manual changes;
- MCP request cancellation propagated through Electron IPC to the renderer.

Cancellation of EditorFunctions is cooperative. A request cancelled before execution does no work. If cancellation arrives while a native EditorFunction is already executing, AgentIntegration preserves any dirty/UI invalidation produced by that completed call, stops before subsequent gameplay calls, and refuses a requested save. The upstream EditorFunction runner is not force-interrupted inside a native call.

## Gameplay lifecycle

The renderer stress regression executes 50 gameplay tests sequentially. It asserts:

- no more than one gameplay frame watcher is active at any instant;
- every watcher is released;
- active watcher count returns to zero after the batch.

Normal preview lifecycle and disposable gameplay-test iframe lifecycle remain separate.

## Large-project reads

Large-read regressions cover:

- 350 root events in one live `gdProject` scene;
- `events.read` pagination with `offset`/`limit` (maximum page size 200);
- a page of 50 events at offset 200 retains the full-tree `eventsRevision` and original canonical paths;
- 500 runtime instances in a debugger dump with `maxInstances: 100`;
- the runtime snapshot reports the complete instance count while returning only the bounded instance payload and explicit truncation count.

`events.read` pagination is opt-in. Existing callers that omit `offset` and `limit` retain the previous full-tree response shape.

## Regression commands

Representative gates:

```text
node --test app/AgentIntegration/protocols/mcp/McpStress.test.js
node --test app/AgentIntegration/protocols/mcp/McpHttpServer.test.js
node --test app/AgentIntegration/RendererBridge.test.js
npm test -- --runTestsByPath src/AgentIntegration/RendererCommandAdapter.spec.js --watchAll=false
npm test -- --runTestsByPath src/AgentIntegration/editor/EditorFunctionService.spec.js src/AgentIntegration/editor/EditorFunctionCommands.spec.js --watchAll=false
npm test -- --runTestsByPath src/AgentIntegration/EventTools.spec.js src/AgentIntegration/editor/EventCommands.spec.js src/AgentIntegration/RuntimeTelemetry.spec.js --watchAll=false
node newIDE/electron-app/app/AgentIntegration/ArchitectureGuard.js
```

## Relevant commits

- `cd283fb96c` - 50 mutate/hot-reload/snapshot cycles (150 calls).
- `45941ba70d` - timeout recovery and reconnect coverage.
- `a1d53b5e49` - interleaved external/manual revision conflicts and recovery.
- `bbd36f5dd3` - sequential gameplay-test watcher stress.
- `9066084b03` - MCP request cancellation propagated across Electron/renderer IPC.
- `eb660dea0a` - cooperative EditorFunction cancellation and save suppression.
- `d6c345a6e6` - heap/listener growth thresholds in the MCP soak.
- `5af5cff83b` - paginated large event reads and 500-instance bounded snapshot regression.
