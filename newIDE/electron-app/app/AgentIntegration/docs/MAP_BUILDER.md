# 3D Map Builder guide for GDevelop MCP agents

This document describes **how to reason about and build a 3D map** through the live AgentIntegration/MCP surface. It is intentionally separate from [`3D_QUALITY_GATE.md`](./3D_QUALITY_GATE.md):

- **Map Builder** = understand the game, design the route, then construct it.
- **3D Quality Gate** = prove the result is structurally, visually and functionally acceptable.

The central rule is simple:

> **Do not design geometry before you understand the gameplay contract.**

A map is an arrangement of mechanics, not a collection of meshes.

## Phase 0 — Protect the project before experimenting

Before a material map change:

1. Confirm the exact project file currently open with `project.status`.
2. Check `hasUnsavedChanges`.
3. Prefer a clearly named review/working copy while the design is still experimental.
4. Create a checkpoint or transaction before a mutation batch when available.
5. Know which file is the user's original and do not overwrite it merely to make an experiment convenient.
6. Record the current scene/editor state and the reference scene you intend to study.

If the project has already been modified by earlier agents, do not assume the current main scene is pristine. Compare against a known backup/template when one exists and state which reference you are using.

## Phase 1 — Reconstruct the game's mechanical grammar

Before creating a new scene, read the working reference scene as if it were documentation.

### 1.1 Read the scene structure

Use the available inspection functions to identify:

- scene objects and object groups;
- initial instances and their positions/sizes/rotations;
- scene/global variables;
- scene properties, layers, lighting and skybox;
- important resources used by the scene.

Do not start by copying every object. First determine **why each object is there**.

### 1.2 Read behaviors and physics roles

For every gameplay-relevant object, inspect its behaviors and write down its role. A useful table is:

| Object | Runtime role | Physics/behavior | Map-builder implication |
| --- | --- | --- | --- |
| Player | controlled character | movement/jump/camera behaviors | determines reachable gaps/heights and camera clearance |
| Ground | walkable base | static collision | defines safe traversal surface |
| Obstacle | navigation/platform geometry | static collision | may block, support or gate routes |
| Pushable object | puzzle tool | dynamic collision | needs maneuvering room and recoverable paths |
| Collectible | reward/goal | interaction event | must be reachable and visibly readable |

Names are not enough. Two visually similar blocks can have completely different gameplay roles.

### 1.3 Read the EventScript before building

A copied object can preserve behaviors while losing the events that make those behaviors useful. Read the reference scene's event source and identify at least:

- movement control events;
- jump-related control/conditions when applicable;
- camera control events;
- pointer lock or cursor-capture events;
- interaction/collection events;
- variables that those events depend on;
- mobile/touch/gamepad control paths if the new scene is expected to support them.

Treat this as the **scene control contract**. A new scene is incomplete until its required subset of that contract exists and is tested.

### Concrete Ripe Skirt lesson

`ThirdPersonCamera` on the Player did not make mouse camera control work by itself. The working scene also required:

- a click/touch path that calls pointer lock;
- `MousePointerLock::MovementX()` and `MovementY()` events that update third-person rotation/elevation;
- the `IsCameraLocked` variable/logic that prevents auto-rotation from immediately fighting manual camera movement.

The first Skyline Trial omitted those events, so the camera behavior existed but the mouse did nothing.

## Phase 2 — Derive numeric design constraints

Do not eyeball challenge geometry when the game exposes the numbers that define reachability.

Record relevant values such as:

- Player jump height;
- character collision/body size when it matters;
- camera distance and elevation behavior;
- static platform heights;
- pushable-object dimensions;
- trigger/collection distance;
- movement speed when horizontal gaps are involved.

Then derive explicit design thresholds.

### Ripe Skirt reference profile

The pre-agent starter established these useful relationships:

- Player `jumpHeight = 100`;
- third-person camera distance = `600`;
- PushableBox reference size = `256 x 128 x 64`;
- PushableBox is Dynamic with density `10`, friction `2.75` and high damping;
- Obstacle/Ground are Static;
- a useful vertical chain is approximately `64 -> 128 -> 192 -> 256`.

The important relationship is not the absolute numbers alone. Ground-to-128 is above the direct jump threshold, while box-top-to-128 and the later 64-unit steps are reachable. That makes the movable box mechanically meaningful.

When creating a different game/map, derive an equivalent relationship from that game's own values instead of reusing these numbers blindly.

## Phase 3 — Design the route before placing decorative geometry

Describe the map first as a route graph, not a screenshot.

A minimal map plan should identify:

- **spawn** — where the player starts and what is immediately readable;
- **main route** — the required progression path;
- **optional route(s)** — risk/reward or exploration branches;
- **mechanical gates** — jumps, movable objects, switches, doors or enemies;
- **reward clusters** — where collectibles or progression rewards sit;
- **recovery space** — where a player can recover from a bad move or reposition a puzzle object;
- **camera clearance zones** — space required for the player camera to remain useful.

For each gate, write the intended solution in one sentence before implementing it. Example:

> Move the gray dynamic box sideways around the black static blocker, then push it under the 128-high ledge to create the first reachable step.

If the intended solution cannot be described clearly, the geometry is probably not ready to build.

## Phase 4 — Give static and dynamic geometry distinct jobs

Do not use physics types as visual variants.

### Static geometry

Use static blocks/platforms to:

- define boundaries;
- create ledges and elevation;
- block direct routes;
- shape corridors and sight lines;
- provide stable landing surfaces.

They should not overlap other solids unless the overlap is deliberate, understood and harmless.

### Dynamic/pushable geometry

Use pushable objects when their movement changes what the player can do.

A good push-block puzzle has four explicit parts:

