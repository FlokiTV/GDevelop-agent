# AgentIntegration Characterization Baseline

This document freezes the behavior that must survive the AgentApi -> AgentIntegration/MCP migration. It does **not** freeze the legacy REST `/v1` protocol, which is intentionally being removed.

## Baseline commit

Architecture baseline starts after `080a724` (`docs: define agent integration architecture`).

## Capabilities that must survive

### Editor/project lifecycle

- report whether a live project is open;
- expose current file identifier, project name/UUID and dirty state;
- create a project, optionally from an example;
- open a local project with explicit protection against discarding unsaved changes;
- close a project with explicit protection against discarding unsaved changes;
- save and save-as explicitly;
- never autosave as a hidden side effect of ordinary authoring operations.

### Native editor functions

- discover generated EditorFunction metadata;
- describe one function;
- execute one EditorFunction;
- execute deterministic ordered batches;
- preserve `didModifyProject`, created scene names and created-project reporting;
- trigger dirty state and editor invalidation after successful mutations;
- preserve the special disposable gameplay-test lifecycle around `run_gameplay_test`.

### Events

- deterministic scene-events read;
- deterministic scene-events apply;
- notify the open Events Sheet about out-of-editor changes;
- keep AI generation optional and separate from deterministic event authoring.

### Assets/resources

- list and inspect resources;
- import and replace local resources;
- rename resources;
- remove resources safely;
- inspect resource health and references;
- integrate asset/resource store capabilities when the editor environment supplies them;
- update live editor state after mutation.

### Safety

- create, list, diff, restore and delete checkpoints;
- begin, inspect, commit and roll back transactions;
- preserve previous dirty state across checkpoint restore;
- restore previously open scene editor tabs after full serialized restore;
- prevent restoring an unrelated checkpoint while a transaction is active.

### Preview lifecycle

- report preview/debugger status;
- start preview;
- hot reload preview;
- play, pause and refresh a running preview;
- close preview windows without tearing down the native debugger server;
- keep normal preview lifecycle separate from gameplay-test iframe lifecycle.

### Preview input

- keyboard and mouse input;
- touch input;
- virtual gamepad;
- ordered input sequences;
- reset/release tracked input state;
- target preview windows while rejecting editor windows.

### Runtime observation

- runtime status;
- runtime snapshot;
- console/log collection;
- runtime assertions;
- wait-for conditions;
- robust debugger selection during hot-reload overlap.

### Editor visual context

- list open scene editors;
- open/focus a scene or events editor;
- select scene instances;
- focus selection;
- capture editor/preview windows, including desktop-capture fallback when `capturePage()` is empty.

### Diagnostics/validation/output

- project diagnostics;
- event/resource/behavior validation as available through existing diagnostic tools;
- aggregate validation report;
- optional checkpoint diff;
- optional gameplay tests;
- optional runtime assertions/log inspection;
- HTML5 export;
- post-export diagnostic refresh;
- validation/export must not introduce unexpected dirty state.

## Current automated baseline

### Electron/desktop Node suite

Command:

```text
node --test \
  newIDE/electron-app/app/AgentApi/AgentPreviewRuntime.test.js \
  newIDE/electron-app/app/AgentApi/ArchitectureGuard.test.js \
  newIDE/electron-app/app/AgentApi/index.test.js \
  newIDE/electron-app/app/AgentApi/PreviewInputTools.test.js
```

Baseline: **16/16 tests passed**.

This suite currently covers preview runtime installation, touch/gamepad validation, keyboard/mouse input, preview targeting, sequences, input reset, capture fallback, long gameplay timeout budgeting, function metadata routing and the architecture isolation guard.

### Renderer AgentApi suite

Command:

```text
npm test -- --runTestsByPath \
  src/AgentApi/AssetTools.spec.js \
  src/AgentApi/CheckpointTools.spec.js \
  src/AgentApi/DiagnosticsTools.spec.js \
  src/AgentApi/EditorVisualTools.spec.js \
  src/AgentApi/EventTools.spec.js \
  src/AgentApi/ExportTools.spec.js \
  src/AgentApi/FunctionMetadata.spec.js \
  src/AgentApi/GameplayTestLifecycleTools.spec.js \
  src/AgentApi/PreviewLifecycleTools.spec.js \
  src/AgentApi/RuntimeTelemetry.spec.js \
  --watchAll=false
```

Baseline: **47/47 tests passed across 10 suites**.

## Live behavior gates already established

The previous embedded Agent API phase established live behavior that must remain true after the protocol migration:

- project authoring occurs on the already-open project;
- scene/UI changes can be observed without closing/reopening the project;
- repeated preview close/start cycles keep the native debugger server alive;
- repeated hot reloads continue producing runtime snapshots;
- preview input moves the real game and resets without stuck input;
- sequential gameplay tests run without stale iframe state;
- checkpoint rollback restores scene tabs and active editor context;
- editor screenshots can be captured reliably;
- HTML5 export completes through the live editor environment.

These are product acceptance gates and will be rerun through MCP after each relevant migration phase rather than encoded as a requirement to preserve `/v1`.

## Migration test policy

At every semantic migration block:

1. run the focused tests for the moved module;
2. run the core/adapter boundary tests;
3. run the full 16-test desktop baseline when Electron infrastructure changes;
4. run the full 47-test renderer baseline when editor/runtime behavior changes;
5. run ArchitectureGuard against `upstream/master`;
6. commit only after the affected gate is green.

Before replacing the final legacy execution path with MCP, every capability listed above must either have a direct AgentCore test or an MCP integration test. Legacy REST route tests may then be deleted together with `/v1`.
