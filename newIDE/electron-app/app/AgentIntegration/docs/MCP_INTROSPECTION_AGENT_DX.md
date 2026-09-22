# GDevelop MCP — Introspection and Agent DX Gaps

## Status

This document captures concrete developer-experience gaps observed while using the live GDevelop MCP to refactor the Coin Idle project from JavaScript-heavy events into a fully native, readable GDevelop Event Sheet.

It is intentionally narrower than the completed game-creation coverage roadmap. The core MCP already has broad functional coverage. The remaining issues documented here are primarily about **discoverability, schema precision, safe authoring ergonomics, and external-client usability**.

The key distinction is:

> The MCP often already has the capability, but an external agent cannot always discover the exact contract cheaply enough to use it without prior internal knowledge.

This document should therefore be used as a post-roadmap DX backlog, not as evidence that the authoring core is missing.

---

## 1. Observed case study: Coin Idle native-event refactor

### What worked

The live MCP was able to:

- read and replace the live Event Sheet;
- create native `Standard`, `Group`, `Comment`, and `Repeat` events;
- author native conditions/actions for mouse input, timers, variables, text, storage, random values, and expressions;
- create visible scene variables;
- preserve the open in-memory project;
- validate, preview, inspect runtime behavior, save, and rollback;
- style Event Sheet groups and comments through canonical serialized event fields.

The finished Coin Idle refactor required **no gameplay JavaScript**.

### Where agent friction appeared

The agent initially consulted GDevelop implementation metadata/tests to determine exact event and instruction shapes. Later inspection showed that part of this was unnecessary:

- `events.instructions.search` and `events.instructions.describe` already exist in AgentIntegration;
- `events.read` already exposes canonical serialized event JSON in `data.eventsJson`;
- the canonical `Group` payload already includes `colorR`, `colorG`, `colorB`;
- the canonical `Comment` payload already includes background and text RGB fields under `color`.

The friction came from not having a sufficiently explicit, easy-to-follow contract for **which representation to consume and which discovery command to call first**.

---

# 2. Gap A — Existing capability is under-documented

## A1 — `events.read` has two conceptually different representations

During the Coin Idle work, the normalized event/handle tree was consumed instead of the canonical serialized tree. The normalized representation is useful for stable handles and localized mutations, but it does not expose every event-type-specific serialized property.

The canonical representation is `data.eventsJson`, and it is the correct source when an agent needs the complete serialized event payload, including fields such as Event Sheet colors.

### Problem

A client can reasonably call `events.read`, see an event tree, and assume that tree is the full editable representation.

That assumption is unsafe.

### Documentation change

Document the result contract explicitly:

- `eventsJson`: authoritative canonical serialized GDevelop event payload;
- normalized/handle representation: stable addressing/navigation data for localized operations;
- `eventsRevision`: optimistic-concurrency token for localized event mutations.

Add a warning:

> Do not reconstruct or style event nodes from the normalized handle tree. Use `eventsJson` whenever event-type-specific serialized fields are required.

### Acceptance

A new external client, using only MCP docs, can discover a Group's color fields and update them without reading GDevelop source or tests.

---

## A2 — Existing instruction discovery needs to be in the primary authoring workflow

The roadmap originally identified instruction discovery as CAP-01, and AgentIntegration now contains:

- `events.instructions.search`;
- `events.instructions.describe`.

However, the normal live-editing guidance still makes it too easy for an agent to jump directly from `events.read` to hand-authored instruction JSON.

### Documentation change

The recommended native-event workflow should be:

1. `events.read`;
2. identify the target event node/type;
3. `events.instructions.search` for unfamiliar conditions/actions;
4. `events.instructions.describe` before constructing parameters;
5. author with `events.insert/update/apply`;
6. `validation.run`;
7. preview/runtime acceptance.

For common native instructions, documentation should include a few real examples showing canonical identifier plus ordered parameters.

### Acceptance

