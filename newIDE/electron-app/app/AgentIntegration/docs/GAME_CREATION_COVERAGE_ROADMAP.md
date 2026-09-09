# GDevelop AgentIntegration/MCP — Game Creation Coverage Roadmap

## Purpose

This document defines the work required to evolve AgentIntegration from a strong live-editing MCP surface into a nearly complete programmatic interface for autonomous game creation in GDevelop.

The current MCP is already capable of building and validating complete small/medium games: it can create/open projects, author scenes/objects/instances/events/resources, control previews, inspect runtime state, validate, save and export HTML5. The remaining work is primarily about **coverage, discovery, specialization and release completeness** rather than rebuilding the existing live-editing core.

The target is not “expose every internal GDevelop method”. The target is:

> An MCP-capable agent can discover what the installed GDevelop build supports, author any normal game structure without prior hard-coded knowledge, inspect and debug the running game, produce deterministic evidence, and build/publish supported targets while preserving the current safety and upstream-reviewability model.

## Architectural invariants

All work in this roadmap must preserve these constraints:

1. **MCP remains the only public agent protocol.**
2. **Business logic stays outside the MCP adapter.** MCP projects AgentIntegration/AgentCore capabilities; it must not become a second implementation of editor semantics.
3. **Live editing is authoritative.** Normal authoring targets the already-open in-memory project and must not close/reopen the project to synchronize state.
4. **Upstream integration remains minimal.** Prefer AgentIntegration-owned code and the existing small set of upstream hooks.
5. **Mutations remain explicit and concurrency-safe.** Keep project/event revision checks, idempotency, transactions/checkpoints and structured recovery.
6. **Saving and publication remain explicit.** Authoring must not silently save, export or publish.
7. **External/network capabilities are least-privilege.** Asset/document/build/publication integrations must not weaken the loopback/auth boundary or persist credentials into discovery/logs/replay artifacts.
8. **Capabilities must be discoverable from the connected build.** Clients should not need a hard-coded catalog of GDevelop object types, behaviors, instructions, effects or extensions.
9. **Every new capability gets an automated gate and a live-Electron acceptance path when UI/runtime behavior matters.**

## Baseline already available

### Public MCP/editor lifecycle

AgentIntegration currently exposes one local Streamable HTTP MCP endpoint with discovery, rotating bearer authentication, explicit window/project targeting and MCP 2026-07-28 as the primary protocol revision. MCP 2025-11-25 remains a stateless protocol compatibility mode on the same boundary.

### Current command families

The live command registry already covers:

- project lifecycle: `project.create/open/close/status/save/save-as`;
- EditorFunction discovery/execution: `editor.functions.list/describe/call/call-batch`;
- editor context: `scene.open`, `editor.visual.status`, instance selection/focus;
- deterministic scene events: `events.read/insert/update/move/delete/apply`;
- local resources: list/inspect/import/replace/rename/remove;
- checkpoints and transactions;
- diagnostics and aggregate validation;
- preview lifecycle and hot reload;
- keyboard/mouse/touch/gamepad preview input;
- runtime status/snapshot/log/assert/wait-for;
- desktop window listing/capture;
- HTML5 export.

### Embedded EditorFunctions

The generated EditorFunction catalog currently contains **39 functions**, of which **30 are executable in the embedded editor integration** and **9 remain generation-service-only**.

The generation-service-only group is currently:

- `create_or_update_plan`;
- `report_fulfilment_problem`;
- `read_full_docs`;
- `search_docs`;
- `run_explorer_agent`;
- `run_edit_agent`;
- `run_tests`;
- `search_object_asset_store`;
- `search_resource_store`.

The roadmap does **not** require embedding the orchestration/sub-agent functions. It does require reconsidering docs and store discovery because those are editor/product capabilities useful to any MCP client.

### Existing authoring depth

The embedded functions already support important high-level authoring operations including scene creation/deletion/renaming, object creation/duplication/deletion, global objects, behaviors, variables, scene layers/effects/groups, object properties/effects, 2D/3D instance placement and editing, project properties/resources, event generation/reads and gameplay tests.

This means the main missing capability is no longer basic CRUD. It is the ability to **discover and manipulate advanced GDevelop structures without assuming the model already knows internal identifiers and schemas**.

---

# Coverage gaps

## P0 — Required for autonomous authoring without prior model knowledge

### CAP-01 — Instruction catalog: conditions, actions and expressions

**Problem:** `events.*` can author event trees, but the MCP does not expose an authoritative searchable catalog of installed conditions, actions and expressions with parameter schemas. An agent may know the event-tree shape while still guessing instruction identifiers or argument order.

