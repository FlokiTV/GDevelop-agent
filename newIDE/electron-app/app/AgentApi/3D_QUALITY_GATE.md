# 3D quality gate for embedded agents

A successful build, zero runtime errors, or a clean diagnostics report is **not** enough to call a 3D change finished. Agents must validate what a player actually sees and what the game actually does.

Use this gate after creating or materially changing a 3D scene.

## Acceptance rule

Do not mark a 3D task complete until all of these are true:

1. The scene is structurally valid.
2. Important object sizes and orientations are grounded in the source object/template rather than guessed.
3. The editor view has been captured and inspected.
4. A real preview from the player camera has been captured and inspected.
5. Important interactions have been proven by an observable state change.
6. Temporary probes have been restored and the intended project state has been saved only after validation.

If any one of these is missing, report the task as partially validated rather than complete.

## 1. Establish a reference before changing geometry

Before resizing or rotating a 3D model:

- call `inspect_object_properties` to read the model's nominal width, height, depth and resource;
- call `describe_instances` on an existing/template scene when a reference implementation exists;
- record whether reference instances use `customSize` and their 3D rotation;
- identify which local axis is the model's visual thickness axis before changing a single dimension.

Do not assume a model should be scaled uniformly. A mesh can be authored with its thin axis on X, Y or Z, and an instance rotation can swap the apparent axis in the scene.

### Concrete lesson from the Ripe Skirt starter

The starter coin model has nominal dimensions `31 x 31 x 31`, while reference instances use `rotationY = 90` and do not apply arbitrary uniform instance scaling. Creating new coins at `40-44 x 40-44 x 40-44` made them read as thick cylinders.

For the Skyline Trial quality pass, `rotationY = 90` was restored and the thickness axis was reduced independently (`10 x 31 x 31`). This is a project-specific example, not a universal coin size. The reusable rule is: **derive orientation and thickness axis from the reference, then alter only the dimension that needs visual adjustment.**

## 2. Inspect composition, not just instance data

After placing geometry:

1. Open the intended scene with `open-scene`.
2. Select a representative set with `editor-select-instances`.
3. Use `focusMode: "fit"` for a composition view and `focusMode: "center"` for local inspection.
4. Capture the editor window with `/v1/windows` + `/v1/capture`.
5. Inspect the returned PNG before continuing.

Look specifically for:

- oversized or undersized props;
- excessive vertical mass that blocks the player camera;
- repeated blocks with no readable route or hierarchy;
- collectibles hidden inside geometry or visually confused with obstacles;
- floating, intersecting or inaccessible objects;
- a route that looks acceptable from a top view but is unreadable from gameplay height.

A top/editor view is useful for layout, but it does not replace the player camera.

## 3. Always inspect a real preview

Start or hot-reload the preview, then:

1. use `/v1/windows` to find the actual preview window;
2. capture it with `/v1/capture?windowId=...`;
3. inspect the PNG;
4. verify that it is the intended scene, not merely the project's first scene;
5. repeat after material visual changes.

Do not infer visual quality from `preview-start: { started: true }`.

The preview image is the authoritative check for apparent scale, lighting, occlusion and camera readability.

## 4. Prove interactions with an observable state change

The existence of an event is not proof that gameplay works.

For collectibles, switches, doors, damage zones and similar interactions, prove at least one observable effect:

- the collectible count changes;
- the object disappears;
- a scene/global variable changes;
- the door changes state;
- the target scene changes;
- an equivalent runtime assertion passes.

### Controlled collectible probe

A reliable collectible test is:

1. record the collectible's original position;
2. temporarily move one instance inside the trigger radius of the Player;
3. hot-reload the preview;
4. assert the score/count variable when telemetry is healthy, or visually verify that the runtime collectible was removed;
5. restore the original editor position;
6. hot-reload again;
7. confirm the editor still contains the intended instance and no probe state remains.

This separates "input mapping failed" from "collection logic failed" and avoids pretending that simulated movement proved the interaction.

## 5. Use runtime telemetry when healthy, but do not depend on it blindly

Preferred proof combines preview capture with `runtime-status`, `runtime-snapshot`, `runtime-assert` or `runtime-wait-for`.

However, debugger telemetry can time out while a visible preview is still running. If `runtime_telemetry_timeout:*` occurs:

- record the telemetry failure explicitly;
- verify `preview-runtime-status`/window presence where available;
- use controlled input or a controlled proximity probe;
- capture before/after preview images;
- inspect runtime logs if available;
- do **not** convert the telemetry timeout into a passing telemetry result.

A fallback may validate gameplay behavior, but the telemetry problem remains a separate Agent API issue.

## 6. Event authoring limitation in the embedded API

At the time this guide was written, embedded `add_scene_events`/`generate_events` calls run with `relatedAiRequestId: null`. The native event generation function therefore rejects them with `No related AI request ID found for events generation.`

Rules for agents:

- never report events as added when this call failed;
- prefer a deterministic supported event-authoring path when one exists;
- if a temporary file-level fallback is absolutely necessary for investigation, use a clearly named **working copy**, preserve a backup, reopen the copy through GDevelop, and validate the parsed EventScript before previewing;
- never overwrite the user's original project merely to bypass this limitation;
- track the missing deterministic event-authoring path as an Agent API gap to fix.

## 7. Finish with a clean, reviewable state

Before calling the scene ready:

- restore temporary moved/test instances;
- commit or roll back any active transaction intentionally;
- run project diagnostics;
- re-read the important event source;
- capture a final preview;
- confirm the intended project file is the one being edited/saved;
- keep the user's original file untouched when the work is still awaiting approval.

Warnings must be interpreted, not counted mechanically. For example, a resource diagnostic that says "outside project" while its own structured details say `insideProjectFolder: true` is a diagnostics defect/fallback signal, not evidence that the asset is actually missing.

## Minimal evidence to record in a task update

A useful completion note should state:

- scene name;
- reference object/scene used for scale and orientation;
- final important dimensions/rotations;
- what editor and preview captures were inspected;
- which interaction was exercised and what changed;
- diagnostics/runtime failures that remain separate issues;
- whether changes are in the original project or a review copy.

This evidence is what lets the next agent continue accurately instead of repeating assumptions.
