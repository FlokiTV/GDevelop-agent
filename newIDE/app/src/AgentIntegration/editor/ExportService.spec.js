// @flow
import { exportLocalHtml5ForAgent } from '../ExportTools';
import { createExportService } from './ExportService';

jest.mock('../ExportTools', () => ({
  exportLocalHtml5ForAgent: jest.fn(async options => ({
    outputDir: options.outputDir || 'default',
  })),
}));

describe('ExportService', () => {
  beforeEach(() => jest.clearAllMocks());

  test('exports with injected project and i18n', async () => {
    exportLocalHtml5ForAgent.mockResolvedValue({ outputDir: 'out' });
    const project: any = {};
    const i18n: any = {};
    const service = createExportService({ project, i18n });
    await expect(service.exportHtml5({ outputDir: 'out' })).resolves.toEqual({
      outputDir: 'out',
    });
    expect(exportLocalHtml5ForAgent).toHaveBeenCalledWith({
      project,
      i18n,
      outputDir: 'out',
    });
  });

  test('requires an open project', async () => {
    const service = createExportService({ project: null, i18n: {} });
    await expect(service.exportHtml5()).rejects.toMatchObject({
      code: 'no_project_open',
    });
  });
});
