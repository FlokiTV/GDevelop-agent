// @flow
import {
  createDiagnosticsTools,
  serializeWholeProjectDiagnosticReport,
} from './DiagnosticsTools';

const gd: libGDevelop = global.gd;

const i18n: any = {
  _: value =>
    typeof value === 'string'
      ? value
      : value && (value.message || value.id)
      ? value.message || value.id
      : String(value),
};

describe('AgentApi DiagnosticsTools', () => {
  let project: gdProject;

  beforeEach(() => {
    // $FlowFixMe[invalid-constructor]
    project = new gd.ProjectHelper.createNewGDJSProject();
    project.resetProjectUuid();
    project.setName('Diagnostics Test');
    project.setPackageName('com.example.diagnosticstest');
    project.setVersion('1.0.0');
    project.insertNewLayout('Game', 0);
  });

  afterEach(() => {
    project.delete();
  });

  it('serializes native code-generation diagnostics without UI rendering', () => {
    const fakeReport: any = {
      count: () => 1,
      get: () => ({
        getSceneName: () => 'Game',
        count: () => 1,
        get: () => ({
          getType: () => gd.ProjectDiagnostic.UnknownObject,
          getMessage: () => 'Unknown object Enemy',
          getObjectName: () => '',
          getActualValue: () => 'Enemy',
          getExpectedValue: () => '',
        }),
      }),
    };

    expect(serializeWholeProjectDiagnosticReport(fakeReport)).toEqual([
      expect.objectContaining({
        severity: 'error',
        category: 'native-code-generation',
        code: 'unknown-object',
        message: 'Unknown object Enemy',
        sceneName: 'Game',
        actualValue: 'Enemy',
      }),
    ]);
  });

  it('aggregates fresh project and resource diagnostics into one report', () => {
    project.setPackageName('');
    const assetTools: any = {
      listResources: () => ({
        resources: [
          {
            name: 'missing.png',
            file: 'missing.png',
            localFilePath: 'C:/game/missing.png',
            fileStatus: 'error',
            orphaned: false,
          },
          {
            name: 'unused.png',
            file: 'unused.png',
            localFilePath: 'C:/game/unused.png',
            fileStatus: '',
            orphaned: true,
          },
        ],
        unregisteredReferences: ['ghost.wav'],
        summary: {
          total: 2,
          used: 1,
          orphaned: 1,
          missingFiles: 1,
          outsideProjectFiles: 0,
          unregisteredReferences: 1,
        },
      }),
    };

    const diagnostics = createDiagnosticsTools({ project, i18n, assetTools });
    const report = diagnostics.inspect({ includeNativeReport: false });

    expect(report.summary.ok).toBe(false);
    expect(report.summary.errors).toBeGreaterThanOrEqual(3);
    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: 'project-properties',
          code: 'invalid-project-property:packageName',
        }),
        expect.objectContaining({
          category: 'resources',
          code: 'missing-resource-file',
        }),
        expect.objectContaining({
          category: 'resources',
          code: 'unregistered-resource-reference',
        }),
        expect.objectContaining({
          category: 'resources',
          code: 'orphaned-resource',
          severity: 'info',
        }),
      ])
    );
    expect(report.sections.resources.health.summary.missingFiles).toBe(1);
  });

  it('returns a clean report for a simple valid project', () => {
    const assetTools: any = {
      listResources: () => ({
        resources: [],
        unregisteredReferences: [],
        summary: {
          total: 0,
          used: 0,
          orphaned: 0,
          missingFiles: 0,
          outsideProjectFiles: 0,
          unregisteredReferences: 0,
        },
      }),
    };
    const diagnostics = createDiagnosticsTools({ project, i18n, assetTools });
    const report = diagnostics.inspect({ includeNativeReport: false });

    expect(report.summary.errors).toBe(0);
    expect(report.summary.ok).toBe(true);
    expect(report.sections.eventsValidation).toEqual([]);
    expect(report.sections.requiredBehaviorProperties).toEqual([]);
  });
});
