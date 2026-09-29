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
  'objects.behaviors.list',
  'objects.behaviors.available',
  'objects.behaviors.describe',
  'objects.behaviors.add',
  'objects.behaviors.update',
  'objects.behaviors.remove',
  'objects.properties.describe',
  'objects.properties.set',
  'scene.instances.create',
  'scene.open',
  'validation.run',
  'preview.status',
  'preview.start',
  'preview.close-all',
  'preview.layout.inspect',
  'runtime.inspect',
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

const getReadyPreviewTarget = value => {
  const candidates =
    value && Array.isArray(value.targets)
      ? value.targets
      : value && value.preview && Array.isArray(value.preview.targets)
      ? value.preview.targets
      : [];
  return (
    candidates.find(
      target =>
        target &&
        target.ready === true &&
        Number.isInteger(target.windowId) &&
        typeof target.debuggerId === 'string'
    ) ||
    candidates.find(
      target =>
        target &&
        Number.isInteger(target.windowId) &&
        typeof target.debuggerId === 'string'
    ) ||
    null
  );
};

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
  assert(Number.isInteger(revision), 'dx29_missing_project_revision');
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
  assert(tool, 'dx29_missing_tool:' + name);
  return tool;
};

const assertBehaviorToolSchemas = tools => {
  REQUIRED_TOOLS.forEach(name => findTool(tools, name));
  const available = findTool(tools, 'objects.behaviors.available');
  const add = findTool(tools, 'objects.behaviors.add');
  const update = findTool(tools, 'objects.behaviors.update');
  const remove = findTool(tools, 'objects.behaviors.remove');

  assert(
    available.inputSchema &&
      available.inputSchema.properties &&
      available.inputSchema.properties.compatibleOnly &&
      available.inputSchema.properties.includeCapabilities,
    'dx29_available_schema_missing'
  );
  assert(
    add.inputSchema &&
      Array.isArray(add.inputSchema.required) &&
      add.inputSchema.required.includes('objectName') &&
      add.inputSchema.required.includes('behaviorType') &&
      add.inputSchema.properties.behaviorName,
    'dx29_add_schema_missing'
  );
  assert(
    update.inputSchema &&
      update.inputSchema.properties &&
      update.inputSchema.properties.changes &&
      update.inputSchema.properties.changes.items &&
      update.inputSchema.properties.changes.items.properties &&
      update.inputSchema.properties.changes.items.properties.path &&
      update.inputSchema.properties.changes.items.properties.value,
    'dx29_update_schema_missing'
  );
  assert(
    remove.inputSchema &&
      remove.inputSchema.properties &&
      remove.inputSchema.properties.dryRun &&
      remove.inputSchema.properties.dryRun.default === true &&
      remove.inputSchema.properties.cascadeDependents &&
      remove.inputSchema.properties.removeInstanceOverrides,
    'dx29_remove_schema_missing'
  );
};

const chooseResizableCapability = attachedItems => {
  const items = Array.isArray(attachedItems) ? attachedItems : [];
  return (
    items.find(
      item =>
        item &&
        item.capability === true &&
        item.operationDiscovery &&
        item.operationDiscovery.command === 'events.instructions.search' &&
        /resizable/i.test(
          [item.type, item.name, item.metadata && item.metadata.fullName]
            .filter(Boolean)
            .join(' ')
        )
    ) || null
  );
};

const chooseConfigurableCandidate = items => {
  const candidates = Array.isArray(items) ? items : [];
  return (
    candidates.find(
      item =>
        item &&
        item.hidden !== true &&
        item.attachment &&
        item.attachment.addable === true &&
        item.compatibility &&
        item.compatibility.nativeCompatible === true &&
        (!Array.isArray(item.requiredBehaviorTypes) ||
          item.requiredBehaviorTypes.length === 0) &&
        item.parameters &&
        Array.isArray(item.parameters.propertyNames) &&
        item.parameters.propertyNames.length > 0
    ) || null
  );
};

const chooseIncompatibleCandidate = items => {
  const candidates = Array.isArray(items) ? items : [];
  return (
    candidates.find(
      item =>
        item &&
        item.hidden !== true &&
        item.capabilityInterface == null &&
        item.compatibility &&
        item.compatibility.nativeCompatible === false
    ) || null
  );
};