A client unfamiliar with `IsCursorOnObject` can discover it, obtain its parameter contract, create a valid event, and validate it without repository inspection.

---

## A3 — Typed EditorFunctions need a clearer preferred-path statement

The historical roadmap correctly identified generic `editor.functions.call` as a weakly typed surface. Typed MCP projection work now exists, but generic call remains visible and useful.

### Problem

An external agent can still default to the generic call and unnecessarily manage argument schemas manually.

### Documentation change

State explicitly:

> Prefer the generated typed EditorFunction MCP tool when present. Use `editor.functions.call` for compatibility, dynamic dispatch, or batching only.

The documentation should show how to map from `editor.functions.list/describe` to the typed projected tool name.

### Acceptance

A new client uses the typed function surface for ordinary single-function calls without being instructed out-of-band.

---

# 3. Gap B — Event-node schemas are still too generic

Instruction discovery answers:

> "What condition/action/expression exists and what parameters does it take?"

It does **not** fully answer:

> "What fields may a Group, Comment, Repeat, Standard, JavaScript, Link, or other event node contain in canonical serialized JSON?"

This is the main remaining introspection gap exposed by the color issue.

## B1 — Add event-node schema introspection

### Proposed API

Preferred naming:

- `events.nodes.list`
- `events.nodes.describe`

Alternative:

- `events.schema.list`
- `events.schema.describe`

Example:

```json
{
  "eventType": "BuiltinCommonInstructions::Comment"
}
```

Example result:

```json
{
  "eventType": "BuiltinCommonInstructions::Comment",
  "displayName": "Comment",
  "fields": {
    "comment": { "type": "string", "required": true },
    "comment2": { "type": "string" },
    "color": {
      "type": "object",
      "properties": {
        "r": { "type": "integer", "minimum": 0, "maximum": 255 },
        "g": { "type": "integer", "minimum": 0, "maximum": 255 },
        "b": { "type": "integer", "minimum": 0, "maximum": 255 },
        "textR": { "type": "integer", "minimum": 0, "maximum": 255 },
        "textG": { "type": "integer", "minimum": 0, "maximum": 255 },
        "textB": { "type": "integer", "minimum": 0, "maximum": 255 }
      }
    }
  },
  "example": {
    "type": "BuiltinCommonInstructions::Comment",
    "comment": "Explain why this section exists."
  }
}
```

### Requirements

- derive from the connected build or the same authoritative serialization metadata used by the editor;
- include required/optional fields;
- identify editor-only/visual fields;
- include defaults and value ranges where known;
- include child/subevent support;
- include a minimal valid example;
- avoid a separately maintained static catalog.

### Acceptance

A clean client can discover and construct Group and Comment nodes, including visual styling, without reading repository code.

---

## B2 — Make `events.insert/update/apply` schemas more informative

Current mutation tools necessarily accept flexible serialized event objects, but a plain `object` schema pushes validation too late.

### Preferred direction

Where practical, project a discriminated union for known event node types:

```text
eventJson:
  oneOf:
    - StandardEvent
    - GroupEvent
    - CommentEvent
    - RepeatEvent
    - ...
```

If the union is too large or unstable for `tools/list`, return an explicit schema reference/capability hint pointing to `events.nodes.describe`.

### Requirements

- malformed known fields should fail before renderer dispatch when possible;
- unknown/new upstream event types must remain forward-compatible;
- do not hard-code a frozen catalog that breaks extension/upstream evolution.

### Acceptance

A Comment with an invalid RGB value or wrong field type is rejected with a structured error that names the field and expected contract.

---

## B3 — Add expression discovery if still absent from the live surface

Instruction discovery covers conditions/actions. Native event expressions remain another place where agents may rely on model memory, especially for:

- math helpers;
- conversion functions;
- object expressions;
- behavior expressions;
- extension expressions;
- return types and parameter types.

### Proposed API

- `events.expressions.search`
- `events.expressions.describe`

### Acceptance