**Target surface:**

- `events.instructions.search`
- `events.instructions.describe`
- optionally `events.expressions.search/describe` if expressions require a distinct representation

**Requirements:**

- source data from the connected GDevelop build/metadata provider, not a copied static catalog;
- filter by kind, extension, object/behavior type, text/capability and deprecation status;
- return canonical identifier, display name, description, parameter definitions, allowed values and object/behavior requirements;
- expose expression return type and parameter types;
- include enough metadata to build valid event instructions without web/model memory;
- deterministic schemas and compatibility tests.

**Acceptance:** an external MCP client can discover an installed behavior condition it did not hard-code, construct a valid Standard event using only returned metadata, run the preview and validate the resulting behavior.

### CAP-02 — Object, behavior and effect type discovery

**Problem:** authoring accepts `object_type`, `behavior_type` and `effect_type`, but there is no first-class MCP catalog for the installed build.

**Target surface:**

- `editor.types.objects.list/describe`
- `editor.types.behaviors.list/describe`
- `editor.types.effects.list/describe`

**Requirements:**

- canonical type identifiers and installed extension ownership;
- supported rendering mode/2D/3D constraints;
- property schemas/defaults/choices/resource requirements;
- behavior applicability constraints;
- effect property metadata and 2D/3D compatibility;
- searchable by natural terms/capability.

**Acceptance:** a clean client can discover a type, create/configure it, inspect the object and validate it in a live preview without hard-coded type metadata.

### CAP-03 — EventsFunctionsExtension/custom logic authoring

**Problem:** project serialization/inspection knows about EventsFunctionsExtensions, but AgentIntegration does not expose a complete write surface for custom functions, custom behaviors and events-based custom objects.

**Target surface:** an `extensions.*` authoring service independent of MCP transport.

Minimum operations:

- list/inspect/create/rename/delete project extensions;
- create/update/delete extension functions;
- create/update/delete function parameters and object/behavior requirements;
- create/update/delete events-based behaviors;
- create/update/delete events-based custom objects and variants;
- read/write their event sheets through stable handles/revisions;
- preserve whole-project reference refactors on rename/delete.

**Acceptance:** create a new extension from scratch, add a custom function and custom behavior, use them in a scene, preview the game, hot reload subsequent edits and rollback through AgentIntegration safety tools.

### CAP-04 — External Events authoring

**Problem:** the current `events.*` surface is scene-centric. Projects commonly use External Events for modular logic.

**Target surface:**

- `external-events.list/create/inspect/rename/delete`
- event-tree operations targeting an external-events document, preferably by generalizing the existing stable event-tree service rather than cloning it.

**Requirements:** same stable handles, event revision, optimistic concurrency and refactoring safety as scene events.

**Acceptance:** create External Events, author logic, reference/use it from a scene, verify in preview, rename it with references preserved, and delete safely.

### CAP-05 — External Layout authoring

**Problem:** GDevelop supports External Layouts but there is no AgentIntegration CRUD/inspection surface for them.

**Target surface:**

- `external-layouts.list/create/inspect/duplicate/rename/delete`
- instance CRUD equivalent to scene initial instances where appropriate.

**Acceptance:** create and populate an External Layout, use it from game logic, inspect the live project, duplicate/rename it and validate references.

### CAP-06 — Embedded GDevelop documentation discovery

**Problem:** `search_docs` and `read_full_docs` exist upstream but are marked generation-service-only. A generic MCP host cannot ask the connected GDevelop integration for authoritative product/extension documentation.

**Target surface:**

- `docs.search`
- `docs.read`
- optional MCP resources for versioned documentation entries.

**Requirements:**

- no dependency on the old generation-agent orchestration contract;
- identify source/version/extension;
- bounded responses with pagination/sections;
- clear offline/network-unavailable errors;
- caching with explicit scope/TTL.

**Acceptance:** an external host can search an unfamiliar feature, read the relevant documentation and use the discovered API in a successful live-edit scenario.

### CAP-07 — Asset Store and resource-store discovery/import

**Problem:** `search_object_asset_store` and `search_resource_store` are generation-service-only. Local file import works, but a standalone MCP client cannot discover GDevelop library assets itself.

**Target surface:**

- `store.objects.search/inspect/import`
- `store.resources.search/inspect/import`

**Requirements:**

- explicit network boundary and cancellation;
- result provenance/license/author/attribution metadata when available;
- bounded thumbnails/metadata, no accidental large downloads;
- import through existing resource/object authoring paths rather than separate project mutation logic;
- deterministic naming/collision behavior;
- no stored credentials in project/audit artifacts.

