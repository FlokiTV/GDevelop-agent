# MCP compatibility matrix

AgentIntegration exposes one public protocol surface: MCP Streamable HTTP on loopback. The server contract is intentionally pinned to MCP `2026-07-28`; compatibility is added only when it does not create a second transport state machine or weaken the live-editor safety model.

| Client / surface                  | Status                | Evidence / policy                                                                                                                                                                                                                       |
| --------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Official MCP JavaScript client v2 | Automated pass        | Protocol negotiation, `tools/list`, `tools/call`, `prompts/list`, `prompts/get`, `resources/list`, `resources/read`, reconnect, auth, targeting and image content are covered by Node tests.                                            |
| MCP Inspector                     | Pending external gate | `@modelcontextprotocol/inspector` is not installed in the repository runtime. Run against the live loopback endpoint before release when Inspector is available.                                                                        |
| External Streamable HTTP host A   | Pending live gate     | Must connect to a running canonical GDevelop build using discovery + bearer token and complete read-only discovery at minimum.                                                                                                          |
| External Streamable HTTP host B   | Pending live gate     | Same acceptance as host A; use a distinct host implementation rather than another wrapper around the official test client.                                                                                                              |
| Legacy MCP 2025 stateless         | Not enabled           | The current SDK handler is configured with `legacy: 'reject'`. The product contract is pinned to `2026-07-28`; legacy is not enabled merely for speculative compatibility.                                                              |
| stdio shim                        | Not implemented       | Streamable HTTP is the native local transport and already supports discovery, auth, targeting and concurrent clients. A stdio shim would add another lifecycle/credential bridge and is deferred until a required host cannot use HTTP. |

## Automated compatibility gate

From `newIDE/electron-app`:

```text
node --test app/AgentIntegration/protocols/mcp/McpHttpServer.test.js app/AgentIntegration/protocols/mcp/McpPrompts.test.js app/AgentIntegration/protocols/mcp/McpResources.test.js app/AgentIntegration/protocols/mcp/McpCanonicalE2E.test.js
```

This gate uses the official MCP client and verifies the server's negotiated protocol plus tools, prompts, resources, reconnect and the canonical MCP-only authoring replay. It does not substitute for a host-specific live test against the packaged Electron application.

## Live host configuration

A running GDevelop writes `gdevelop-mcp.json` and a separate private bearer-token file under Electron `userData`. Clients must read the endpoint and token-file location from discovery rather than hard-code the port or embed the bearer in configuration checked into source control.

For Streamable HTTP hosts that support custom request headers, configure:

```text
endpoint: <discovery.endpoint>
Authorization: Bearer <contents of discovery.auth.tokenFile>
X-GDevelop-Window-Id: <optional editor BrowserWindow id>
X-GDevelop-Project-Path: <optional absolute project path>
X-GDevelop-Client-Id: <optional stable local client id for admission fairness>
```

Never copy the bearer token into logs, screenshots, replay artifacts or repository files. When more than one editor is open, use explicit window/project targeting rather than relying on focus.

## Release acceptance

Before declaring host compatibility complete:

1. run the automated compatibility gate above;
2. run MCP Inspector or its current conformance equivalent against a live packaged build;
3. connect at least two independent Streamable HTTP hosts to the same supported build family;
4. for each host verify discovery/auth, `tools/list`, one read-only `tools/call`, `prompts/list/get`, `resources/list/read`, reconnect, and explicit editor targeting when multiple windows exist;
5. record host/version/result without storing credentials.

The canonical GUI E2E remains a separate release gate because in-process protocol tests cannot prove that a real Electron editor visibly updates.
