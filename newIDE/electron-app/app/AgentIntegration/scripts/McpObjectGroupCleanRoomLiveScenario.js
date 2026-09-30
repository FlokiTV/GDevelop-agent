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
  'editor.functions.create-scene',
  'editor.functions.create-object',
  'objects.groups.list',
  'objects.groups.get',
  'objects.groups.for-object',
  'objects.groups.usages',
  'objects.groups.create',
  'objects.groups.rename',
  'objects.groups.delete',
  'objects.groups.members.add',
  'objects.groups.members.remove',
  'objects.groups.members.move',
  'events.read',
  'events.insert',
  'events.delete',
  'events.instructions.search',
  'events.instructions.describe',
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
  assert(Number.isInteger(revision), 'dx31_missing_project_revision');
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
  assert(tool, 'dx31_missing_tool:' + name);
  return tool;
};

const assertGroupToolSchemas = tools => {
  REQUIRED_TOOLS.forEach(name => findTool(tools, name));
  const create = findTool(tools, 'objects.groups.create');
  const addMember = findTool(tools, 'objects.groups.members.add');
  const remove = findTool(tools, 'objects.groups.delete');
  assert(
    create.inputSchema &&
      create.inputSchema.properties &&
      create.inputSchema.properties.groupName &&
      create.inputSchema.properties.groupScope,
    'dx31_group_create_schema_missing'
  );
  assert(
    addMember.inputSchema &&
      addMember.inputSchema.properties &&
      addMember.inputSchema.properties.objectName,
    'dx31_group_member_schema_missing'
  );
  assert(
    remove.inputSchema &&
      remove.inputSchema.properties &&
      remove.inputSchema.properties.dryRun &&
      remove.inputSchema.properties.dryRun.default === true,
    'dx31_group_delete_not_dry_run'
  );
};