**Acceptance:** search for an asset, inspect license/provenance, import it into a live project, instantiate it, preview it and roll the project back safely.

### CAP-08 — Strongly typed MCP projection for EditorFunctions

**Problem:** `editor.functions.describe` knows per-function schemas, but actual execution is routed through generic `editor.functions.call` whose `arguments` field is only `{type: object}`. The generic tool also has conservative mutation annotations even for read-only functions.

**Preferred design:** project executable EditorFunctions as individual MCP tools generated from FunctionMetadata, while retaining the generic discovery/call surface for compatibility and batching.

**Requirements:**

- deterministic MCP names and collision policy;
- per-function input schema;
- per-function readOnly/destructive/idempotent/longRunning annotations derived from authoritative metadata;
- argument-dependent mutation functions remain safe and accurately represented;
- generic call remains available where useful, but clients should not need it for normal single calls;
- schema snapshot/conformance gate.

**Acceptance:** an MCP host sees typed tools for the embedded functions through `tools/list`, rejects malformed calls before editor dispatch and receives accurate read-only/mutation annotations.

---

## P1 — Required for high-quality production game authoring and QA

### CAP-09 — Structured object-type authoring

**Problem:** generic object configuration metadata is useful, but complex object structures need specialized operations. Examples include Sprite animations/frames/points/collision masks, Tilemap structures, particle emitters and model-specific configuration.

**Direction:** provide extensible type-specific authoring modules keyed by object metadata, not one giant switch in MCP.

**Initial scope:**

- Sprite animations, directions/frames, named points/origin/center and collision masks;
- Tilemap/tile atlas configuration where supported by native editor services;
- particle emitter structured configuration;
- 3D Model animation/material/resource configuration;
- text/font-specific structures where generic properties are insufficient.

**Acceptance:** construct representative objects from raw/local resources without relying on a prebuilt Asset Store object and verify visual/runtime output.

### CAP-10 — Explicit extension management

**Problem:** some EditorFunctions install required extensions implicitly when an object/behavior type is used, but there is no lifecycle surface.

**Target surface:**

- `extensions.installed.list`
- `extensions.catalog.search/describe`
- `extensions.install/update/remove`

**Requirements:** distinguish built-in, project events-based and external/community extensions; report dependency/reference blockers before remove/update.

**Acceptance:** discover and install a required extension, author content using it, inspect installed version/source and safely reject removal while referenced.

### CAP-11 — Remote resource import and provenance

**Problem:** resource tools accept local files only. Agents frequently obtain generated or hosted assets through URLs.

**Target:** `resources.import-url`/`replace-url` implemented through a bounded downloader feeding the existing resource mutation service.

**Security:** protocol allowlist, redirects policy, timeout, maximum bytes, MIME sniffing, checksum, destination policy and SSRF-safe defaults.

**Provenance:** store optional source URL/provider/license/author/attribution metadata in an AgentIntegration-owned sidecar/manifest unless a suitable GDevelop-native field exists.

**Acceptance:** import a valid remote resource, reject unsafe/oversized destinations, preserve provenance and validate the resource in preview/export.

### CAP-12 — Asset processing pipeline

**Problem:** importing bytes is not enough for autonomous production. Common transformations still require another toolchain.

**Candidate operations:** image resize/crop/pad/atlas/spritesheet slicing, audio normalize/transcode, video transcode, model validation/optimization.

**Rule:** transformations should be separate from project semantics and produce explicit output artifacts before resource replacement/import.

**Acceptance:** perform at least one deterministic image and audio transformation, import outputs, validate hashes/metadata and use them in a game.

### CAP-13 — Scene duplication and reusable authoring templates

**Problem:** object duplication exists, but scene duplication is not first-class. Repeated levels benefit from structural cloning.

**Target:** `scene.duplicate` with conflict-safe naming and optional resource/reference strategy.

**Acceptance:** duplicate a non-trivial scene with layers, groups, instances and events; verify the clone is structurally independent where expected and remains valid after edits.

### CAP-14 — Build targets and packaging configuration

**Problem:** `export.html5` is first-class, but desktop/mobile delivery is not.

**Target build surface:** capability-driven, because availability depends on GDevelop services/platform/build environment.

- `build.targets.list`
- `build.start/status/cancel/result`
- local/export targets where supported;
- remote build-service integration only through explicit auth/configuration.

**Configuration coverage:** icons, splash/loading screen, platform identifiers, orientation/resolution and target-specific settings required to produce installable artifacts.