1. **Start position** — not already solved unless it is a tutorial.
2. **Maneuver** — a meaningful repositioning step.
3. **Goal position** — the location where the box changes reachability.
4. **Reward/progression** — something beyond the gate that justifies solving it.

Also leave enough room for the player to get behind the box in every intended push direction. Avoid walls/corners that create irreversible softlocks unless restart/recovery is a deliberate mechanic.

### Ripe Skirt lesson

An earlier Skyline Trial revision placed dynamic boxes inside static obstacles and used small repeated vertical increments. The result had literal collision intersections and made the boxes unnecessary. The corrected approach first restored the static/dynamic roles, then rebuilt the route around the real jump threshold.

## Phase 5 — Place collectibles as level-design signals

Collectibles should communicate route and reward, not just fill empty floor.

Use them to:

- preview the next reachable location;
- reward completion of a mechanical gate;
- mark an optional route;
- pull the player's attention toward a readable objective.

Avoid placing every collectible on the safe ground plane if the map is supposed to contain traversal challenge.

Before accepting placement:

- preserve native/reference scale and orientation when a trusted reference exists;
- confirm collectible AABBs do not intersect solid geometry;
- verify the collection trigger actually reaches the Player at the intended apparent distance;
- prove at least one collection in a real preview.

### Ripe Skirt coin lesson

The starter uses Coin with native instance sizing (`customSize = false`) and `rotationY = 90`. Guessing a larger uniform size made the coins look like thick cylinders; manually flattening one axis also looked artificial. The map builder should therefore preserve the trusted native presentation first and only scale after a visual comparison proves it is necessary.

## Phase 6 — Design for the player camera, not only the editor camera

A layout that looks clean from above can be poor from gameplay height.

Before finalizing arena dimensions:

- inspect the third-person camera distance;
- leave enough space behind the spawn so the camera does not begin inside/against a wall;
- check tall masses for occlusion;
- avoid making the first obstacle consume most of the screen;
- ensure the intended next goal can be read from likely player angles.

### Ripe Skirt lesson

A 900-deep arena placed the Player too close to the rear wall for a third-person camera distance around 600. The editor view looked usable, but the player camera was dominated by the wall. Increasing arena depth fixed a gameplay-camera problem that structural diagnostics could not detect.

## Phase 7 — Build in a mechanics-first order

A reliable construction order is:

1. Create/open the target scene and establish lighting/skybox only as needed for visibility.
2. Place Ground and boundaries.
3. Place Player spawn and immediately test camera clearance.
4. Place the **minimum geometry for the main mechanic**.
5. Place required dynamic puzzle pieces.
6. Calculate solid AABB intersections.
7. Verify jump/gap thresholds numerically.
8. Add rewards/collectibles.
9. Calculate collectible-vs-solid intersections.
10. Add visual variation only after the route works.
11. Restore/author the required control and interaction event contract.
12. Run the real preview and test the route.

Do not decorate a mechanically invalid map. Decoration makes later corrections harder to reason about.

## Phase 8 — Validate every essential control in the new scene

Before calling the map playable, exercise the scene's required controls individually:

- movement;
- jump;
- mouse/third-person camera;
- interaction/collection;
- movable-object manipulation when used;
- recovery/reset when the puzzle design requires it.

For mouse camera control, a valid proof must include the pointer-lock/capture step when required and an observable camera-angle change. Merely seeing a `ThirdPersonCamera` behavior on the Player is not proof.

For automated input, distinguish **event delivery** from **gameplay effect**. If `preview.input.send` succeeds but the Player does not visibly or measurably move, mark the test **inconclusive** and rely on a measured alternative or manual playtest. Do not infer success from unrelated animation in the frame.

## Phase 9 — Use a short build/inspect loop

After each meaningful geometry batch:

1. inspect instances/data;
2. run the AABB/reachability checks relevant to the change;
3. capture the editor view;
4. capture the real player preview;
5. correct composition/mechanics before adding more content.

This is intentionally slower than dumping dozens of blocks into the scene at once. It is faster than debugging a visually dense map whose errors have no clear origin.

## Phase 10 — Final acceptance belongs to the Quality Gate

When the map design is complete, execute [`3D_QUALITY_GATE.md`](./3D_QUALITY_GATE.md) in full.

The map is not finished merely because:

- diagnostics show zero errors;
- `preview.start` returned success;
- all instances exist;
- the collectible event source parses;
- the scene looks good from the top editor camera.

Completion requires structural, visual and behavioral evidence from the actual player experience.

## Common failure patterns to reject

Reject or revise a map when you see any of these patterns:

- blocks placed because they “look like a level” but have no mechanical role;
- dynamic objects embedded in static geometry;
- platform heights chosen without reference to Player movement values;
- all rewards reachable without using the advertised puzzle mechanic;
- collectibles clipping solids;
- objects rescaled without checking the trusted reference appearance;
- Player spawned against a wall that conflicts with camera distance;
- new scene has Player behaviors but is missing the reference control events;
- pointer lock is missing, so mouse movement never reaches camera logic;
- an automated input call returned success but no gameplay transform changed;
- a map is declared complete from diagnostics alone.

## Handoff record for the next map-building agent

For each map-building task, leave a compact evidence record containing:

- project file and scene name;
- trusted reference scene/template/backup;
- gameplay-relevant objects and their roles;
- Player movement/jump/camera numbers used for design;
- required event/control contract copied or reimplemented;
- route/gates and intended solution for each puzzle;
- important heights/gaps/dimensions;
- AABB results for solids and collectibles;
- editor and player-camera captures inspected;
- interactions actually exercised;
- automation results that were inconclusive;
- whether work lives in the original project or a safe review copy;
- remaining manual playtest questions.

The purpose is not paperwork. This record prevents the next agent from starting with guesses and repeating the same design mistakes.
