// @flow
import { AgentError } from '../core/AgentError';
import LocalFileStorageProvider from '../../ProjectsStorage/LocalFileStorageProvider';
import optionalRequire from '../../Utils/OptionalRequire';
import { serializeToJSObject } from '../../Utils/Serializer';

const fs = optionalRequire('fs');
const nodePath = optionalRequire('path');
const crypto = optionalRequire('crypto');

type Options = {|
  project: ?gdProject,
  getCurrentProject?: ?() => ?gdProject,
  fileIdentifier: ?string,
  hasUnsavedChanges: boolean,
  projectRevisionTracker?: ?any,
  semanticConcurrency?: ?any,
  getTransactionStatus?: ?() => any,
  getSerializedProjectSnapshotForPersistence?: ?(project: gdProject) => any,
  readProjectDiskSnapshot?: ?(fileIdentifier: ?string) => any,
  createProjectForAgent: (options: any) => Promise<any>,
  openFromFileMetadataWithStorageProvider: (
    fileMetadataAndStorageProviderName: any,
    options?: any
  ) => Promise<void>,
  closeProject: () => Promise<void>,
  saveProject: (options?: any) => Promise<any>,
  saveProjectAsWithStorageProvider: (options?: any) => Promise<any>,
  pathModule: ?{| resolve: (path: string) => string |},
|};

type DiskSnapshot = {|
  available: boolean,
  fileIdentifier: ?string,
  exists: ?boolean,
  readable: boolean,
  byteSize: ?number,
  modifiedAt: ?number,
  rawHash: ?string,
  serializedHash: ?string,
  parseError: ?string,
|};

type PersistenceState = {|
  projectId: string,
  fileIdentifier: ?string,
  baselineDiskSnapshot: DiskSnapshot,
  baselineCapturedAt: number,
  lastSuccessfulSave: ?any,
  lastReload: ?any,
|};

const persistenceStateByProjectId: Map<string, PersistenceState> = new Map();

const sortJsonValue = (value: any): any => {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value)
    .sort()
    .reduce((result, key) => {
      result[key] = sortJsonValue(value[key]);
      return result;
    }, {});
};

const stableStringify = (value: any): string =>
  JSON.stringify(sortJsonValue(value));

const sha256 = (content: string): ?string => {
  if (!crypto || typeof crypto.createHash !== 'function') return null;
  return crypto
    .createHash('sha256')
    .update(content, 'utf8')
    .digest('hex');
};

const serializeProject = (project: gdProject): Object =>
  serializeToJSObject(project, 'serializeTo', {
    canonicalEventSerialization: false,
  });

const getDefaultSerializedProjectSnapshot = (project: gdProject) => {
  const serialized = serializeProject(project);
  const canonicalJson = stableStringify(serialized);
  return {
    hashAlgorithm: crypto ? 'sha256' : null,
    serializedHash: sha256(canonicalJson),
    byteSize: unescape(encodeURIComponent(canonicalJson)).length,
  };
};

const readDiskSnapshot = (fileIdentifier: ?string): DiskSnapshot => {
  if (!fs || !fileIdentifier) {
    return {
      available: !!fs,
      fileIdentifier: fileIdentifier || null,
      exists: fileIdentifier ? null : false,
      readable: false,
      byteSize: null,
      modifiedAt: null,
      rawHash: null,
      serializedHash: null,
      parseError: null,
    };
  }

  try {
    if (!fs.existsSync(fileIdentifier)) {
      return {
        available: true,
        fileIdentifier,
        exists: false,
        readable: false,
        byteSize: null,
        modifiedAt: null,
        rawHash: null,
        serializedHash: null,
        parseError: null,
      };
    }
    const stat = fs.statSync(fileIdentifier);
    if (!stat.isFile()) {
      return {
        available: true,
        fileIdentifier,
        exists: true,
        readable: false,
        byteSize: stat.size,
        modifiedAt: stat.mtimeMs,
        rawHash: null,
        serializedHash: null,
        parseError: 'project_path_is_not_a_file',
      };
    }
    const content = fs.readFileSync(fileIdentifier, 'utf8');
    let serializedHash = null;
    let parseError = null;
    try {
      serializedHash = sha256(
        stableStringify(JSON.parse(content.replace(/^\uFEFF/, '')))
      );
    } catch (error) {
      parseError = error && error.message ? error.message : String(error);
    }
    return {
      available: true,
      fileIdentifier,
      exists: true,
      readable: true,
      byteSize: stat.size,
      modifiedAt: stat.mtimeMs,
      rawHash: sha256(content),
      serializedHash,
      parseError,
    };
  } catch (error) {
    return {
      available: true,
      fileIdentifier,
      exists: null,
      readable: false,
      byteSize: null,
      modifiedAt: null,
      rawHash: null,
      serializedHash: null,
      parseError: error && error.message ? error.message : String(error),
    };
  }
};

