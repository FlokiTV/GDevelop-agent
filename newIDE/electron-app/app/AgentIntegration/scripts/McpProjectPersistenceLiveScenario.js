const fs = require('fs');
const os = require('os');
const path = require('path');
const { connectLiveGDevelopMcp, sanitizeForReplay } = require('./McpClient');

const PROJECT_NAME = 'DX41 Project Persistence Acceptance';
const PERSISTED_SCENE = 'DX41PersistedScene';
const ROLLBACK_SCENE = 'DX41RollbackOnlyScene';

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const callOk = async (session, name, args = {}) => {
  const result = await session.call(name, args);
  if (result.isError) {
    const error = new Error(
      `${name} failed: ${JSON.stringify(
        result.structuredContent || result.content || result.data
      )}`
    );
    error.result = result;
    throw error;
  }
  return result;
};

const expectErrorCode = (result, code) => {
  assert(result && result.isError === true, `expected_error:${code}`);
  const serialized = JSON.stringify(
    result.structuredContent || result.content || result.data || result
  );
  assert(serialized.includes(code), `missing_error_code:${code}:${serialized}`);
};

const findTool = (tools, name) => {
  const tool = tools.find(candidate => candidate.name === name);
  assert(tool, `missing_tool:${name}`);
  return tool;
};

const parseArgs = argv => {
  const options = { label: 'live', evidencePath: null };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--label') {
      options.label = argv[++index] || 'live';
    } else if (argument === '--evidence') {
      options.evidencePath = argv[++index] || null;
    } else {
      throw new Error(`unknown_argument:${argument}`);
    }
  }
  return options;
};

const addExternalProbe = content => {
  const parsed = JSON.parse(String(content).replace(/^\uFEFF/, ''));
  parsed.__dx41ExternalProbe = 'semantic-external-change';
  return `${JSON.stringify(parsed, null, 2)}\n`;
};

const installRepositoryReadGuard = () => {
  const repositoryRoot = path.resolve(__dirname, '..', '..', '..', '..', '..');
  const originalReadFileSync = fs.readFileSync.bind(fs);
  const originalReadFile = fs.readFile.bind(fs);
  const assertAllowed = filePath => {
    if (typeof filePath !== 'string') return;
    const resolved = path.resolve(filePath);
    const relative = path.relative(repositoryRoot, resolved);
    const insideRepository =
      relative === '' ||
      (!relative.startsWith('..') && !path.isAbsolute(relative));
    if (insideRepository) {
      throw new Error(
        `clean_room_repository_read_forbidden:${path.basename(resolved)}`
      );
    }
  };
  fs.readFileSync = (filePath, ...args) => {
    assertAllowed(filePath);
    return originalReadFileSync(filePath, ...args);
  };
  fs.readFile = (filePath, ...args) => {
    assertAllowed(filePath);
    return originalReadFile(filePath, ...args);
  };
  return () => {
    fs.readFileSync = originalReadFileSync;
    fs.readFile = originalReadFile;
  };
};

const connect = label =>
  connectLiveGDevelopMcp({
    clientId: `gdevelop-dx41-${label}`,
    agentId: 'dx41-persistence-agent',
    sessionId: `dx41-${label}`,
    taskId: 'dx41-project-persistence',
  });

