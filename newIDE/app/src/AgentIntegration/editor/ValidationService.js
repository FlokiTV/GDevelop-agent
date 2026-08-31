// @flow
import { AgentError } from '../core/AgentError';

type Options = {|
  project: ?gdProject,
  diagnosticsTools: any,
  safetyService: any,
  runtimeTelemetry: any,
  editorFunctionService: any,
  exportService: any,
  getPreviewStatus: () => any,
|};

const getMessage = (error: any): string =>
  error && error.message ? error.message : String(error);

export const createValidationService = ({
  project,
  diagnosticsTools,
  safetyService,
  runtimeTelemetry,
  editorFunctionService,
  exportService,
  getPreviewStatus,
}: Options) => ({
  run: async (request: any = {}) => {
    if (!project || !diagnosticsTools) {
      throw new AgentError({ code: 'no_project_open' });
    }

    const steps = [];
    let checkpointDiff = null;
    if (typeof request.checkpointId === 'string' && request.checkpointId) {
      try {
        checkpointDiff = safetyService.diffCheckpoint({
          checkpointId: request.checkpointId,
        }).diff;
        steps.push({ name: 'checkpoint-diff', ok: true });
      } catch (error) {
        steps.push({
          name: 'checkpoint-diff',
          ok: false,
          error: getMessage(error),
        });
      }
    }

    const gameplayTests = [];
    const requestedGameplayTests = Array.isArray(request.gameplayTests)
      ? request.gameplayTests
      : [];
    if (requestedGameplayTests.length > 20) {
      throw new AgentError({ code: 'too_many_validation_gameplay_tests' });
    }
    for (const gameplayTest of requestedGameplayTests) {
      const argumentsForTest =
        gameplayTest && typeof gameplayTest === 'object'
          ? { ...gameplayTest }
          : {};
      if (
        typeof argumentsForTest.source === 'string' &&
        argumentsForTest.persist === undefined
      ) {
        argumentsForTest.persist = false;
      }
      try {
        const callResult = await editorFunctionService.run({
          calls: [
            {
              name: 'run_gameplay_test',
              arguments: argumentsForTest,
            },
          ],
          save: false,
        });
        const finishedResult = callResult.results[0] || null;
        const passed = !!(
          finishedResult &&
          finishedResult.status === 'finished' &&
          finishedResult.success
        );
        gameplayTests.push({
          testName: argumentsForTest.test_name || null,
          ok: passed,
          result: finishedResult,
        });
        steps.push({
          name: `gameplay-test:${String(
            argumentsForTest.test_name || gameplayTests.length
          )}`,
          ok: passed,
        });
      } catch (error) {
        const message = getMessage(error);
        gameplayTests.push({
          testName: argumentsForTest.test_name || null,
          ok: false,
          error: message,
        });
        steps.push({
          name: `gameplay-test:${String(
            argumentsForTest.test_name || gameplayTests.length
          )}`,
          ok: false,
          error: message,
        });
      }
    }

    const runtimeAssertions = [];
    const requestedRuntimeAssertions = Array.isArray(request.runtimeAssertions)
      ? request.runtimeAssertions
      : [];
    if (requestedRuntimeAssertions.length > 50) {
      throw new AgentError({ code: 'too_many_runtime_assertions' });
    }
    for (const runtimeAssertion of requestedRuntimeAssertions) {
      try {
        if (!runtimeTelemetry) {
          throw new AgentError({ code: 'preview_debugger_unavailable' });
        }
        const result = await runtimeTelemetry.assertRuntime({
          ...(runtimeAssertion || {}),
          debuggerId:
            (runtimeAssertion && runtimeAssertion.debuggerId) ||
            request.debuggerId,
        });
        runtimeAssertions.push({ ok: !!result.passed, result });
        steps.push({ name: 'runtime-assertion', ok: !!result.passed });
      } catch (error) {
        const message = getMessage(error);
        runtimeAssertions.push({ ok: false, error: message });
        steps.push({ name: 'runtime-assertion', ok: false, error: message });
      }
    }

    let runtimeLogs = null;
    if (request.includeRuntimeLogs) {
      try {
        if (!runtimeTelemetry) {
          throw new AgentError({ code: 'preview_debugger_unavailable' });
        }
        runtimeLogs = runtimeTelemetry.getLogs({
          debuggerId: request.debuggerId,
          limit: request.runtimeLogLimit,
        });
        steps.push({
          name: 'runtime-logs',
          ok: runtimeLogs.errors === 0,
          errors: runtimeLogs.errors,
          warnings: runtimeLogs.warnings,
        });
      } catch (error) {
        runtimeLogs = { error: getMessage(error) };
        steps.push({
          name: 'runtime-logs',
          ok: false,
          error: runtimeLogs.error,
        });
      }
    }

    let exportResult = null;
    if (request.export) {
      try {
        const exportOptions =
          request.export && typeof request.export === 'object'
            ? request.export
            : {};
        exportResult = {
          ok: true,
          result: await exportService.exportHtml5({
            outputDir:
              typeof exportOptions.outputDir === 'string'
                ? exportOptions.outputDir
                : undefined,
          }),
        };
        steps.push({ name: 'html5-export', ok: true });
      } catch (error) {
        exportResult = { ok: false, error: getMessage(error) };
        steps.push({
          name: 'html5-export',
          ok: false,
          error: exportResult.error,
        });
      }
    }

    const diagnostics = diagnosticsTools.inspect(request);
    const failedSteps = steps.filter(step => step.ok === false);
    return {
      ok: diagnostics.summary.ok && failedSteps.length === 0,
      generatedAt: new Date().toISOString(),
      projectName: project.getName(),
      projectUuid: project.getProjectUuid(),
      diagnostics,
      checkpointDiff,
      preview: getPreviewStatus(),
      gameplayTests,
      runtimeAssertions,
      runtimeLogs,
      export: exportResult,
      steps,
      summary: {
        diagnosticErrors: diagnostics.summary.errors,
        diagnosticWarnings: diagnostics.summary.warnings,
        checksRun: steps.length,
        checksFailed: failedSteps.length,
      },
    };
  },
});
