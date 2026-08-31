// @flow
import { createProjectLifecycleService } from './ProjectLifecycleService';

const makeProject = (name = 'Game') => ({
  getName: () => name,
  getProjectUuid: () => 'project-uuid',
});

const makeService = (overrides: any = {}) => {
  const project =
    overrides.project === undefined ? makeProject() : overrides.project;
  const dependencies = {
    project,
    fileIdentifier: 'C:/game.json',
    hasUnsavedChanges: false,
    createProjectForAgent: jest.fn(async () => ({
      createdProject: makeProject('Created'),
      exampleSlug: null,
    })),
    openFromFileMetadataWithStorageProvider: jest.fn(async () => {}),
    closeProject: jest.fn(async () => {}),
    saveProject: jest.fn(async () => ({ fileIdentifier: 'C:/game.json' })),
    saveProjectAsWithStorageProvider: jest.fn(async options => ({
      fileIdentifier: options.forcedSavedAsLocation.fileIdentifier,
    })),
    pathModule: { resolve: path => `resolved:${path}` },
    ...overrides,
  };
  return {
    service: createProjectLifecycleService(dependencies),
    dependencies,
  };
};

describe('ProjectLifecycleService', () => {
  test('creates a project only when no project is open', async () => {
    const { service } = makeService({ project: null });
    await expect(service.create({ name: 'Created' })).resolves.toMatchObject({
      created: true,
      projectName: 'Created',
      needsSaveAs: true,
    });

    const openService = makeService().service;
    await expect(openService.create({ name: 'Other' })).rejects.toMatchObject({
      code: 'project_already_open',
    });
  });

  test('requires explicit discard before opening over unsaved changes', async () => {
    const { service, dependencies } = makeService({
      hasUnsavedChanges: true,
    });
    await expect(
      service.open({ filePath: 'C:/other.json' })
    ).rejects.toMatchObject({
      code: 'unsaved_changes_require_explicit_discard',
    });
    expect(
      dependencies.openFromFileMetadataWithStorageProvider
    ).not.toHaveBeenCalled();

    await service.open({
      filePath: 'C:/other.json',
      discardUnsavedChanges: true,
    });
    expect(
      dependencies.openFromFileMetadataWithStorageProvider
    ).toHaveBeenCalledTimes(1);
  });

  test('close is idempotent with no open project and protects dirty state', async () => {
    await expect(
      makeService({ project: null }).service.close()
    ).resolves.toEqual({ closed: false, reason: 'no_project_open' });

    const { service, dependencies } = makeService({
      hasUnsavedChanges: true,
    });
    await expect(service.close()).rejects.toMatchObject({
      code: 'unsaved_changes_require_explicit_discard',
    });
    await expect(
      service.close({ discardUnsavedChanges: true })
    ).resolves.toEqual({ closed: true });
    expect(dependencies.closeProject).toHaveBeenCalledTimes(1);
  });

  test('save is explicit and returns the resulting file identifier', async () => {
    const { service, dependencies } = makeService();
    await expect(service.save()).resolves.toEqual({
      saved: true,
      fileIdentifier: 'C:/game.json',
    });
    expect(dependencies.saveProject).toHaveBeenCalledWith({
      skipNewVersionWarning: true,
    });
  });

  test('save-as resolves the local path and preserves project name by default', async () => {
    const { service, dependencies } = makeService();
    const result = await service.saveAs({ filePath: './copy.json' });
    expect(result.saved).toBe(true);
    expect(dependencies.saveProjectAsWithStorageProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        forcedSavedAsLocation: {
          name: 'Game',
          fileIdentifier: 'resolved:./copy.json',
        },
      })
    );
  });
});
