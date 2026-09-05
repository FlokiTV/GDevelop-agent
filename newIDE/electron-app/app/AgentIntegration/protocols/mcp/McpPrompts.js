const PROMPT_META = {
  'gdevelop/cacheScope': 'process',
  'gdevelop/ttlMs': 60000,
  'gdevelop/promptVersion': 1,
};

const prompt = (name, title, description, text) => ({
  name,
  title,
  description,
  text,
  _meta: { ...PROMPT_META },
});

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
    'Surgical event authoring',
    'Edit event trees with stable handles, revisions and localized patches.',
    [
      'Call events.read and keep its eventsRevision and canonical handles.',
      'Prefer events.insert/update/delete/move for localized changes.',
      'Pass expectedEventsRevision and project expectedRevision when required.',
      'Use events.apply replace/append only as an explicit bulk fallback.',
      'Review returned event diff and validation issues before continuing.',
      'If revisions are stale, read again and re-target the current canonical handles.',
    ].join('\n')
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
  PROMPTS,
  toPromptResult,
  registerGDevelopPrompts,
};