**Acceptance:** at minimum one desktop/installable target beyond HTML5 plus explicit capability/error behavior for unavailable targets. Mobile targets require a separate real-device/emulator gate before claiming support.

### CAP-15 — Preview-impact metadata and lifecycle decisions

**Problem:** the agent can hot reload, but command metadata does not formally state whether a mutation requires no preview action, hot reload, or preview restart.

**Target metadata:** `previewImpact: none | hot-reload | restart | unknown` on mutation descriptors/results.

**Acceptance:** a generic agent can make a series of heterogeneous edits and choose the correct preview action solely from returned metadata, with tests preventing false `hot-reload` claims.

### CAP-16 — Event debugger and execution trace

**Problem:** runtime snapshots show state, not *why* an event did or did not execute.

**Target capabilities:**

- event breakpoints by stable handle;
- pause/continue/step where debugger support permits;
- execution counts/timestamps;
- condition evaluation trace;
- last executed event handles;
- mapping runtime traces back to authoring handles.

**Acceptance:** diagnose a deliberately failing condition using trace evidence without modifying the project just to add logging events.

### CAP-17 — Runtime profiler and specialized telemetry

**Current state:** runtime snapshot includes scene/global variables, object instances, scalar behavior state and approximate FPS.

**Missing production telemetry:**

- frame-time distribution and hitch detection;
- memory/heap where available;
- render/draw-call style metrics if exposed by runtime;
- audio channels/sounds/music state;
- physics contacts/velocities/body state;
- pathfinding/navigation state;
- network/WebSocket/request state for online games.

**Acceptance:** define capability-based telemetry modules; unavailable low-level metrics must report unsupported explicitly rather than fabricate values.

### CAP-18 — Deterministic gameplay testing

**Problem:** input/assertion tools exist, but reproducibility is limited by random/time behavior.

**Target controls:**

- seeded randomness where runtime allows;
- fixed/controlled timestep or deterministic clock mode for tests;
- named test fixtures;
- deterministic start state;
- reset/replay semantics.

**Acceptance:** run the same automated gameplay scenario repeatedly with stable assertions and documented nondeterministic exceptions.

### CAP-19 — Input record/replay, visual regression and device simulation

**Target:**

- record normalized preview input into a portable sequence;
- replay it with timing policy;
- screenshot baseline capture/compare;
- configurable image-diff tolerance and ignore regions;
- mobile/device preview presets for viewport, DPR, orientation changes and safe-area assumptions where the preview stack can represent them reliably;
- short playtest video capture as optional evidence, not required for every run.

**Acceptance:** record a scenario, replay it after a project edit, compare expected screenshots, run at least one device/viewport preset and produce structured pass/fail evidence.

---

## P2 — Scale, collaboration and delivery completeness

### CAP-20 — Multiplayer preview orchestration

**Problem:** multiple windows can be targeted, but there is no game-test abstraction for N synchronized players.

**Target:**

- start/identify N preview clients;
- stable player/client aliases;
- coordinated input sequences;
- synchronized assertions across clients;
- configurable latency/jitter/loss simulation only where technically reliable.

**Acceptance:** two-client gameplay test with independent input and cross-client state assertions.

### CAP-21 — Network observability

Expose bounded network diagnostics useful for multiplayer/backend games: request/WebSocket lifecycle, status/failures, latency and selected metadata while redacting secrets/content by default.

**Acceptance:** diagnose a failed network interaction without exposing bearer/session secrets into MCP logs or replay artifacts.

### CAP-22 — Granular revisions and semantic locks

**Current state:** project-wide optimistic revision plus dedicated events revision is robust but conservative for parallel agents.

**Target:**

- optional revisions for scene/object/resource/extension documents where native change tracking can support them reliably;
- semantic lease/lock service for long multi-agent operations;
- never weaken project-wide revision as final safety net.

**Acceptance:** two clients can safely edit independent areas concurrently while conflicts in the same semantic scope are deterministically rejected.

### CAP-23 — Rich MCP resources/subscriptions

**Current resources:** project status, editor visual context and resource catalog, plus operation state elsewhere in the integration.

**Candidate resources:**

- project/scenes index;
- scene object/instance summaries;
- scene/external/extension event trees;
- extension/type catalogs;
- runtime snapshot/log streams;
- diagnostics/latest validation;
- build operation state.

Where MCP subscriptions are appropriate, publish revision/change notifications instead of forcing polling.

**Acceptance:** a read-heavy client can maintain current project context primarily through resources/subscriptions while mutations still use tools.