const getChoiceValues = property =>
  property &&
  property.constraints &&
  Array.isArray(property.constraints.choices)
    ? property.constraints.choices
        .map(choice =>
          choice && typeof choice === 'object' ? choice.value : choice
        )
        .filter(
          value =>
            typeof value === 'string' ||
            typeof value === 'number' ||
            typeof value === 'boolean'
        )
    : [];

const chooseSimpleWritableProperty = properties => {
  const writable = (Array.isArray(properties) ? properties : []).filter(
    property =>
      property &&
      property.writable === true &&
      property.path &&
      ['boolean', 'number', 'string'].includes(property.valueType)
  );
  return (
    writable.find(property =>
      getChoiceValues(property).some(value => value !== property.currentValue)
    ) ||
    writable.find(property => getChoiceValues(property).length === 0) ||
    null
  );
};

const nextValueFor = property => {
  const alternateChoice = getChoiceValues(property).find(
    value => value !== property.currentValue
  );
  if (alternateChoice !== undefined) return alternateChoice;
  if (property.valueType === 'boolean') return !property.currentValue;
  if (property.valueType === 'number') {
    const current = Number(property.currentValue);
    return Number.isFinite(current) ? current + 1 : 1;
  }
  return String(property.currentValue || '') + '-dx29-live';
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
        'dx29_clean_room_repository_read_forbidden:' + path.basename(resolved)
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

const findWritableSizeProperties = described => {
  const properties =
    described && Array.isArray(described.properties)
      ? described.properties
      : [];
  const find = name =>
    properties.find(
      property =>
        property &&
        property.name === name &&
        property.writable === true &&
        property.valueType === 'number'
    );
  return { width: find('width'), height: find('height') };
};

const run = async ({
  label = 'live',
  evidencePath = path.join(
    os.tmpdir(),
    `gdevelop-dx29-behavior-lifecycle-${process.pid}.json`
  ),
} = {}) => {
  const rootDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gdevelop-dx29-behavior-lifecycle-')
  );
  const projectDir = path.join(rootDir, 'project');
  const projectFile = path.join(projectDir, 'game.json');
  fs.mkdirSync(projectDir, { recursive: true });

  const restoreRepositoryReads = installRepositoryReadGuard();
  let session = null;
  let transactionId = null;
  let projectOpen = false;
  let previewOpen = false;
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
      clientId: `gdevelop-dx29-behavior-lifecycle-${label}-${suffix}`,
      confirmDestructiveOperations: true,
    });

  const call = async (name, args = {}, { allowError = false } = {}) => {
    const result = await session.call(name, args);
    record(name, args, result);
    if (result.isError && !allowError) {
      const error = extractError(result);
      throw new Error(
        `dx29_tool_failed:${name}:${
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
      idempotencyKey: `dx29-${name}-${revision}-${replay.length}`,
    });
    if (transactionId) {
      const meta =
        result.meta ||
        (result.structuredContent && result.structuredContent.meta) ||
        null;
      assert(
        meta && meta.transactionId === transactionId,
        `dx29_transaction_metadata_missing:${name}`
      );
    }
    return result;
  };

  const isOwnedStaleProject = status => {
    if (
      !status ||
      status.projectOpen !== true ||
      status.projectName !== 'DX29 Behavior Lifecycle Acceptance' ||
      status.hasUnsavedChanges !== false ||
      typeof status.fileIdentifier !== 'string'
    ) {
      return false;
    }
    const normalizedFile = path.resolve(status.fileIdentifier);
    const tempRoot = path.resolve(os.tmpdir());
    const relative = path.relative(tempRoot, normalizedFile);
    if (
      relative === '' ||
      relative.startsWith('..') ||
      path.isAbsolute(relative)
    ) {
      return false;
    }
    return /(?:^|[\\/])gdevelop-dx29-behavior-lifecycle-[^\\/]+[\\/]project[\\/]game\.json$/i.test(
      normalizedFile
    );
  };

  const ensureFreshEditor = async () => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const status = getData(await call('project.status'));
      if (!status || status.projectOpen !== true) return;
      if (!isOwnedStaleProject(status)) {
        throw new Error(
          `dx29_requires_fresh_editor:${JSON.stringify({
            fileIdentifier: status.fileIdentifier,
            projectName: status.projectName,
            hasUnsavedChanges: status.hasUnsavedChanges,
          })}`
        );
      }
      await call('project.close', { discardUnsavedChanges: false });
      await wait(250);
    }
    throw new Error('dx29_stale_project_cleanup_exhausted');
  };

  const closePreview = async () => {
    if (!previewOpen) return;
    await call('preview.close-all');
    previewOpen = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      const status = getData(await call('preview.status'));
      if (status && (status.state === 'stopped' || status.running === false)) {
        return;
      }
      await wait(100);
    }
    throw new Error('dx29_preview_did_not_stop');
  };

  const createObjectCandidates = async ({
    sceneName,
    query,
    prefix,
    maxCandidates = 20,
  }) => {
    const listed = getData(
      await call('editor.types.objects.list', {
        query,
        deprecated: 'exclude',
        renderingMode: '2d',
        limit: 100,
      })
    );
    const candidates =
      listed && Array.isArray(listed.items)
        ? listed.items.filter(item => item && item.kind === 'object')
        : [];
    const created = [];
    for (
      let index = 0;
      index < Math.min(candidates.length, maxCandidates);
      index++
    ) {
      const candidate = candidates[index];
      const objectName = `${prefix}${index}`;
      try {
        await mutate('editor.functions.create-object', {
          scene_name: sceneName,
          object_name: objectName,
          object_type: candidate.type,
        });
        created.push({ objectName, objectType: candidate.type });
      } catch (_) {}
    }
    return created;
  };

  const findResizableObject = async (sceneName, suffix) => {
    const created = [
      ...(await createObjectCandidates({
        sceneName,
        query: 'tiled',
        prefix: `DX29Resizable${suffix}T`,
        maxCandidates: 12,
      })),
      ...(await createObjectCandidates({
        sceneName,
        query: 'sprite',
        prefix: `DX29Resizable${suffix}S`,
        maxCandidates: 12,
      })),
    ];
    for (const candidate of created) {
      const attached = getData(
        await call('objects.behaviors.list', {
          sceneName,
          objectName: candidate.objectName,
        })
      );
      const capability = chooseResizableCapability(attached && attached.items);
      if (!capability) continue;
      const described = getData(
        await call('objects.behaviors.describe', {
          sceneName,
          objectName: candidate.objectName,
          behaviorName: capability.name,
        })
      );
      const actions =
        described &&
        described.behavior &&
        described.behavior.operations &&
        Array.isArray(described.behavior.operations.actions)
          ? described.behavior.operations.actions
          : [];
      const setWidth = actions.find(action => /SetWidth$/.test(action.id));
      const setHeight = actions.find(action => /SetHeight$/.test(action.id));
      if (!setWidth || !setHeight) continue;
      const properties = getData(
        await call('objects.properties.describe', {
          targetKind: 'object-definition',
          sceneName,
          objectName: candidate.objectName,
        })
      );
      const size = findWritableSizeProperties(properties);
      if (!size.width || !size.height) continue;
      return {
        ...candidate,
        capability,
        setWidth,
        setHeight,
        widthProperty: size.width,
        heightProperty: size.height,
      };
    }
    throw new Error('dx29_resizable_object_not_discovered');
  };

  const findLifecycleCandidate = async (sceneName, objectName) => {
    let offset = 0;
    const compatible = [];
    const incompatible = [];
    do {
      const page = getData(
        await call('objects.behaviors.available', {
          sceneName,
          objectName,
          includeCapabilities: false,
          compatibleOnly: false,
          deprecated: 'exclude',
          limit: 100,
          offset,
        })
      );
      for (const item of (page && page.items) || []) {
        if (
          item &&
          item.compatibility &&
          item.compatibility.nativeCompatible === true
        ) {
          compatible.push(item);
        } else if (
          item &&
          item.compatibility &&
          item.compatibility.nativeCompatible === false
        ) {
          incompatible.push(item);
        }
      }
      if (!page || page.nextOffset == null) break;
      offset = page.nextOffset;
    } while (offset < 10000);
    return {
      configurable: chooseConfigurableCandidate(compatible),
      incompatible: chooseIncompatibleCandidate(incompatible),
      compatible,
      incompatibleItems: incompatible,
    };
  };

  const findConfigurableObject = async (sceneName, suffix, preferred) => {
    const queue = preferred ? [preferred] : [];
    const additional = await createObjectCandidates({
      sceneName,
      query: '',
      prefix: `DX29Lifecycle${suffix}`,
      maxCandidates: 24,
    });
    queue.push(...additional);
    for (const candidate of queue) {
      const lifecycle = await findLifecycleCandidate(
        sceneName,
        candidate.objectName
      );
      if (lifecycle.configurable && lifecycle.incompatible) {
        return { ...candidate, ...lifecycle };
      }
    }
    throw new Error('dx29_lifecycle_object_not_discovered');
  };

  try {
    session = await connect('initial');
    const tools = await session.listTools();
    assertBehaviorToolSchemas(tools);

    await ensureFreshEditor();
    await call('project.create', {
      name: 'DX29 Behavior Lifecycle Acceptance',
      idempotencyKey: 'dx29-create-project',
    });
    projectOpen = true;
    await wait(300);
    await call('project.save-as', {
      filePath: projectFile,
      name: 'DX29 Behavior Lifecycle Acceptance',
    });

    const baselinePersistence = getData(
      await call('project.persistence.status')
    );
    assert(
      baselinePersistence &&
        baselinePersistence.persisted &&
        baselinePersistence.persisted.serializedHash,
      'dx29_baseline_persisted_hash_missing'
    );
    const baselinePersistedHash = baselinePersistence.persisted.serializedHash;

    const begun = getData(
      await call('safety.transactions.begin', {
        label: 'DX-29 behavior lifecycle MCP-only acceptance',
      })
    );
    transactionId = begun && begun.transactionId;
    assert(transactionId, 'dx29_transaction_missing');

    const suffix = Date.now().toString(36);
    const sceneName = `DX29Behaviors${suffix}`;
    await mutate('editor.functions.create-scene', { scene_name: sceneName });

    const resizable = await findResizableObject(sceneName, suffix);

    const widthValue = 321;
    const heightValue = 181;
    const sizeMutation = getData(
      await mutate('objects.properties.set', {
        targetKind: 'object-definition',
        sceneName,
        objectName: resizable.objectName,
        changes: [
          { path: resizable.widthProperty.path, value: widthValue },
          { path: resizable.heightProperty.path, value: heightValue },
        ],
      })
    );
    const applied = (sizeMutation && sizeMutation.applied) || [];
    assert(
      applied.some(
        change =>
          change.path === resizable.widthProperty.path &&
          Number(change.value) === widthValue
      ) &&
        applied.some(
          change =>
            change.path === resizable.heightProperty.path &&
            Number(change.value) === heightValue
        ),
      'dx29_size_mutation_response_invalid'
    );

    await mutate('scene.instances.create', {
      sceneName,
      objectName: resizable.objectName,
      position: { x: 80, y: 80 },
    });

    const lifecycle = await findConfigurableObject(sceneName, suffix, {
      objectName: resizable.objectName,
      objectType: resizable.objectType,
    });
    const behaviorName = `DX29LiveBehavior${suffix}`;
    const added = getData(
      await mutate('objects.behaviors.add', {
        sceneName,
        objectName: lifecycle.objectName,
        behaviorType: lifecycle.configurable.type,
        behaviorName,
      })
    );
    assert(
      added &&
        added.added === true &&
        added.behavior &&
        added.behavior.name === behaviorName &&
        added.behavior.type === lifecycle.configurable.type,
      'dx29_live_behavior_add_failed'
    );

    let behaviorDescription = getData(
      await call('objects.behaviors.describe', {
        sceneName,
        objectName: lifecycle.objectName,
        behaviorName,
      })
    );
    const property = chooseSimpleWritableProperty(
      behaviorDescription &&
        behaviorDescription.behavior &&
        behaviorDescription.behavior.properties
    );
    assert(property, 'dx29_live_behavior_property_not_discovered');
    const propertyValue = nextValueFor(property);
    const updated = getData(
      await mutate('objects.behaviors.update', {
        sceneName,
        objectName: lifecycle.objectName,
        behaviorName,
        changes: [{ path: property.path, value: propertyValue }],
      })
    );
    assert(
      updated &&
        updated.updated === true &&
        updated.delegatedTo === 'objects.properties.set',
      'dx29_live_behavior_update_failed'
    );

    behaviorDescription = getData(
      await call('objects.behaviors.describe', {
        sceneName,
        objectName: lifecycle.objectName,
        behaviorName,
      })
    );
    const propertyAfter = (
      (behaviorDescription &&
        behaviorDescription.behavior &&
        behaviorDescription.behavior.properties) ||
      []
    ).find(item => item.path === property.path);
    assert(
      propertyAfter && propertyAfter.currentValue === propertyValue,
      `dx29_live_behavior_property_not_persisted:${JSON.stringify({
        objectType: lifecycle.objectType,
        behaviorType: lifecycle.configurable.type,
        propertyPath: property.path,
        before: property.currentValue,
        expected: propertyValue,
        after: propertyAfter && propertyAfter.currentValue,
      })}`
    );

    const removeDryRunRevision = getRevision(await call('project.status'));
    const removeDryRun = getData(
      await call('objects.behaviors.remove', {
        sceneName,
        objectName: lifecycle.objectName,
        behaviorName,
      })
    );
    assert(
      removeDryRun &&
        removeDryRun.removed === false &&
        removeDryRun.preflight &&
        removeDryRun.preflight.dryRun === true,
      'dx29_live_remove_dry_run_invalid'
    );
    assert(
      getRevision(await call('project.status')) === removeDryRunRevision,
      'dx29_live_remove_dry_run_changed_revision'
    );

    const removed = getData(
      await mutate('objects.behaviors.remove', {
        sceneName,
        objectName: lifecycle.objectName,
        behaviorName,
        dryRun: false,
      })
    );
    assert(
      removed &&
        removed.removed === true &&
        removed.removedBehaviorNames.includes(behaviorName),
      'dx29_live_remove_apply_failed'
    );
    const afterRemove = getData(
      await call('objects.behaviors.list', {
        sceneName,
        objectName: lifecycle.objectName,
      })
    );
    assert(
      !(afterRemove.items || []).some(item => item.name === behaviorName),
      'dx29_live_behavior_survived_remove'
    );

    const revisionBeforeIncompatible = getRevision(
      await call('project.status')
    );
    const incompatibleAttempt = await call(
      'objects.behaviors.add',
      {
        sceneName,
        objectName: lifecycle.objectName,
        behaviorType: lifecycle.incompatible.type,
        behaviorName: `DX29Incompatible${suffix}`,
        expectedRevision: revisionBeforeIncompatible,
        idempotencyKey: `dx29-incompatible-${revisionBeforeIncompatible}`,
      },
      { allowError: true }
    );
    assert(
      incompatibleAttempt.isError === true,
      'dx29_incompatible_behavior_should_fail'
    );
    const incompatibleError = extractError(incompatibleAttempt);
    assert(
      incompatibleError &&
        incompatibleError.code === 'behavior_incompatible_with_object' &&
        incompatibleError.field === 'behaviorType',
      'dx29_incompatible_error_not_structured'
    );
    assert(
      getRevision(await call('project.status')) === revisionBeforeIncompatible,
      'dx29_incompatible_attempt_changed_revision'
    );

    const validation = getData(
      await call('validation.run', {
        includeNativeReport: false,
        includeAssets: true,
      })
    );
    const validationErrors =
      validation && Array.isArray(validation.errors)
        ? validation.errors.length
        : validation && Number.isInteger(validation.errorCount)
        ? validation.errorCount
        : validation &&
          validation.summary &&
          Number.isInteger(validation.summary.errors)
        ? validation.summary.errors
        : 0;
    assert(validationErrors === 0, 'dx29_validation_has_errors');

    await call('scene.open', { sceneName, mode: 'scene' });
    const preview = getData(
      await call('preview.start', {
        numberOfWindows: 1,
        waitUntilReady: true,
        readyTimeoutMs: 10000,
      })
    );
    assert(
      preview && preview.state === 'ready' && preview.runtimeReady === true,
      'dx29_preview_not_ready'
    );
    previewOpen = true;

    let previewTarget = getReadyPreviewTarget(preview);
    for (let attempt = 0; attempt < 30 && !previewTarget; attempt++) {
      await wait(200);
      previewTarget = getReadyPreviewTarget(
        getData(await call('preview.status'))
      );
    }
    assert(previewTarget, 'dx29_ready_preview_target_missing');

    let runtimeReady = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      await wait(attempt === 0 ? 800 : 200);
      try {
        const count = getData(
          await call('runtime.inspect', {
            selector: {
              kind: 'object-count',
              objectName: resizable.objectName,
            },
          })
        );
        if (count && count.value === 1) {
          runtimeReady = true;
          break;
        }
      } catch (_) {}
    }
    assert(runtimeReady, 'dx29_runtime_not_ready');

    const layout = getData(
      await call('preview.layout.inspect', {
        previewWindowId: previewTarget.windowId,
        targets: [
          {
            id: 'dx29-resizable-runtime',
            kind: 'object',
            objectName: resizable.objectName,
            instanceIndex: 0,
          },
        ],
      })
    );
    const runtimeTarget =
      layout && Array.isArray(layout.targets) ? layout.targets[0] : null;
    const runtimeBounds =
      runtimeTarget && runtimeTarget.bounds && runtimeTarget.bounds.scene;
    assert(
      runtimeBounds &&
        Number(runtimeBounds.width) === widthValue &&
        Number(runtimeBounds.height) === heightValue,
      `dx29_runtime_size_mismatch:${JSON.stringify({
        bounds: runtimeBounds,
      })}`
    );
    const runtimeWidth = Number(runtimeBounds.width);
    const runtimeHeight = Number(runtimeBounds.height);

    await closePreview();

    const evidence = sanitizeForReplay({
      kind: 'dx29-behavior-lifecycle-clean-room',
      generatedAt: new Date().toISOString(),
      protocolVersion: session.protocolVersion,
      cleanRoom: {
        repositoryImplementationOrTestsReadDuringScenario: false,
        repositoryReadGuard: true,
        authoringInputSource: 'live MCP discovery and public tools',
      },
      resizable: {
        objectName: resizable.objectName,
        objectType: resizable.objectType,
        capabilityName: resizable.capability.name,
        capabilityType: resizable.capability.type,
        setWidthActionId: resizable.setWidth.id,
        setHeightActionId: resizable.setHeight.id,
        widthPropertyPath: resizable.widthProperty.path,
        heightPropertyPath: resizable.heightProperty.path,
        width: widthValue,
        height: heightValue,
        runtimeWidth,
        runtimeHeight,
      },
      lifecycle: {
        objectName: lifecycle.objectName,
        objectType: lifecycle.objectType,
        behaviorType: lifecycle.configurable.type,
        behaviorName,
        propertyPath: property.path,
        propertyValue,
        removed: true,
        removeDryRun: true,
      },
      incompatible: {
        behaviorType: lifecycle.incompatible.type,
        errorCode: incompatibleError.code,
        field: incompatibleError.field,
        revisionUnchanged: true,
      },
      preview: {
        ready: true,
        runtimeReady: true,
        validationErrors,
      },
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
      'dx29_transaction_rollback_scene_survived'
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
      'dx29_transaction_rollback_not_clean'
    );

    await call('project.close', { discardUnsavedChanges: false });
    projectOpen = false;
    await session.close();
    session = null;
    fs.rmSync(rootDir, { recursive: true, force: true });

    return {
      ok: true,
      protocolVersion: evidence.protocolVersion,
      resizableCapabilityType: resizable.capability.type,
      setWidthActionId: resizable.setWidth.id,
      setHeightActionId: resizable.setHeight.id,
      runtimeWidth,
      runtimeHeight,
      behaviorType: lifecycle.configurable.type,
      behaviorRemoved: true,
      incompatibleBlocked: true,
      transactionRollbackClean: true,
      evidencePath,
    };
  } finally {
    try {
      if (session && previewOpen) {
        await session.call('preview.close-all', {});
      }
    } catch (_) {}
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
        'MCP DX-29 behavior lifecycle scenario failed: ' +
          (error && error.stack ? error.stack : String(error)) +
          '\n'
      );
      process.exitCode = 1;
    });
}

module.exports = {
  REQUIRED_TOOLS,
  assertBehaviorToolSchemas,
  chooseResizableCapability,
  chooseConfigurableCandidate,
  chooseIncompatibleCandidate,
  chooseSimpleWritableProperty,
  extractError,
  nextValueFor,
  run,
};
