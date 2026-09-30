const fs = require('fs');
const os = require('os');
const path = require('path');
const { connectLiveGDevelopMcp, sanitizeForReplay } = require('./McpClient');

const REQUIRED_TOOLS = [
  'project.status',
  'project.create',
  'project.save-as',
  'project.close',
  'project.persistence.status',
  'editor.types.objects.list',
  'editor.types.objects.describe',
  'editor.functions.create-scene',
  'objects.definitions.list',
  'objects.definitions.get',
  'objects.definitions.usages',
  'objects.definitions.create',
  'objects.definitions.duplicate',
  'objects.definitions.rename',
  'objects.definitions.delete',
  'objects.definitions.move-scope',
  'objects.groups.create',
  'objects.groups.get',
  'objects.groups.members.add',
  'scene.instances.create',
  'scene.instances.get',
  'events.read',
  'events.insert',
  'events.instructions.search',
  'validation.run',
  'safety.transactions.begin',
  'safety.transactions.rollback',
];

const wait = milliseconds =>
  new Promise(resolve => setTimeout(resolve, milliseconds));

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

const getRevision = result => {
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
      : data && Number.isInteger(data.currentProjectRevision)
      ? data.currentProjectRevision
      : null;
  assert(Number.isInteger(revision), 'dx34_missing_project_revision');
  return revision;
};

const extractError = result =>
  result && result.structuredContent && result.structuredContent.error
    ? result.structuredContent.error
    : result && result.data && result.data.error
    ? result.data.error
    : null;

const findTool = (tools, name) => {
  const tool = tools.find(candidate => candidate.name === name);
  assert(tool, 'dx34_missing_tool:' + name);
  return tool;
};

const assertDefinitionToolSchemas = tools => {
  REQUIRED_TOOLS.forEach(name => findTool(tools, name));
  const create = findTool(tools, 'objects.definitions.create');
  const remove = findTool(tools, 'objects.definitions.delete');
  const move = findTool(tools, 'objects.definitions.move-scope');
  assert(
    create.inputSchema &&
      create.inputSchema.properties &&
      create.inputSchema.properties.objectType &&
      create.inputSchema.properties.initialProperties,
    'dx34_create_schema_missing'
  );
  assert(
    remove.inputSchema &&
      remove.inputSchema.properties &&
      remove.inputSchema.properties.dryRun &&
      remove.inputSchema.properties.dryRun.default === true,
    'dx34_delete_not_dry_run'
  );
  assert(
    move.inputSchema &&
      move.inputSchema.properties &&
      move.inputSchema.properties.dryRun &&
      move.inputSchema.properties.dryRun.default === true,
    'dx34_move_not_dry_run'
  );
};

const chooseSpriteType = items =>
  (Array.isArray(items) ? items : []).find(item => item.type === 'Sprite') ||
  (Array.isArray(items) ? items : []).find(item =>
    /sprite/i.test(
      [item.type, item.name, item.fullName].filter(Boolean).join(' ')
    )
  ) ||
  null;

