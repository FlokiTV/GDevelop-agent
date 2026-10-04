const fs = require('fs');
const os = require('os');
const path = require('path');
const { connectLiveGDevelopMcp, sanitizeForReplay } = require('./McpClient');

const REQUIRED_TOOLS = [
  'project.status',
  'project.create',
  'project.save-as',
  'project.close',
  'events.instructions.search',
  'events.read',
  'events.insert',
  'diagnostics.capabilities',
  'diagnostics.query',
  'validation.run',
  'safety.transactions.begin',
  'safety.transactions.rollback',
];

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const getData = result =>
  result && result.data
    ? result.data
    : result && result.structuredContent && result.structuredContent.data
    ? result.structuredContent.data
    : result && result.structuredContent
    ? result.structuredContent
    : null;

const extractError = result =>
  result && result.structuredContent && result.structuredContent.error
    ? result.structuredContent.error
    : result && result.data && result.data.error
    ? result.data.error
    : null;

const revisionOf = result => {
  const data = getData(result);
  const revision =
    result && result.meta && Number.isInteger(result.meta.projectRevision)
      ? result.meta.projectRevision
      : result &&
        result.structuredContent &&
        result.structuredContent.meta &&
        Number.isInteger(result.structuredContent.meta.projectRevision)
      ? result.structuredContent.meta.projectRevision
      : data && Number.isInteger(data.projectRevision)
      ? data.projectRevision
      : null;
  assert(Number.isInteger(revision), 'dx39_missing_project_revision');
  return revision;
};

const validationErrorCount = validation =>
  validation && Array.isArray(validation.errors)
    ? validation.errors.length
    : validation && Number.isInteger(validation.errorCount)
    ? validation.errorCount
    : validation &&
      validation.summary &&
      Number.isInteger(validation.summary.diagnosticErrors)
    ? validation.summary.diagnosticErrors
    : validation &&
      validation.diagnostics &&
      validation.diagnostics.summary &&
      Number.isInteger(validation.diagnostics.summary.errors)
    ? validation.diagnostics.summary.errors
    : 0;

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
        'dx39_clean_room_repository_read_forbidden:' + path.basename(resolved)
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

