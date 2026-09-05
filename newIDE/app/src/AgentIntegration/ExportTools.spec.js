// @flow
import { runWithRestoredCompilationDirectory } from './ExportTools';

jest.mock('../ExportAndShare/Headless/ExportLocalHtml5Headless', () => ({
  exportLocalHtml5Headless: jest.fn(),
}));

describe('AgentIntegration ExportTools', () => {
  it('restores the project compilation directory after a successful export', async () => {
    let currentDirectory = 'C:/previous';
    const project = ({
      getLastCompilationDirectory: () => currentDirectory,
      setLastCompilationDirectory: value => {
        currentDirectory = value;
      },
    }: any);

    const result = await runWithRestoredCompilationDirectory(
      project,
      async () => {
        project.setLastCompilationDirectory('C:/temporary-export');
        return { outputDir: 'C:/temporary-export' };
      }
    );

    expect(result).toEqual({ outputDir: 'C:/temporary-export' });
    expect(currentDirectory).toBe('C:/previous');
  });

  it('restores the project compilation directory when export fails', async () => {
    let currentDirectory = 'C:/previous';
    const project = ({
      getLastCompilationDirectory: () => currentDirectory,
      setLastCompilationDirectory: value => {
        currentDirectory = value;
      },
    }: any);

    await expect(
      runWithRestoredCompilationDirectory(project, async () => {
        project.setLastCompilationDirectory('C:/temporary-export');
        throw new Error('export_failed');
      })
    ).rejects.toThrow('export_failed');
    expect(currentDirectory).toBe('C:/previous');
  });
});
