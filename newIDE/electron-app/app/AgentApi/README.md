# Embedded Agent API

This module exposes the currently running GDevelop desktop editor through a loopback-only HTTP API.

The implementation is intentionally isolated:

- `newIDE/electron-app/app/AgentApi/index.js`: HTTP server, authentication, window targeting and IPC transport.
- `newIDE/app/src/AgentApi/useAgentApi.js`: renderer adapter that executes the existing GDevelop `EditorFunctions` against the project already loaded in memory.

Only two small hooks are required outside these folders:

- `electron-app/app/main.js` starts/stops the HTTP server.
- `app/src/MainFrame/index.js` mounts the renderer adapter with the editor callbacks it already owns.

## Discovery

At startup the desktop app writes `agent-api.json` in Electron's `userData` directory. It contains the loopback host, port, process id and a per-process random token.

Default endpoint: `http://127.0.0.1:38473`.

`GET /health` does not require authentication. All `/v1/*` routes require the token in the `X-GDevelop-Agent-Token` header.

## API

- `GET /health`
- `GET /v1/status`
- `GET /v1/project`
- `GET /v1/functions`
- `POST /v1/call`
- `POST /v1/calls`
- `POST /v1/save`

Calls can target an open project with `projectPath` or a specific registered Electron `windowId`. If neither is supplied, the focused registered window is used; if there is exactly one registered window it is used as a fallback.

Example request body for `/v1/call`:

```json
{
  "projectPath": "C:\\path\\game.json",
  "name": "add_instance",
  "arguments": {},
  "save": false
}
```

The `name` is an existing GDevelop `EditorFunction`. This module deliberately does not implement a second mutation language: it reuses the same editor-function engine and outside-editor notifications used by GDevelop's built-in AI tooling, so scene/editor state is updated in memory.

## Security

The server binds only to `127.0.0.1`. A new random 256-bit token is generated for each desktop process. The token is never returned by an HTTP endpoint; local clients discover it from `agent-api.json`.
