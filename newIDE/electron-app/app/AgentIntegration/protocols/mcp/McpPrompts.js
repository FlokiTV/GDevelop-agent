const PROMPT_META = {
  'gdevelop/cacheScope': 'process',
  'gdevelop/ttlMs': 60000,
  'gdevelop/promptVersion': 4,
};

const prompt = (name, title, description, text) => ({
  name,
  title,
  description,
  text,
  _meta: { ...PROMPT_META },
});

const NATIVE_EVENT_AUTHORING_GUIDE = [
  '# Native Event Sheet authoring',
  '',
  '1. Discover the live build with tools/list or agent.capabilities; do not hard-code the command catalog.',
  '2. Read project.status, then events.read. Treat events.read.data.eventsJson as the authoritative canonical serialized event payload. data.events is only the stable handle/navigation tree; do not reconstruct event fields from it.',
  '3. Keep eventsRevision from events.read and projectRevision from project.status as write preconditions. Use expectedEventsRevision plus MCP expectedRevision/idempotencyKey when offered; use a checkpoint/transaction for risky multi-step work.',
  '4. Discover unfamiliar actions and conditions with events.instructions.search/describe. Discover numeric/string expressions through the same surface with kind="expression"; there is no separate events.expressions catalog. Author discovered instructions in canonical serialized form as {"type":{"value":"<discovered-id>"},"parameters":["<ordered visible parameters>"],"subInstructions":[]}; derive parameter order/types from the described metadata instead of model memory.',
  '5. Discover canonical event-node types with events.nodes.list and inspect exact connected-build defaults/known fields with events.nodes.describe. Mutation schemas may project those contracts and carry x-gdevelop-schema-reference back to this discovery surface.',
  '6. Prefer the smallest mutation: events.style.update for Group/Comment RGB-only edits; events.patch for one action/condition insert/move/delete, one parameter/flag, or a supported small event field; events.insert/move/delete for event/subevent structure. Use events.update only for intentional full-node replacement and events.apply only as an explicit bulk replace/append fallback.',
  '7. events.patch requires the current expectedEventsRevision and stable handles from events.read. parameterName is resolved from connected-build instruction metadata; use parameterIndex when metadata is ambiguous. Do not resend the parent eventJson for a one-parameter/action/condition change. Group/Comment style updates still use abstract background/text RGB objects.',
  '8. After mutation, re-read or inspect the returned diff/revisions. On stale revision conflicts, read current state and re-target stable handles instead of overwriting.',
  '9. Run diagnostics.inspect and validation.run. Start preview only when missing; otherwise use preview.hot-reload and runtime snapshot/log/assert tools for acceptance.',
  '10. Saving is explicit: call project.save/project.save-as only when the user intends persistence. Never close/reopen the project merely to synchronize state.',
  '11. Authoring decisions must use the live structured MCP response. Raw events.read.data.eventsJson is authoritative; sanitized replay/evidence output is for persistence/audit only and must not replace live authoring data.',
].join('\n');

const PROMPTS = [
  prompt(
    'gdevelop.bootstrap',
    'Bootstrap live editor',
    'Discover the open project and available live-editing capabilities before changing anything.',
    [
      'Work only against the currently open GDevelop editor through MCP.',
      'Start with project.status, agent.capabilities and agent.commands.list or tools/list.',
      'Inspect the relevant scene/resources/events before mutating.',
      'Treat projectRevision and eventsRevision as preconditions for later writes.',
      'Do not save, close or reopen the project unless the user explicitly requires it.',
    ].join('\n')
  ),
  prompt(
    'gdevelop.safe-edit',
    'Safe live edit',
    'Follow the normal inspect→checkpoint→mutate→observe→validate→save workflow.',
    [
      'Inspect current project/UI state and capture the relevant projectRevision.',
      'Create a checkpoint or transaction before risky multi-step work.',
      'Mutate the live in-memory project with expectedRevision/idempotencyKey when offered.',
      'If a stale-write conflict occurs, re-read state and reconcile instead of overwriting.',
      'Use scene.open/editor selection only when visual navigation is necessary.',
      'Capture before/after when visual evidence matters, then hot-reload preview explicitly.',
      'Validate before saving. Saving is always an explicit final action.',
    ].join('\n')
  ),
  prompt(
    'gdevelop.scene-authoring',
    'Scene authoring',
    'Create or edit 2D/3D scenes while keeping the editor live and observable.',
    [
      'Inspect the target scene and list suitable EditorFunctions before authoring.',
      'Create/edit objects and instances in small batches; preserve user tabs, camera and selection.',
      'For material 3D work, build mechanics and collision first, then visual polish.',
      'Use editor.instances.select/editor.selection.focus before capture when a specific instance matters.',
      'After compatible edits call preview.hot-reload rather than restarting or reopening the project.',
    ].join('\n')
  ),
  prompt(
    'gdevelop.events-authoring',
    'Native Event Sheet authoring',
    'Author native Event Sheets from live canonical data, connected-build metadata and localized safe mutations.',
    NATIVE_EVENT_AUTHORING_GUIDE
  ),
  prompt(
    'gdevelop.preview-playtest',
    'Preview and playtest',
    'Exercise the running game and collect visual/runtime evidence without restarting normal iteration.',
    [
      'Use preview.status first; start a preview only if none is running.',
      'After live edits prefer preview.hot-reload and keep the debugger/preview handle stable.',
      'Use preview.input.* for keyboard, mouse, touch or gamepad interaction.',
      'Observe runtime.snapshot/logs/assert/wait-for and capture editor/preview images as needed.',
      'Gameplay tests are ephemeral by default and have a separate lifecycle from the normal preview.',
      'Correct failures live and repeat hot-reload/input/assert without project reopen.',
    ].join('\n')
  ),
  prompt(
    'gdevelop.validate-export',
    'Validate, save and export',
    'Finish a work session with diagnostics, validation, explicit save and optional HTML5 export.',
    [
      'Run diagnostics.inspect and validation.run after the final correction pass.',
      'Review checkpoint/event diffs and unresolved warnings or errors.',
      'Do not save if validation indicates a blocking issue unless the user explicitly requests it.',
      'Call project.save or project.save-as explicitly only after the project is ready.',
      'Use export.html5 as a long-running final output step when requested.',
      'Never use project close/reopen as a synchronization or recovery mechanism.',
    ].join('\n')
  ),
];

const toPromptResult = definition => ({
  description: definition.description,
  messages: [
    {
      role: 'user',
      content: {
        type: 'text',
        text: definition.text,
      },
    },
  ],
});

const registerGDevelopPrompts = server => {
  PROMPTS.forEach(definition => {
    server.registerPrompt(
      definition.name,
      {
        title: definition.title,
        description: definition.description,
        _meta: definition._meta,
      },
      async () => toPromptResult(definition)
    );
  });
};

module.exports = {
  PROMPT_META,
  NATIVE_EVENT_AUTHORING_GUIDE,
  PROMPTS,
  toPromptResult,
  registerGDevelopPrompts,
};
