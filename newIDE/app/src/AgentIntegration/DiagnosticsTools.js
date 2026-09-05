// @flow
import { type I18n as I18nType } from '@lingui/core';
import { getProjectPropertiesErrors } from '../Utils/ProjectErrorsChecker';
import { scanProjectForValidationErrors } from '../Utils/EventsValidationScanner';

const gd: libGDevelop = global.gd;

type DiagnosticsToolsOptions = {|
  project: gdProject,
  i18n: I18nType,
  assetTools: ?any,
|};

type DiagnosticIssue = {|
  severity: 'error' | 'warning' | 'info',
  category: string,
  code: string,
  message: string,
  sceneName?: string,
  objectName?: string,
  actualValue?: string,
  expectedValue?: string,
  details?: any,
|};

const getProjectDiagnosticTypeName = (type: number): string => {
  if (type === gd.ProjectDiagnostic.UndeclaredVariable)
    return 'undeclared-variable';
  if (type === gd.ProjectDiagnostic.MissingBehavior) return 'missing-behavior';
  if (type === gd.ProjectDiagnostic.UnknownObject) return 'unknown-object';
  if (type === gd.ProjectDiagnostic.MismatchedObjectType)
    return 'mismatched-object-type';
  return `unknown-native-diagnostic-${String(type)}`;
};

export const serializeWholeProjectDiagnosticReport = (
  wholeProjectDiagnosticReport: gdWholeProjectDiagnosticReport
): Array<DiagnosticIssue> => {
  const issues = [];
  for (
    let reportIndex = 0;
    reportIndex < wholeProjectDiagnosticReport.count();
    reportIndex++
  ) {
    const report = wholeProjectDiagnosticReport.get(reportIndex);
    const sceneName = report.getSceneName();
    for (
      let diagnosticIndex = 0;
      diagnosticIndex < report.count();
      diagnosticIndex++
    ) {
      const diagnostic = report.get(diagnosticIndex);
      const typeName = getProjectDiagnosticTypeName(diagnostic.getType());
      issues.push({
        severity: typeName === 'undeclared-variable' ? 'warning' : 'error',
        category: 'native-code-generation',
        code: typeName,
        message: diagnostic.getMessage(),
        sceneName,
        objectName: diagnostic.getObjectName() || undefined,
        actualValue: diagnostic.getActualValue() || undefined,
        expectedValue: diagnostic.getExpectedValue() || undefined,
      });
    }
  }
  return issues;
};

export const serializeRequiredBehaviorProblems = (
  project: gdProject
): Array<DiagnosticIssue> => {
  const problems = gd.WholeProjectRefactorer.findInvalidRequiredBehaviorProperties(
    project
  );
  const issues = [];
  for (let index = 0; index < problems.size(); index++) {
    const problem = problems.at(index);
    const object = problem.getSourceObject();
    const behavior = problem.getSourceBehaviorContent();
    const expectedBehaviorType = problem.getExpectedBehaviorTypeName();
    const suggestedBehaviorNames = gd.WholeProjectRefactorer.getBehaviorsWithType(
      object,
      expectedBehaviorType
    ).toJSArray();
    issues.push({
      severity: 'error',
      category: 'behavior-property',
      code: 'invalid-required-behavior-property',
      message: `Invalid required behavior property "${problem.getSourcePropertyName()}" on behavior "${behavior.getName()}" of object "${object.getName()}".`,
      objectName: object.getName(),
      expectedValue: expectedBehaviorType,
      details: {
        behaviorName: behavior.getName(),
        propertyName: problem.getSourcePropertyName(),
        suggestedBehaviorNames,
      },
    });
  }
  return issues;
};

const serializeProjectPropertyIssues = (
  i18n: I18nType,
  project: gdProject
): Array<DiagnosticIssue> => {
  const errorsByProperty = getProjectPropertiesErrors(i18n, project);
  const issues = [];
  Object.keys(errorsByProperty).forEach(propertyName => {
    errorsByProperty[propertyName].forEach(error => {
      issues.push({
        severity: error.type,
        category: 'project-properties',
        code: `invalid-project-property:${propertyName}`,
        message: error.message,
        details: {
          propertyName,
          extraExplanation: error.extraExplanation,
        },
      });
    });
  });
  return issues;
};