A client can discover `RandomInRange`, `ToString`, or an unfamiliar extension expression, including return type and ordered parameters, without repository inspection.

---

# 4. Gap C — Safe visual-editing ergonomics

Full canonical event replacement works, but visual-only operations should not require rewriting an entire event node when the intent is simply presentation.

## C1 — Add a localized style patch operation

### Proposed API

`events.style.update`

Example:

```json
{
  "sceneName": "CoinIdle",
  "handle": "event:...",
  "expectedEventsRevision": "events:...",
  "style": {
    "background": { "r": 45, "g": 100, "b": 180 },
    "text": { "r": 240, "g": 246, "b": 252 }
  }
}
```

The command should translate the abstract style into the canonical fields supported by that event type.

### Why this is useful

- reduces accidental logic replacement;
- expresses user intent directly;
- avoids clients needing to know that Group uses `colorR/G/B` while Comment uses a nested `color` object;
- permits event-type-specific validation;
- makes visual-only diffs auditable.

### Requirements

- reject unsupported style fields for the target type;
- preserve event persistent identity and subevents;
- support optimistic event revision;
- return before/after style;
- mark the operation as project-mutating but non-destructive.

### Acceptance

An agent can color a Group and Comment without sending their conditions, actions, or subevents back to the server.

---

# 5. Gap D — Connection and client ergonomics

This is partly host-specific and should not be confused with a GDevelop MCP protocol gap.

The current external-client contract is sound:

1. read `gdevelop-mcp.json`;
2. use its dynamic `endpoint`;
3. read the bearer token from `auth.tokenFile`;
4. pin the advertised protocol version;
5. connect through Streamable HTTP;
6. discover tools dynamically.

However, hosts that do not register the local GDevelop MCP directly may need a small local client program. During Coin Idle work, short `node -e` clients were used; one large workflow temporarily required a script file because Windows command-line length was exceeded.

## D1 — Provide a reusable external-client helper

Instead of each scenario repeating transport/bootstrap code, provide a small supported helper such as:

```js
const { connectLiveGDevelopMcp } = require('./McpClient');

const session = await connectLiveGDevelopMcp({
  clientId: 'my-agent',
});

const result = await session.call('project.status', {});
await session.close();
```

### Requirements

- never print or return bearer credentials in normal results;
- dynamic discovery every process start;
- optional window/project targeting;
- protocol pinning from discovery;
- structured `call`, `listTools`, and close lifecycle;
- no hidden retry of mutations;
- no hard-coded port/token/tool catalog.

### Acceptance

A new external Node client can perform a read-only `project.status` in fewer than ~20 lines without duplicating authentication/transport boilerplate.

---

## D2 — Optional safe CLI for one-off tool calls

A small CLI could remove the need for ad hoc `node -e` programs:

```text
node McpToolCall.js project.status
node McpToolCall.js events.read --json '{"sceneName":"CoinIdle"}'
```

This should be considered convenience tooling, not a replacement for MCP.

### Safety requirements

- credentials never printed;
- mutation commands require an explicit `--allow-mutate`;
- destructive commands remain governed by MCP elicitation/confirmation;
- JSON output supports a raw structured-data mode and a sanitized replay mode;
- targeting flags reuse the same discovery contract.

### Acceptance

A developer can inspect raw `events.read.data.eventsJson` from a terminal without writing a temporary client script.

---

# 6. Gap E — Raw data versus replay evidence must be explicit

The repository contains `sanitizeForReplay`, whose purpose is to remove credential-bearing keys before evidence is persisted.

Important clarification from the Coin Idle investigation:

> The missing color fields were **not** caused by `sanitizeForReplay`. The wrong event representation was read.

Still, client helpers and docs should make a stronger distinction between:

- live authoritative tool response;
- normalized navigation/handle view;
- sanitized replay/evidence artifact.

### Documentation rule

Replay artifacts are evidence, not an authoring API contract.

Agents should perform authoring decisions from the live structured response and use sanitized data only when persisting logs/replays.

