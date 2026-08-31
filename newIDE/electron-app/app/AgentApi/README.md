# Embedded Agent API

This module exposes the running GDevelop desktop editor through a loopback-only HTTP API so an agent can build, test and export a game without editing the project JSON behind the editor's back.

The implementation stays isolated:

- `newIDE/electron-app/app/AgentApi/index.js`: HTTP, authentication, window discovery/capture and IPC transport.
- `newIDE/app/src/AgentApi/useAgentApi.js`: project lifecycle, preview/export helpers and the adapter to GDevelop's existing `EditorFunctions`.
- `newIDE/app/src/AgentApi/AssetTools.js`: safe local resource lifecycle and diagnostics.
- `newIDE/app/src/AgentApi/CheckpointTools.js`: in-memory checkpoints, structural diffs and transactions.
- `newIDE/app/src/AgentApi/FunctionMetadata.js`: searchable EditorFunction schemas derived from native source by `generateFunctionMetadata.js`.
- `newIDE/app/src/AgentApi/RuntimeTelemetry.js`: bounded runtime snapshots, logs, assertions and wait conditions backed by GDevelop's native debugger protocol.
- `newIDE/app/src/AgentApi/EditorVisualTools.js`: scene-editor instance selection and native focus/fit controls for visual inspection.
- `newIDE/app/src/AgentApi/DiagnosticsTools.js`: aggregated project/event/resource/behavior diagnostics and validation summaries.
- `newIDE/app/src/AgentApi/ExportTools.js`: wraps the native HTML5 exporter while restoring agent-observed project state after the operation.
- `newIDE/electron-app/app/AgentApi/ArchitectureGuard.js`: verifies the fork delta stays inside AgentApi plus the explicit upstream hook allowlist.

Only three small hooks live outside these folders: `electron-app/app/main.js` installs the service, `app/src/MainFrame/index.js` passes callbacks already owned by the editor, and `electron-app/app/PreviewWindow.js` exposes preview-window identity to the isolated input/runtime adapters. Core single-instance behavior and the native HTML5 exporter remain upstream-identical.

## Upstream isolation guard

From the repository root, run:

```bash
node newIDE/electron-app/app/AgentApi/ArchitectureGuard.js upstream/master
```

The guard fails if the fork changes any tracked upstream file outside the two AgentApi directories and the three explicit hook files above. CI/checkouts can override the comparison ref with `GDEVELOP_AGENT_UPSTREAM_REF`.

## Discovery and security

At startup the desktop app writes `agent-api.json` in Electron's `userData` directory. It contains `host`, `port`, `pid`, `version` and a fresh random token. The default endpoint is `http://127.0.0.1:38473`.

`GET /health` is unauthenticated. Every `/v1/*` request requires `X-GDevelop-Agent-Token`. The server binds only to `127.0.0.1`.

## Core endpoints

- `GET /health` — process/service health.
- `GET /v1/status` — registered editor windows and project paths.
- `GET /v1/project` — live project/editor/preview state.
- `GET /v1/functions` — native GDevelop editor functions with generated argument metadata. Use `?q=instance+opacity` for capability search and `?executableOnly=true` to hide generation-service-only tools.
- `GET /v1/functions/<name>` — complete metadata for one function: description, arguments, input schema, mutation mode, project requirement, source location and examples.
- `GET /v1/diagnostics` — aggregated fresh project/event/resource/behavior diagnostics plus the latest native code-generation report. Use `includeAssets=false` or `includeNativeReport=false` to skip sections.
- `POST /v1/validate` — aggregate diagnostics with optional checkpoint diff, gameplay tests, runtime assertions/logs and HTML5 export into one report.
- `GET /v1/capabilities` — high-level end-to-end capabilities.
- `GET /v1/windows` — editor and preview Electron windows.
- `GET /v1/capture?windowId=<id>` — PNG capture of an editor or preview window.
- `POST /v1/call` — execute one native `EditorFunction`.
- `POST /v1/calls` — execute native `EditorFunction`s in a batch.
- `POST /v1/action` — execute one high-level embedded-agent action.
- `POST /v1/save` — compatibility shortcut for saving the current project.

