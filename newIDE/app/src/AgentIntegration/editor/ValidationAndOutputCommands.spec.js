// @flow
import { AgentHost } from '../core/AgentHost';
import { createDiagnosticsCommandDescriptors } from './DiagnosticsCommands';
import { createExportCommandDescriptors } from './ExportCommands';
import { createValidationCommandDescriptors } from './ValidationCommands';

const makeHost = () => {
  const diagnosticsTools = { inspect: jest.fn(() => ({ ok: true })) };
  const staticDiagnosticsService = {
    capabilities: jest.fn(() => ({ domain: 'static-editor-project' })),
    query: jest.fn(() => ({ summary: { errors: 0, warnings: 0 } })),
  };
  const exportService = { exportHtml5: jest.fn(async () => ({ built: true })) };
  const validationService = { run: jest.fn(async () => ({ ok: true })) };
  const host = new AgentHost({
    environment: { project: {} },
    descriptors: [
      ...createDiagnosticsCommandDescriptors({
        diagnosticsTools,
        staticDiagnosticsService,
      }),
      ...createValidationCommandDescriptors({ validationService }),
      ...createExportCommandDescriptors({ exportService }),
    ],
  });
  return {
    host,
    diagnosticsTools,
    staticDiagnosticsService,
    exportService,
    validationService,
  };
};

describe('validation and output commands', () => {
  test('dispatches diagnostics through the registry', async () => {
    const { host, diagnosticsTools } = makeHost();
    const result = await host.execute('diagnostics.inspect', {
      includeAssets: false,
    });
    expect(result.data).toEqual({ ok: true });
    expect(diagnosticsTools.inspect).toHaveBeenCalledWith({
      includeAssets: false,
    });
  });

  test('dispatches unified static diagnostics with project-revision caching metadata', async () => {
    const { host, staticDiagnosticsService } = makeHost();
    const capabilities = await host.execute('diagnostics.capabilities', {});
    const query = await host.execute('diagnostics.query', {
      severities: ['error'],
      sceneName: 'Main',
    });

    expect(capabilities.data).toEqual({ domain: 'static-editor-project' });
    expect(query.data).toEqual({ summary: { errors: 0, warnings: 0 } });
    expect(staticDiagnosticsService.query).toHaveBeenCalledWith({
      severities: ['error'],
      sceneName: 'Main',
    });
    expect(host.describeCommand('diagnostics.query').metadata).toMatchObject({
      readOnly: true,
      requiresProject: true,
      cacheScope: 'project-revision',
    });
  });

  test('marks validation and export as long-running commands', () => {
    const { host } = makeHost();
    expect(host.describeCommand('validation.run').metadata).toMatchObject({
      readOnly: true,
      longRunning: true,
      requiresProject: true,
    });
    expect(host.describeCommand('export.html5').metadata).toMatchObject({
      readOnly: true,
      longRunning: true,
      requiresProject: true,
    });
  });

  test('dispatches validation and export services', async () => {
    const { host, validationService, exportService } = makeHost();
    await host.execute('validation.run', { includeRuntimeLogs: true });
    await host.execute('export.html5', { outputDir: 'out' });
    expect(validationService.run).toHaveBeenCalledWith({
      includeRuntimeLogs: true,
    });
    expect(exportService.exportHtml5).toHaveBeenCalledWith({
      outputDir: 'out',
    });
  });
});
