// @flow
import { AgentError } from '../core/AgentError';
import { exportLocalHtml5ForAgent } from '../../AgentApi/ExportTools';

type Options = {|
  project: ?gdProject,
  i18n: any,
|};

export const createExportService = ({ project, i18n }: Options) => ({
  exportHtml5: async ({ outputDir }: any = {}) => {
    if (!project) throw new AgentError({ code: 'no_project_open' });
    return exportLocalHtml5ForAgent({
      project,
      i18n,
      outputDir:
        typeof outputDir === 'string' && outputDir ? outputDir : undefined,
    });
  },
});