Target a renderer with `projectPath` or `windowId`. With neither, the focused registered editor is preferred, then the only registered editor. Editor windows remain registered even with no project open so a client can create/open a project.

## High-level actions

Send these to `POST /v1/action` with a `type` field:

- `create-project`: `{ "type":"create-project", "name":"Game", "templateSlug":null }`
- `open-project`: `{ "type":"open-project", "filePath":"C:\\games\\game.json", "discardUnsavedChanges":false }`
- `close-project`: `{ "type":"close-project", "discardUnsavedChanges":true }`
- `save-project`
- `save-project-as`: `{ "type":"save-project-as", "filePath":"C:\\games\\game.json" }`
- `list-resources` — list resources with usage, missing-file/outside-project status and unregistered references.
- `inspect-resource`: `{ "type":"inspect-resource", "resourceName":"player.png" }` — includes object usage and shared-file information.
- `import-local-resource`: `{ "type":"import-local-resource", "filePath":"C:\\art\\player.png", "kind":"image", "resourceName":"player.png" }`.
- `replace-local-resource`: `{ "type":"replace-local-resource", "resourceName":"player.png", "filePath":"C:\\art\\player-v2.png" }` — preserves resource-specific settings and can optionally delete the previous local file when safe.
- `rename-resource`: `{ "type":"rename-resource", "resourceName":"player.png", "newResourceName":"hero.png" }` — updates project references through GDevelop's native resource renamer.
- `remove-resource`: `{ "type":"remove-resource", "resourceName":"unused.png", "deleteFile":true }` — refuses removal while referenced; physical deletion is allowed only for an unshared local file inside the project folder.
- `checkpoint-create`, `checkpoint-list`, `checkpoint-diff`, `checkpoint-delete`, `checkpoint-restore` — in-memory project snapshots and structural diffs.
- `transaction-begin`, `transaction-status`, `transaction-commit`, `transaction-rollback` — protected mutation batches with safe internal project restore on rollback.
- `open-scene`: `{ "type":"open-scene", "sceneName":"Level1", "mode":"scene" }` (`scene`, `events` or `both`)
- `editor-visual-status` — lists currently mounted scene editors and points callers to the shared `/v1/capture` endpoint.
- `editor-select-instances`: `{ "type":"editor-select-instances", "sceneName":"Level1", "objectName":"Player", "focusMode":"fit" }` — selects all matching instances by object name, or one instance with `instanceId` using the same shortened persistent UUID returned by `describe_instances`; focus mode is `center`, `fit` or `none`.
- `editor-focus-selection`: `{ "type":"editor-focus-selection", "sceneName":"Level1", "mode":"center" }` — centers or fits the current native SceneEditor selection without mutating the project.
- `preview-status`
- `preview-start`: `{ "type":"preview-start", "numberOfWindows":1 }`
- `preview-hot-reload`
- `preview-control`: `{ "type":"preview-control", "action":"pause" }` (`play`, `pause`, `refresh`)
- `preview-input`: `{ "type":"preview-input", "previewWindowId":12, "event":{"type":"keyDown","keyCode":"ArrowRight"} }` — keyboard/mouse input sent directly by Electron.
- `preview-input-sequence`: timed keyboard/mouse steps, followed by `preview-input-reset` when needed.
- `preview-touch`: `{ "type":"preview-touch", "previewWindowId":12, "action":"start", "identifier":0, "x":120, "y":240 }` (`start`, `move`, `end`, `cancel`).
- `preview-gamepad`: connect/update/disconnect/reset a virtual gamepad with `axes` and `buttons` arrays.
- `preview-runtime-status` / `preview-runtime-reset` — install/inspect/reset the isolated preview runtime.
- `preview-close-all`
- `runtime-status`: `{ "type":"runtime-status", "debuggerId":"<optional>" }` — native debugger pause/scene status.
- `runtime-snapshot`: `{ "type":"runtime-snapshot", "maxInstances":200, "objectNames":["Player","Enemy"] }` — scene/time/FPS approximation, variables, object counts, instances and behavior state from the native debugger dump.
- `runtime-logs`: `{ "type":"runtime-logs", "limit":50 }` — bounded console/error history captured from the debugger protocol.
- `runtime-assert`: `{ "type":"runtime-assert", "condition":{"path":"objects.Player.count","operator":"gte","value":1} }`.
- `runtime-wait-for`: `{ "type":"runtime-wait-for", "condition":{"path":"scene.name","operator":"equals","value":"Win"}, "timeoutMs":5000, "intervalMs":250 }` — repeatedly refreshes the native debugger dump until the condition matches or times out.
- `diagnostics-project` — same aggregated project diagnostics as `GET /v1/diagnostics`.
- `validation-report`: optional `checkpointId`, `gameplayTests`, `runtimeAssertions`, `includeRuntimeLogs`, `debuggerId` and `export`. Gameplay-test source probes default to `persist:false` unless explicitly requested. The response contains one pass/fail summary and per-step results.
- `export-html5`: `{ "type":"export-html5", "outputDir":"C:\\games\\build" }`

