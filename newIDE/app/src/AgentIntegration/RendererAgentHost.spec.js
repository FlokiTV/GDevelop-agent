// @flow
import { createRendererAgentHost } from './RendererAgentHost';

const EXPECTED_PUBLIC_COMMANDS = [
  'agent.capabilities',
  'agent.commands.describe',
  'agent.commands.list',
  'diagnostics.inspect',
  'editor.functions.call',
  'editor.functions.call-batch',
  'editor.functions.describe',
  'editor.functions.list',
  'editor.instances.select',
  'editor.selection.focus',
  'editor.visual.status',
  'events.apply',
  'events.read',
  'export.html5',
  'preview.close-all',
  'preview.control',
  'preview.hot-reload',
  'preview.start',
  'preview.status',
  'project.close',
  'project.create',
  'project.open',
  'project.save',
  'project.save-as',
  'project.status',
  'resources.import-local',
  'resources.inspect',
  'resources.list',
  'resources.remove',
  'resources.rename',
  'resources.replace-local',
  'runtime.assert',
  'runtime.logs',
  'runtime.snapshot',
  'runtime.status',
  'runtime.wait-for',
  'safety.checkpoints.create',
  'safety.checkpoints.delete',
  'safety.checkpoints.diff',
  'safety.checkpoints.list',
  'safety.checkpoints.restore',
  'safety.transactions.begin',
  'safety.transactions.commit',
  'safety.transactions.rollback',
  'safety.transactions.status',
  'scene.open',
  'validation.run',
];

describe('RendererAgentHost public command inventory', () => {
  it('keeps the complete public registry explicit and deterministic', () => {
    const host = createRendererAgentHost({
      environment: {},
      assetTools: {},
      diagnosticsTools: {},
      editorFunctionService: { run: jest.fn() },
      editorVisualService: {},
      eventTools: {},
      exportService: {},
      previewService: {},
      projectLifecycleService: {},
      runtimeTelemetry: {},
      safetyService: {},
      validationService: {},
    });

    const commandNames = host.listCommands().map(command => command.name);
    expect(commandNames).toEqual(EXPECTED_PUBLIC_COMMANDS);
    expect(new Set(commandNames).size).toBe(commandNames.length);
  });
});
