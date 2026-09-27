# Deterministic preview input and interaction QA

DX-22 adds two canonical preview primitives:

- `preview.input.inspect`: read-only runtime geometry, hit-test and pointer inspection.
- `preview.input.interact`: frame-synchronized pointer interaction.

The older `preview.input.send` and `preview.input.sequence` remain compatibility primitives. Deterministic interaction QA should prefer `inspect` and `interact`.

## Targeting

Both tools accept either:

- a runtime selector with `objectName` and optional `instanceId` / `instanceIndex`; or
- explicit `x` / `y` coordinates.

Coordinates default to Electron content/viewport CSS pixels. Set `coordinateSpace: "scene"` and optionally `layer` to resolve scene coordinates through the runtime layer/camera transform.

For drag, destination fields are `toTarget` or `toX` / `toY`, with `toCoordinateSpace` and `toLayer` when needed.

## Runtime geometry and hit-test authority

Inspection is backed by the live GDevelop runtime:

- `RuntimeObject.getWidth()/getHeight()`;
- `RuntimeObject.getCenterXInScene()/getCenterYInScene()`;
- `RuntimeObject.getAABB()`;
- `RuntimeObject.getHitBoxes()`;
- `RuntimeLayer.convertCoords()/convertInverseCoords()`;
- runtime layer order/visibility and object z-order.

The result includes scene and transformed viewport center/bounds/hitboxes, canvas/game-resolution scaling, `devicePixelRatio`, and the exact viewport CSS coordinate used for dispatch.

Hit-test candidates are ordered by visible layer, z-order, then runtime instance order. Hidden objects, hidden-layer objects, and objects no longer living on the scene are excluded from ownership and are reported separately in `hitTest.excluded`. This means a hidden stale control cannot win ownership over a visible replacement at the same point.

## Visibility, disabled and legacy semantics

Visual/runtime visibility is authoritative and automatic. The result separates:

- `classification.presentationSurface`;
- `classification.interactionControl`;
- `state.hidden`, `layerVisible`, `livingOnScene`, and `hitTestable`.

GDevelop projects can encode “disabled”, “locked”, or “legacy” semantics in arbitrary event logic, so the adapter does not guess these states from object names or visuals. Callers can provide explicit runtime predicates:

```json
{
  "controlState": {
    "disabledWhen": {
      "scope": "scene",
      "variable": "Locked",
      "operator": "truthy"
    },
    "legacyWhen": {
      "scope": "scene",
      "variable": "UseLegacyControl",
      "operator": "truthy"
    }
  }
}
```

Matching predicates produce `preview_target_disabled` / `preview_target_legacy` diagnostics and set the corresponding classification field. Disabled targets are still dispatchable so QA can prove that the game ignores them; hidden/non-living/non-hit-testable/out-of-viewport targets are rejected before dispatch.

## Canonical actions

`preview.input.interact` accepts:

- `move`
- `hover`
- `press`
- `release`
- `click`
- `double-click`
- `drag`

A click is not sent as down+up in the same browser turn. The service dispatches move, waits for a processed runtime frame, dispatches mouse-down, waits for a processed runtime frame, then dispatches mouse-up and waits again. Drag uses the same rule for the press, each bounded interpolation step, and release.

The processed-frame signal comes from the current scene `TimeManager` observed across `requestAnimationFrame`; fixed sleeps are not part of the canonical interaction path. If no processed runtime frame is observed within the bounded frame/timeout budget, the call fails with `preview_input_frame_timeout`.

## Wait-for-state and assert-after-input

`waitFor` and `assertAfter` observe scene/global variables with operators:

`equals`, `not-equals`, `gt`, `gte`, `lt`, `lte`, `truthy`, `falsy`.

`waitFor` advances by processed runtime frames until the predicate is stable or its bounded timeout expires. `assertAfter` evaluates the post-input state and returns a structured assertion failure when it does not match.

## Result shape

Interaction results include:

- exact dispatched phases/events and their frame-synchronization evidence;
- source/destination viewport coordinates;
- resolved target identity and geometry;
- hit-test owner before/after;
- tracked pressed buttons/keys and pointer position;
- hover owner;
- click dispatch count/effect authority;
- cursor state;
- wait/assert observations;
- viewport/canvas/game-resolution/DPI metadata.

## Acceptance evidence

Source acceptance is covered by:

- `AgentPreviewRuntime.test.js`: runtime geometry, scaling/DPI, cursor, frame synchronization, wait-for-state and hidden stale exclusion.
- `PreviewInteractionService.test.js`: canonical click/double-click/drag semantics, disabled classification, structured hidden diagnostics and observable result state.
- `PreviewDeterministicInteractionAcceptance.test.js`: deterministic tab switching, language toggle, buy, locked/unlocked upgrade, 20 repeated identical click sequences, and hidden stale replacement ownership.
- MCP/registry regression: tool catalog projection, canonical response envelope, official MCP transport and preview target-isolation tests.