const chooseObjectTypes = items => {
  const candidates = Array.isArray(items)
    ? items.filter(item => item && item.kind === 'object')
    : [];
  const sprite =
    candidates.find(item => item.type === 'Sprite') ||
    candidates.find(item => /sprite/i.test([item.type, item.name].join(' ')));
  const text =
    candidates.find(item => item.type === 'TextObject::Text') ||
    candidates.find(
      item =>
        item.type !== (sprite && sprite.type) &&
        /(^|\b)text(\b|$)/i.test(
          [item.type, item.name, item.fullName].filter(Boolean).join(' ')
        )
    );
  const first = sprite || candidates[0] || null;
  return {
    first,
    second:
      text ||
      candidates.find(item => !first || item.type !== first.type) ||
      null,
  };
};

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
        'dx31_clean_room_repository_read_forbidden:' + path.basename(resolved)
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
    `gdevelop-dx31-object-groups-${process.pid}.json`
  ),
} = {}) => {
  const rootDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gdevelop-dx31-object-groups-')
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
      clientId: `gdevelop-dx31-object-groups-${label}-${suffix}`,
      confirmDestructiveOperations: true,
    });

  const call = async (name, args = {}, { allowError = false } = {}) => {
    const result = await session.call(name, args);
    record(name, args, result);
    if (result.isError && !allowError) {
      const error = extractError(result);
      throw new Error(
        `dx31_tool_failed:${name}:${
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
      idempotencyKey: `dx31-${name}-${revision}-${replay.length}`,
    });
    if (transactionId) {
      const meta =
        result.meta ||
        (result.structuredContent && result.structuredContent.meta) ||
        null;
      assert(
        meta && meta.transactionId === transactionId,
        `dx31_transaction_metadata_missing:${name}`
      );
    }
    return result;
  };

  const isOwnedStaleProject = status => {
    if (
      !status ||
      status.projectOpen !== true ||
      status.projectName !== 'DX31 Object Groups Acceptance' ||
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
      /(?:^|[\\/])gdevelop-dx31-object-groups-[^\\/]+[\\/]project[\\/]game\.json$/i.test(
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
          `dx31_requires_fresh_editor:${JSON.stringify({
            fileIdentifier: status.fileIdentifier,
            projectName: status.projectName,
            hasUnsavedChanges: status.hasUnsavedChanges,
          })}`
        );
      }
      await call('project.close', { discardUnsavedChanges: false });
      await wait(250);
    }
    throw new Error('dx31_stale_project_cleanup_exhausted');
  };

  try {
    session = await connect('initial');
    const tools = await session.listTools();
    assertGroupToolSchemas(tools);
    await ensureFreshEditor();

    await call('project.create', {
      name: 'DX31 Object Groups Acceptance',
      idempotencyKey: 'dx31-create-project',
    });
    projectOpen = true;
    await wait(300);
    await call('project.save-as', {
      filePath: projectFile,
      name: 'DX31 Object Groups Acceptance',
    });

    const baselinePersistence = getData(
      await call('project.persistence.status')
    );
    assert(
      baselinePersistence &&
        baselinePersistence.persisted &&
        baselinePersistence.persisted.serializedHash,
      'dx31_baseline_persisted_hash_missing'
    );
    const baselinePersistedHash = baselinePersistence.persisted.serializedHash;

    const begun = getData(
      await call('safety.transactions.begin', {
        label: 'DX-31 object groups MCP-only acceptance',
      })
    );
    transactionId = begun && begun.transactionId;
    assert(transactionId, 'dx31_transaction_missing');

    const suffix = Date.now().toString(36);
    const sceneName = `DX31Scene${suffix}`;
    const firstObjectName = `DX31Sprite${suffix}`;
    const secondObjectName = `DX31Text${suffix}`;
    const groupName = `DX31Actors${suffix}`;
    const renamedGroupName = `DX31Units${suffix}`;

    await mutate('editor.functions.create-scene', { scene_name: sceneName });

    const objectTypesResult = getData(
      await call('editor.types.objects.list', {
        deprecated: 'exclude',
        renderingMode: '2d',
        limit: 100,
      })
    );
    const chosen = chooseObjectTypes(
      objectTypesResult && objectTypesResult.items
    );
    assert(
      chosen.first && chosen.second && chosen.first.type !== chosen.second.type,
      'dx31_two_object_types_not_discovered'
    );

    await mutate('editor.functions.create-object', {
      scene_name: sceneName,
      object_name: firstObjectName,
      object_type: chosen.first.type,
    });
    await mutate('editor.functions.create-object', {
      scene_name: sceneName,
      object_name: secondObjectName,
      object_type: chosen.second.type,
    });

    const created = getData(
      await mutate('objects.groups.create', {
        groupName,
        groupScope: 'scene',
        sceneName,
      })
    );
    assert(
      created && created.created === true && created.group.name === groupName,
      'dx31_group_create_failed'
    );

    await mutate('objects.groups.members.add', {
      groupName,
      groupScope: 'scene',
      sceneName,
      objectName: firstObjectName,
    });
    await mutate('objects.groups.members.add', {
      groupName,
      groupScope: 'scene',
      sceneName,
      objectName: secondObjectName,
    });

    const describedGroup = getData(
      await call('objects.groups.get', {
        groupName,
        groupScope: 'scene',
        sceneName,
      })
    );
    assert(
      describedGroup &&
        describedGroup.group &&
        describedGroup.group.memberCount === 2 &&
        describedGroup.group.members[0].objectType &&
        describedGroup.group.members[1].objectType &&
        describedGroup.group.members[0].objectType !==
          describedGroup.group.members[1].objectType,
      'dx31_group_members_not_typed'
    );

    const reverse = getData(
      await call('objects.groups.for-object', {
        objectName: secondObjectName,
        sceneName,
        groupScope: 'scene',
      })
    );
    assert(
      reverse &&
        reverse.items &&
        reverse.items.some(item => item.name === groupName),
      'dx31_reverse_lookup_failed'
    );

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
    assert(setX, 'dx31_setx_not_discovered');

    const instruction = getData(
      await call('events.instructions.describe', {
        id: setX.id,
        kind: 'action',
        extension: setX.extension.name,
      })
    );
    const objectParameter =
      instruction &&
      instruction.item &&
      instruction.item.parameters.find(
        parameter => parameter.valueType && parameter.valueType.object
      );
    assert(
      objectParameter &&
        objectParameter.referenceSemantics &&
        objectParameter.referenceSemantics.entityKinds.includes('object-group'),
      'dx31_group_parameter_semantics_missing'
    );

    let events = getData(await call('events.read', { sceneName }));
    const inserted = await mutate('events.insert', {
      sceneName,
      expectedEventsRevision: events.eventsRevision,
      eventsJson: [
        {
          type: 'BuiltinCommonInstructions::Standard',
          conditions: [],
          actions: [
            {
              type: { value: setX.id },
              parameters: [groupName, '=', '10'],
              subInstructions: [],
            },
          ],
          events: [],
        },
      ],
    });
    assert(getData(inserted), 'dx31_group_event_insert_failed');

    const usages = getData(
      await call('objects.groups.usages', {
        groupName,
        groupScope: 'scene',
        sceneName,
      })
    );
    assert(
      usages &&
        usages.usages &&
        usages.usages.authoritativeReferenceCount === 1 &&
        usages.usages.authoritativeReferences[0].parameterIndex === 0,
      'dx31_group_usage_mapping_failed'
    );

    const renamed = getData(
      await mutate('objects.groups.rename', {
        groupName,
        groupScope: 'scene',
        sceneName,
        newGroupName: renamedGroupName,
      })
    );
    assert(
      renamed && renamed.renamed === true && renamed.nativeRefactor === true,
      'dx31_group_rename_failed'
    );

    events = getData(await call('events.read', { sceneName }));
    const authoredEvent = (events.events || []).find(
      event =>
        event.actions && event.actions.some(action => action.type === setX.id)
    );
    assert(authoredEvent, 'dx31_authored_event_missing');
    const authoredAction = authoredEvent.actions.find(
      action => action.type === setX.id
    );
    assert(
      authoredAction.parameters[0] === renamedGroupName,
      'dx31_group_reference_not_refactored'
    );

    const revisionBeforeDeletePlan = getRevision(await call('project.status'));
    const deletePlan = getData(
      await call('objects.groups.delete', {
        groupName: renamedGroupName,
        groupScope: 'scene',
        sceneName,
      })
    );
    assert(
      deletePlan &&
        deletePlan.deleted === false &&
        deletePlan.plan &&
        deletePlan.plan.blockers.some(
          blocker => blocker.code === 'object_group_in_use'
        ),
      'dx31_delete_plan_missing_blocker'
    );
    assert(
      getRevision(await call('project.status')) === revisionBeforeDeletePlan,
      'dx31_delete_dry_run_changed_revision'
    );

    const blocked = await call(
      'objects.groups.delete',
      {
        groupName: renamedGroupName,
        groupScope: 'scene',
        sceneName,
        dryRun: false,
        expectedRevision: revisionBeforeDeletePlan,
        idempotencyKey: `dx31-delete-blocked-${suffix}`,
      },
      { allowError: true }
    );
    const blockedError = extractError(blocked);
    assert(
      blocked.isError === true &&
        blockedError &&
        blockedError.code === 'object_group_delete_blocked',
      'dx31_in_use_delete_not_blocked'
    );
    assert(
      getRevision(await call('project.status')) === revisionBeforeDeletePlan,
      'dx31_blocked_delete_changed_revision'
    );

    events = getData(await call('events.read', { sceneName }));
    const cleanupEvent = (events.events || []).find(
      event =>
        event.actions && event.actions.some(action => action.type === setX.id)
    );
    assert(cleanupEvent, 'dx31_cleanup_event_missing');
    await mutate('events.delete', {
      sceneName,
      expectedEventsRevision: events.eventsRevision,
      handle: cleanupEvent.handle,
    });
    await mutate('objects.groups.delete', {
      groupName: renamedGroupName,
      groupScope: 'scene',
      sceneName,
      dryRun: false,
    });

    const finalList = getData(
      await call('objects.groups.list', {
        sceneName,
        groupScope: 'scene',
      })
    );
    assert(
      finalList &&
        Array.isArray(finalList.items) &&
        !finalList.items.some(item => item.name === renamedGroupName),
      'dx31_group_delete_not_persisted'
    );

    const validation = getData(
      await call('validation.run', {
        includeNativeReport: false,
        includeAssets: true,
      })
    );
    const validationErrors = validationErrorCount(validation);
    assert(validationErrors === 0, 'dx31_validation_has_errors');

    const evidence = sanitizeForReplay({
      kind: 'dx31-object-groups-clean-room',
      generatedAt: new Date().toISOString(),
      protocolVersion: session.protocolVersion,
      cleanRoom: {
        repositoryImplementationOrTestsReadDuringScenario: false,
        repositoryReadGuard: true,
        authoringInputSource: 'live MCP discovery and public tools',
      },
      sceneName,
      objectTypes: [chosen.first.type, chosen.second.type],
      group: {
        createdName: groupName,
        renamedName: renamedGroupName,
        memberCount: 2,
        reverseLookupVerified: true,
        objectParameterSemantics: true,
        eventUsageMapped: true,
        nativeRenameRefactor: true,
        deleteDryRunBlocked: true,
        removed: true,
      },
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
      'dx31_transaction_rollback_scene_survived'
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
      'dx31_transaction_rollback_not_clean'
    );

    await call('project.close', { discardUnsavedChanges: false });
    projectOpen = false;
    await session.close();
    session = null;
    fs.rmSync(rootDir, { recursive: true, force: true });

    return {
      ok: true,
      protocolVersion: evidence.protocolVersion,
      objectTypes: evidence.objectTypes,
      memberCount: 2,
      eventUsageMapped: true,
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
        'MCP DX-31 object group scenario failed: ' +
          (error && error.stack ? error.stack : String(error)) +
          '\n'
      );
      process.exitCode = 1;
    });
}

module.exports = {
  REQUIRED_TOOLS,
  assertGroupToolSchemas,
  chooseObjectTypes,
  validationErrorCount,
  run,
};
