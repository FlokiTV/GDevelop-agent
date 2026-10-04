const fs = require('fs');
const os = require('os');
const path = require('path');
const { connectLiveGDevelopMcp, sanitizeForReplay } = require('./McpClient');

const REQUIRED_TOOLS = [
  'project.status',
  'project.create',
  'project.save-as',
  'project.close',
  'editor.types.objects.list',
  'editor.functions.create-object',
  'objects.definitions.create',
  'objects.definitions.get',
  'objects.definitions.rename',
  'objects.groups.create',
  'objects.groups.members.add',
  'objects.groups.get',
  'scene.instances.create',
  'scene.instances.get',
  'events.instructions.search',
  'events.read',
  'events.insert',
  'resources.visual.import',
  'resources.visual.inspect',
  'objects.sprite.animations.create',
  'objects.sprite.frames.add',
  'mutations.capabilities',
  'mutations.plan',
  'mutations.commit',
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
  assert(Number.isInteger(revision), 'dx38_missing_project_revision');
  return revision;
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

const makePngHeader = (width, height, colorType = 6) => {
  const buffer = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  buffer[24] = 8;
  buffer[25] = colorType;
  return buffer;
};

const chooseSpriteType = items => {
  const candidates = Array.isArray(items)
    ? items.filter(item => item && item.kind === 'object')
    : [];
  return (
    candidates.find(item => item.type === 'Sprite') ||
    candidates.find(item =>
      /(^|\b)sprite(\b|$)/i.test(
        [
          item.type,
          item.name,
          item.fullName,
          item.description,
          item.extensionName,
        ]
          .filter(Boolean)
          .join(' ')
      )
    ) ||
    null
  );
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
        'dx38_clean_room_repository_read_forbidden:' + path.basename(resolved)
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
    'gdevelop-dx38-mutation-planning-' + process.pid + '.json'
  ),
} = {}) => {
  const rootDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gdevelop-dx38-mutation-planning-')
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
        'dx38_tool_failed:' +
          name +
          ':' +
          (error && error.code ? error.code : 'unknown')
      );
    }
    return result;
  };

  const mutate = async (name, args = {}, options = {}) => {
    const revision = revisionOf(await call('project.status'));
    return call(
      name,
      {
        ...args,
        expectedRevision: revision,
        idempotencyKey: 'dx38-' + name + '-' + revision + '-' + replay.length,
      },
      options
    );
  };

  try {
    session = await connectLiveGDevelopMcp({
      clientId: 'gdevelop-dx38-mutation-planning-' + label,
      confirmDestructiveOperations: true,
    });
    const tools = await session.listTools();
    for (const name of REQUIRED_TOOLS) {
      assert(
        tools.some(tool => tool.name === name),
        'dx38_missing_tool:' + name
      );
    }

    const initialStatus = getData(await call('project.status'));
    assert(
      !initialStatus || initialStatus.projectOpen !== true,
      'dx38_requires_fresh_editor'
    );

    await call('project.create', {
      name: 'DX38 Mutation Planning Acceptance',
      idempotencyKey: 'dx38-create-project',
    });
    projectOpen = true;
    await call('project.save-as', {
      filePath: projectFile,
      name: 'DX38 Mutation Planning Acceptance',
    });

    const statusAfterCreate = getData(await call('project.status'));
    const sceneName =
      statusAfterCreate &&
      Array.isArray(statusAfterCreate.sceneNames) &&
      statusAfterCreate.sceneNames[0];
    assert(sceneName, 'dx38_scene_missing');

    const begun = getData(
      await call('safety.transactions.begin', {
        label: 'DX-38 mutation plan acceptance',
      })
    );
    transactionId = begun && begun.transactionId;
    assert(transactionId, 'dx38_transaction_missing');

    const textTypes = getData(
      await call('editor.types.objects.list', {
        query: 'text',
        deprecated: 'exclude',
        renderingMode: '2d',
        limit: 100,
      })
    );
    const spriteTypes = getData(
      await call('editor.types.objects.list', {
        query: 'sprite',
        deprecated: 'exclude',
        renderingMode: '2d',
        limit: 100,
      })
    );
    const textType = (textTypes.items || []).find(
      item => item.type === 'TextObject::Text'
    );
    const spriteType = chooseSpriteType(spriteTypes.items);
    assert(textType && spriteType, 'dx38_object_types_not_discovered');

    const objectName = 'DX38Hero';
    const staleName = 'DX38StaleRename';
    const renamedName = 'DX38HeroRenamed';
    const groupName = 'DX38Actors';

    const created = getData(
      await mutate('objects.definitions.create', {
        objectName,
        objectType: textType.type,
        objectScope: 'scene',
        sceneName,
      })
    );
    const objectId =
      created &&
      created.object &&
      created.object.identity &&
      created.object.identity.objectId;
    assert(objectId, 'dx38_object_id_missing');

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
    const firstInstance = getData(
      await mutate('scene.instances.create', {
        sceneName,
        objectName,
        position: { x: 40, y: 60 },
      })
    );
    const firstInstanceId =
      firstInstance &&
      firstInstance.instance &&
      (firstInstance.instance.instanceId ||
        (firstInstance.instance.identity &&
          firstInstance.instance.identity.instanceId));
    assert(firstInstanceId, 'dx38_first_instance_missing');

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
    assert(setX, 'dx38_setx_not_discovered');

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

    const capabilities = getData(await call('mutations.capabilities'));
    assert(
      capabilities &&
        Array.isArray(capabilities.eligibleCommands) &&
        capabilities.eligibleCommands.includes('objects.definitions.rename') &&
        capabilities.eligibleCommands.includes('resources.visual.delete') &&
        capabilities.token &&
        capabilities.token.staleOnProjectRevisionChange === true &&
        capabilities.token.singleUse === true,
      'dx38_capabilities_missing'
    );

    // 1) Plan a rename and prove the dry-run is side-effect-free.
    const revisionBeforeRenamePlan = revisionOf(await call('project.status'));
    const renamePlan = getData(
      await call('mutations.plan', {
        command: 'objects.definitions.rename',
        input: { objectId, newObjectName: renamedName },
      })
    );
    const revisionAfterRenamePlan = revisionOf(await call('project.status'));
    assert(
      revisionAfterRenamePlan === revisionBeforeRenamePlan,
      'dx38_rename_plan_changed_project_revision'
    );
    assert(
      renamePlan &&
        renamePlan.valid === true &&
        renamePlan.commitAllowed === true &&
        renamePlan.planToken &&
        renamePlan.sideEffects.projectModified === false &&
        renamePlan.sideEffects.filesystemModified === false &&
        renamePlan.sideEffects.runtimeModified === false &&
        renamePlan.changeSet.renames.length === 1 &&
        renamePlan.changeSet.referenceRewrites.length >= 3 &&
        renamePlan.impact &&
        renamePlan.impact.affectedReferenceCount >= 3 &&
        renamePlan.preconditions.projectRevision === revisionBeforeRenamePlan,
      'dx38_rename_plan_missing'
    );
    const rewriteKinds = new Set(
      renamePlan.changeSet.referenceRewrites.map(
        rewrite => rewrite.referenceKind
      )
    );
    assert(
      rewriteKinds.has('instance-of-object') &&
        rewriteKinds.has('group-member') &&
        rewriteKinds.has('event-parameter-object'),
      'dx38_rename_rewrite_preview_incomplete'
    );

    const objectBeforeCommit = getData(
      await call('objects.definitions.get', { objectId })
    );
    assert(
      objectBeforeCommit &&
        objectBeforeCommit.object &&
        objectBeforeCommit.object.name === objectName,
      'dx38_dry_run_renamed_object'
    );

    // 2) Create a stale plan, mutate elsewhere, then prove commit rejection.
    const stalePlan = getData(
      await call('mutations.plan', {
        command: 'objects.definitions.rename',
        input: { objectId, newObjectName: staleName },
      })
    );
    assert(stalePlan && stalePlan.planToken, 'dx38_stale_plan_missing_token');
    await mutate('scene.instances.create', {
      sceneName,
      objectName,
      position: { x: 100, y: 120 },
    });
    const staleCommit = await mutate(
      'mutations.commit',
      { planToken: stalePlan.planToken },
      { allowError: true }
    );
    assert(staleCommit.isError === true, 'dx38_stale_plan_commit_unexpected');
    const staleError = extractError(staleCommit);
    assert(
      staleError && staleError.code === 'mutation_plan_stale',
      'dx38_stale_plan_wrong_error'
    );
    const afterStale = getData(
      await call('objects.definitions.get', { objectId })
    );
    assert(
      afterStale && afterStale.object && afterStale.object.name === objectName,
      'dx38_stale_plan_mutated_object'
    );

    // Re-plan after the intervening mutation, then commit and compare exact diff.
    const freshPlan = getData(
      await call('mutations.plan', {
        command: 'objects.definitions.rename',
        input: { objectId, newObjectName: renamedName },
      })
    );
    assert(
      freshPlan && freshPlan.planToken && freshPlan.commitAllowed === true,
      'dx38_fresh_plan_missing'
    );
    const committed = getData(
      await mutate('mutations.commit', {
        planToken: freshPlan.planToken,
      })
    );
    assert(
      committed &&
        committed.committed === true &&
        committed.committedDiffMatchesPlan === true &&
        JSON.stringify(committed.committedDiff) ===
          JSON.stringify(freshPlan.changeSet) &&
        JSON.stringify(committed.plannedChangeSet) ===
          JSON.stringify(freshPlan.changeSet),
      'dx38_committed_diff_does_not_match_plan'
    );

    const groupAfter = getData(
      await call('objects.groups.get', {
        groupName,
        groupScope: 'scene',
        sceneName,
      })
    );
    assert(
      groupAfter &&
        groupAfter.group &&
        groupAfter.group.members.some(
          member => member.objectName === renamedName
        ),
      'dx38_group_refactor_missing'
    );
    const instanceAfter = getData(
      await call('scene.instances.get', {
        sceneName,
        instanceId: firstInstanceId,
      })
    );
    assert(
      instanceAfter &&
        instanceAfter.instance &&
        instanceAfter.instance.objectName === renamedName,
      'dx38_instance_refactor_missing'
    );
    events = getData(await call('events.read', { sceneName }));
    assert(
      (events.events || []).some(event =>
        (event.actions || []).some(
          action =>
            action.type === setX.id &&
            Array.isArray(action.parameters) &&
            action.parameters[0] === renamedName
        )
      ),
      'dx38_event_refactor_missing'
    );

    // 3) Resource delete plan must report blockers/usages and preserve bytes/project.
    const spriteName = 'DX38Sprite';
    await mutate('editor.functions.create-object', {
      scene_name: sceneName,
      object_name: spriteName,
      object_type: spriteType.type,
    });
    const resourceName = 'dx38-used.png';
    await mutate('resources.visual.import', {
      resourceName,
      kind: 'image',
      contentBase64: makePngHeader(32, 16).toString('base64'),
    });
    await mutate('objects.sprite.animations.create', {
      sceneName,
      objectName: spriteName,
      animationName: 'Idle',
      looping: true,
      timeBetweenFrames: 0.1,
    });
    await mutate('objects.sprite.frames.add', {
      sceneName,
      objectName: spriteName,
      animationName: 'Idle',
      image: resourceName,
      collisionMask: { kind: 'full-image' },
    });

    const resourceBefore = getData(
      await call('resources.visual.inspect', { resourceName })
    );
    const revisionBeforeResourcePlan = revisionOf(await call('project.status'));
    const resourcePlan = getData(
      await call('mutations.plan', {
        command: 'resources.visual.delete',
        input: { resourceName, deleteFile: true },
      })
    );
    const revisionAfterResourcePlan = revisionOf(await call('project.status'));
    const resourceAfterPlan = getData(
      await call('resources.visual.inspect', { resourceName })
    );
    assert(
      revisionAfterResourcePlan === revisionBeforeResourcePlan,
      'dx38_resource_plan_changed_project_revision'
    );
    assert(
      resourcePlan &&
        resourcePlan.valid === true &&
        resourcePlan.commitAllowed === false &&
        resourcePlan.changeSet.deletes.length === 1 &&
        resourcePlan.diagnostics.blockers.length > 0 &&
        resourcePlan.impact &&
        resourcePlan.impact.blockerCount > 0 &&
        resourcePlan.sideEffects.filesystemModified === false,
      'dx38_resource_blocker_plan_missing'
    );
    assert(
      resourceBefore &&
        resourceAfterPlan &&
        resourceBefore.resource &&
        resourceAfterPlan.resource &&
        resourceBefore.resource.name === resourceAfterPlan.resource.name &&
        resourceBefore.resource.projectRelativePath ===
          resourceAfterPlan.resource.projectRelativePath &&
        resourceBefore.physical.sha256 === resourceAfterPlan.physical.sha256 &&
        resourceBefore.physical.byteSize ===
          resourceAfterPlan.physical.byteSize,
      'dx38_resource_dry_run_changed_file_or_registration'
    );

    const blockedCommit = await mutate(
      'mutations.commit',
      { planToken: resourcePlan.planToken },
      { allowError: true }
    );
    const blockedError = extractError(blockedCommit);
    assert(
      blockedCommit.isError === true &&
        blockedError &&
        blockedError.code === 'mutation_plan_commit_blocked',
      'dx38_resource_blocked_commit_wrong_result'
    );
    const resourceAfterBlockedCommit = getData(
      await call('resources.visual.inspect', { resourceName })
    );
    assert(
      resourceAfterBlockedCommit &&
        resourceAfterBlockedCommit.resource &&
        resourceAfterBlockedCommit.resource.name === resourceName,
      'dx38_blocked_resource_commit_removed_resource'
    );

    const validation = getData(await call('validation.run'));
    const validationErrors = validationErrorCount(validation);
    assert(
      validationErrors === 0,
      'dx38_validation_errors:' + validationErrors
    );

    const rollback = getData(
      await call('safety.transactions.rollback', { transactionId })
    );
    assert(
      rollback && rollback.rolledBack !== false,
      'dx38_transaction_rollback_failed'
    );
    transactionId = null;

    await call('project.close', { discardUnsavedChanges: false });
    projectOpen = false;

    const evidence = {
      label,
      protocolVersion: session.protocolVersion,
      renameDryRun: {
        revisionStable: revisionBeforeRenamePlan === revisionAfterRenamePlan,
        changeKinds: Object.keys(renamePlan.changeSet).filter(
          key =>
            Array.isArray(renamePlan.changeSet[key]) &&
            renamePlan.changeSet[key].length > 0
        ),
        rewriteKinds: Array.from(rewriteKinds).sort(),
        affectedReferenceCount: renamePlan.impact.affectedReferenceCount,
        eventRevisions: renamePlan.preconditions.eventRevisions,
        graphRevision: renamePlan.preconditions.graphRevision,
        noProjectFilesystemRuntimeSideEffects:
          renamePlan.sideEffects.projectModified === false &&
          renamePlan.sideEffects.filesystemModified === false &&
          renamePlan.sideEffects.runtimeModified === false,
      },
      stalePlan: {
        rejected: true,
        code: staleError.code,
        objectNameAfterRejectedCommit: afterStale.object.name,
      },
      committedPlan: {
        committed: true,
        committedDiffMatchesPlan: committed.committedDiffMatchesPlan,
        exactDiffEquality:
          JSON.stringify(committed.committedDiff) ===
          JSON.stringify(freshPlan.changeSet),
        groupInstanceEventReferencesRewritten: true,
      },
      resourceDeleteDryRun: {
        revisionStable:
          revisionBeforeResourcePlan === revisionAfterResourcePlan,
        commitAllowed: resourcePlan.commitAllowed,
        blockerCount: resourcePlan.diagnostics.blockers.length,
        graphBlockerCount: resourcePlan.impact.blockerCount,
        resourceStillPresent: true,
        bytesUnchanged:
          resourceBefore.physical.sha256 ===
            resourceAfterPlan.physical.sha256 &&
          resourceBefore.physical.byteSize ===
            resourceAfterPlan.physical.byteSize,
        blockedCommitCode: blockedError.code,
      },
      validationErrors,
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