### CAP-24 — Publication integrations

Publication is intentionally separate from build/export.

Potential adapters include gd.games and optional third-party targets such as itch/Steam, but every adapter must be opt-in and credential-aware.

**Rules:**

- explicit user intent before publish/update;
- never persist credentials in project or MCP discovery;
- dry-run/manifest where possible;
- publish result includes immutable build/artifact identity;
- no automatic store submission or release promotion.

**Acceptance:** implement only targets with a stable supported API and a secure credential story. Lack of a third-party adapter must not block the core completeness milestone.

### CAP-25 — Final autonomous game-creation benchmark

Create a product-level benchmark that starts from a clean/open GDevelop project and requires an external MCP host to build a representative game without repository-side shortcuts.

The scenario should exercise:

- discovery of unknown types/instructions;
- assets/docs;
- custom extension logic;
- scene + external events/layout;
- structured object editing;
- preview/test/debug cycle;
- deterministic assertions and visual evidence;
- save + at least HTML5 and one additional build target when available;
- rollback/reconnect resilience;
- no project close/reopen during normal authoring.

This benchmark is the completion gate for the roadmap, not merely protocol unit tests.

---

# Work sequencing and dependencies

## Phase A — Discovery foundation

Implement CAP-01, CAP-02 and the metadata foundation required by CAP-08 first. These reduce guesswork for every later authoring feature.

## Phase B — Missing GDevelop project structures

Implement CAP-03, CAP-04 and CAP-05. These are the largest structural gaps between AgentIntegration and the normal GDevelop project model.

## Phase C — Knowledge and content acquisition

Implement CAP-06, CAP-07, CAP-10 and CAP-11. Asset processing CAP-12 can follow after import/provenance contracts stabilize.

## Phase D — Typed authoring and production ergonomics

Finish CAP-08, then CAP-09, CAP-13 and CAP-15. These improve correctness and reduce the number of fragile generic calls.

## Phase E — QA/debugging determinism

Implement CAP-16 through CAP-19. Deterministic testing should precede claiming advanced autonomous reliability.

## Phase F — Builds and scale

Implement CAP-14, then CAP-20 through CAP-24 as supported by the actual GDevelop/runtime/platform APIs.

## Phase G — Completion benchmark

CAP-25 runs only after the relevant capabilities have live acceptance evidence.

---

# Cross-cutting acceptance requirements

Every implementation card must satisfy the relevant subset of these gates:

1. command/business implementation lives in AgentIntegration/AgentCore-owned code;
2. MCP only projects descriptors/resources and protocol behavior;
3. typed JSON schemas reject malformed input before mutation;
4. mutation metadata, destructive semantics and preview impact are accurate;
5. expected project/event/scope revision is enforced when applicable;
6. cancellation propagates through long-running operations;
7. retries/idempotency are documented and tested;
8. secrets are redacted from logs, traces, resources and artifacts;
9. operation has focused unit tests;
10. MCP official-client integration coverage exists;
11. live packaged Electron acceptance exists for capabilities that depend on editor UI/runtime/network/build services;
12. ArchitectureGuard remains green and upstream hooks do not grow without an explicit architectural decision;
13. docs/command discovery are updated in the same change;
14. `git diff --check` and the affected regression suites pass before publication.

# Non-goals / boundaries

The following should not be conflated with AgentIntegration core coverage:

- image/music/voice/3D generation models themselves;
- arbitrary third-party website automation;
- storing user storefront credentials;
- a second REST protocol;
- duplicating GDevelop business rules in MCP;
- exposing unrestricted JavaScript/native internals merely to bypass missing domain APIs.

External creative tools can generate assets; AgentIntegration should focus on safe ingestion, provenance, configuration and validation inside GDevelop.

# Decisions that may require user input later

No decision currently blocks roadmap creation. During implementation, ask before committing to any of these scope choices if they materially change cost/security/product behavior:

1. which non-HTML5 build targets must be considered mandatory for the completeness milestone;
2. whether third-party publication adapters (itch/Steam/etc.) are desired or whether gd.games/build artifacts are sufficient;
3. whether remote URL asset ingestion is allowed by default or must be opt-in per project/session;
4. whether generated asset provenance should live in a repository sidecar file or only in transient AgentIntegration metadata when GDevelop has no native field;
5. how much runtime instrumentation may modify the GDevelop debugger/runtime protocol versus remaining read-only over existing dumps.

Until one of those decisions becomes blocking, implementation should prefer capability-driven, optional adapters and preserve the current minimal upstream footprint.
