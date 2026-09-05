// @flow
import { type I18n as I18nType } from '@lingui/core';
import { exportLocalHtml5Headless } from '../ExportAndShare/Headless/ExportLocalHtml5Headless';

export const runWithRestoredCompilationDirectory = async <T>(
  project: gdProject,
  operation: () => Promise<T>
): Promise<T> => {
  const previousOutputDirectory = project.getLastCompilationDirectory();
  try {
    return await operation();
  } finally {
    project.setLastCompilationDirectory(previousOutputDirectory);
  }
};

export const exportLocalHtml5ForAgent = ({
  project,
  i18n,
  outputDir,
}: {|
  project: gdProject,
  i18n: I18nType,
  outputDir?: string,
|}) =>
  runWithRestoredCompilationDirectory(project, () =>
    exportLocalHtml5Headless({
      project,
      i18n,
      outputDir,
    })
  );
