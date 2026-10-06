const fs = require('fs');
const os = require('os');
const path = require('path');
const { connectLiveGDevelopMcp, sanitizeForReplay } = require('./McpClient');

const REQUIRED_TOOLS = [
  'project.status',
  'project.create',
  'project.save-as',
  'project.close',
  'scene.open',
  'scene.layers.create',
  'scene.layers.list',
  'scene.layers.visual.capabilities',
  'scene.layers.visual.inspect',
  'scene.layers.camera.update',
  'scene.layers.effects.add',
  'scene.layers.effects.update',
  'scene.layers.effects.reorder',
  'scene.layers.effects.remove',
  'editor.types.effects.list',
  'editor.types.effects.describe',
  'events.instructions.search',
  'events.instructions.describe',
  'events.read',
  'events.insert',
  'preview.status',
  'preview.start',
  'preview.close-all',
  'preview.viewport.status',
  'preview.viewport.set',
  'preview.visual.baseline.capture',
  'preview.visual.baseline.compare',
  'runtime.snapshot',
  'validation.run',
  'safety.transactions.begin',
  'safety.transactions.rollback',
];

const VIEWPORT = { width: 640, height: 360 };

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const closeEnough = (actual, expected, epsilon = 0.01) =>
  Number.isFinite(Number(actual)) &&
  Math.abs(Number(actual) - expected) <= epsilon;

const isDisposableAcceptanceFixture = status => {
  if (
    !status ||
    status.projectOpen !== true ||
    status.projectName !== 'DX32 Layer Visual Acceptance' ||
    typeof status.fileIdentifier !== 'string'
  ) {
    return false;
  }
  const resolved = path.resolve(status.fileIdentifier);
  const relativeToTemp = path.relative(os.tmpdir(), resolved);
  const insideTemp =
    relativeToTemp !== '' &&
    !relativeToTemp.startsWith('..') &&
    !path.isAbsolute(relativeToTemp);
  return (
    insideTemp &&
    path.basename(resolved).toLowerCase() === 'game.json' &&
    resolved
      .split(path.sep)
      .some(part => part.startsWith('gdevelop-dx32-layer-visual-'))
  );
};

const buildCameraActionParameters = ({ instruction, layerName, value }) => {
  const parameters = Array.isArray(instruction && instruction.parameters)
    ? instruction.parameters
    : [];
  const maxIndex = Math.max(
    -1,
    ...parameters.map(parameter => parameter.index).filter(Number.isInteger)
  );
  const result = Array.from({ length: maxIndex + 1 }, () => '');
  let valueAssigned = false;

  parameters.forEach(parameter => {
    if (!Number.isInteger(parameter.index)) return;
    const index = parameter.index;
    const type = String(parameter.type || '').toLowerCase();
    const name = String(parameter.name || '').toLowerCase();
    const description = String(parameter.description || '').toLowerCase();

    if (parameter.codeOnly) {
      result[index] = '';
      return;
    }
    if (type === 'layer' || name.includes('layer')) {
      result[index] = JSON.stringify(layerName);
      return;
    }
    if (type === 'operator' || name.includes('operator')) {
      result[index] = '=';
      return;
    }
    if (
      description.includes('camera number') ||
      (name.includes('camera') && name.includes('number'))
    ) {
      result[index] = '0';
      return;
    }
    if (
      !valueAssigned &&
      (type === 'expression' ||
        (parameter.valueType && parameter.valueType.number))
    ) {
      result[index] = String(value);
      valueAssigned = true;
      return;
    }
    if (
      parameter.defaultValue !== undefined &&
      parameter.defaultValue !== null
    ) {
      result[index] = String(parameter.defaultValue).replace(/^"|"$/g, '');
    }
  });

  assert(
    valueAssigned,
    'dx32_camera_action_value_parameter_not_discovered:' +
      (instruction && instruction.id)
  );
  return result;
};

