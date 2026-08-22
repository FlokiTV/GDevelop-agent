# Embedded Agent API

This module exposes the running GDevelop desktop editor through a loopback-only HTTP API so an agent can build, test and export a game without editing the project JSON behind the editor's back.

The implementation stays isolated:

- `newIDE/electron-app/app/AgentApi/index.js`: HTTP, authentication, window discovery/capture and IPC transport.
- `newIDE/app/src/AgentApi/useAgentApi.js`: project lifecycle, preview/export helpers and the adapter to GDevelop's existing `EditorFunctions`.
- `newIDE/app/src/AgentApi/AssetTools.js`: safe local resource lifecycle and diagnostics.
- `newIDE/app/src/AgentApi/CheckpointTools.js`: in-memory checkpoints, structural diffs and transactions.

Only small hooks live outside these folders: `electron-app/app/main.js` installs the service and `app/src/MainFrame/index.js` passes callbacks already owned by the editor.

## Discovery and security

At startup the desktop app writes `agent-api.json` in Electron's `userData` directory. It contains `host`, `port`, `pid`, `version` and a fresh random token. The default endpoint is `http://127.0.0.1:38473`.

`GET /health` is unauthenticated. Every `/v1/*` request requires `X-GDevelop-Agent-Token`. The server binds only to `127.0.0.1`.

## Core endpoints

- `GET /health` — process/service health.
- `GET /v1/status` — registered editor windows and project paths.
- `GET /v1/project` — live project/editor/preview state.
- `GET /v1/functions` — native GDevelop editor functions, including projectless functions such as `initialize_project`.
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
- `preview-status`
- `preview-start`: `{ "type":"preview-start", "numberOfWindows":1 }`
- `preview-hot-reload`
- `preview-control`: `{ "type":"preview-control", "action":"pause" }` (`play`, `pause`, `refresh`)
- `preview-close-all`
- `export-html5`: `{ "type":"export-html5", "outputDir":"C:\\games\\build" }`

Opening or closing a project with unsaved changes is rejected unless `discardUnsavedChanges:true` is explicit.

## Native authoring surface

The primary mutation API is still GDevelop's own `EditorFunctions`, not a parallel language. This covers scenes, objects, behaviors, variables, events, 2D/3D instances, project settings/resources, asset/resource store installation, docs/search, scripts, gameplay tests and editor-function tests.

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

Create/open a project, save-as to a local `.json`, import/install resources, author using native EditorFunctions, run `run_tests`/`run_gameplay_test`, launch and visually inspect a preview with `/v1/windows` + `/v1/capture`, iterate/hot-reload, save, then export HTML5 headlessly.
