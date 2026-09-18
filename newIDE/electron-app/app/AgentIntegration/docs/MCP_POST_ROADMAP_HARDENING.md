# GDevelop MCP — Post-Roadmap Hardening and Continuous Certification

## Purpose

CAP-01 through CAP-25 completed the functional game-creation roadmap. The integration can discover the connected GDevelop build, author normal project structures, inspect and debug runtime behavior, execute deterministic QA, save/export/build supported targets and exercise reconnect/rollback safety through the public MCP surface.

The next phase is not another feature-coverage roadmap. It is **hardening the completed MCP surface against upstream drift and making unsupported boundaries explicit**.

This document is the working plan for that phase.

---

## Current status

### Repository baseline

- Current fork HEAD: `8a5aa7d26257039a565616e38dee43b2d325cb06`.
- The fork recently merged upstream GDevelop through `0f049e463a`.
- CI workflow failures caused by fork-missing AWS/Crowdin credentials were made fork-safe in `8a5aa7d262`.
- The current push-level workflows are green.

### Last full autonomous certification

The last complete packaged autonomous benchmark was executed before the latest upstream merge, on the CAP-25 line rooted at:

- CAP-25 completion: `7c6e0610f6af416e454376d1555b5f226bb33a42`.
- MCP protocol: `2026-07-28`.
- Packaged MCP surface at that point: 211 tools.
- External benchmark: PASS.

That benchmark demonstrated, through public MCP only:

- capability discovery without hard-coded GDevelop model identifiers;
- docs and Resource Store usage;
- scene, structured object, extension action, External Events and External Layout authoring;
- runtime assertions and visual regression;
- profiling;
- explicit save;
- HTML5 export;
- an additional `web-online` build artifact;
- MCP reconnect without losing the live project;
- transaction rollback after reconnect;
- no project close/reopen as a normal synchronization mechanism.

### Important distinction

The roadmap is functionally complete, but the **current HEAD has not yet been re-certified with the entire packaged CAP-25 benchmark after the latest upstream merge**.

The normal CI gates prove selected command, protocol and architecture invariants. They do not yet prove the entire product-level autonomous workflow after every upstream update.

This is the highest-priority remaining MCP task.

---

# What is complete

The following areas should be treated as implemented unless a new upstream regression disproves them.

| Area | Status |
| --- | --- |
| Public MCP transport and authentication | Complete |
| Build-derived capability discovery | Complete |
| Conditions/actions/expressions discovery | Complete |
| Object/behavior/effect type discovery | Complete |
| Strongly typed MCP projection | Complete |
| Scene/object/instance/resource authoring | Complete |
| Structured object authoring | Complete for certified supported structures |
| EventsFunctionsExtension/custom logic authoring | Complete |
| External Events | Complete |
| External Layouts | Complete |
| Embedded docs discovery | Complete |
| Asset/Resource Store discovery and import | Complete |
| Remote resource ingestion and provenance | Complete |
| Deterministic image/audio asset processing | Complete for implemented transforms |
| Extension lifecycle management | Complete |
| Scene duplication | Complete |
| Preview-impact metadata | Complete |
| Event debugging/runtime inspection | Complete for exposed runtime primitives |
| Deterministic gameplay testing | Complete |
| Input record/replay and visual regression | Complete |
| Device/viewport simulation | Complete for preview-representable presets |
| Multiplayer preview orchestration | Complete |
| Network observability | Complete |
| Semantic revisions and leases | Complete |
| Rich MCP resources/subscriptions | Complete |
| HTML5 export | Complete |
| Capability-driven additional builds | Complete |
| gd.games publication adapter | Complete and opt-in |
| Final autonomous benchmark | Complete on the last certified baseline |

---

# Remaining MCP work

## P0 — Re-certify the current upstream-merged HEAD

Before adding more capabilities, rerun the product-level certification on the current `master`.

### Why this is required

The latest upstream merge changed substantial areas of GDevelop, including EditorFunctions, custom object/behavior/function authoring, events, project refactoring and runtime/test infrastructure.

Unit/integration gates can remain green while:

- metadata schemas drift;
- a generated EditorFunction changes shape;
- a type disappears or is renamed;
- a hot-reload assumption changes;
- a packaged renderer behaves differently;
- a runtime/debugger dump changes;
- a long-running build path stops preserving the active renderer host;
- an acceptance-only path regresses.

### Required re-certification

Run against a fresh packaged build from current `master`:

1. production renderer build;
2. Windows package;
3. MCP packaged discovery gate;
4. CAP-25 external autonomous benchmark;
5. runtime assertion and visual evidence;
6. HTML5 export;
7. additional supported build target;
8. reconnect;
9. post-reconnect mutation and rollback;
10. ArchitectureGuard;
11. full relevant renderer and Electron/MCP suites;
12. final Git cleanliness/publication verification.

### Re-certification output

Record:

- exact Git SHA;
- MCP protocol;
- tool count;
- resource count;
- discovered capability snapshot/hash;
- benchmark duration;
- build targets discovered;
- unsupported capabilities reported;
- generated artifact identities;
- test totals;
- ArchitectureGuard changed-file/hook count.