const normalizeFileIdentifier = (
  fileIdentifier: ?string,
  pathModule: ?any
): ?string => {
  if (!fileIdentifier) return null;
  let normalized = fileIdentifier;
  const resolver =
    pathModule && typeof pathModule.resolve === 'function'
      ? pathModule
      : nodePath && typeof nodePath.resolve === 'function'
      ? nodePath
      : null;
  if (resolver) {
    try {
      normalized = resolver.resolve(fileIdentifier);
    } catch (error) {
      normalized = fileIdentifier;
    }
  }
  normalized = normalized.replace(/\\/g, '/');
  return /^[A-Za-z]:\//.test(normalized)
    ? normalized.toLowerCase()
    : normalized;
};

const diskSnapshotChanged = (
  baseline: DiskSnapshot,
  current: DiskSnapshot
): boolean => {
  if (baseline.available !== current.available) return true;
  if (baseline.exists !== current.exists) return true;
  if (baseline.rawHash || current.rawHash) {
    return baseline.rawHash !== current.rawHash;
  }
  if (baseline.byteSize !== current.byteSize) return true;
  return baseline.modifiedAt !== current.modifiedAt;
};

const summarizeDiskSnapshot = (snapshot: DiskSnapshot) => ({
  available: snapshot.available,
  fileIdentifier: snapshot.fileIdentifier,
  exists: snapshot.exists,
  readable: snapshot.readable,
  byteSize: snapshot.byteSize,
  modifiedAt: snapshot.modifiedAt,
  rawHash: snapshot.rawHash,
  serializedHash: snapshot.serializedHash,
  parseError: snapshot.parseError,
});

const getRequestOwner = (requestContext: any): ?string => {
  if (
    requestContext &&
    requestContext.identity &&
    typeof requestContext.identity.ownerKey === 'string' &&
    requestContext.identity.ownerKey
  ) {
    return requestContext.identity.ownerKey;
  }
  return requestContext &&
    typeof requestContext.semanticLeaseOwner === 'string' &&
    requestContext.semanticLeaseOwner
    ? requestContext.semanticLeaseOwner
    : null;
};