const serializeEventValidationIssues = (
  project: gdProject
): Array<DiagnosticIssue> =>
  scanProjectForValidationErrors(project).map(error => ({
    severity: error.type === 'missing-instruction' ? 'warning' : 'error',
    category: 'events-validation',
    code: error.type,
    message:
      error.type === 'missing-instruction'
        ? `Missing instruction: ${error.instructionType}`
        : `${
            error.type === 'missing-parameter' ? 'Missing' : 'Invalid'
          } parameter in ${error.instructionSentence || error.instructionType}`,
    objectName: error.objectName || undefined,
    details: {
      isCondition: error.isCondition,
      instructionType: error.instructionType,
      instructionSentence: error.instructionSentence,
      parameterIndex: error.parameterIndex,
      parameterValue: error.parameterValue,
      locationName: error.locationName,
      locationType: error.locationType,
      eventPath: error.eventPath,
      extensionName: error.extensionName,
      functionName: error.functionName,
      behaviorName: error.behaviorName,
    },
  }));

const serializeAssetIssues = (assetHealth: any): Array<DiagnosticIssue> => {
  if (!assetHealth) return [];
  const issues = [];
  (assetHealth.unregisteredReferences || []).forEach(resourceName => {
    issues.push({
      severity: 'error',
      category: 'resources',
      code: 'unregistered-resource-reference',
      message: `Resource reference "${resourceName}" is used but is not registered in the project resource manager.`,
      details: { resourceName },
    });
  });
  (assetHealth.resources || []).forEach(resource => {
    if (resource.fileStatus === 'error') {
      issues.push({
        severity: 'error',
        category: 'resources',
        code: 'missing-resource-file',
        message: `Resource "${
          resource.name
        }" points to a missing or invalid file.`,
        details: {
          resourceName: resource.name,
          file: resource.file,
          localFilePath: resource.localFilePath,
        },
      });
    } else if (resource.fileStatus === 'warning') {
      issues.push({
        severity: 'warning',
        category: 'resources',
        code: 'resource-file-outside-project',
        message: `Resource "${
          resource.name
        }" points outside the project folder.`,
        details: {
          resourceName: resource.name,
          file: resource.file,
          localFilePath: resource.localFilePath,
        },
      });
    }
    if (resource.orphaned) {
      issues.push({
        severity: 'info',
        category: 'resources',
        code: 'orphaned-resource',
        message: `Resource "${
          resource.name
        }" is registered but not used by the project.`,
        details: {
          resourceName: resource.name,
          file: resource.file,
        },
      });
    }
  });
  return issues;
};

const summarizeIssues = (issues: Array<DiagnosticIssue>) => {
  const errors = issues.filter(issue => issue.severity === 'error').length;
  const warnings = issues.filter(issue => issue.severity === 'warning').length;
  const info = issues.filter(issue => issue.severity === 'info').length;
  const byCategory = {};
  issues.forEach(issue => {
    if (!byCategory[issue.category]) {
      byCategory[issue.category] = { errors: 0, warnings: 0, info: 0 };
    }
    if (issue.severity === 'error') byCategory[issue.category].errors += 1;
    else if (issue.severity === 'warning')
      byCategory[issue.category].warnings += 1;
    else byCategory[issue.category].info += 1;
  });
  return {
    ok: errors === 0,
    total: issues.length,
    errors,
    warnings,
    info,
    byCategory,
  };
};

export const createDiagnosticsTools = ({
  project,
  i18n,
  assetTools,
}: DiagnosticsToolsOptions) => {
  const inspect = (request: any = {}) => {
    const projectPropertyIssues = serializeProjectPropertyIssues(i18n, project);
    const eventValidationIssues = serializeEventValidationIssues(project);
    const requiredBehaviorIssues = serializeRequiredBehaviorProblems(project);
    const nativeIssues =
      request.includeNativeReport === false
        ? []
        : serializeWholeProjectDiagnosticReport(
            project.getWholeProjectDiagnosticReport()
          );
    const assetHealth =
      request.includeAssets === false || !assetTools
        ? null
        : assetTools.listResources();
    const assetIssues = serializeAssetIssues(assetHealth);
    const issues = [
      ...projectPropertyIssues,
      ...eventValidationIssues,
      ...requiredBehaviorIssues,
      ...nativeIssues,
      ...assetIssues,
    ];

    return {
      projectName: project.getName(),
      projectUuid: project.getProjectUuid(),
      generatedAt: new Date().toISOString(),
      nativeReportNote:
        'Native code-generation diagnostics reflect the most recent preview/export code generation. Event parameter validation, required behavior properties and resource health are scanned fresh.',
      summary: summarizeIssues(issues),
      issues,
      sections: {
        projectProperties: projectPropertyIssues,
        eventsValidation: eventValidationIssues,
        requiredBehaviorProperties: requiredBehaviorIssues,
        nativeCodeGeneration: nativeIssues,
        resources: {
          health: assetHealth,
          issues: assetIssues,
        },
      },
    };
  };

  return { inspect };
};
