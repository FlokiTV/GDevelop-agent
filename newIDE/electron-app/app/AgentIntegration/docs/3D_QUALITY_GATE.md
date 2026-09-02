# 3D quality gate for GDevelop MCP agents

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
7. The controls required by the scene — movement, jump, camera, interaction/collection and any reset/recovery flow — have been exercised in the real preview.

If any one of these is missing, report the task as partially validated rather than complete.

## 1. Establish a reference before changing geometry

Before resizing or rotating a 3D model:

- call `inspect_object_properties` to read the model's nominal width, height, depth and resource;
- call `describe_instances` on an existing/template scene when a reference implementation exists;
- record whether reference instances use `customSize` and their 3D rotation;
- identify which local axis is the model's visual thickness axis before changing a single dimension.

Do not assume a model should be scaled uniformly. A mesh can be authored with its thin axis on X, Y or Z, and an instance rotation can swap the apparent axis in the scene.

### Concrete lesson from the Ripe Skirt starter

The starter coin model has nominal dimensions `31 x 31 x 31`, while reference instances use `rotationY = 90` and `customSize = false`. Creating new coins at `40-44 x 40-44 x 40-44` made them read as thick cylinders. A later attempt to force a `10 x 31 x 31` custom size also produced an artificial look.

The correct Skyline Trial redesign therefore returned to the starter contract: recreate Coin instances without `instances_size` so they keep the native model dimensions, and set only the reference rotation (`rotationY = 90`). The reusable rule is: **when a trusted reference exists, preserve its native instance sizing before inventing a corrective scale.**

## 2. Inspect composition, not just instance data

After placing geometry:

1. Open the intended scene with `scene.open`.
2. Select a representative set with `editor.instances.select`.
3. Use `focusMode: "fit"` for a composition view and `focusMode: "center"` for local inspection.
4. Use `desktop.windows.list` to identify the editor window and `desktop.window.capture` to capture it.
5. Inspect the returned MCP `image/png` content before continuing.

Look specifically for:

- oversized or undersized props;
- excessive vertical mass that blocks the player camera;
- repeated blocks with no readable route or hierarchy;
- collectibles hidden inside geometry or visually confused with obstacles;
- floating, intersecting or inaccessible objects;
- a route that looks acceptable from a top view but is unreadable from gameplay height.

A top/editor view is useful for layout, but it does not replace the player camera.

## 3. Always inspect a real preview

Start or hot-reload the preview with `preview.start` / `preview.hot-reload`, then:

1. use `desktop.windows.list` to find the actual preview window;
2. call `desktop.window.capture` with that `windowId`;
3. inspect the returned MCP image;
4. verify that it is the intended scene, not merely the project's first scene;
5. repeat after material visual changes.

Do not infer visual quality from a successful `preview.start` result alone.

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

Preferred proof combines preview capture with `runtime.status`, `runtime.snapshot`, `runtime.assert` or `runtime.wait-for`.

However, debugger telemetry can time out while a visible preview is still running. If `runtime_telemetry_timeout:*` occurs:

- record the telemetry failure explicitly;
- verify `preview.input.runtime-status` and window presence where available;
- use controlled input or a controlled proximity probe;
- capture before/after preview images;
- inspect runtime logs if available;
- do **not** convert the telemetry timeout into a passing telemetry result.

A fallback may validate gameplay behavior, but the telemetry problem remains a separate AgentIntegration/runtime issue.

## 6. Author events through deterministic AgentIntegration commands

The MCP surface now exposes deterministic event access through `events.read` and `events.apply`. These commands operate on the live in-memory project and notify the open Events Sheet about out-of-editor changes. AI event generation is not required for this path.

Rules for agents:

- read the current event tree before replacing or appending event JSON;
- use `events.apply` only with data derived from the current live project state;
- inspect diagnostics after a material event change and verify the Events Sheet/preview when behavior matters;
- prefer the smallest supported mutation; surgical event-node patching will supersede whole-tree replacement where available;
- never edit the project JSON behind GDevelop merely to bypass an authoring limitation.

## 7. Validate level mechanics before decorating

A 3D level is not a pile of visually distinct objects. Before adding or moving geometry, identify what each object actually does at runtime and preserve that role.

For each gameplay-relevant object:

- inspect its behaviors and physics body type;
- distinguish static navigation geometry from dynamic interactable objects;
- read movement values such as jump height, stair height and max speed before choosing platform heights or gaps;
- derive challenge thresholds from those values instead of eyeballing a staircase;
- calculate AABB intersections for solids and collectibles after placement; unexplained solid-solid intersections are a failed quality gate;
- inspect the player camera settings and leave enough space behind/around the spawn for that camera to work.

### Concrete lesson from Ripe Skirt

The pre-agent starter establishes clear roles: `Ground` and `Obstacle` use Static Physics3D bodies, while `PushableBox` is a heavy Dynamic body with high friction/damping. The Player has `jumpHeight = 100` and a third-person camera distance of `600`.

