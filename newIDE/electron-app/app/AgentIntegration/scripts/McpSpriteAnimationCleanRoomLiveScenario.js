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
  'resources.visual.import',
  'resources.visual.inspect',
  'objects.sprite.animations.list',
  'objects.sprite.animations.get',
  'objects.sprite.animations.create',
  'objects.sprite.animations.update',
  'objects.sprite.animations.move',
  'objects.sprite.animations.delete',
  'objects.sprite.frames.add',
  'objects.sprite.frames.update',
  'objects.sprite.frames.move',
  'objects.sprite.frames.delete',
  'objects.sprite.points.set',
  'objects.sprite.points.delete',
  'objects.sprite.collision-mask.set',
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
  assert(Number.isInteger(revision), 'dx30_missing_project_revision');
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
  assert(tool, 'dx30_missing_tool:' + name);
  return tool;
};

const assertSpriteToolSchemas = tools => {
  REQUIRED_TOOLS.forEach(name => findTool(tools, name));
  const create = findTool(tools, 'objects.sprite.animations.create');
  const addFrame = findTool(tools, 'objects.sprite.frames.add');
  const moveFrame = findTool(tools, 'objects.sprite.frames.move');
  const deleteAnimation = findTool(tools, 'objects.sprite.animations.delete');
  const collisionMask = findTool(tools, 'objects.sprite.collision-mask.set');

  assert(
    create.inputSchema &&
      create.inputSchema.properties &&
      create.inputSchema.properties.animationName &&
      create.inputSchema.properties.looping &&
      create.inputSchema.properties.timeBetweenFrames,
    'dx30_animation_create_schema_missing'
  );
  assert(
    addFrame.inputSchema &&
      addFrame.inputSchema.properties &&
      addFrame.inputSchema.properties.image &&
      addFrame.inputSchema.properties.origin &&
      addFrame.inputSchema.properties.center &&
      addFrame.inputSchema.properties.points &&
      addFrame.inputSchema.properties.collisionMask,
    'dx30_frame_add_schema_missing'
  );
  assert(
    moveFrame.inputSchema &&
      moveFrame.inputSchema.properties &&
      moveFrame.inputSchema.properties.dryRun &&
      moveFrame.inputSchema.properties.dryRun.default === true &&
      moveFrame.inputSchema.properties.acknowledgeIndexReferenceRisk,
    'dx30_frame_move_safety_schema_missing'
  );
  assert(
    deleteAnimation.inputSchema &&
      deleteAnimation.inputSchema.properties &&
      deleteAnimation.inputSchema.properties.dryRun &&
      deleteAnimation.inputSchema.properties.dryRun.default === true,
    'dx30_animation_delete_safety_schema_missing'
  );
  assert(
    collisionMask.inputSchema &&
      collisionMask.inputSchema.properties &&
      collisionMask.inputSchema.properties.collisionMask &&
      collisionMask.inputSchema.properties.collisionMask.properties &&
      collisionMask.inputSchema.properties.collisionMask.properties.kind,
    'dx30_collision_mask_schema_missing'
  );
};

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
        'dx30_clean_room_repository_read_forbidden:' + path.basename(resolved)
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