Do not hard-code 211 tools as the expected current value. The expected state is semantic compatibility, not a fixed count.

---

# CAP-26 — Continuous MCP Certification

## Goal

Turn the CAP-25 product benchmark from a one-time completion proof into a repeatable compatibility gate for a fork that continuously receives upstream GDevelop changes.

A merge should not be considered MCP-safe merely because unit tests and a subset of protocol tests pass.

## Core requirements

### CAP-26.1 — Machine-readable certification manifest

Every certification run should emit a bounded JSON manifest containing at least:

- repository SHA;
- upstream base SHA;
- packaged application version;
- MCP protocol revision;
- number of tools/resources/prompts;
- normalized command/tool schema digest;
- capability digest;
- supported build targets;
- supported publication adapters;
- runtime/debug/test capability flags;
- result of autonomous benchmark phases;
- result of reconnect/rollback phase;
- result of ArchitectureGuard;
- timestamps/durations;
- artifact paths/identities where applicable.

The manifest is evidence, not an authoritative API contract. Expected counts may change legitimately.

### CAP-26.2 — Schema and capability drift detection

Compare the current build with the last accepted certification.

Classify drift into:

- additive compatible;
- metadata-only compatible;
- removed/deprecated capability;
- schema breaking;
- behavioral regression;
- unknown/manual review.

Examples:

- a new EditorFunction is additive;
- adding an optional property may be compatible;
- renaming a required input is breaking;
- a command remaining discoverable but failing acceptance is a behavioral regression;
- tool-count changes alone are informational.

The gate should report the exact changed commands/types rather than only a hash mismatch.

### CAP-26.3 — Two-tier CI strategy

Do not make every small commit pay the full packaged benchmark cost.

#### Tier A — fast push/PR gate

Run:

- protocol tests;
- schema projection tests;
- relevant AgentIntegration renderer tests;
- ArchitectureGuard;
- capability/schema snapshot comparison where possible without packaging;
- workflow/YAML sanity.

Target: minutes.

#### Tier B — packaged certification

Run:

- fresh production build/package;
- packaged MCP gate;
- representative autonomous benchmark;
- runtime/visual assertions;
- export/build;
- reconnect/rollback.

Trigger at minimum:

- changes inside AgentIntegration;
- changes to the three upstream integration hooks;
- merges from upstream GDevelop;
- changes to EditorFunctions metadata/projection;
- changes to preview/debug/runtime infrastructure used by AgentIntegration;
- manual workflow dispatch.

If GitHub-hosted execution is too expensive for the full remote-build phase, split the benchmark into:

- deterministic CI-safe packaged certification;
- explicitly credentialed/provider certification.

### CAP-26.4 — Upstream merge certification

An upstream merge is a first-class certification event.

The workflow must detect the upstream base and answer:

- what changed in the MCP-visible model;
- whether all previously certified required capabilities still exist;
- whether generated metadata still conforms;
- whether the packaged benchmark still passes.

The merge is allowed to introduce additive capabilities without manual snapshot churn.

### CAP-26.5 — Certification history

Keep a compact history of accepted certification manifests.

Recommended policy:

- store manifests as CI artifacts for every run;
- optionally version only a small latest-known-good summary;
- do not commit screenshots, large replay files or build artifacts;
- retain visual/replay evidence as transient CI artifacts.

### CAP-26.6 — Failure diagnostics

A failed certification must identify the phase and actionable cause.

Preferred phase names:

- `discovery`;
- `authoring`;
- `assets-docs`;
- `preview`;
- `runtime-assert`;
- `visual-regression`;
- `save`;
- `export-html5`;
- `additional-build`;
- `reconnect`;
- `rollback`;
- `architecture`.

Do not collapse product failures into a generic `benchmark_failed` message.

---

# Known boundaries and optional future tracks

These are not blockers for core MCP completeness. They are explicit product boundaries.

## Mobile/device certification

Current build support is capability-driven. A target must not be described as production-supported merely because metadata says it exists.

A future mobile certification track should require:

- real Android emulator/device or equivalent supported pipeline;
- install/launch;
- input;
- orientation/viewport behavior;
- runtime assertion;
- artifact verification.

iOS requires an appropriate macOS/signing environment and should remain explicitly unsupported where that environment is absent.

## Reliable network shaping

Multiplayer preview orchestration and bounded/redacted network observability are implemented.

Reliable latency/jitter/packet-loss simulation is not currently certified.

Only add it if there is a trustworthy primitive such as:

- Chromium/CDP network emulation that correctly affects the relevant traffic;
- a runtime/backend test proxy designed for this purpose.

Never advertise network shaping based on a partial primitive that does not cover actual game transport.

## Third-party publication adapters

`gd.games` is the implemented publication adapter.

Potential adapters such as itch.io or Steam are optional and should only be added when all of the following exist:

- stable supported API/CLI;
- secure credential story;
- explicit user intent;
- dry-run/manifest where practical;
- immutable artifact identity;
- no credential persistence in project/MCP artifacts.