const deriveEffectPropertyValue = property => {
  const choices = Array.isArray(property && property.choices)
    ? property.choices
    : [];
  const defaultValue = property && property.defaultValue;
  if (choices.length) {
    const alternative = choices.find(
      choice => String(choice.value) !== String(defaultValue)
    );
    return String((alternative || choices[0]).value);
  }

  const type = String((property && property.type) || '').toLowerCase();
  if (type === 'number') {
    const parsed = Number(defaultValue);
    if (/opacity|intensity|strength|amount/i.test(property.name || '')) {
      return parsed === 0.65 ? 0.55 : 0.65;
    }
    return Number.isFinite(parsed) ? parsed : 1;
  }
  if (type === 'boolean') {
    return String(defaultValue).toLowerCase() !== 'true';
  }
  return typeof defaultValue === 'string'
    ? defaultValue
    : String(defaultValue || '');
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
  assert(Number.isInteger(revision), 'dx32_missing_project_revision');
  return revision;
};

const validationErrorCount = validation =>
  validation &&
  validation.summary &&
  Number.isInteger(validation.summary.errors)
    ? validation.summary.errors
    : validation &&
      validation.summary &&
      Number.isInteger(validation.summary.diagnosticErrors)
    ? validation.summary.diagnosticErrors
    : validation &&
      validation.diagnostics &&
      validation.diagnostics.summary &&
      Number.isInteger(validation.diagnostics.summary.errors)
    ? validation.diagnostics.summary.errors
    : validation && Array.isArray(validation.errors)
    ? validation.errors.length
    : 0;

