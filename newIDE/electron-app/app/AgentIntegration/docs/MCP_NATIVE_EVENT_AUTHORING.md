# Native Event Sheet authoring through MCP

This guide is the default repository-side workflow for authoring GDevelop Event Sheets through the live MCP. It focuses on choosing the correct event representation, discovering instruction contracts before writing JSON, and preferring typed EditorFunction tools when they exist.

## 1. Read the event tree before editing

Call `events.read` for the target scene, External Events sheet, or extension function.

The structured command result contains three different pieces of information with different purposes:

- `data.eventsJson` — the **authoritative canonical serialized GDevelop event payload**. Use this representation when you need complete event-type-specific fields or when constructing canonical `eventJson` / `eventsJson` for mutations.
- `data.events` — a normalized navigation/index tree. It provides stable event/instruction handles, paths, fingerprints, type names, basic flags and child relationships for localized addressing.
- `data.eventsRevision` — the optimistic-concurrency token for localized event mutations such as `events.insert`, `events.update`, `events.move` and `events.delete`.

The normalized `data.events` tree is intentionally not a complete editable serialization. For example, it does not carry every event-type-specific visual field.

> Do not reconstruct or style event nodes from `data.events`. Read the canonical node from `data.eventsJson`, and use handles plus `eventsRevision` only for addressing and concurrency.

When `events.read` is paginated, both `eventsJson` and `events` contain the requested root slice while `eventsRevision` still identifies the complete current target event tree.

## 2. Discover unfamiliar conditions/actions/expressions before authoring

Do not guess native instruction or expression identifiers, return types or ordered parameters from model memory. Use the live metadata exposed by the connected build.

Typical discovery flow:

```json
{
  "tool": "events.instructions.search",
  "arguments": {
    "query": "cursor",
    "kind": "condition",
    "limit": 10
  }
}
```

Select the returned instruction id, then describe it:

```json
{
  "tool": "events.instructions.describe",
  "arguments": {
    "id": "<id returned by search>",
    "kind": "condition"
  }
}
```

For behavior-owned instructions, preserve the returned `behaviorType` when describing the instruction.

`events.instructions.describe` is the contract to consult before constructing the canonical instruction's ordered `parameters`. Search/describe can also expose applicability/context metadata from the live build. Expressions use the same authoritative surface: search with `kind: "expression"`, then describe the selected result to obtain `returnType`, ordered parameter metadata, free/object/behavior ownership, extension ownership, requirements and supported event contexts. Dedicated `events.expressions.*` aliases are intentionally unnecessary while this live contract remains complete. For example, searching for `RandomInRange` discovers the numeric helper from the connected build, while `ToString` is returned as a string expression with its ordered input contract.

Recommended native-event sequence:

1. `events.read`.
2. Locate the canonical target node in `data.eventsJson` and its corresponding handle in `data.events`.
3. For each unfamiliar condition/action/expression, call `events.instructions.search` with the appropriate `kind`.
4. Call `events.instructions.describe` for the selected identifier; for expressions, preserve the returned scope/extension disambiguators and `returnType`.
5. Construct canonical event JSON using the discovered ordered parameter contract.
6. Use the smallest suitable mutation: `events.style.update` for visual-only Group/Comment colors, otherwise `events.insert/update/move/delete`; reserve `events.apply` for deliberate bulk replacement/append.
7. Pass the current `eventsRevision` where the localized mutation requires `expectedEventsRevision`.
8. Run `diagnostics.inspect` / `validation.run`, then preview and inspect runtime behavior before explicitly saving.

## 3. Canonical Group and Comment examples

Use `events.nodes.list` to discover canonical event node types from the connected build and `events.nodes.describe` to inspect one type. `describe` probes an isolated temporary event, returns its canonical default/example, `canHaveSubEvents`, known fields and a forward-compatible schema derived from that build. The schema is intentionally marked `known-default-fields` and allows additional properties, because fields absent from the default serialization can still exist on authored nodes. For an existing event instance, `events.read.data.eventsJson` remains the authority for its complete current serialized state.