const run = async ({
  label = 'live',
  evidencePath: requestedEvidencePath = null,
} = {}) => {
  const restoreRepositoryReads = installRepositoryReadGuard();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gdevelop-dx41-'));
  const savePath = path.join(tempDir, 'DX41Persistence.json');
  const evidencePath =
    requestedEvidencePath ||
    path.join(
      os.tmpdir(),
      `gdevelop-dx41-persistence-${label}-${process.pid}.json`
    );
  let session = null;
  let transactionId = null;

  try {
    session = await connect(label);
    const initial = await callOk(session, 'project.status', {});
    assert(
      !initial.data || initial.data.projectOpen === false,
      'dx41_requires_fresh_editor_without_open_project'
    );

    await callOk(session, 'project.create', { name: PROJECT_NAME });
    await session.close();
    session = await connect(label);

    const tools = await session.listTools();
    [
      'project.status',
      'project.save-as',
      'project.save',
      'project.persistence.status',
      'project.persistence.verify',
      'project.reload',
      'editor.functions.create-scene',
      'safety.transactions.begin',
      'safety.transactions.rollback',
      'validation.run',
    ].forEach(name => findTool(tools, name));

    const saveAs = await callOk(session, 'project.save-as', {
      filePath: savePath,
      name: PROJECT_NAME,
    });
    assert(saveAs.data && saveAs.data.saved === true, 'initial_save_as_failed');
    assert(fs.existsSync(savePath), 'initial_project_file_missing');

    let persistence = await callOk(session, 'project.persistence.status', {});
    assert(
      persistence.data &&
        persistence.data.hasUnsavedChanges === false &&
        persistence.data.persisted &&
        persistence.data.persisted.serializedHash &&
        persistence.data.persisted.externalModificationDetected === false,
      'initial_persistence_status_invalid'
    );
    assert(
      persistence.data.generatedState &&
        persistence.data.generatedState.export &&
        persistence.data.generatedState.export.relationToPersistence ===
          'independent-generated-output',
      'generated_state_not_distinguished'
    );

    const projectId = persistence.data.projectId;
    const fileIdentifier = persistence.data.fileIdentifier;
    const baselinePersistedHash = persistence.data.persisted.serializedHash;
    const baselineRevision = persistence.data.currentProjectRevision;

    const created = await callOk(session, 'editor.functions.create-scene', {
      scene_name: PERSISTED_SCENE,
      is_first_scene: true,
      expectedRevision: baselineRevision,
      idempotencyKey: `dx41-create-persisted-scene-${label}`,
    });
    assert(created.data, 'persisted_scene_create_failed');

    persistence = await callOk(session, 'project.persistence.status', {
      expectedProjectId: projectId,
      expectedFileIdentifier: fileIdentifier,
    });
    assert(
      persistence.data.hasUnsavedChanges === true,
      'dirty_editor_not_reported'
    );
    assert(
      persistence.data.inMemory.serializedHash !==
        persistence.data.persisted.serializedHash,
      'dirty_memory_not_distinguished_from_persisted_disk'
    );
    assert(
      persistence.data.persisted.serializedHash === baselinePersistedHash,
      'persisted_disk_changed_before_explicit_save'
    );

    const save = await callOk(session, 'project.save', {
      expectedProjectId: projectId,
      expectedFileIdentifier: fileIdentifier,
      expectedProjectRevision: persistence.data.currentProjectRevision,
    });
    assert(save.data && save.data.saved === true, 'explicit_save_failed');
    assert(save.data.resourcesFlushed === true, 'resource_flush_not_reported');
    assert(save.data.persistedHash, 'save_missing_persisted_hash');

    const verify = await callOk(session, 'project.persistence.verify', {
      expectedProjectId: projectId,
      expectedFileIdentifier: fileIdentifier,
      expectedProjectRevision: save.data.projectRevision,
      expectedPersistedRevision: save.data.persistedRevision,
      expectedPersistedHash: save.data.persistedHash,
    });
    assert(verify.data && verify.data.verified === true, 'save_verify_failed');
    assert(
      verify.data.hasUnsavedChanges === false,
      'project_not_clean_after_save'
    );

    const reload = await callOk(session, 'project.reload', {
      expectedProjectId: projectId,
      expectedFileIdentifier: fileIdentifier,
      expectedProjectRevision: save.data.projectRevision,
      expectedPersistedHash: save.data.persistedHash,
    });
    assert(
      reload.data && reload.data.reloaded === true,
      'project_reload_failed'
    );
    assert(
      reload.data.persistedHash === save.data.persistedHash,
      'reload_hash_changed_before_reopen'
    );

    await session.close();
    session = await connect(label);

    const reopenedStatus = await callOk(session, 'project.status', {});
    assert(
      reopenedStatus.data &&
        Array.isArray(reopenedStatus.data.sceneNames) &&
        reopenedStatus.data.sceneNames.includes(PERSISTED_SCENE),
      'persisted_scene_missing_after_reload'
    );

    const afterReload = await callOk(session, 'project.persistence.status', {
      expectedProjectId: projectId,
      expectedFileIdentifier: fileIdentifier,
    });
    assert(
      afterReload.data.persisted.serializedHash === save.data.persistedHash,
      'persisted_hash_changed_after_reload'
    );
    assert(
      afterReload.data.hasUnsavedChanges === false,
      'reload_did_not_restore_clean_state'
    );

    const originalDiskBytes = fs.readFileSync(savePath, 'utf8');
    fs.writeFileSync(savePath, addExternalProbe(originalDiskBytes), 'utf8');

    const externalStatus = await callOk(session, 'project.persistence.status', {
      expectedProjectId: projectId,
      expectedFileIdentifier: fileIdentifier,
    });
    assert(
      externalStatus.data.persisted.externalModificationDetected === true,
      'external_disk_change_not_detected'
    );
    assert(
      externalStatus.data.persisted.currentMemoryMatchesDisk === false,
      'external_disk_change_still_matches_memory'
    );

    const conflict = await session.call('project.save', {
      expectedProjectId: projectId,
      expectedFileIdentifier: fileIdentifier,
      expectedProjectRevision: externalStatus.data.currentProjectRevision,
    });
    expectErrorCode(conflict, 'project_disk_conflict');

    fs.writeFileSync(savePath, originalDiskBytes, 'utf8');
    const restoredStatus = await callOk(session, 'project.persistence.status', {
      expectedProjectId: projectId,
      expectedFileIdentifier: fileIdentifier,
    });
    assert(
      restoredStatus.data.persisted.externalModificationDetected === false,
      'restored_disk_still_reported_as_external_change'
    );

    const persistedHashBeforeTransaction =
      restoredStatus.data.persisted.serializedHash;
    const begun = await callOk(session, 'safety.transactions.begin', {
      label: 'DX41 rollback-only persistence guard',
    });
    transactionId = begun.data && begun.data.transactionId;
    assert(transactionId, 'transaction_id_missing');

    await callOk(session, 'editor.functions.create-scene', {
      scene_name: ROLLBACK_SCENE,
      expectedRevision: restoredStatus.data.currentProjectRevision,
      idempotencyKey: `dx41-create-rollback-scene-${label}`,
    });

    const blockedSave = await session.call('project.save', {
      expectedProjectId: projectId,
      expectedFileIdentifier: fileIdentifier,
    });
    expectErrorCode(blockedSave, 'persistence_blocked_by_active_transaction');

    await callOk(session, 'safety.transactions.rollback', { transactionId });
    transactionId = null;
    await session.close();
    session = await connect(label);

    const afterRollback = await callOk(session, 'project.status', {});
    assert(
      !afterRollback.data.sceneNames.includes(ROLLBACK_SCENE),
      'rollback_only_scene_survived_rollback'
    );
    assert(
      afterRollback.data.sceneNames.includes(PERSISTED_SCENE),
      'persisted_scene_lost_after_rollback'
    );

    const afterRollbackPersistence = await callOk(
      session,
      'project.persistence.status',
      {
        expectedProjectId: projectId,
        expectedFileIdentifier: fileIdentifier,
      }
    );
    assert(
      afterRollbackPersistence.data.persisted.serializedHash ===
        persistedHashBeforeTransaction,
      'rollback_changed_persisted_project_hash'
    );
    assert(
      afterRollbackPersistence.data.hasUnsavedChanges === false,
      'rollback_did_not_restore_clean_state'
    );

    const validation = await callOk(session, 'validation.run', {
      includeNativeReport: true,
      includeAssets: true,
      includeRuntimeLogs: false,
    });
    const validationErrors =
      validation.data &&
      validation.data.summary &&
      Number.isInteger(validation.data.summary.diagnosticErrors)
        ? validation.data.summary.diagnosticErrors
        : validation.data &&
          validation.data.diagnostics &&
          validation.data.diagnostics.summary &&
          Number.isInteger(validation.data.diagnostics.summary.errors)
        ? validation.data.diagnostics.summary.errors
        : 0;
    assert(validationErrors === 0, 'dx41_validation_has_errors');

    const evidence = sanitizeForReplay({
      kind: 'dx41-project-persistence-acceptance',
      label,
      generatedAt: new Date().toISOString(),
      protocolVersion: session.protocolVersion,
      cleanRoom: {
        repositoryImplementationOrTestsReadDuringScenario: false,
        repositoryReadGuard: true,
        authoringInputSource: 'live MCP discovery and reads',
      },
      discovery: {
        toolCount: tools.length,
        persistenceStatusPublished: true,
        persistenceVerifyPublished: true,
        reloadPublished: true,
      },
      dirtyVsPersisted: {
        baselinePersistedHash,
        dirtyDetected: true,
        memoryDiffersFromPersisted: true,
        diskUnchangedBeforeExplicitSave: true,
      },
      saveReloadVerification: {
        persistedHash: save.data.persistedHash,
        persistedRevision: save.data.persistedRevision,
        verifyPassed: true,
        reloadPassed: true,
        sceneSurvivedReload: true,
        resourcesFlushed: save.data.resourcesFlushed,
      },
      externalDiskConflict: {
        detected: true,
        saveRejected: true,
        errorCode: 'project_disk_conflict',
        restoredBaseline: true,
      },
      transactionPersistenceGuard: {
        saveBlockedInsideTransaction: true,
        errorCode: 'persistence_blocked_by_active_transaction',
        rollbackRestoredMemory: true,
        persistedHashUnchanged: true,
      },
      generatedState: afterReload.data.generatedState,
      validation: {
        errors: validationErrors,
        summary: validation.data && validation.data.summary,
      },
    });

    fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          label,
          evidencePath,
          protocolVersion: session.protocolVersion,
          toolCount: tools.length,
          persistedHash: save.data.persistedHash,
          validationErrors,
          reloadVerified: true,
          externalConflictRejected: true,
          transactionSaveBlocked: true,
        },
        null,
        2
      )}\n`
    );
    return evidence;
  } finally {
    if (transactionId && session) {
      try {
        await session.call('safety.transactions.rollback', { transactionId });
      } catch (_) {}
    }
    if (session) {
      try {
        await session.call('project.close', { discardUnsavedChanges: true });
      } catch (_) {}
      try {
        await session.close();
      } catch (_) {}
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
    restoreRepositoryReads();
  }
};

if (require.main === module) {
  const options = parseArgs(process.argv.slice(2));
  run(options).catch(error => {
    console.error(error && error.stack ? error.stack : String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  addExternalProbe,
  parseArgs,
  run,
};