const validationErrorCount = validation =>
  validation && Array.isArray(validation.errors)
    ? validation.errors.length
    : validation && Number.isInteger(validation.errorCount)
    ? validation.errorCount
    : validation &&
      validation.summary &&
      Number.isInteger(validation.summary.errors)
    ? validation.summary.errors
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
        'dx34_clean_room_repository_read_forbidden:' + path.basename(resolved)
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
    `gdevelop-dx34-object-definitions-${process.pid}.json`
  ),
} = {}) => {
  const rootDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gdevelop-dx34-object-definitions-')
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

  const connect = async suffix =>
    connectLiveGDevelopMcp({
      clientId: `gdevelop-dx34-object-definitions-${label}-${suffix}`,
      confirmDestructiveOperations: true,
    });

  const call = async (name, args = {}, { allowError = false } = {}) => {
    const result = await session.call(name, args);
    record(name, args, result);
    if (result.isError && !allowError) {
      const error = extractError(result);
      throw new Error(
        `dx34_tool_failed:${name}:${
          error && error.code ? error.code : 'unknown'
        }`
      );
    }
    return result;
  };

  const mutate = async (name, args = {}) => {
    const revision = getRevision(await call('project.status'));
    const result = await call(name, {
      ...args,
      expectedRevision: revision,
      idempotencyKey: `dx34-${name}-${revision}-${replay.length}`,
    });
    if (transactionId) {
      const meta =
        result.meta ||
        (result.structuredContent && result.structuredContent.meta) ||
        null;
      assert(
        meta && meta.transactionId === transactionId,
        `dx34_transaction_metadata_missing:${name}`
      );
    }
    return result;
  };

  const isOwnedStaleProject = status => {
    if (
      !status ||
      status.projectOpen !== true ||
      status.projectName !== 'DX34 Object Definitions Acceptance' ||
      status.hasUnsavedChanges !== false ||
      typeof status.fileIdentifier !== 'string'
    ) {
      return false;
    }
    const normalizedFile = path.resolve(status.fileIdentifier);
    const relative = path.relative(path.resolve(os.tmpdir()), normalizedFile);
    return (
      relative !== '' &&
      !relative.startsWith('..') &&
      !path.isAbsolute(relative) &&
      /(?:^|[\\/])gdevelop-dx34-object-definitions-[^\\/]+[\\/]project[\\/]game\.json$/i.test(
        normalizedFile
      )
    );
  };

  const ensureFreshEditor = async () => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const status = getData(await call('project.status'));
      if (!status || status.projectOpen !== true) return;
      if (!isOwnedStaleProject(status)) {
        throw new Error(
          `dx34_requires_fresh_editor:${JSON.stringify({
            fileIdentifier: status.fileIdentifier,
            projectName: status.projectName,
            hasUnsavedChanges: status.hasUnsavedChanges,
          })}`
        );
      }
      await call('project.close', { discardUnsavedChanges: false });
      await wait(250);
    }
    throw new Error('dx34_stale_project_cleanup_exhausted');
  };

  try {
    session = await connect('initial');
    const tools = await session.listTools();
    assertDefinitionToolSchemas(tools);
    await ensureFreshEditor();

    await call('project.create', {
      name: 'DX34 Object Definitions Acceptance',
      idempotencyKey: 'dx34-create-project',
    });
    projectOpen = true;
    await wait(300);
    await call('project.save-as', {
      filePath: projectFile,
      name: 'DX34 Object Definitions Acceptance',
    });

    const baselinePersistence = getData(
      await call('project.persistence.status')
    );
    assert(
      baselinePersistence &&
        baselinePersistence.persisted &&
        baselinePersistence.persisted.serializedHash,
      'dx34_baseline_persisted_hash_missing'
    );
    const baselinePersistedHash = baselinePersistence.persisted.serializedHash;

    const begun = getData(
      await call('safety.transactions.begin', {
        label: 'DX-34 object definitions MCP-only acceptance',
      })
    );
    transactionId = begun && begun.transactionId;
    assert(transactionId, 'dx34_transaction_missing');

    const suffix = Date.now().toString(36);
    const sceneName = `DX34Scene${suffix}`;
    const objectName = `DX34Hero${suffix}`;
    const duplicateName = `DX34HeroCopy${suffix}`;
    const renamedName = `DX34HeroRenamed${suffix}`;
    const groupName = `DX34Actors${suffix}`;

    await mutate('editor.functions.create-scene', { scene_name: sceneName });

    const types = getData(
      await call('editor.types.objects.list', {
        query: 'sprite',
        deprecated: 'include',
        renderingMode: '2d',
        limit: 100,
      })
    );
    const spriteType = chooseSpriteType(types && types.items);
    assert(spriteType, 'dx34_sprite_type_not_discovered');

    const typeDescription = getData(
      await call('editor.types.objects.describe', { type: spriteType.type })
    );
    assert(
      typeDescription &&
        typeDescription.item &&
        typeDescription.item.creationSchema &&
        Array.isArray(typeDescription.item.supportedBehaviors) &&
        Array.isArray(typeDescription.item.supportedCapabilities),
      'dx34_type_authoring_metadata_missing'
    );

    const created = getData(
      await mutate('objects.definitions.create', {
        objectName,
        objectType: spriteType.type,
        objectScope: 'scene',
        sceneName,
      })
    );
    assert(created && created.created, 'dx34_object_create_failed');
    const objectId = created.object.identity.objectId;
    assert(objectId, 'dx34_object_id_missing');

    const duplicated = getData(
      await mutate('objects.definitions.duplicate', {
        objectId,
        newObjectName: duplicateName,
      })
    );
    assert(
      duplicated &&
        duplicated.duplicated &&
        duplicated.object.identity.objectId !== objectId,
      'dx34_object_duplicate_failed'
    );
    const duplicateId = duplicated.object.identity.objectId;

    await mutate('objects.definitions.delete', {
      objectId: duplicateId,
      dryRun: false,
    });

    await mutate('objects.groups.create', {
      groupName,
      groupScope: 'scene',
      sceneName,
    });
    await mutate('objects.groups.members.add', {
      groupName,
      groupScope: 'scene',
      sceneName,
      objectName,
    });

    const instance = getData(
      await mutate('scene.instances.create', {
        sceneName,
        objectName,
        position: { x: 64, y: 96 },
      })
    );
    assert(instance && instance.created, 'dx34_instance_create_failed');
    const instanceId =
      instance.instance &&
      (instance.instance.instanceId ||
        (instance.instance.identity && instance.instance.identity.instanceId));
    assert(instanceId, 'dx34_instance_id_missing');

    const search = getData(
      await call('events.instructions.search', {
        kind: 'action',
        query: 'SetX',
        deprecated: 'include',
        includeHidden: true,
        limit: 100,
      })
    );
    const setX = (search && search.items ? search.items : []).find(
      item =>
        item.id === 'SetX' &&
        (item.parameters || []).some(
          parameter => parameter.valueType && parameter.valueType.object
        )
    );
    assert(setX, 'dx34_setx_not_discovered');

    let events = getData(await call('events.read', { sceneName }));
    await mutate('events.insert', {
      sceneName,
      expectedEventsRevision: events.eventsRevision,
      eventsJson: [
        {
          type: 'BuiltinCommonInstructions::Standard',
          conditions: [],
          actions: [
            {
              type: { value: setX.id },
              parameters: [objectName, '=', '10'],
              subInstructions: [],
            },
          ],
          events: [],
        },
      ],
    });

    const usages = getData(
      await call('objects.definitions.usages', { objectId })
    );
    assert(
      usages &&
        usages.counts.instances === 1 &&
        usages.counts.groups === 1 &&
        usages.counts.authoritativeEventReferences === 1,
      'dx34_usage_mapping_failed'
    );

    const renamed = getData(
      await mutate('objects.definitions.rename', {
        objectId,
        newObjectName: renamedName,
      })
    );
    assert(
      renamed &&
        renamed.renamed &&
        renamed.objectId === objectId &&
        renamed.nativeRefactor,
      'dx34_object_rename_failed'
    );

    const groupAfterRename = getData(
      await call('objects.groups.get', {
        groupName,
        groupScope: 'scene',
        sceneName,
      })
    );
    assert(
      groupAfterRename &&
        groupAfterRename.group.members.some(
          member => member.objectName === renamedName
        ),
      'dx34_group_reference_not_refactored'
    );

    const instanceAfterRename = getData(
      await call('scene.instances.get', { sceneName, instanceId })
    );
    assert(
      instanceAfterRename &&
        instanceAfterRename.instance.objectName === renamedName,
      'dx34_instance_reference_not_refactored'
    );

    events = getData(await call('events.read', { sceneName }));
    const authoredEvent = (events.events || []).find(
      event =>
        event.actions && event.actions.some(action => action.type === setX.id)
    );
    assert(authoredEvent, 'dx34_authored_event_missing');
    const authoredAction = authoredEvent.actions.find(
      action => action.type === setX.id
    );
    assert(
      authoredAction.parameters[0] === renamedName,
      'dx34_event_reference_not_refactored'
    );

    const revisionBeforeDeletePlan = getRevision(await call('project.status'));
    const deletePlan = getData(
      await call('objects.definitions.delete', { objectId })
    );
    assert(
      deletePlan &&
        deletePlan.deleted === false &&
        deletePlan.plan.blockers.some(
          blocker => blocker.code === 'object_definition_has_instances'
        ) &&
        deletePlan.plan.blockers.some(
          blocker => blocker.code === 'object_definition_in_groups'
        ) &&
        deletePlan.plan.blockers.some(
          blocker => blocker.code === 'object_definition_referenced_by_events'
        ),
      'dx34_delete_plan_missing_blockers'
    );
    assert(
      getRevision(await call('project.status')) === revisionBeforeDeletePlan,
      'dx34_delete_dry_run_changed_revision'
    );

    const blocked = await call(
      'objects.definitions.delete',
      {
        objectId,
        dryRun: false,
        expectedRevision: revisionBeforeDeletePlan,
        idempotencyKey: `dx34-delete-blocked-${suffix}`,
      },
      { allowError: true }
    );
    const blockedError = extractError(blocked);
    assert(
      blocked.isError === true &&
        blockedError &&
        blockedError.code === 'object_definition_delete_blocked',
      'dx34_in_use_delete_not_blocked'
    );

    const listed = getData(
      await call('objects.definitions.list', {
        objectScope: 'scene',
        sceneName,
      })
    );
    assert(
      listed &&
        listed.items.some(
          item =>
            item.identity.objectId === objectId && item.name === renamedName
        ),
      'dx34_list_missing_renamed_object'
    );

    const validation = getData(
      await call('validation.run', {
        includeNativeReport: false,
        includeAssets: true,
      })
    );
    const validationErrors = validationErrorCount(validation);
    assert(validationErrors === 0, 'dx34_validation_has_errors');

    const evidence = sanitizeForReplay({
      kind: 'dx34-object-definitions-clean-room',
      generatedAt: new Date().toISOString(),
      protocolVersion: session.protocolVersion,
      cleanRoom: {
        repositoryImplementationOrTestsReadDuringScenario: false,
        repositoryReadGuard: true,
        authoringInputSource: 'live MCP discovery and public tools',
      },
      sceneName,
      objectType: spriteType.type,
      objectId,
      instanceId,
      creationSchemaDiscovered: true,
      duplicateFreshIdentity: true,
      usageMapped: true,
      nativeRenameRefactor: true,
      inUseDeleteBlocked: true,
      validationErrors,
      replay,
    });
    fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));

    await call('safety.transactions.rollback', { transactionId });
    transactionId = null;
    await session.close();
    session = await connect('after-rollback');

    const afterRollbackStatus = getData(await call('project.status'));
    assert(
      afterRollbackStatus &&
        Array.isArray(afterRollbackStatus.sceneNames) &&
        !afterRollbackStatus.sceneNames.includes(sceneName),
      'dx34_transaction_rollback_scene_survived'
    );
    const afterRollbackPersistence = getData(
      await call('project.persistence.status')
    );
    assert(
      afterRollbackPersistence &&
        afterRollbackPersistence.persisted &&
        afterRollbackPersistence.persisted.serializedHash ===
          baselinePersistedHash &&
        afterRollbackPersistence.hasUnsavedChanges === false,
      'dx34_transaction_rollback_not_clean'
    );

    await call('project.close', { discardUnsavedChanges: false });
    projectOpen = false;
    await session.close();
    session = null;
    fs.rmSync(rootDir, { recursive: true, force: true });

    return {
      ok: true,
      protocolVersion: evidence.protocolVersion,
      objectType: evidence.objectType,
      objectId: evidence.objectId,
      instanceId: evidence.instanceId,
      creationSchemaDiscovered: true,
      duplicateFreshIdentity: true,
      usageMapped: true,
      nativeRenameRefactor: true,
      inUseDeleteBlocked: true,
      validationErrors,
      transactionRollbackClean: true,
      evidencePath,
    };
  } finally {
    try {
      if (session && transactionId) {
        await session.call('safety.transactions.rollback', { transactionId });
      }
    } catch (_) {}
    try {
      if (session && projectOpen) {
        await session.call('project.close', { discardUnsavedChanges: true });
      }
    } catch (_) {}
    try {
      if (session) await session.close();
    } catch (_) {}
    fs.rmSync(rootDir, { recursive: true, force: true });
    restoreRepositoryReads();
  }
};

if (require.main === module) {
  let label = 'live';
  let evidencePath;
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--label') label = args[++index];
    else if (args[index] === '--evidence') evidencePath = args[++index];
    else throw new Error('unknown_argument:' + args[index]);
  }
  run({ label, ...(evidencePath ? { evidencePath } : {}) })
    .then(result => {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    })
    .catch(error => {
      process.stderr.write(
        'MCP DX-34 object definition scenario failed: ' +
          (error && error.stack ? error.stack : String(error)) +
          '\n'
      );
      process.exitCode = 1;
    });
}

module.exports = {
  REQUIRED_TOOLS,
  assertDefinitionToolSchemas,
  chooseSpriteType,
  validationErrorCount,
  run,
};