Lack of these adapters does not reduce core game-authoring completeness.

## Deep runtime telemetry

Current MCP exposes truthful runtime/debug/profile information supported by available runtime primitives.

Possible future telemetry:

- heap/memory;
- draw calls/render timing;
- audio channel state;
- physics contacts/body details;
- navigation/pathfinding internals;
- richer transport metrics.

Each metric must be capability-driven. If the runtime cannot expose it reliably, return `unsupported`; never synthesize it.

## Durable distributed locking

Semantic revisions and leases improve concurrent authoring, while project-wide revision remains the final safety net.

Current leases are process-local. They are not a distributed persistent lock service.

A durable lock system would only be justified if the product needs:

- multiple editor processes coordinating the same project;
- leases surviving process restart;
- server-backed multi-user editing.

Do not add distributed-lock complexity solely to increase theoretical completeness.

## Generation-service orchestration functions

Some upstream generation-agent functions are intentionally not embedded as MCP editor tools, including orchestration/sub-agent functions such as planning or explorer/edit agents.

This is deliberate.

MCP should expose GDevelop product/editor capabilities, not duplicate a higher-level AI orchestration stack.

Docs and store capabilities that were useful to generic MCP clients were already implemented as independent AgentIntegration surfaces.

---

# Work packages

## W26-A — Current HEAD re-certification

**Priority:** P0

- fresh build/package from current master;
- run all CAP-25 phases;
- record current manifest;
- fix regressions caused by upstream drift;
- publish only after clean full acceptance.

**Exit:** current master has fresh packaged completion evidence.

## W26-B — Certification manifest

**Priority:** P0

- define schema;
- emit from benchmark;
- normalize capability/tool descriptors;
- store as CI artifact;
- add focused tests.

**Exit:** every benchmark produces a deterministic, bounded certification manifest.

## W26-C — Drift classifier

**Priority:** P0

- compare current and previous manifests;
- identify additive/removal/schema changes;
- provide human-readable diff;
- test compatible and breaking fixtures.

**Exit:** upstream drift is actionable rather than a raw snapshot failure.

## W26-D — GitHub Actions certification workflow

**Priority:** P0

- create fast Tier A gate;
- create packaged Tier B workflow;
- add upstream-merge/manual triggers;
- avoid secret-dependent false failures;
- upload evidence artifacts.

**Exit:** a relevant upstream change cannot reach a false-green MCP state without exercising certification.

## W26-E — Failure/report UX

**Priority:** P1

- phase-coded errors;
- certification summary in Actions;
- artifact links;
- concise last-known-good vs current drift report.

**Exit:** a failed run explains what broke without requiring manual log archaeology.

## W26-F — Optional environment certifications

**Priority:** P2 / opt-in

Candidate independent tracks:

- Android/mobile;
- provider-backed additional builds;
- real publication smoke tests;
- reliable network shaping;
- deeper runtime telemetry.

These should not block CAP-26 core completion.

---

# Acceptance matrix for CAP-26

| Gate | Fast CI | Packaged certification |
| --- | ---: | ---: |
| Architecture boundary | Required | Required |
| Command/tool schemas | Required | Required |
| Capability discovery | Required | Required |
| Renderer focused tests | Required | Required |
| MCP protocol tests | Required | Required |
| Production build | Optional | Required |
| Desktop package | No | Required |
| External autonomous authoring | No | Required |
| Live preview/runtime assertions | No | Required |
| Visual regression | No | Required |
| Save | No | Required |
| HTML5 export | No | Required |
| Additional supported build | No | Required when provider/environment allows |
| Reconnect | No | Required |
| Rollback after reconnect | No | Required |
| Publication smoke test | No | Optional/credentialed |
| Mobile real-device test | No | Optional separate track |

---

# Definition of done

CAP-26 is complete when:

1. current `master` has fresh full packaged certification evidence;
2. the certification emits a machine-readable manifest;
3. schema/capability drift is classified semantically;
4. CI has a fast gate and a packaged gate;
5. upstream merges automatically trigger the appropriate certification path;
6. secret-dependent integrations skip truthfully when credentials are absent rather than failing unrelated forks;
7. benchmark failures identify a concrete phase;
8. transient evidence is preserved as CI artifacts, not committed repository noise;
9. ArchitectureGuard remains green;
10. documentation identifies unsupported optional capabilities explicitly.

---

# Operating principles

1. **Do not reopen completed coverage work without evidence of regression.**
2. **Treat upstream drift as the main risk now.**
3. **Prefer semantic compatibility checks over fixed tool counts.**
4. **Keep provider/credential-dependent gates separate from deterministic core certification.**
5. **Never convert an unavailable capability into a fake success.**
6. **Keep MCP as the only public agent protocol.**
7. **Keep business logic in AgentIntegration/AgentCore, not workflow scripts or MCP adapters.**
8. **Keep upstream hooks minimal and reviewable.**

---

# Immediate next action

Start with **W26-A — Current HEAD re-certification**.

Do not implement new optional capabilities before the current upstream-merged build proves that the completed MCP roadmap still passes the full packaged autonomous benchmark.