const run = async ({
  label = 'live',
  evidencePath = path.join(
    os.tmpdir(),
    `gdevelop-dx30-sprite-animation-${process.pid}.json`
  ),
} = {}) => {
  const rootDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gdevelop-dx30-sprite-animation-')
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
      clientId: `gdevelop-dx30-sprite-animation-${label}-${suffix}`,
      confirmDestructiveOperations: true,
    });

  const call = async (name, args = {}, { allowError = false } = {}) => {
    const result = await session.call(name, args);
    record(name, args, result);
    if (result.isError && !allowError) {
      const error = extractError(result);
      throw new Error(
        `dx30_tool_failed:${name}:${
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
      idempotencyKey: `dx30-${name}-${revision}-${replay.length}`,
    });
    if (transactionId) {
      const meta =
        result.meta ||
        (result.structuredContent && result.structuredContent.meta) ||
        null;
      assert(
        meta && meta.transactionId === transactionId,
        `dx30_transaction_metadata_missing:${name}`
      );
    }
    return result;
  };

  const isOwnedStaleProject = status => {
    if (
      !status ||
      status.projectOpen !== true ||
      status.projectName !== 'DX30 Sprite Animation Acceptance' ||
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
      /(?:^|[\\/])gdevelop-dx30-sprite-animation-[^\\/]+[\\/]project[\\/]game\.json$/i.test(
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
          `dx30_requires_fresh_editor:${JSON.stringify({
            fileIdentifier: status.fileIdentifier,
            projectName: status.projectName,
            hasUnsavedChanges: status.hasUnsavedChanges,
          })}`
        );
      }
      await call('project.close', { discardUnsavedChanges: false });
      await wait(250);
    }
    throw new Error('dx30_stale_project_cleanup_exhausted');
  };

  try {
    session = await connect('initial');
    const tools = await session.listTools();
    assertSpriteToolSchemas(tools);

    await ensureFreshEditor();
    await call('project.create', {
      name: 'DX30 Sprite Animation Acceptance',
      idempotencyKey: 'dx30-create-project',
    });
    projectOpen = true;
    await wait(300);
    await call('project.save-as', {
      filePath: projectFile,
      name: 'DX30 Sprite Animation Acceptance',
    });

    const baselinePersistence = getData(
      await call('project.persistence.status')
    );
    assert(
      baselinePersistence &&
        baselinePersistence.persisted &&
        baselinePersistence.persisted.serializedHash,
      'dx30_baseline_persisted_hash_missing'
    );
    const baselinePersistedHash = baselinePersistence.persisted.serializedHash;

    const begun = getData(
      await call('safety.transactions.begin', {
        label: 'DX-30 Sprite animation MCP-only acceptance',
      })
    );
    transactionId = begun && begun.transactionId;
    assert(transactionId, 'dx30_transaction_missing');

    const suffix = Date.now().toString(36);
    const sceneName = `DX30Sprites${suffix}`;
    const objectName = `DX30Hero${suffix}`;
    await mutate('editor.functions.create-scene', { scene_name: sceneName });

    const objectTypes = getData(
      await call('editor.types.objects.list', {
        query: 'sprite',
        deprecated: 'exclude',
        renderingMode: '2d',
        limit: 100,
      })
    );
    const spriteType = chooseSpriteType(objectTypes && objectTypes.items);
    assert(spriteType && spriteType.type, 'dx30_sprite_type_not_discovered');

    await mutate('editor.functions.create-object', {
      scene_name: sceneName,
      object_name: objectName,
      object_type: spriteType.type,
    });

    const resources = [
      { name: `dx30-a-${suffix}`, width: 32, height: 16 },
      { name: `dx30-b-${suffix}`, width: 48, height: 24 },
      { name: `dx30-c-${suffix}`, width: 64, height: 32 },
    ];
    for (const resource of resources) {
      await mutate('resources.visual.import', {
        resourceName: resource.name,
        kind: 'image',
        contentBase64: makePngHeader(resource.width, resource.height).toString(
          'base64'
        ),
      });
      const inspected = getData(
        await call('resources.visual.inspect', {
          resourceName: resource.name,
        })
      );
      assert(
        inspected &&
          inspected.image &&
          Number(inspected.image.width) === resource.width &&
          Number(inspected.image.height) === resource.height,
        `dx30_visual_metadata_mismatch:${resource.name}`
      );
    }

    const animationName = `DX30Run${suffix}`;
    const renamedAnimationName = `DX30Sprint${suffix}`;
    const created = getData(
      await mutate('objects.sprite.animations.create', {
        sceneName,
        objectName,
        animationName,
        looping: true,
        timeBetweenFrames: 0.1,
      })
    );
    assert(
      created &&
        created.created === true &&
        created.animation &&
        created.animation.animationName === animationName,
      'dx30_animation_create_failed'
    );

    const polygonA = [
      [{ x: 0, y: 0 }, { x: 32, y: 0 }, { x: 32, y: 16 }, { x: 0, y: 16 }],
    ];
    const polygonB = [
      [{ x: 0, y: 0 }, { x: 48, y: 0 }, { x: 48, y: 24 }, { x: 0, y: 24 }],
    ];

    await mutate('objects.sprite.frames.add', {
      sceneName,
      objectName,
      animationName,
      image: resources[0].name,
      origin: { x: 3, y: 4 },
      center: { default: false, x: 16, y: 8 },
      points: [{ name: 'Hand', x: 20, y: 6 }],
      collisionMask: { kind: 'polygons', polygons: polygonA },
    });
    await mutate('objects.sprite.frames.add', {
      sceneName,
      objectName,
      animationName,
      image: resources[1].name,
      origin: { x: 3, y: 4 },
      center: { default: false, x: 24, y: 12 },
      points: [{ name: 'Hand', x: 26, y: 7 }],
      collisionMask: { kind: 'full-image' },
    });

    let described = getData(
      await call('objects.sprite.animations.get', {
        sceneName,
        objectName,
        animationName,
      })
    );
    let animation = described && described.animation;
    let direction =
      animation && Array.isArray(animation.directions)
        ? animation.directions[0]
        : null;
    assert(
      animation &&
        direction &&
        direction.frameCount === 2 &&
        direction.looping === true &&
        Number(direction.timeBetweenFrames) === 0.1 &&
        direction.timingModel === 'uniform-per-direction',
      'dx30_animation_introspection_failed'
    );
    assert(
      direction.frames[0] &&
        direction.frames[0].resource &&
        direction.frames[0].resource.discovery &&
        direction.frames[0].resource.discovery.command ===
          'resources.visual.inspect' &&
        direction.frames[0].origin.x === 3 &&
        direction.frames[0].center.default === false &&
        direction.frames[0].points.some(point => point.name === 'Hand') &&
        direction.frames[0].collisionMask.kind === 'polygons',
      'dx30_frame_metadata_introspection_failed'
    );
    assert(
      Array.isArray(animation.diagnostics) &&
        animation.diagnostics.some(
          diagnostic =>
            diagnostic.code === 'sprite_collision_mask_mode_inconsistent'
        ),
      'dx30_collision_inconsistency_diagnostic_missing'
    );

    await mutate('objects.sprite.points.set', {
      sceneName,
      objectName,
      animationName,
      frameIndex: 0,
      pointKind: 'custom',
      pointName: 'Muzzle',
      x: 27,
      y: 5,
    });
    described = getData(
      await call('objects.sprite.animations.get', {
        sceneName,
        objectName,
        animationName,
      })
    );
    assert(
      described.animation.directions[0].frames[0].points.some(
        point => point.name === 'Muzzle' && point.x === 27 && point.y === 5
      ),
      'dx30_point_set_not_persisted'
    );
    await mutate('objects.sprite.points.delete', {
      sceneName,
      objectName,
      animationName,
      frameIndex: 0,
      pointName: 'Muzzle',
    });

    await mutate('objects.sprite.collision-mask.set', {
      sceneName,
      objectName,
      animationName,
      frameIndex: 1,
      collisionMask: { kind: 'polygons', polygons: polygonB },
    });
    described = getData(
      await call('objects.sprite.animations.get', {
        sceneName,
        objectName,
        animationName,
      })
    );
    animation = described.animation;
    assert(
      !animation.diagnostics.some(
        diagnostic =>
          diagnostic.code === 'sprite_collision_mask_mode_inconsistent'
      ),
      'dx30_collision_mask_consistency_not_restored'
    );

    const replacement = getData(
      await mutate('objects.sprite.frames.update', {
        sceneName,
        objectName,
        animationName,
        frameIndex: 0,
        image: resources[2].name,
      })
    );
    assert(
      replacement &&
        replacement.updated === true &&
        replacement.preserved &&
        replacement.preserved.customPoints === true &&
        replacement.preserved.collisionMask === true &&
        replacement.preserved.unrelatedAnimations === true &&
        replacement.frame &&
        replacement.frame.image === resources[2].name &&
        replacement.frame.points.some(point => point.name === 'Hand') &&
        replacement.frame.collisionMask.kind === 'polygons',
      'dx30_frame_resource_replace_corrupted_metadata'
    );

    const renamed = getData(
      await mutate('objects.sprite.animations.update', {
        sceneName,
        objectName,
        animationName,
        newAnimationName: renamedAnimationName,
        looping: false,
        timeBetweenFrames: 0.2,
      })
    );
    assert(
      renamed &&
        renamed.updated === true &&
        renamed.renameRefactor &&
        renamed.renameRefactor.nativeRefactor === true &&
        renamed.animation &&
        renamed.animation.animationName === renamedAnimationName &&
        renamed.animation.directions[0].looping === false &&
        Number(renamed.animation.directions[0].timeBetweenFrames) === 0.2,
      'dx30_animation_update_or_refactor_failed'
    );

    const revisionBeforeDryRun = getRevision(await call('project.status'));
    const movePlan = getData(
      await call('objects.sprite.frames.move', {
        sceneName,
        objectName,
        animationName: renamedAnimationName,
        fromIndex: 0,
        toIndex: 1,
      })
    );
    assert(
      movePlan &&
        movePlan.moved === false &&
        movePlan.plan &&
        movePlan.plan.dryRun === true &&
        movePlan.plan.referenceRisk &&
        movePlan.plan.referenceRisk.requiresAcknowledgement === true,
      'dx30_frame_move_dry_run_missing'
    );
    assert(
      getRevision(await call('project.status')) === revisionBeforeDryRun,
      'dx30_frame_move_dry_run_changed_revision'
    );

    const unsafeMove = await call(
      'objects.sprite.frames.move',
      {
        sceneName,
        objectName,
        animationName: renamedAnimationName,
        fromIndex: 0,
        toIndex: 1,
        dryRun: false,
        expectedRevision: revisionBeforeDryRun,
        idempotencyKey: `dx30-unsafe-frame-move-${suffix}`,
      },
      { allowError: true }
    );
    const unsafeError = extractError(unsafeMove);
    assert(
      unsafeMove.isError === true &&
        unsafeError &&
        unsafeError.code === 'sprite_index_reference_risk_ack_required',
      'dx30_unsafe_frame_move_not_blocked'
    );
    assert(
      getRevision(await call('project.status')) === revisionBeforeDryRun,
      'dx30_unsafe_frame_move_changed_revision'
    );

    await mutate('objects.sprite.frames.move', {
      sceneName,
      objectName,
      animationName: renamedAnimationName,
      fromIndex: 0,
      toIndex: 1,
      dryRun: false,
      acknowledgeIndexReferenceRisk: true,
    });

    const validation = getData(
      await call('validation.run', {
        includeNativeReport: false,
        includeAssets: true,
      })
    );
    const validationErrors = validationErrorCount(validation);
    assert(validationErrors === 0, 'dx30_validation_has_errors');

    const deletePlanRevision = getRevision(await call('project.status'));
    const deletePlan = getData(
      await call('objects.sprite.animations.delete', {
        sceneName,
        objectName,
        animationName: renamedAnimationName,
      })
    );
    assert(
      deletePlan &&
        deletePlan.deleted === false &&
        deletePlan.plan &&
        deletePlan.plan.referenceRisk &&
        deletePlan.plan.referenceRisk.requiresAcknowledgement === true,
      'dx30_animation_delete_dry_run_missing'
    );
    assert(
      getRevision(await call('project.status')) === deletePlanRevision,
      'dx30_animation_delete_dry_run_changed_revision'
    );

    await mutate('objects.sprite.animations.delete', {
      sceneName,
      objectName,
      animationName: renamedAnimationName,
      dryRun: false,
      acknowledgeIndexReferenceRisk: true,
    });
    const finalList = getData(
      await call('objects.sprite.animations.list', {
        sceneName,
        objectName,
      })
    );
    assert(
      finalList &&
        Array.isArray(finalList.items) &&
        !finalList.items.some(
          item => item.animationName === renamedAnimationName
        ),
      'dx30_animation_delete_not_persisted'
    );

    const evidence = sanitizeForReplay({
      kind: 'dx30-sprite-animation-clean-room',
      generatedAt: new Date().toISOString(),
      protocolVersion: session.protocolVersion,
      cleanRoom: {
        repositoryImplementationOrTestsReadDuringScenario: false,
        repositoryReadGuard: true,
        authoringInputSource: 'live MCP discovery and public tools',
      },
      spriteType: spriteType.type,
      sceneName,
      objectName,
      animation: {
        createdName: animationName,
        renamedName: renamedAnimationName,
        frameCount: 2,
        loopingInitial: true,
        loopingFinal: false,
        timingModel: 'uniform-per-direction',
        initialTimeBetweenFrames: 0.1,
        finalTimeBetweenFrames: 0.2,
        nativeRenameRefactor: true,
        removed: true,
      },
      frameAuthoring: {
        origin: { x: 3, y: 4 },
        center: { default: false, x: 16, y: 8 },
        customPoint: 'Hand',
        transientPointCreatedAndDeleted: 'Muzzle',
        collisionMask: 'polygons',
        replacementResource: resources[2].name,
        metadataPreservedOnReplacement: true,
      },
      resources: resources.map(resource => ({
        name: resource.name,
        width: resource.width,
        height: resource.height,
      })),
      indexSafety: {
        dryRunRevisionStable: true,
        unsafeApplyBlocked: true,
        acknowledgedFrameMoveApplied: true,
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
      'dx30_transaction_rollback_scene_survived'
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
      'dx30_transaction_rollback_not_clean'
    );

    await call('project.close', { discardUnsavedChanges: false });
    projectOpen = false;
    await session.close();
    session = null;
    fs.rmSync(rootDir, { recursive: true, force: true });

    return {
      ok: true,
      protocolVersion: evidence.protocolVersion,
      spriteType: spriteType.type,
      frameCount: 2,
      nativeRenameRefactor: true,
      metadataPreservedOnReplacement: true,
      indexRiskGuarded: true,
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
        'MCP DX-30 Sprite animation scenario failed: ' +
          (error && error.stack ? error.stack : String(error)) +
          '\n'
      );
      process.exitCode = 1;
    });
}

module.exports = {
  REQUIRED_TOOLS,
  assertSpriteToolSchemas,
  chooseSpriteType,
  makePngHeader,
  validationErrorCount,
  run,
};