Runtime assertion paths address the returned snapshot (`scene.name`, `scene.variables.Score.value`, `objects.Player.count`, `objects.Player.instances.0.x`, etc.). Supported operators are `equals`/`eq`, `notEquals`/`neq`, `gt`, `gte`, `lt`, `lte`, `contains`, `exists`, `not-exists`, `truthy` and `falsy`. Snapshot payloads are bounded; `maxInstances` defaults to 200 and is capped at 1000.

Opening or closing a project with unsaved changes is rejected unless `discardUnsavedChanges:true` is explicit.

## Native authoring surface

The primary mutation API is still GDevelop's own `EditorFunctions`, not a parallel language. This covers scenes, objects, behaviors, variables, events, 2D/3D instances, project settings/resources, asset/resource store installation, docs/search, scripts, gameplay tests and editor-function tests.

Function metadata is generated from `EditorFunctions/index.js` and imported helper implementations instead of being manually duplicated. After native EditorFunctions change, run `node src/AgentApi/generateFunctionMetadata.js` from `newIDE/app`; `--check` fails when the committed generated catalog is stale. Flags such as `requiresProject`, `modifiesProject` and argument-dependent mutation behavior are reconciled against the live native function objects at runtime.

Example:

```json
{
  "projectPath": "C:\\games\\game.json",
  "name": "put_3d_instances",
  "arguments": {
    "scene_name": "Level1",
    "object_name": "Coin",
    "layer_name": "",
    "brush_kind": "point",
    "brush_position": "320,240,30",
    "new_instances_count": 1
  },
  "save": false
}
```

Projectless `initialize_project` is also available through `/v1/call` when the target editor has no project open. `/v1/action` `create-project` is the simpler lifecycle wrapper.

## Recommended end-to-end workflow

Create/open a project, save-as to a local `.json`, create a checkpoint, import/install resources, author using native EditorFunctions, run `/v1/diagnostics`, launch and visually inspect a preview with `/v1/windows` + `/v1/capture`, automate gameplay with preview input + runtime assertions, iterate/hot-reload, then call `/v1/validate` with the checkpoint and requested tests/export. Save only after the validation report is acceptable.

For any 3D scene creation or material 3D edit, use the dedicated workflow docs instead of treating the validation report as sufficient:

- [`MAP_BUILDER.md`](./MAP_BUILDER.md) — mechanics-first map construction: study the reference scene, reconstruct object/physics/control roles, derive reachability and camera constraints, design the route/puzzles, then build incrementally.
- [`3D_QUALITY_GATE.md`](./3D_QUALITY_GATE.md) — acceptance gate: inspect real editor/player-camera captures, validate AABBs and reachability, exercise movement/jump/camera/interactions, and require observable gameplay evidence before calling the work finished.

A new scene that copied Player behaviors but omitted its reference EventScript control contract is not considered playable; camera pointer-lock/mouse events, movement, jump and interactions must be accounted for explicitly.