The original level encodes a deliberate vertical progression: the pushable box top is at `64`, a low obstacle top at `128`, a high obstacle top at `192`, and elevated coins at roughly `226`. Ground-to-128 is not a direct 100-pixel jump, while the subsequent `64`-pixel steps are reachable. This makes the box mechanically necessary.

A bad Skyline Trial revision ignored those roles: it used roughly 60-pixel platform increments (making the box unnecessary), placed dynamic boxes inside static obstacles, clipped a coin almost entirely inside collision geometry, and spawned the player too close to a rear wall for a 600-distance camera. The corrected redesign was accepted structurally only after solid-solid intersections and coin-solid intersections both reached zero and the progression was rebuilt around the real jump threshold.

The general rule is: **first reproduce the relationship between mechanics and geometry, then change the visual layout.** A distinct level can use a different route while preserving the game's mechanical grammar.

### Designing puzzles with static and pushable blocks

When a project has both static and dynamic block types, do not treat them as interchangeable art variants. Give each one a stable gameplay role and make the level communicate that role consistently.

For Ripe Skirt specifically:

- `Obstacle` is the dark/black navigation geometry and has `Physics3D.bodyType = Static`;
- `PushableBox` is the gray movable puzzle piece and has `Physics3D.bodyType = Dynamic`, density `10`, friction `2.75` and high linear/angular damping;
- the starter reference size for a pushable box is `256 x 128 x 64`;
- the Player has `jumpHeight = 100`, so a `128`-high static ledge is intentionally unreachable from the ground but reachable from the top of a `64`-high pushable box.

A useful push-block micro-puzzle should have four explicit parts:

1. **Start position** — where the movable box begins. For non-tutorial puzzles, avoid spawning it already aligned with the goal.
2. **Maneuver** — at least one meaningful repositioning step, such as moving sideways or around a static blocker before the final push.
3. **Goal position** — a clear staging position where the box creates a reachable step or route.
4. **Reward** — collectibles or progression placed beyond the threshold that cannot be reached directly from the ground.

Before accepting the puzzle:

- prove numerically that the direct route is blocked (`requiredHeight > jumpHeight`) and the box-assisted route is reachable;
- calculate AABB intersections for every initial solid and collectible;
- leave enough floor space around the box for the player to get behind the intended push directions;
- avoid narrow dead ends where a box can be pushed against a wall and become impossible to recover without restarting;
- ensure a static blocker actually changes the required box route instead of merely adding visual clutter;
- keep easy/tutorial collectibles separate from the elevated reward cluster so collecting everything requires solving the puzzle;
- inspect the puzzle from both editor/top view and the real player camera.

The Skyline Trial refinement uses two examples: the central box starts laterally offset from its `128 -> 192 -> 256` staircase, while the side puzzle uses a second box whose straight route is blocked. Its initial AABB requires the box to move at least `176` pixels sideways before it can pass the blocker and be pushed toward the `128 -> 192` reward route.

If synthetic keyboard automation sends events but produces no visible movement, record the input validation as **inconclusive**. Do not use coin animation or changing frames as proof that the Player or box moved; require a measured/runtime position change, an obvious before/after transform, or a manual playtest.

## 8. Validate the complete control contract

A scene can contain the correct behaviors and still be unplayable because the events that drive those behaviors were not carried over. Treat controls as part of the map contract, not as an unrelated implementation detail.

Before accepting a new scene, compare its event source with a known-working reference scene and identify every control path the map depends on. At minimum verify:

- movement reaches the expected directions and speeds;
- jump works at the height assumptions used by the level design;
- the player camera can be controlled as intended;
- interaction/collection triggers execute and produce an observable result;
- pointer lock, cursor capture or touch/gamepad activation happens when required;
- movement does not unexpectedly reset a manually controlled camera;
- any recovery/reset path needed by movable-object puzzles is usable.

### Concrete lesson from Ripe Skirt: ThirdPersonCamera is not enough

The first Skyline Trial copied the Player object with its `ThirdPersonCamera` behavior, but copied none of the reference camera events. The result looked structurally correct while the mouse could not rotate the camera.

The working reference scene uses two distinct pieces that must both exist:

1. a pointer-lock request after the appropriate click/touch input;
2. events that read `MousePointerLock::MovementX()` and `MovementY()` while locked and apply those values to `ThirdPersonCamera` rotation/elevation.

It also maintains an `IsCameraLocked` scene variable so the third-person auto-rotation does not immediately fight manual camera input.

Reusable rule: **duplicating an object/behavior does not duplicate the event contract that makes it usable.** Whenever a scene is created from scratch, read the reference EventScript before building and explicitly account for movement, jump, camera and interaction events.

For mouse-camera validation, do not accept only “input events were sent.” Capture a before/after preview or measure a camera/player transform that proves the viewing angle actually changed. If pointer lock requires a click, include that click in the test sequence.

For a construction-oriented workflow, read [`MAP_BUILDER.md`](./MAP_BUILDER.md) before creating or materially redesigning a map.

## 9. Finish with a clean, reviewable state

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