---

# 7. Recommended agent workflow for native Event Sheet authoring

A robust default workflow should be documented as:

1. **Discover the live build**
   - `tools/list`
   - `agent.capabilities`
   - never hard-code the tool catalog.

2. **Read project/editor state**
   - `project.status`
   - `editor.visual.status`
   - `events.read`.

3. **Choose the correct event representation**
   - use `eventsJson` for complete canonical node data;
   - use stable handles/revision data for targeted mutations.

4. **Discover unfamiliar instructions**
   - `events.instructions.search`;
   - `events.instructions.describe`.

5. **Discover unfamiliar event-node fields**
   - future: `events.nodes.describe`;
   - until implemented, document canonical examples for the built-in node types most commonly authored.

6. **Use the smallest mutation**
   - `events.update` for one node;
   - `events.insert/delete/move` for localized structural changes;
   - `events.apply` only for deliberate bulk replacement;
   - future: `events.style.update` for visual-only changes.

7. **Protect multi-step work**
   - transaction/checkpoint;
   - project and event revision preconditions;
   - idempotency keys where appropriate.

8. **Validate**
   - `validation.run`;
   - preview/hot reload;
   - runtime logs/assertions;
   - desktop capture when editor presentation matters.

9. **Save explicitly**
   - `project.save` only after successful acceptance.

---

# 8. Prioritized backlog

| Priority | Item | Type | Rationale |
| --- | --- | --- | --- |
| P0 | Document `events.read.eventsJson` vs normalized handle tree | Docs | Prevents the exact mistake observed in Coin Idle |
| P0 | Promote `events.instructions.search/describe` into the primary authoring guide | Docs | Capability already exists; reduces internal/source lookup |
| P0 | Add canonical Group/Comment examples including visual fields | Docs | Immediate low-cost fix |
| P0 | Clarify typed EditorFunction preferred path | Docs | Avoids unnecessary generic calls |
| P1 | `events.nodes.list/describe` | API | Authoritative node-level schema introspection |
| P1 | Improve event mutation schemas / schema references | API | Earlier validation and clearer contracts |
| P1 | `events.expressions.search/describe` if not already live | API | Removes expression-name/parameter guesswork |
| P1 | `events.style.update` | API | Safe, intent-specific visual mutations |
| P2 | Reusable `connectLiveGDevelopMcp` helper | Client DX | Removes repeated transport/auth boilerplate |
| P2 | Safe one-off MCP CLI | Client DX | Avoids temporary scripts for inspection/tool calls |
| P2 | MCP prompt/resource: native Event Sheet authoring guide | Docs/DX | Makes recommended workflow discoverable to agents |

---

# 9. Non-goals

This backlog should **not**:

- duplicate GDevelop business logic inside the MCP adapter;
- expose arbitrary internal editor methods simply because they exist;
- replace canonical `events.*` mutations with dozens of narrow wrappers;
- hard-code a static instruction/event catalog that can drift from the connected build;
- weaken revision, transaction, authentication, or explicit-save boundaries;
- encourage direct editing of the project JSON on disk.

The preferred design remains capability-driven and live-project-first.

---

# 10. Definition of done for the DX milestone

The introspection/DX work can be considered complete when a clean external MCP client can perform the following without reading repository source or relying on prior GDevelop model knowledge:

1. connect from the discovery file safely;
2. discover available native event instruction metadata;
3. discover the canonical schema for Group and Comment event nodes;
4. read a scene and correctly distinguish canonical `eventsJson` from the handle/navigation representation;
5. add a native condition/action using discovered parameter metadata;
6. add a Group and Comment using discovered node metadata;
7. change Group/Comment colors through a localized, validated operation;
8. validate and preview the result;
9. save explicitly;
10. produce sanitized evidence without confusing replay data with authoritative live authoring state.

At that point, consulting GDevelop source should be a debugging/implementation activity for MCP developers, not a normal requirement for MCP consumers.