### Group

A serialized Group uses top-level RGB fields:

```json
{
  "type": "BuiltinCommonInstructions::Group",
  "name": "Player input",
  "source": "",
  "creationTime": 0,
  "colorR": 74,
  "colorG": 176,
  "colorB": 228,
  "events": []
}
```

The presentation fields are `colorR`, `colorG` and `colorB`. Preserve existing subevents when performing a localized update unless replacing them is explicitly intended.

### Comment

A serialized Comment keeps background and text RGB fields inside `color`:

```json
{
  "type": "BuiltinCommonInstructions::Comment",
  "color": {
    "r": 255,
    "g": 230,
    "b": 109,
    "textR": 0,
    "textG": 0,
    "textB": 0
  },
  "comment": "Explain why this block exists."
}
```

Do not infer these fields from the normalized handle tree. They are canonical serialization details and should be read from `eventsJson`.

### Localized visual-only style updates

Use `events.style.update` when the intent is only to change Group/Comment colors. The command accepts the same event target forms and stable `handle` used by other localized event mutations, and requires the current `expectedEventsRevision`.

The abstract style contract deliberately hides the canonical representation difference between Group and Comment:

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

- RGB channels are integers from 0 through 255.
- Group supports `background` only and maps it to `colorR/colorG/colorB`.
- Comment supports `background` and `text`, mapped to the nested `color` object.
- Unsupported style fields/event types fail before mutation.
- The operation preserves the complete canonical node, including `aiGeneratedEventId`, comment/group content, conditions/actions and subevents; callers do not resend them.
- The result returns `beforeStyle`, `afterStyle`, the new `eventsRevision`, and a `style-update` diff.
- Reapplying an already-current style with a fresh event revision is a no-op; at MCP level, the normal mutation `idempotencyKey` can also deduplicate retry replay.

## 4. Prefer typed EditorFunction MCP tools

`editor.functions.list` and `editor.functions.describe` expose the live FunctionMetadata catalog. Executable EditorFunctions are also projected as function-specific MCP tools with their own input schema and mutation metadata.

The typed MCP name is deterministic:

```text
EditorFunction: inspect_variables
Typed MCP tool: editor.functions.inspect-variables
```

The rule is `editor.functions.<function-name-with-underscores-replaced-by-hyphens>`.

For normal single-function work:

1. Discover the function with `editor.functions.list`.
2. Inspect its schema with `editor.functions.describe` when needed.
3. Confirm the corresponding typed tool is present in `tools/list`.
4. Call the typed `editor.functions.<name>` tool directly.

Prefer the typed tool because the MCP client receives the function-specific JSON schema and accurate read-only/mutation metadata before dispatch.

Use `editor.functions.call` only for compatibility or genuinely dynamic dispatch. Use `editor.functions.call-batch` when an ordered dynamic batch is the actual intent. Do not default to the generic call for an ordinary single known function.

## 5. Canonical data, handles and replay evidence are different contracts

Authoring decisions should come from the live structured MCP response:

- canonical authoring payload: `events.read.data.eventsJson`;
- stable addressing/navigation: `events.read.data.events` plus `eventsRevision`;
- persisted replay/evidence: sanitized output intended for logs and audit.

Sanitized replay data is evidence, not the source of truth for reconstructing authoring payloads.

## 6. Completion checklist for one event edit

Before considering an Event Sheet mutation accepted:

- the target and current `eventsRevision` were re-read;
- unfamiliar instruction identifiers/parameters were discovered rather than guessed;
- canonical event-type-specific fields came from `eventsJson`;
- the smallest mutation tool was used, including `events.style.update` for visual-only Group/Comment RGB changes;
- stale revision errors were reconciled by re-reading instead of overwriting;
- diagnostics/validation are clean for the intended change;
- preview/runtime behavior was checked when the change affects gameplay;
- `project.save` is called only after acceptance when persistence is intended.
