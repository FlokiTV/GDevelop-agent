// @flow
import { createValidationService } from './ValidationService';

const makeService = (overrides: any = {}) => {
  const project = {
    getName: () => 'Game',
    getProjectUuid: () => 'uuid',
  };
  const diagnosticsTools = {
    inspect: jest.fn(() => ({
      summary: { ok: true, errors: 0, warnings: 1 },
    })),
  };
  const safetyService = {
    diffCheckpoint: jest.fn(() => ({ diff: { changed: true } })),
  };
  const runtimeTelemetry = {
    assertRuntime: jest.fn(async () => ({ passed: true })),
    getLogs: jest.fn(() => ({ errors: 0, warnings: 0 })),
  };
  const editorFunctionService = {
    run: jest.fn(async () => ({
      results: [{ status: 'finished', success: true }],
    })),
  };
  const exportService = {
    exportHtml5: jest.fn(async () => ({ outputDir: 'build' })),
  };
  const getPreviewStatus = jest.fn(() => ({ running: true }));
  const service = createValidationService({
    project,
    diagnosticsTools,
    safetyService,
    runtimeTelemetry,
    editorFunctionService,
    exportService,
    getPreviewStatus,
    ...overrides,
  });
  return {
    service,
    diagnosticsTools,
    safetyService,
    runtimeTelemetry,
    editorFunctionService,
    exportService,
    getPreviewStatus,
  };
};

describe('ValidationService', () => {
  test('aggregates checkpoint, gameplay, runtime logs and export', async () => {
    const deps = makeService();
    const result = await deps.service.run({
      checkpointId: 'cp-1',
      gameplayTests: [{ test_name: 'smoke', source: 'test source' }],
      runtimeAssertions: [{ expression: '1 === 1' }],
      includeRuntimeLogs: true,
      export: { outputDir: 'out' },
    });

    expect(result.ok).toBe(true);
    expect(result.checkpointDiff).toEqual({ changed: true });
    expect(result.summary).toEqual({
      diagnosticErrors: 0,
      diagnosticWarnings: 1,
      checksRun: 5,
      checksFailed: 0,
    });
    expect(deps.editorFunctionService.run).toHaveBeenCalledWith({
      calls: [
        {
          name: 'run_gameplay_test',
          arguments: {
            test_name: 'smoke',
            source: 'test source',
            persist: false,
          },
        },
      ],
      save: false,
    });
    expect(deps.exportService.exportHtml5).toHaveBeenCalledWith({
      outputDir: 'out',
    });
  });

  test('records failed probes instead of aborting aggregate validation', async () => {
    const deps = makeService({
      runtimeTelemetry: {
        assertRuntime: jest.fn(async () => {
          throw new Error('assert failed');
        }),
        getLogs: jest.fn(() => ({ errors: 2, warnings: 0 })),
      },
    });
    const result = await deps.service.run({
      runtimeAssertions: [{}],
      includeRuntimeLogs: true,
    });
    expect(result.ok).toBe(false);
    expect(result.summary.checksFailed).toBe(2);
    expect(result.runtimeAssertions[0].error).toBe('assert failed');
  });

  test('enforces gameplay and assertion limits before execution', async () => {
    const { service } = makeService();
    await expect(
      service.run({ gameplayTests: Array.from({ length: 21 }, () => ({})) })
    ).rejects.toMatchObject({ code: 'too_many_validation_gameplay_tests' });
    await expect(
      service.run({ runtimeAssertions: Array.from({ length: 51 }, () => ({})) })
    ).rejects.toMatchObject({ code: 'too_many_runtime_assertions' });
  });

  test('requires an open project', async () => {
    const { service } = makeService({ project: null });
    await expect(service.run()).rejects.toMatchObject({
      code: 'no_project_open',
    });
  });
});
