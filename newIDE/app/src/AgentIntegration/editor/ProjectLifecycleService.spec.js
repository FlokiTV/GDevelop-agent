// @flow
import { createProjectLifecycleService } from './ProjectLifecycleService';

let projectSequence = 0;

const makeProject = (name = 'Game', filePath = 'C:/game.json') => {
  projectSequence += 1;
  const projectId = `project-uuid-${projectSequence}`;
  return {
    getName: () => name,
    getProjectUuid: () => projectId,
    getProjectFile: () => filePath,
    isFolderProject: () => false,
  };
};

const makeDiskSnapshot = (
  fileIdentifier = 'C:/game.json',
  overrides: any = {}
) => ({
  available: true,
  fileIdentifier,
  exists: true,
  readable: true,
  byteSize: 128,
  modifiedAt: 1000,
  rawHash: 'raw-baseline',
  serializedHash: 'serialized-memory',
  parseError: null,
  ...overrides,
});

const makeService = (overrides: any = {}) => {
  const project =
    overrides.project === undefined ? makeProject() : overrides.project;
  const readProjectDiskSnapshot =
    overrides.readProjectDiskSnapshot ||
    jest.fn(filePath => makeDiskSnapshot(filePath));
  const dependencies = {
    project,
    fileIdentifier: 'C:/game.json',
    hasUnsavedChanges: false,
    projectRevisionTracker: {
      synchronize: jest.fn(() => 7),
    },
    semanticConcurrency: {
      assertLeaseAccess: jest.fn(),
    },
    getTransactionStatus: jest.fn(() => ({ active: false })),
    getSerializedProjectSnapshotForPersistence: jest.fn(() => ({
      hashAlgorithm: 'sha256',
      serializedHash: 'serialized-memory',
      byteSize: 96,
    })),
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
    pathModule: {
      resolve: path => (path.startsWith('C:/') ? path : `resolved:${path}`),
    },
    ...overrides,
    readProjectDiskSnapshot,
  };
  return {
    service: createProjectLifecycleService(dependencies),
    dependencies,
  };
};

describe('ProjectLifecycleService', () => {
  test('does not eagerly require a UUID from a transient bootstrap project', () => {
    const transientProject = {
      getName: () => 'Transient',
      getProjectUuid: () => '',
      getProjectFile: () => '',
      isFolderProject: () => false,
    };
    expect(() => makeService({ project: transientProject })).not.toThrow();
  });

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

  test('reports editor memory separately from persisted disk state', () => {
    const { service } = makeService({ hasUnsavedChanges: true });
    const status = service.persistenceStatus();

    expect(status).toMatchObject({
      hasUnsavedChanges: true,
      currentProjectRevision: 7,
      inMemory: {
        state: 'dirty',
        serializedHash: 'serialized-memory',
      },
      persisted: {
        rawHash: 'raw-baseline',
        serializedHash: 'serialized-memory',
        externalModificationDetected: false,
        currentMemoryMatchesDisk: true,
      },
      resources: {
        pendingFlushes: 0,
        flushState: 'write-through',
        projectManifestPersisted: false,
      },
    });
  });

  test('save is explicit, verifies the disk and records persisted revision/hash', async () => {
    const { service, dependencies } = makeService();
    await expect(service.save()).resolves.toMatchObject({
      saved: true,
      fileIdentifier: 'C:/game.json',
      projectRevision: 7,
      persistedRevision: 7,
      hasUnsavedChanges: false,
      persistedHash: 'serialized-memory',
      resourcesFlushed: true,
      verification: {
        readable: true,
        serializedHashMatchesMemory: true,
      },
    });
    expect(dependencies.saveProject).toHaveBeenCalledWith({
      skipNewVersionWarning: true,
    });

    expect(service.verifyPersistence()).toMatchObject({
      verified: true,
      expectedPersistedHash: 'serialized-memory',
      actualPersistedHash: 'serialized-memory',
      lastSavedProjectRevision: 7,
    });
  });

  test('save rejects an external disk change instead of silently overwriting it', async () => {
    const readProjectDiskSnapshot = jest
      .fn()
      .mockReturnValueOnce(makeDiskSnapshot())
      .mockReturnValue(
        makeDiskSnapshot('C:/game.json', {
          rawHash: 'raw-external-change',
          serializedHash: 'serialized-external-change',
        })
      );
    const { service, dependencies } = makeService({
      readProjectDiskSnapshot,
    });

    await expect(service.save()).rejects.toMatchObject({
      code: 'project_disk_conflict',
      details: {
        baselineRawHash: 'raw-baseline',
        currentRawHash: 'raw-external-change',
      },
    });
    expect(dependencies.saveProject).not.toHaveBeenCalled();
  });

  test('save and reload are blocked while a safety transaction is active', async () => {
    const { service, dependencies } = makeService({
      getTransactionStatus: jest.fn(() => ({
        active: true,
        transactionId: 'tx-1',
        owner: { ownerKey: 'agent-a' },
      })),
    });

    await expect(service.save()).rejects.toMatchObject({
      code: 'persistence_blocked_by_active_transaction',
      details: { transactionId: 'tx-1' },
    });
    await expect(service.reload()).rejects.toMatchObject({
      code: 'persistence_blocked_by_active_transaction',
    });
    expect(dependencies.saveProject).not.toHaveBeenCalled();
    expect(
      dependencies.openFromFileMetadataWithStorageProvider
    ).not.toHaveBeenCalled();
  });

  test('persistence operations honor project identity and revision guardrails', async () => {
    const { service } = makeService();

    await expect(
      service.save({ expectedProjectId: 'wrong-project' })
    ).rejects.toMatchObject({
      code: 'project_identity_conflict',
      details: { conflictField: 'projectId' },
    });
    await expect(
      service.save({ expectedProjectRevision: 6 })
    ).rejects.toMatchObject({
      code: 'revision_conflict',
      currentRevision: 7,
    });
  });

  test('reload never discards dirty memory unless explicit and returns hash for post-reload verification', async () => {
    const project = makeProject('Game', 'C:/game.json');
    const { service, dependencies } = makeService({
      project,
      hasUnsavedChanges: true,
    });

    await expect(service.reload()).rejects.toMatchObject({
      code: 'unsaved_changes_require_explicit_discard',
    });

    await expect(
      service.reload({ discardUnsavedChanges: true })
    ).resolves.toMatchObject({
      reloaded: true,
      fileIdentifier: 'C:/game.json',
      persistedHash: 'serialized-memory',
      discardedUnsavedChanges: true,
      verificationRequired: true,
      verificationCommand: 'project.persistence.verify',
    });
    expect(
      dependencies.openFromFileMetadataWithStorageProvider
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        fileMetadata: { fileIdentifier: 'C:/game.json' },
      }),
      { ignoreUnsavedChanges: true }
    );
  });

  test('save-as resolves the local path and preserves project name by default', async () => {
    const project = makeProject();
    const { service, dependencies } = makeService({ project });
    const result = await service.saveAs({ filePath: './copy.json' });
    expect(result).toMatchObject({
      saved: true,
      fileIdentifier: 'resolved:./copy.json',
      persistedHash: 'serialized-memory',
      resourcesFlushed: true,
    });
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
