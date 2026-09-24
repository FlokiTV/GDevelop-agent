// @flow

/**
 * Machine-readable policy for EditorFunctions that must not be exposed inside
 * run_script. Keep the reason stable: AgentIntegration projects this policy to
 * external clients so direct-call and script exposure cannot silently drift.
 */
export const NON_SCRIPTABLE_FUNCTION_REASONS: Map<string, string> = new Map([
  ['run_script', 'recursive-script-execution-disabled'],
  ['initialize_project', 'project-bootstrap-outside-script'],

  // Server-side/generation-service workflows stay plain tools.
  ['read_full_docs', 'generation-service-only'],
  ['search_docs', 'generation-service-only'],
  ['search_object_asset_store', 'generation-service-only'],
  ['search_resource_store', 'generation-service-only'],
  ['create_or_update_plan', 'generation-service-only'],
  ['report_fulfilment_problem', 'generation-service-only'],
  ['run_edit_agent', 'generation-service-only'],
  ['run_explorer_agent', 'generation-service-only'],
  ['get_game_starter_summary', 'project-bootstrap-outside-script'],

  // Event generation is orchestrator-owned rather than script-owned.
  ['generate_events', 'orchestrator-event-generation-outside-script'],
  ['add_scene_events', 'orchestrator-event-generation-outside-script'],

  // Gameplay test calls own a long-running preview lifecycle.
  ['run_tests', 'long-running-preview-lifecycle-outside-script'],
  ['run_gameplay_test', 'long-running-preview-lifecycle-outside-script'],
]);

export const NON_SCRIPTABLE_FUNCTION_NAMES: Set<string> = new Set(
  NON_SCRIPTABLE_FUNCTION_REASONS.keys()
);

export const getNonScriptableFunctionReason = (name: string): string | null =>
  NON_SCRIPTABLE_FUNCTION_REASONS.get(name) || null;
