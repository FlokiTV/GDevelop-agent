# MCP Runtime Layout Inspection

DX-23 adds read-only structural QA for a running GDevelop preview. It consumes the same live runtime-object geometry introduced for deterministic interaction, but does not dispatch input, mutate the project, add Event Sheet instrumentation or infer game-specific semantics.

## Commands

- `preview.layout.capabilities` describes selectors, geometry authority, assertion kinds, hidden-object behavior, text-fit limits and region capture.
- `preview.layout.inspect` resolves object/instance selectors, whole runtime layers and caller-declared named regions into scene/viewport geometry.
- `preview.layout.assert` evaluates deterministic structural assertions and returns machine-readable violations.
- `preview.capture.region` captures an explicit rectangle or a resolved runtime object's transformed viewport bounds and returns the actual integer crop used.

All commands are target-aware because they live under `preview.*`. A `previewWindowId` is automatically checked against `target.status.preview.targets`; normal `expectedProjectId`, `expectedSceneSelector` and `expectedPreviewTarget` preconditions remain available through the canonical MCP contract.

## Selectors

Object and instance targets use:

```json
{
  "id": "buy-label",
  "kind": "object",
  "objectName": "BuyLabel",
  "instanceIndex": 0
}
```

A runtime `instanceId` may replace or further constrain the selector. Layer targets expand the bounded runtime snapshot and then resolve each member through authoritative runtime geometry:

```json
{ "id": "ui-layer", "kind": "layer", "layer": "UI", "includeHidden": true }
```

Named regions are caller-declared viewport rectangles. They are useful for panels, safe areas and parent/container boundaries that do not have a dedicated runtime object:

```json
{
  "regions": [
    { "name": "gameplay-safe", "x": 0, "y": 0, "width": 900, "height": 720 }
  ],
  "targets": [
    { "id": "safe", "kind": "region", "region": "gameplay-safe" }
  ]
}
```

Geometry is reported in `viewport-css-px` and includes runtime identity, scene bounds, transformed viewport bounds, hitboxes, visibility, clipping against both viewport and canvas, and runtime text metadata when available. Hidden objects are still inspectable; overlap assertions exclude them by default unless `includeHidden: true` is requested.

## Assertions

`preview.layout.assert` supports:

- `visible`: require runtime-visible presentation.
- `not-clipped`: require transformed bounds to be entirely inside the viewport or canvas.
- `within`: require targets to fit a selected container target or named region, with optional padding.
- `no-overlap`: reject pairwise intersections; `allowPairs` explicitly documents intentional layering.
- `min-gap`: require horizontal or vertical separation between sorted targets.
- `align`: compare left/right/top/bottom/center-x/center-y within a tolerance.
- `safe-area`: require targets either inside or outside a protected region/container.
- `text-fit`: require a runtime text object's transformed visual bounds to fit inside a container.

A failed assertion returns structured entries with `assertionId`, `type`, stable `code`, `severity`, involved target identities/bounds, intersection rectangle when applicable, and expected/actual details.

Text-fit is deliberately visual/runtime based: it is supported when the selected runtime object exposes text through the normal GDevelop getter and its transformed runtime bounds are available. It does not estimate glyph metrics from strings or fonts. When runtime text measurement is unavailable, the assertion returns `preview_layout_text_measurement_unavailable` instead of guessing.

## Capture by bounds

To capture a runtime object only:

```json
{
  "previewWindowId": 17,
  "target": { "objectName": "BuyButton", "instanceIndex": 0 },
  "padding": 4,
  "clampToViewport": true
}
```

The result reports `requestedRegion`, `paddedRegion`, `actualRegion`, target identity, viewport metadata and capture diagnostics. The MCP transport converts the returned PNG buffer to normal `image/png` content. Explicit rectangle capture uses the same command with `region: { x, y, width, height }`; exactly one of `target` or `region` is required.

## Responsive QA and visual regression

Use `preview.viewport.set` to establish exact logical content sizes before structural assertions. DX-23 source acceptance covers 1280x720, 1366x768, 1440x900, 1600x900 and 1920x1080, including an intentionally clipped/overlapping/text-overflow layout that fails and a corrected layout that passes at every viewport.

Structural QA complements screenshot review. `preview.qa.capabilities.visualRegression.structuralLayout` advertises `preview.layout.assert` and `preview.capture.region` alongside `preview.visual.baseline.*`. Layout assertions answer geometric questions deterministically; perceptual/pixel comparison still answers appearance questions that bounds cannot represent.

## Verification

DX-23 is covered by focused service/registry/QA/targeting/live-scenario tests and the existing broad AgentIntegration/MCP regression suites. The responsive acceptance runs the same deliberately bad and corrected layouts at 1280x720, 1366x768, 1440x900, 1600x900 and 1920x1080.

Final reconciliation on 2026-09-27 re-ran the focused DX-23 set (16/16), broad AgentIntegration set (96/96) and full MCP protocol set (71/71), with Prettier list-different, JavaScript syntax checks, ArchitectureGuard and git diff --check all clean. The previously captured live source acceptance used protocol 2026-07-28 at an exact 1280x720 viewport: runtime inspection resolved a real Text object, reported partial viewport clipping, structural assertions returned clipping and text-overflow violations, region capture returned the actual clamped crop, validation reported zero errors, and project revision stayed unchanged across inspect/assert/capture.