const wait = milliseconds =>
  new Promise(resolve => setTimeout(resolve, milliseconds));

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
        'dx32_clean_room_repository_read_forbidden:' + path.basename(resolved)
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
    'gdevelop-dx32-layer-visual-' + process.pid + '.json'
  ),
} = {}) => {
  const rootDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gdevelop-dx32-layer-visual-')
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

  const call = async (name, args = {}, { allowError = false } = {}) => {
    const result = await session.call(name, args);
    record(name, args, result);
    if (result.isError && !allowError) {
      const error = extractError(result);
      throw new Error(
        'dx32_tool_failed:' +
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
      idempotencyKey: 'dx32-' + name + '-' + revision + '-' + replay.length,
    });
    if (transactionId) {
      const meta =
        result.meta ||
        (result.structuredContent && result.structuredContent.meta) ||
        null;
      assert(
        meta && meta.transactionId === transactionId,
        'dx32_transaction_metadata_missing:' + name
      );
    }
    return result;
  };

  try {
    session = await connectLiveGDevelopMcp({
      clientId: 'gdevelop-dx32-layer-visual-' + label,
      confirmDestructiveOperations: true,
    });
    const tools = await session.listTools();
    for (const name of REQUIRED_TOOLS) {
      assert(
        tools.some(tool => tool.name === name),
        'dx32_missing_tool:' + name
      );
    }

    const initialStatus = getData(await call('project.status'));
    if (initialStatus && initialStatus.projectOpen === true) {
      assert(
        isDisposableAcceptanceFixture(initialStatus),
        'dx32_requires_fresh_editor:' +
          JSON.stringify({
            projectName: initialStatus.projectName || null,
            fileIdentifier: initialStatus.fileIdentifier || null,
            hasUnsavedChanges: !!initialStatus.hasUnsavedChanges,
          })
      );
      if (initialStatus.preview && initialStatus.preview.running) {
        await call('preview.close-all');
        for (let attempt = 0; attempt < 40; attempt++) {
          const previewStatus = getData(await call('preview.status'));
          if (
            previewStatus &&
            (previewStatus.state === 'stopped' ||
              previewStatus.running === false)
          ) {
            break;
          }
          await wait(250);
        }
      }
      await call('project.close', {
        discardUnsavedChanges: true,
        idempotencyKey: 'dx32-clean-residual-acceptance-fixture',
      });
      const statusAfterCleanup = getData(await call('project.status'));
      assert(
        !statusAfterCleanup || statusAfterCleanup.projectOpen !== true,
        'dx32_residual_fixture_cleanup_failed'
      );
    }

    await call('project.create', {
      name: 'DX32 Layer Visual Acceptance',
      idempotencyKey: 'dx32-create-project',
    });
    let statusAfterCreate = null;
    for (let attempt = 0; attempt < 40; attempt++) {
      statusAfterCreate = getData(await call('project.status'));
      if (statusAfterCreate && statusAfterCreate.projectOpen === true) break;
      await wait(250);
    }
    assert(
      statusAfterCreate && statusAfterCreate.projectOpen === true,
      'dx32_project_create_not_visible'
    );
    projectOpen = true;
    await call('project.save-as', {
      filePath: projectFile,
      name: 'DX32 Layer Visual Acceptance',
    });

    const createdStatus = getData(await call('project.status'));
    const sceneName =
      createdStatus &&
      Array.isArray(createdStatus.sceneNames) &&
      createdStatus.sceneNames[0];
    assert(sceneName, 'dx32_scene_missing');

    const begun = getData(
      await call('safety.transactions.begin', {
        label: 'DX-32 layer camera and effects acceptance',
      })
    );
    transactionId = begun && begun.transactionId;
    assert(transactionId, 'dx32_transaction_missing');

    await mutate('scene.layers.create', {
      sceneName,
      name: 'Gameplay',
      position: 1,
    });
    await mutate('scene.layers.create', {
      sceneName,
      name: 'UI',
      position: 2,
    });

    const capabilities = getData(
      await call('scene.layers.visual.capabilities')
    );
    assert(
      capabilities &&
        capabilities.authority === 'editor-project' &&
        capabilities.runtimeStateTool === 'runtime.snapshot' &&
        Array.isArray(capabilities.runtimeCameraFields) &&
        capabilities.runtimeCameraFields.includes('zoom') &&
        Array.isArray(capabilities.unavailablePersistentCameraFields) &&
        capabilities.effectTypeDiscovery &&
        capabilities.effectTypeDiscovery.describe ===
          'editor.types.effects.describe',
      'dx32_visual_capabilities_invalid'
    );

    const uiBefore = getData(
      await call('scene.layers.visual.inspect', {
        sceneName,
        layerName: 'UI',
      })
    );

    const cameraUpdated = getData(
      await mutate('scene.layers.camera.update', {
        sceneName,
        layerName: 'Gameplay',
        renderingType: '2d',
        cameraType: 'perspective',
        defaultCameraBehavior: 'do-nothing',
        followsBaseLayerCamera: false,
        fieldOfView: 55,
        nearPlaneDistance: 1,
        farPlaneDistance: 4000,
        plane2DMaxDrawingDistance: 2000,
        cameraCount: 1,
      })
    );
    assert(
      cameraUpdated &&
        cameraUpdated.after &&
        cameraUpdated.after.name === 'Gameplay' &&
        cameraUpdated.after.camera3D.fieldOfView === 55 &&
        cameraUpdated.after.cameraCount === 1 &&
        cameraUpdated.runtimeDynamicStateModified === false,
      'dx32_persistent_camera_update_failed'
    );

    const preferredEffects = getData(
      await call('editor.types.effects.list', {
        query: 'Sepia',
        renderingMode: '2d',
        deprecated: 'exclude',
        includeHidden: false,
        limit: 25,
        offset: 0,
      })
    );
    let effectCandidates = Array.isArray(preferredEffects.items)
      ? preferredEffects.items
      : [];
    if (!effectCandidates.length) {
      const allEffects = getData(
        await call('editor.types.effects.list', {
          renderingMode: '2d',
          deprecated: 'exclude',
          includeHidden: false,
          limit: 100,
          offset: 0,
        })
      );
      effectCandidates = Array.isArray(allEffects.items)
        ? allEffects.items
        : [];
    }
    assert(effectCandidates.length > 0, 'dx32_no_2d_effect_types_discovered');

    effectCandidates = [...effectCandidates].sort((a, b) => {
      const aPreferred = /sepia/i.test(String(a.type || a.name || '')) ? 0 : 1;
      const bPreferred = /sepia/i.test(String(b.type || b.name || '')) ? 0 : 1;
      return aPreferred - bPreferred;
    });

    let describedEffect = null;
    let effectProperty = null;
    for (const candidate of effectCandidates) {
      const extension =
        typeof candidate.extension === 'string'
          ? candidate.extension
          : candidate.extension && candidate.extension.name;
      const effectDescription = getData(
        await call('editor.types.effects.describe', {
          type: candidate.type,
          ...(extension ? { extension } : {}),
        })
      );
      const item = effectDescription && effectDescription.item;
      if (!item || item.kind !== 'effect' || item.onlyWorkingFor3D) continue;
      const property = (item.properties || []).find(current =>
        ['number', 'boolean', 'string'].includes(
          String(current.type || '').toLowerCase()
        )
      );
      if (property) {
        describedEffect = item;
        effectProperty = property;
        break;
      }
    }
    assert(
      describedEffect && effectProperty,
      'dx32_effect_schema_discovery_failed'
    );

    const effectName = 'DX32Effect';
    const configuredEffectValue = deriveEffectPropertyValue(effectProperty);
    const addedEffect = getData(
      await mutate('scene.layers.effects.add', {
        sceneName,
        layerName: 'Gameplay',
        effectName,
        effectType: describedEffect.type,
        enabled: false,
      })
    );
    assert(
      addedEffect &&
        addedEffect.created &&
        addedEffect.created.type === describedEffect.type &&
        addedEffect.created.enabled === false,
      'dx32_effect_add_failed'
    );

    const updatedEffect = getData(
      await mutate('scene.layers.effects.update', {
        sceneName,
        layerName: 'Gameplay',
        effectName,
        enabled: true,
        properties: { [effectProperty.name]: configuredEffectValue },
      })
    );
    const updatedProperty =
      updatedEffect &&
      updatedEffect.after &&
      updatedEffect.after.properties.find(
        property => property.name === effectProperty.name
      );
    assert(
      updatedEffect &&
        updatedEffect.after &&
        updatedEffect.after.enabled === true &&
        updatedProperty &&
        String(updatedProperty.value) === String(configuredEffectValue),
      'dx32_effect_parameter_update_failed'
    );

    const gameplayInspect = getData(
      await call('scene.layers.visual.inspect', {
        sceneName,
        layerName: 'Gameplay',
      })
    );
    const uiAfter = getData(
      await call('scene.layers.visual.inspect', {
        sceneName,
        layerName: 'UI',
      })
    );
    assert(
      gameplayInspect &&
        gameplayInspect.layer &&
        gameplayInspect.layer.effects.some(
          effect =>
            effect.name === effectName &&
            effect.type === describedEffect.type &&
            effect.enabled === true
        ),
      'dx32_effect_inspection_missing'
    );
    assert(
      uiBefore &&
        uiAfter &&
        JSON.stringify(uiBefore.layer) === JSON.stringify(uiAfter.layer),
      'dx32_ui_layer_changed_by_gameplay_configuration'
    );

    const invalidEffectRevisionBefore = revisionOf(
      await call('project.status')
    );
    const invalidEffect = await call(
      'scene.layers.effects.update',
      {
        sceneName,
        layerName: 'Gameplay',
        effectName,
        properties: { doesNotExist: 1 },
        expectedRevision: invalidEffectRevisionBefore,
        idempotencyKey: 'dx32-invalid-effect-parameter',
      },
      { allowError: true }
    );
    const invalidEffectError = extractError(invalidEffect);
    assert(
      invalidEffect.isError &&
        invalidEffectError &&
        invalidEffectError.code === 'effect_parameter_not_found' &&
        invalidEffectError.field === 'doesNotExist',
      'dx32_invalid_effect_parameter_diagnostic_missing'
    );
    const invalidEffectRevisionAfter = revisionOf(await call('project.status'));
    assert(
      invalidEffectRevisionAfter === invalidEffectRevisionBefore,
      'dx32_invalid_effect_parameter_bumped_revision'
    );
    const afterInvalid = getData(
      await call('scene.layers.visual.inspect', {
        sceneName,
        layerName: 'Gameplay',
      })
    );
    assert(
      afterInvalid.layer.effects
        .find(effect => effect.name === effectName)
        .properties.some(
          property =>
            property.name === effectProperty.name &&
            String(property.value) === String(configuredEffectValue)
        ),
      'dx32_invalid_effect_parameter_mutated_state'
    );

    const cameraActions = {};
    for (const id of ['SetCameraCenterX', 'SetCameraCenterY', 'ZoomCamera']) {
      const searched = getData(
        await call('events.instructions.search', {
          kind: 'action',
          query: id,
          deprecated: 'include',
          includeHidden: true,
          limit: 100,
          offset: 0,
        })
      );
      const found = (searched.items || []).find(item => item.id === id);
      assert(found, 'dx32_camera_action_search_failed:' + id);
      const extension =
        typeof found.extension === 'string'
          ? found.extension
          : found.extension && found.extension.name;
      const described = getData(
        await call('events.instructions.describe', {
          kind: 'action',
          id: found.id,
          ...(extension ? { extension } : {}),
          includeHidden: true,
        })
      );
      const item = described && described.item;
      assert(
        item && item.id === id,
        'dx32_camera_action_describe_failed:' + id
      );
      cameraActions[id] = item;
    }

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
              type: { value: cameraActions.SetCameraCenterX.id },
              parameters: buildCameraActionParameters({
                instruction: cameraActions.SetCameraCenterX,
                layerName: 'Gameplay',
                value: 123,
              }),
              subInstructions: [],
            },
            {
              type: { value: cameraActions.SetCameraCenterY.id },
              parameters: buildCameraActionParameters({
                instruction: cameraActions.SetCameraCenterY,
                layerName: 'Gameplay',
                value: 234,
              }),
              subInstructions: [],
            },
            {
              type: { value: cameraActions.ZoomCamera.id },
              parameters: buildCameraActionParameters({
                instruction: cameraActions.ZoomCamera,
                layerName: 'Gameplay',
                value: 1.5,
              }),
              subInstructions: [],
            },
          ],
          events: [],
        },
      ],
    });

    const validation = getData(
      await call('validation.run', {
        includeNativeReport: false,
        includeAssets: false,
      })
    );
    const validationErrors = validationErrorCount(validation);
    assert(
      validationErrors === 0,
      'dx32_validation_errors:' +
        validationErrors +
        ':' +
        JSON.stringify(validation)
    );

    await call('scene.open', { sceneName, mode: 'scene' });
    const started = getData(
      await call('preview.start', {
        numberOfWindows: 1,
        waitUntilReady: true,
        readyTimeoutMs: 10000,
      })
    );
    previewOpen = true;
    const target =
      started &&
      Array.isArray(started.targets) &&
      started.targets.find(
        item =>
          item &&
          item.ready === true &&
          Number.isInteger(item.windowId) &&
          typeof item.debuggerId === 'string'
      );
    assert(target, 'dx32_ready_preview_target_missing');

    const resized = getData(
      await call('preview.viewport.set', {
        previewWindowId: target.windowId,
        width: VIEWPORT.width,
        height: VIEWPORT.height,
        waitUntilApplied: true,
        timeoutMs: 5000,
        restoreWindowState: true,
      })
    );
    assert(
      resized &&
        resized.exact === true &&
        resized.actualViewport.width === VIEWPORT.width &&
        resized.actualViewport.height === VIEWPORT.height,
      'dx32_viewport_not_exact'
    );

    await wait(150);
    const runtime = getData(
      await call('runtime.snapshot', {
        debuggerId: target.debuggerId,
        maxInstances: 20,
      })
    );
    const gameplayRuntime =
      runtime &&
      runtime.scene &&
      Array.isArray(runtime.scene.layers) &&
      runtime.scene.layers.find(layer => layer.name === 'Gameplay');
    const uiRuntime =
      runtime &&
      runtime.scene &&
      Array.isArray(runtime.scene.layers) &&
      runtime.scene.layers.find(layer => layer.name === 'UI');
    assert(
      gameplayRuntime &&
        closeEnough(gameplayRuntime.camera.x, 123) &&
        closeEnough(gameplayRuntime.camera.y, 234) &&
        closeEnough(gameplayRuntime.camera.zoom, 1.5),
      'dx32_gameplay_runtime_camera_not_configured'
    );
    assert(
      uiRuntime &&
        !closeEnough(uiRuntime.camera.x, 123) &&
        !closeEnough(uiRuntime.camera.y, 234) &&
        closeEnough(uiRuntime.camera.zoom, 1),
      'dx32_ui_runtime_camera_was_affected'
    );

    const baselineId = 'dx32-layer-visual-' + process.pid;
    const baseline = getData(
      await call('preview.visual.baseline.capture', {
        previewWindowId: target.windowId,
        baselineId,
        maxWidth: VIEWPORT.width,
        maxHeight: VIEWPORT.height,
      })
    );
    assert(
      baseline &&
        baseline.baselineId === baselineId &&
        Number.isInteger(baseline.bytes) &&
        baseline.bytes > 0,
      'dx32_visual_baseline_capture_failed'
    );

    const compared = getData(
      await call('preview.visual.baseline.compare', {
        previewWindowId: target.windowId,
        baselineId,
        mode: 'exact',
      })
    );
    assert(
      compared &&
        compared.passed === true &&
        compared.exactPngIdentity === true &&
        compared.differentPixelRatio === 0,
      'dx32_visual_baseline_compare_failed'
    );

    await call('preview.close-all');
    previewOpen = false;

    const rollback = getData(
      await call('safety.transactions.rollback', { transactionId })
    );
    assert(
      rollback && rollback.rolledBack !== false,
      'dx32_transaction_rollback_failed'
    );
    transactionId = null;

    const cleanAfterRollback = getData(await call('project.status'));
    assert(
      cleanAfterRollback && cleanAfterRollback.hasUnsavedChanges === false,
      'dx32_project_not_clean_after_rollback'
    );

    await call('project.close', { discardUnsavedChanges: false });
    projectOpen = false;

    const evidence = {
      label,
      protocolVersion: session.protocolVersion,
      sceneName,
      visualCapabilities: {
        persistentCameraFields: capabilities.persistentCameraFields,
        runtimeCameraFields: capabilities.runtimeCameraFields,
        unavailablePersistentCameraFields:
          capabilities.unavailablePersistentCameraFields,
        effectTypeDiscovery: capabilities.effectTypeDiscovery,
      },
      gameplayAuthoring: {
        cameraType: cameraUpdated.after.cameraType,
        cameraCount: cameraUpdated.after.cameraCount,
        fieldOfView: cameraUpdated.after.camera3D.fieldOfView,
        effectType: describedEffect.type,
        effectPropertySchema: effectProperty,
        configuredEffectValue,
      },
      runtimeCamera: {
        gameplay: gameplayRuntime.camera,
        ui: uiRuntime.camera,
        uiUnaffected: true,
      },
      qa: {
        viewport: VIEWPORT,
        baselineId: baseline.baselineId,
        baselineBytes: baseline.bytes,
        visualComparePassed:
          compared.passed === true &&
          compared.exactPngIdentity === true &&
          compared.differentPixelRatio === 0,
      },
      invalidEffectParameterRejectedWithoutMutation: {
        code: invalidEffectError.code,
        field: invalidEffectError.field,
        projectRevisionUnchanged:
          invalidEffectRevisionAfter === invalidEffectRevisionBefore,
      },
      validationErrors,
      transactionRollbackClean: cleanAfterRollback.hasUnsavedChanges === false,
      replay,
    };
    fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    return { evidencePath, evidence };
  } finally {
    try {
      if (session) {
        if (previewOpen) {
          try {
            await session.call('preview.close-all', {});
          } catch (_) {}
        }
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
  VIEWPORT,
  buildCameraActionParameters,
  deriveEffectPropertyValue,
  isDisposableAcceptanceFixture,
  run,
};