export const createProjectLifecycleService = ({
  project,
  getCurrentProject,
  fileIdentifier,
  hasUnsavedChanges,
  projectRevisionTracker,
  semanticConcurrency,
  getTransactionStatus,
  getSerializedProjectSnapshotForPersistence = getDefaultSerializedProjectSnapshot,
  readProjectDiskSnapshot = readDiskSnapshot,
  createProjectForAgent,
  openFromFileMetadataWithStorageProvider,
  closeProject,
  saveProject,
  saveProjectAsWithStorageProvider,
  pathModule,
}: Options) => {
  const resolveProject = (): ?gdProject => {
    try {
      return typeof getCurrentProject === 'function'
        ? getCurrentProject()
        : project;
    } catch (error) {
      return null;
    }
  };

  const readProjectId = (currentProject: ?gdProject): ?string => {
    if (
      !currentProject ||
      typeof currentProject.getProjectUuid !== 'function'
    ) {
      return null;
    }
    try {
      return currentProject.getProjectUuid() || null;
    } catch (error) {
      return null;
    }
  };

  const requireProject = (): gdProject => {
    const currentProject = resolveProject();
    if (!currentProject) throw new AgentError({ code: 'no_project_open' });
    return currentProject;
  };

  const getProjectId = (): string => {
    const currentProject = requireProject();
    const projectId = readProjectId(currentProject);
    if (!projectId) throw new AgentError({ code: 'project_uuid_missing' });
    return projectId;
  };

  const getCurrentFileIdentifier = (): ?string => {
    const currentProject = resolveProject();
    if (
      currentProject &&
      typeof currentProject.getProjectFile === 'function' &&
      currentProject.getProjectFile()
    ) {
      return currentProject.getProjectFile();
    }
    return fileIdentifier || null;
  };

  const getCurrentProjectRevision = (): ?number =>
    projectRevisionTracker &&
    typeof projectRevisionTracker.synchronize === 'function'
      ? projectRevisionTracker.synchronize()
      : null;

  const ensurePersistenceState = (): PersistenceState => {
    const projectId = getProjectId();
    const currentFileIdentifier = getCurrentFileIdentifier();
    const normalizedCurrent = normalizeFileIdentifier(
      currentFileIdentifier,
      pathModule
    );
    let state = persistenceStateByProjectId.get(projectId);
    const normalizedStored = state
      ? normalizeFileIdentifier(state.fileIdentifier, pathModule)
      : null;
    if (!state || normalizedStored !== normalizedCurrent) {
      state = {
        projectId,
        fileIdentifier: currentFileIdentifier,
        baselineDiskSnapshot: readProjectDiskSnapshot(currentFileIdentifier),
        baselineCapturedAt: Date.now(),
        lastSuccessfulSave: null,
        lastReload: null,
      };
      persistenceStateByProjectId.set(projectId, state);
    }
    return state;
  };

  const updateBaseline = ({
    fileIdentifier: nextFileIdentifier,
    diskSnapshot,
  }: {|
    fileIdentifier: ?string,
    diskSnapshot?: DiskSnapshot,
  |}): PersistenceState => {
    const state = ensurePersistenceState();
    state.fileIdentifier = nextFileIdentifier;
    state.baselineDiskSnapshot =
      diskSnapshot || readProjectDiskSnapshot(nextFileIdentifier);
    state.baselineCapturedAt = Date.now();
    return state;
  };

  const assertExpectedIdentity = (input: any = {}) => {
    const currentProject = requireProject();
    const actualProjectId = getProjectId();
    const actualFileIdentifier = getCurrentFileIdentifier();
    if (
      input.expectedProjectId !== undefined &&
      input.expectedProjectId !== actualProjectId
    ) {
      throw new AgentError({
        code: 'project_identity_conflict',
        retryable: true,
        hint:
          'Read project.persistence.status and retry against the active project.',
        details: {
          conflictField: 'projectId',
          expectedProjectId: input.expectedProjectId,
          actualProjectId,
          projectName: currentProject.getName(),
          fileIdentifier: actualFileIdentifier,
        },
      });
    }
    if (input.expectedFileIdentifier !== undefined) {
      const expected = normalizeFileIdentifier(
        input.expectedFileIdentifier,
        pathModule
      );
      const actual = normalizeFileIdentifier(actualFileIdentifier, pathModule);
      if (expected !== actual) {
        throw new AgentError({
          code: 'project_identity_conflict',
          retryable: true,
          hint:
            'Read project.persistence.status and retry against the active project path.',
          details: {
            conflictField: 'fileIdentifier',
            expectedFileIdentifier: input.expectedFileIdentifier,
            actualFileIdentifier,
            projectId: actualProjectId,
          },
        });
      }
    }
  };

  const assertExpectedProjectRevision = (input: any = {}) => {
    if (input.expectedProjectRevision === undefined) return;
    const currentRevision = getCurrentProjectRevision();
    if (input.expectedProjectRevision !== currentRevision) {
      throw new AgentError({
        code: 'revision_conflict',
        retryable: true,
        currentRevision,
        hint:
          'Read project.persistence.status and retry with the current project revision.',
        details: {
          conflictScope: 'project',
          expectedRevision: input.expectedProjectRevision,
          actualRevision: currentRevision,
          currentRevision,
        },
      });
    }
  };

  const assertPersistenceSafety = (requestContext: any = {}) => {
    if (typeof getTransactionStatus === 'function') {
      const transaction = getTransactionStatus();
      if (transaction && transaction.active) {
        throw new AgentError({
          code: 'persistence_blocked_by_active_transaction',
          retryable: true,
          hint:
            'Commit or rollback the active safety transaction before saving or reloading the project.',
          details: {
            transactionId: transaction.transactionId || null,
            owner: transaction.owner || null,
            purpose: transaction.purpose || null,
            startedAt: transaction.startedAt || null,
          },
        });
      }
    }
    if (
      semanticConcurrency &&
      typeof semanticConcurrency.assertLeaseAccess === 'function'
    ) {
      semanticConcurrency.assertLeaseAccess(
        ['project'],
        getRequestOwner(requestContext)
      );
    }
  };

  const buildPersistenceStatus = (input: any = {}) => {
    const currentProject = requireProject();
    assertExpectedIdentity(input);
    const state = ensurePersistenceState();
    const currentFileIdentifier = getCurrentFileIdentifier();
    const memory = getSerializedProjectSnapshotForPersistence(currentProject);
    const disk = readProjectDiskSnapshot(currentFileIdentifier);
    let externalModificationDetected = diskSnapshotChanged(
      state.baselineDiskSnapshot,
      disk
    );
    const folderProject =
      typeof currentProject.isFolderProject === 'function' &&
      currentProject.isFolderProject();
    const currentProjectRevision = getCurrentProjectRevision();
    const currentMemoryMatchesDisk =
      !folderProject &&
      !!memory.serializedHash &&
      !!disk.serializedHash &&
      memory.serializedHash === disk.serializedHash;
    const baselineReconciledFromCleanEditor =
      externalModificationDetected &&
      !hasUnsavedChanges &&
      currentMemoryMatchesDisk;
    if (baselineReconciledFromCleanEditor) {
      state.baselineDiskSnapshot = disk;
      state.baselineCapturedAt = Date.now();
      externalModificationDetected = false;
    }

    return {
      projectOpen: true,
      projectId: getProjectId(),
      projectName: currentProject.getName(),
      fileIdentifier: currentFileIdentifier,
      hasUnsavedChanges,
      currentProjectRevision,
      lastSavedProjectRevision:
        state.lastSuccessfulSave &&
        Number.isInteger(state.lastSuccessfulSave.projectRevision)
          ? state.lastSuccessfulSave.projectRevision
          : null,
      inMemory: {
        state: hasUnsavedChanges ? 'dirty' : 'clean',
        hashAlgorithm: memory.hashAlgorithm,
        serializedHash: memory.serializedHash,
        byteSize: memory.byteSize,
      },
      persisted: {
        ...summarizeDiskSnapshot(disk),
        baselineRawHash: state.baselineDiskSnapshot.rawHash,
        baselineSerializedHash: state.baselineDiskSnapshot.serializedHash,
        baselineCapturedAt: state.baselineCapturedAt,
        externalModificationDetected,
        baselineReconciledFromCleanEditor,
        currentMemoryMatchesDisk: folderProject
          ? null
          : currentMemoryMatchesDisk,
        memoryComparisonSupported: !folderProject,
        memoryComparisonReason: folderProject
          ? 'folder_project_uses_split_serialization'
          : null,
      },
      resources: {
        pendingFlushes: 0,
        flushState: 'write-through',
        projectManifestPersisted:
          !hasUnsavedChanges &&
          disk.readable &&
          !externalModificationDetected &&
          (folderProject || currentMemoryMatchesDisk),
        note:
          'AgentIntegration resource-file mutations complete their physical writes before command success; project.save persists the project manifest and does not queue a second resource-file flush.',
      },
      lastSuccessfulSave: state.lastSuccessfulSave,
      lastReload: state.lastReload,
    };
  };

  const assertNoExternalDiskConflict = (input: any, status: any): void => {
    if (
      status.persisted.externalModificationDetected &&
      !input.overwriteExternalChanges
    ) {
      throw new AgentError({
        code: 'project_disk_conflict',
        retryable: true,
        hint:
          'The project file changed on disk. Reload/re-read it, or explicitly set overwriteExternalChanges=true only if overwriting that external change is intended.',
        details: {
          fileIdentifier: status.fileIdentifier,
          baselineRawHash: status.persisted.baselineRawHash,
          currentRawHash: status.persisted.rawHash,
          baselineSerializedHash: status.persisted.baselineSerializedHash,
          currentSerializedHash: status.persisted.serializedHash,
        },
      });
    }
  };

  const verifySavedDisk = ({
    expectedMemoryHash,
    currentFileIdentifier,
  }: {|
    expectedMemoryHash: ?string,
    currentFileIdentifier: ?string,
  |}) => {
    const currentProject = requireProject();
    const disk = readProjectDiskSnapshot(currentFileIdentifier);
    if (
      !disk.available ||
      !disk.exists ||
      !disk.readable ||
      disk.parseError ||
      !disk.serializedHash
    ) {
      throw new AgentError({
        code: 'project_save_verification_failed',
        details: {
          fileIdentifier: currentFileIdentifier,
          disk: summarizeDiskSnapshot(disk),
        },
      });
    }
    const folderProject =
      typeof currentProject.isFolderProject === 'function' &&
      currentProject.isFolderProject();
    if (
      !folderProject &&
      expectedMemoryHash &&
      disk.serializedHash !== expectedMemoryHash
    ) {
      throw new AgentError({
        code: 'project_save_verification_failed',
        details: {
          fileIdentifier: currentFileIdentifier,
          expectedSerializedHash: expectedMemoryHash,
          actualSerializedHash: disk.serializedHash,
        },
      });
    }
    return disk;
  };

  const initialProject = resolveProject();
  if (readProjectId(initialProject)) ensurePersistenceState();

  return {
    create: async ({ name, templateSlug }: any) => {
      if (resolveProject()) {
        throw new AgentError({ code: 'project_already_open' });
      }
      if (!name || typeof name !== 'string') {
        throw new AgentError({ code: 'missing_project_name' });
      }
      const { createdProject, exampleSlug } = await createProjectForAgent({
        name,
        exampleSlug: typeof templateSlug === 'string' ? templateSlug : null,
      });
      if (!createdProject) {
        throw new AgentError({ code: 'project_creation_failed' });
      }
      return {
        created: true,
        projectName: createdProject.getName(),
        projectUuid: createdProject.getProjectUuid(),
        templateSlug: exampleSlug,
        needsSaveAs: true,
      };
    },

    open: async ({ filePath, discardUnsavedChanges = false }: any) => {
      if (!filePath || typeof filePath !== 'string') {
        throw new AgentError({ code: 'missing_project_file_path' });
      }
      if (hasUnsavedChanges && !discardUnsavedChanges) {
        throw new AgentError({
          code: 'unsaved_changes_require_explicit_discard',
          message:
            'The current project has unsaved changes. Explicitly allow discard before opening another project.',
        });
      }
      await openFromFileMetadataWithStorageProvider(
        {
          storageProviderName: LocalFileStorageProvider.internalName,
          fileMetadata: { fileIdentifier: filePath },
        },
        { ignoreUnsavedChanges: !!discardUnsavedChanges }
      );
      return { opened: true, filePath };
    },

    close: async ({ discardUnsavedChanges = false }: any = {}) => {
      if (!resolveProject()) {
        return { closed: false, reason: 'no_project_open' };
      }
      if (hasUnsavedChanges && !discardUnsavedChanges) {
        throw new AgentError({
          code: 'unsaved_changes_require_explicit_discard',
          message:
            'The current project has unsaved changes. Explicitly allow discard before closing it.',
        });
      }
      await closeProject();
      return { closed: true };
    },

    persistenceStatus: (input: any = {}) => buildPersistenceStatus(input),

    verifyPersistence: (input: any = {}) => {
      assertExpectedIdentity(input);
      assertExpectedProjectRevision(input);
      const status = buildPersistenceStatus(input);
      const expectedPersistedHash =
        typeof input.expectedPersistedHash === 'string' &&
        input.expectedPersistedHash
          ? input.expectedPersistedHash
          : status.lastSuccessfulSave &&
            status.lastSuccessfulSave.serializedHash;
      const expectedPersistedRevision =
        input.expectedPersistedRevision !== undefined
          ? input.expectedPersistedRevision
          : status.lastSuccessfulSave &&
            status.lastSuccessfulSave.projectRevision;
      const hashMatches =
        expectedPersistedHash == null
          ? !!status.persisted.serializedHash
          : status.persisted.serializedHash === expectedPersistedHash;
      const revisionMatches =
        expectedPersistedRevision == null ||
        status.lastSuccessfulSave == null ||
        status.lastSuccessfulSave.projectRevision === expectedPersistedRevision;
      return {
        verified:
          !!status.persisted.readable &&
          !status.persisted.parseError &&
          !status.persisted.externalModificationDetected &&
          hashMatches &&
          revisionMatches,
        projectId: status.projectId,
        fileIdentifier: status.fileIdentifier,
        expectedPersistedHash: expectedPersistedHash || null,
        actualPersistedHash: status.persisted.serializedHash,
        expectedPersistedRevision:
          expectedPersistedRevision == null ? null : expectedPersistedRevision,
        lastSavedProjectRevision: status.lastSavedProjectRevision,
        currentProjectRevision: status.currentProjectRevision,
        currentMemoryMatchesDisk: status.persisted.currentMemoryMatchesDisk,
        hasUnsavedChanges: status.hasUnsavedChanges,
        externalModificationDetected:
          status.persisted.externalModificationDetected,
        serializedProjectReadable:
          status.persisted.readable && !status.persisted.parseError,
        disk: status.persisted,
      };
    },

    save: async (input: any = {}, requestContext: any = {}) => {
      const currentProject = requireProject();
      assertExpectedIdentity(input);
      assertExpectedProjectRevision(input);
      assertPersistenceSafety(requestContext);
      const before = buildPersistenceStatus(input);
      assertNoExternalDiskConflict(input, before);
      const memoryBeforeSave = getSerializedProjectSnapshotForPersistence(
        currentProject
      );
      const savedFileMetadata = await saveProject({
        skipNewVersionWarning: true,
      });
      if (!savedFileMetadata) {
        throw new AgentError({ code: 'project_save_failed' });
      }
      const savedFileIdentifier =
        savedFileMetadata.fileIdentifier || getCurrentFileIdentifier();
      const disk = verifySavedDisk({
        expectedMemoryHash: memoryBeforeSave.serializedHash,
        currentFileIdentifier: savedFileIdentifier,
      });
      const projectRevision = getCurrentProjectRevision();
      const state = updateBaseline({
        fileIdentifier: savedFileIdentifier,
        diskSnapshot: disk,
      });
      state.lastSuccessfulSave = {
        at: Date.now(),
        projectId: getProjectId(),
        fileIdentifier: savedFileIdentifier,
        projectRevision,
        rawHash: disk.rawHash,
        serializedHash: disk.serializedHash,
        byteSize: disk.byteSize,
        modifiedAt: disk.modifiedAt,
        resourcesFlushed: true,
      };
      return {
        saved: true,
        projectId: getProjectId(),
        fileIdentifier: savedFileIdentifier,
        projectRevision,
        persistedRevision: projectRevision,
        hasUnsavedChanges: false,
        persistedHash: disk.serializedHash,
        rawFileHash: disk.rawHash,
        resourcesFlushed: true,
        verification: {
          readable: true,
          serializedHashMatchesMemory:
            typeof currentProject.isFolderProject === 'function' &&
            currentProject.isFolderProject()
              ? null
              : disk.serializedHash === memoryBeforeSave.serializedHash,
        },
        changeSummary: {
          before: {
            hasUnsavedChanges: before.hasUnsavedChanges,
            diskRawHash: before.persisted.rawHash,
            diskSerializedHash: before.persisted.serializedHash,
          },
          after: {
            hasUnsavedChanges: false,
            diskRawHash: disk.rawHash,
            diskSerializedHash: disk.serializedHash,
          },
        },
      };
    },

    saveAs: async (input: any, requestContext: any = {}) => {
      const currentProject = requireProject();
      assertExpectedIdentity(input);
      assertExpectedProjectRevision(input);
      assertPersistenceSafety(requestContext);
      if (!pathModule) {
        throw new AgentError({ code: 'local_filesystem_unavailable' });
      }
      const { filePath, name } = input;
      if (!filePath || typeof filePath !== 'string') {
        throw new AgentError({ code: 'missing_project_file_path' });
      }
      const resolvedFilePath = pathModule.resolve(filePath);
      const before = buildPersistenceStatus(input);
      if (
        normalizeFileIdentifier(resolvedFilePath, pathModule) ===
        normalizeFileIdentifier(before.fileIdentifier, pathModule)
      ) {
        assertNoExternalDiskConflict(input, before);
      }
      const savedFileMetadata = await saveProjectAsWithStorageProvider({
        requestedStorageProvider: LocalFileStorageProvider,
        forcedSavedAsLocation: {
          name:
            typeof name === 'string' && name ? name : currentProject.getName(),
          fileIdentifier: resolvedFilePath,
        },
      });
      if (!savedFileMetadata) {
        throw new AgentError({ code: 'project_save_as_failed' });
      }
      const savedFileIdentifier =
        savedFileMetadata.fileIdentifier || resolvedFilePath;
      const memoryAfterSave = getSerializedProjectSnapshotForPersistence(
        currentProject
      );
      const disk = verifySavedDisk({
        expectedMemoryHash: memoryAfterSave.serializedHash,
        currentFileIdentifier: savedFileIdentifier,
      });
      const projectRevision = getCurrentProjectRevision();
      const state = updateBaseline({
        fileIdentifier: savedFileIdentifier,
        diskSnapshot: disk,
      });
      state.lastSuccessfulSave = {
        at: Date.now(),
        projectId: getProjectId(),
        fileIdentifier: savedFileIdentifier,
        projectRevision,
        rawHash: disk.rawHash,
        serializedHash: disk.serializedHash,
        byteSize: disk.byteSize,
        modifiedAt: disk.modifiedAt,
        resourcesFlushed: true,
      };
      return {
        saved: true,
        projectId: getProjectId(),
        fileMetadata: savedFileMetadata,
        fileIdentifier: savedFileIdentifier,
        projectRevision,
        persistedRevision: projectRevision,
        hasUnsavedChanges: false,
        persistedHash: disk.serializedHash,
        rawFileHash: disk.rawHash,
        resourcesFlushed: true,
        verification: {
          readable: true,
          serializedHashMatchesMemory:
            typeof currentProject.isFolderProject === 'function' &&
            currentProject.isFolderProject()
              ? null
              : disk.serializedHash === memoryAfterSave.serializedHash,
        },
        changeSummary: {
          before: {
            fileIdentifier: before.fileIdentifier,
            hasUnsavedChanges: before.hasUnsavedChanges,
          },
          after: {
            fileIdentifier: savedFileIdentifier,
            hasUnsavedChanges: false,
            diskSerializedHash: disk.serializedHash,
          },
        },
      };
    },

    reload: async (input: any = {}, requestContext: any = {}) => {
      requireProject();
      const projectIdBeforeReload = getProjectId();
      const persistenceState = ensurePersistenceState();
      assertExpectedIdentity(input);
      assertExpectedProjectRevision(input);
      assertPersistenceSafety(requestContext);
      const currentFileIdentifier = getCurrentFileIdentifier();
      if (!currentFileIdentifier) {
        throw new AgentError({
          code: 'project_reload_requires_persisted_file',
          hint: 'Save the project to a local file before reloading it.',
        });
      }
      const before = buildPersistenceStatus(input);
      if (hasUnsavedChanges && !input.discardUnsavedChanges) {
        throw new AgentError({
          code: 'unsaved_changes_require_explicit_discard',
          message:
            'The current project has unsaved changes. Explicitly allow discard before reloading it from disk.',
        });
      }
      const disk = readProjectDiskSnapshot(currentFileIdentifier);
      if (
        !disk.exists ||
        !disk.readable ||
        disk.parseError ||
        !disk.serializedHash
      ) {
        throw new AgentError({
          code: 'project_reload_source_unreadable',
          details: {
            fileIdentifier: currentFileIdentifier,
            disk: summarizeDiskSnapshot(disk),
          },
        });
      }
      if (
        typeof input.expectedPersistedHash === 'string' &&
        input.expectedPersistedHash &&
        input.expectedPersistedHash !== disk.serializedHash
      ) {
        throw new AgentError({
          code: 'project_disk_conflict',
          retryable: true,
          details: {
            fileIdentifier: currentFileIdentifier,
            expectedPersistedHash: input.expectedPersistedHash,
            actualPersistedHash: disk.serializedHash,
          },
        });
      }

      await openFromFileMetadataWithStorageProvider(
        {
          storageProviderName: LocalFileStorageProvider.internalName,
          fileMetadata: { fileIdentifier: currentFileIdentifier },
        },
        { ignoreUnsavedChanges: !!input.discardUnsavedChanges }
      );
      persistenceState.fileIdentifier = currentFileIdentifier;
      persistenceState.baselineDiskSnapshot = disk;
      persistenceState.baselineCapturedAt = Date.now();
      persistenceState.lastReload = {
        at: Date.now(),
        projectIdBeforeReload,
        fileIdentifier: currentFileIdentifier,
        persistedHash: disk.serializedHash,
        discardedUnsavedChanges: !!hasUnsavedChanges,
      };
      return {
        reloaded: true,
        fileIdentifier: currentFileIdentifier,
        projectIdBeforeReload,
        persistedHash: disk.serializedHash,
        discardedUnsavedChanges: !!hasUnsavedChanges,
        verificationRequired: true,
        verificationCommand: 'project.persistence.verify',
        changeSummary: {
          before: {
            hasUnsavedChanges: before.hasUnsavedChanges,
            currentProjectRevision: before.currentProjectRevision,
            inMemorySerializedHash: before.inMemory.serializedHash,
          },
          after: {
            source: 'persisted-project-json',
            persistedHash: disk.serializedHash,
          },
        },
      };
    },
  };
};