const run = async ({
  label = 'live',
  evidencePath = path.join(
    os.tmpdir(),
    'gdevelop-dx39-static-diagnostics-' + process.pid + '.json'
  ),
} = {}) => {
  const rootDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gdevelop-dx39-static-diagnostics-')
  );
  const projectDir = path.join(rootDir, 'project');
  const projectFile = path.join(projectDir, 'game.json');
  fs.mkdirSync(projectDir, { recursive: true });

  const restoreRepositoryReads = installRepositoryReadGuard();
  let session = null;
  let transactionId = null;
  let projectOpen = false;
  const replay = [];

  const record = (name, args, result) => {
    replay.push(
      sanitizeForReplay({
        name,
        args,
        result: result.structuredContent || result.data || result.content,
      })
    );
  };

  const call = async (name, args = {}, { allowError = false } = {}) => {
    const result = await session.call(name, args);
    record(name, args, result);
    if (result.isError && !allowError) {
      const error = extractError(result);
      throw new Error(
        'dx39_tool_failed:' +
          name +
          ':' +
          (error && error.code ? error.code : 'unknown')
      );
    }
    return result;
  };

  const mutate = async (name, args = {}) => {
    const revision = revisionOf(await call('project.status'));
    const result = await call(name, {
      ...args,
      expectedRevision: revision,
      idempotencyKey: 'dx39-' + name + '-' + revision + '-' + replay.length,
    });
    if (transactionId) {
      const meta =
        result.meta ||
        (result.structuredContent && result.structuredContent.meta) ||
        null;
      assert(
        meta && meta.transactionId === transactionId,
        'dx39_transaction_metadata_missing:' + name
      );
    }
    return result;
  };

  try {
    session = await connectLiveGDevelopMcp({
      clientId: 'gdevelop-dx39-static-diagnostics-' + label,
      confirmDestructiveOperations: true,
    });

    const tools = await session.listTools();
    for (const name of REQUIRED_TOOLS) {
      assert(
        tools.some(tool => tool.name === name),
        'dx39_missing_tool:' + name
      );
    }

    const initialStatus = getData(await call('project.status'));
    assert(
      !initialStatus || initialStatus.projectOpen !== true,
      'dx39_requires_fresh_editor'
    );

    await call('project.create', {
      name: 'DX39 Static Diagnostics Acceptance',
      idempotencyKey: 'dx39-create-project',
    });
    projectOpen = true;
    await call('project.save-as', {
      filePath: projectFile,
      name: 'DX39 Static Diagnostics Acceptance',
    });

    const statusAfterCreateResult = await call('project.status');
    const statusAfterCreate = getData(statusAfterCreateResult);
    const sceneName =
      statusAfterCreate &&
      Array.isArray(statusAfterCreate.sceneNames) &&
      statusAfterCreate.sceneNames[0];
    assert(sceneName, 'dx39_scene_missing');

    const capabilities = getData(await call('diagnostics.capabilities'));
    assert(
      capabilities &&
        capabilities.domain === 'static-editor-project' &&
        capabilities.excludesRuntimeDiagnostics === true &&
        capabilities.sourceMapping &&
        capabilities.sourceMapping.stableEventHandles === true &&
        capabilities.sourceMapping.stableInstructionHandles === true &&
        capabilities.sourceMapping.parameterIndexAndPath === true &&
        capabilities.incremental &&
        capabilities.incremental.sinceProjectRevisionShortCircuit === true,
      'dx39_capabilities_invalid'
    );

    const cleanBefore = getData(
      await call('diagnostics.query', {
        includeNativeReport: false,
        includeAssets: false,
      })
    );
    assert(cleanBefore, 'dx39_clean_before_missing');
    assert(
      cleanBefore.summary &&
        cleanBefore.summary.errors === 0 &&
        cleanBefore.summary.warnings === 0 &&
        cleanBefore.summary.clean === true &&
        Array.isArray(cleanBefore.diagnostics) &&
        cleanBefore.diagnostics.length === 0,
      'dx39_clean_before_not_explicit'
    );
    assert(
      cleanBefore.snapshot &&
        Number.isInteger(cleanBefore.snapshot.projectRevision),
      'dx39_clean_snapshot_missing'
    );

    const unchanged = getData(
      await call('diagnostics.query', {
        sinceProjectRevision: cleanBefore.snapshot.projectRevision,
        includeNativeReport: false,
        includeAssets: false,
      })
    );
    assert(
      unchanged &&
        unchanged.unchanged === true &&
        unchanged.summary &&
        unchanged.summary.notModified === true &&
        unchanged.summary.returned === 0 &&
        Array.isArray(unchanged.diagnostics) &&
        unchanged.diagnostics.length === 0,
      'dx39_incremental_short_circuit_failed'
    );

    const begun = getData(
      await call('safety.transactions.begin', {
        label: 'DX-39 static diagnostics acceptance',
      })
    );
    transactionId = begun && begun.transactionId;
    assert(transactionId, 'dx39_transaction_missing');

    const search = getData(
      await call('events.instructions.search', {
        kind: 'action',
        query: 'SetX',
        deprecated: 'include',
        includeHidden: true,
        limit: 100,
      })
    );
    const setX = (search.items || []).find(
      item =>
        item.id === 'SetX' &&
        (item.parameters || []).some(
          parameter => parameter.valueType && parameter.valueType.object
        )
    );
    assert(setX, 'dx39_setx_not_discovered');

    const objectParameter = (setX.parameters || []).find(
      parameter => parameter.valueType && parameter.valueType.object
    );
    assert(
      objectParameter && Number.isInteger(objectParameter.index),
      'dx39_object_parameter_metadata_missing'
    );

    const missingObjectName = 'DX39MissingObject';
    const eventsBefore = getData(await call('events.read', { sceneName }));
    const parameters = [];
    const maxParameterIndex = Math.max(
      objectParameter.index,
      ...(setX.parameters || [])
        .map(parameter => parameter.index)
        .filter(Number.isInteger)
    );
    for (let index = 0; index <= maxParameterIndex; index++) {
      parameters[index] = '';
    }
    parameters[objectParameter.index] = missingObjectName;
    if (parameters.length > 1 && parameters[1] === '') parameters[1] = '=';
    if (parameters.length > 2 && parameters[2] === '') parameters[2] = '10';

    await mutate('events.insert', {
      sceneName,
      expectedEventsRevision: eventsBefore.eventsRevision,
      eventsJson: [
        {
          type: 'BuiltinCommonInstructions::Standard',
          conditions: [],
          actions: [
            {
              type: { value: setX.id },
              parameters,
              subInstructions: [],
            },
          ],
          events: [],
        },
      ],
    });

    const invalidQuery = getData(
      await call('diagnostics.query', {
        includeNativeReport: false,
        includeAssets: false,
        sceneName,
        codes: ['invalid-parameter'],
        severities: ['error'],
      })
    );
    assert(
      invalidQuery &&
        invalidQuery.summary &&
        invalidQuery.summary.errors >= 1 &&
        invalidQuery.diagnostics.length >= 1,
      'dx39_invalid_parameter_diagnostic_missing'
    );

    const diagnostic = invalidQuery.diagnostics.find(
      item =>
        item.code === 'invalid-parameter' &&
        item.primaryLocation &&
        item.primaryLocation.field &&
        item.primaryLocation.field.parameterIndex === objectParameter.index &&
        item.primaryLocation.field.value === missingObjectName
    );
    assert(diagnostic, 'dx39_target_diagnostic_missing');
    assert(
      typeof diagnostic.diagnosticId === 'string' &&
        diagnostic.diagnosticId.startsWith('diagnostic:'),
      'dx39_stable_diagnostic_id_missing'
    );
    assert(
      diagnostic.domain === 'static-editor-project' &&
        diagnostic.primaryLocation.scope &&
        diagnostic.primaryLocation.scope.kind === 'scene' &&
        diagnostic.primaryLocation.scope.name === sceneName &&
        diagnostic.primaryLocation.scope.selector &&
        diagnostic.primaryLocation.event &&
        diagnostic.primaryLocation.event.handle &&
        diagnostic.primaryLocation.instruction &&
        diagnostic.primaryLocation.instruction.handle &&
        diagnostic.primaryLocation.field.path ===
          'parameters[' + objectParameter.index + ']' &&
        diagnostic.primaryLocation.mapping &&
        diagnostic.primaryLocation.mapping.exactInstruction === true,
      'dx39_exact_event_source_mapping_missing'
    );
    assert(
      diagnostic.suggestedAction &&
        diagnostic.suggestedAction.safeAutomaticFix === false &&
        diagnostic.suggestedAction.tool === 'events.patch' &&
        diagnostic.suggestedAction.inputHint &&
        diagnostic.suggestedAction.inputHint.operation &&
        diagnostic.suggestedAction.inputHint.operation.kind ===
          'instruction.parameter.update' &&
        diagnostic.suggestedAction.inputHint.operation.instructionHandle ===
          diagnostic.primaryLocation.instruction.handle &&
        diagnostic.suggestedAction.inputHint.operation.parameterIndex ===
          objectParameter.index,
      'dx39_actionable_target_metadata_invalid'
    );

    const unresolved = (diagnostic.relatedLocations || []).find(
      location =>
        location.relation === 'unresolved-referenced-entity' &&
        location.entity &&
        location.entity.name === missingObjectName
    );
    assert(
      unresolved &&
        unresolved.entity.kind === 'object-definition' &&
        unresolved.entity.resolved === false &&
        unresolved.entity.selector === null,
      'dx39_broken_reference_related_target_missing'
    );

    const stableRepeat = getData(
      await call('diagnostics.query', {
        includeNativeReport: false,
        includeAssets: false,
        sceneName,
        codes: ['invalid-parameter'],
      })
    );
    const repeatedDiagnostic = (stableRepeat.diagnostics || []).find(
      item =>
        item.primaryLocation &&
        item.primaryLocation.field &&
        item.primaryLocation.field.value === missingObjectName
    );
    assert(
      repeatedDiagnostic &&
        repeatedDiagnostic.diagnosticId === diagnostic.diagnosticId &&
        repeatedDiagnostic.primaryLocation.instruction.handle ===
          diagnostic.primaryLocation.instruction.handle,
      'dx39_diagnostic_identity_not_stable'
    );

    const validationWhileInvalid = getData(
      await call('validation.run', {
        includeNativeReport: false,
        includeAssets: false,
      })
    );
    assert(
      validationErrorCount(validationWhileInvalid) >= 1,
      'dx39_aggregate_validation_did_not_see_invalid_parameter'
    );

    const rollback = getData(
      await call('safety.transactions.rollback', { transactionId })
    );
    assert(
      rollback && rollback.rolledBack !== false,
      'dx39_transaction_rollback_failed'
    );
    transactionId = null;

    const cleanAfter = getData(
      await call('diagnostics.query', {
        includeNativeReport: false,
        includeAssets: false,
      })
    );
    assert(
      cleanAfter &&
        cleanAfter.summary &&
        cleanAfter.summary.errors === 0 &&
        cleanAfter.summary.warnings === 0 &&
        cleanAfter.summary.clean === true &&
        Array.isArray(cleanAfter.diagnostics) &&
        cleanAfter.diagnostics.length === 0,
      'dx39_clean_after_rollback_not_explicit'
    );

    await call('project.close', { discardUnsavedChanges: false });
    projectOpen = false;

    const evidence = {
      label,
      protocolVersion: session.protocolVersion,
      sceneName,
      capabilities: {
        domain: capabilities.domain,
        excludesRuntimeDiagnostics: capabilities.excludesRuntimeDiagnostics,
        stableEventHandles:
          capabilities.sourceMapping.stableEventHandles,
        stableInstructionHandles:
          capabilities.sourceMapping.stableInstructionHandles,
        parameterIndexAndPath:
          capabilities.sourceMapping.parameterIndexAndPath,
        incrementalShortCircuit:
          capabilities.incremental.sinceProjectRevisionShortCircuit,
      },
      cleanBefore: {
        errors: cleanBefore.summary.errors,
        warnings: cleanBefore.summary.warnings,
        clean: cleanBefore.summary.clean,
        diagnosticCount: cleanBefore.diagnostics.length,
        projectRevision: cleanBefore.snapshot.projectRevision,
      },
      incrementalUnchanged: unchanged.unchanged,
      invalidDiagnostic: {
        diagnosticId: diagnostic.diagnosticId,
        severity: diagnostic.severity,
        code: diagnostic.code,
        scopeSelector: diagnostic.primaryLocation.scope.selector,
        eventHandle: diagnostic.primaryLocation.event.handle,
        instructionHandle: diagnostic.primaryLocation.instruction.handle,
        parameterIndex: diagnostic.primaryLocation.field.parameterIndex,
        fieldPath: diagnostic.primaryLocation.field.path,
        missingTargetName: unresolved.entity.name,
        missingTargetKind: unresolved.entity.kind,
        missingTargetResolved: unresolved.entity.resolved,
        suggestedTool: diagnostic.suggestedAction.tool,
        safeAutomaticFix: diagnostic.suggestedAction.safeAutomaticFix,
      },
      stableDiagnosticIdentity:
        repeatedDiagnostic.diagnosticId === diagnostic.diagnosticId,
      aggregateValidationErrorsWhileInvalid: validationErrorCount(
        validationWhileInvalid
      ),
      cleanAfterRollback: {
        errors: cleanAfter.summary.errors,
        warnings: cleanAfter.summary.warnings,
        clean: cleanAfter.summary.clean,
        diagnosticCount: cleanAfter.diagnostics.length,
      },
      transactionRollbackClean: true,
      replay,
    };

    fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    return { evidencePath, evidence };
  } finally {
    try {
      if (session) {
        if (transactionId) {
          try {
            await session.call('safety.transactions.rollback', {
              transactionId,
            });
          } catch (_) {}
        }
        if (projectOpen) {
          try {
            await session.call('project.close', {
              discardUnsavedChanges: true,
            });
          } catch (_) {}
        }
        await session.close();
      }
    } finally {
      restoreRepositoryReads();
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  }
};

module.exports = {
  REQUIRED_TOOLS,
  run,
};
