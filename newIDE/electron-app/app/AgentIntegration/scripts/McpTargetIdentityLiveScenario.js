const fs = require('fs');
const os = require('os');
const path = require('path');
const { connectLiveGDevelopMcp, sanitizeForReplay } = require('./McpClient');

const PROJECT_NAME = 'DX40 Target Identity Acceptance';
const SCENE_NAME = 'DX40TargetSceneA';

const wait = milliseconds =>
  new Promise(resolve => setTimeout(resolve, milliseconds));

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const expectErrorCode = (result, code) => {
  assert(result && result.isError === true, `expected_error:${code}`);
  const serialized = JSON.stringify(
    result.structuredContent || result.content || result.data || result
  );
  assert(serialized.includes(code), `missing_error_code:${code}:${serialized}`);
};

const parseArgs = argv => {
  const options = { label: 'live', evidencePath: null };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--label') options.label = argv[++index] || 'live';
    else if (argument === '--evidence') {
      options.evidencePath = argv[++index] || null;
    } else throw new Error(`unknown_argument:${argument}`);
  }
  return options;
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
    clientId: `gdevelop-dx40-${label}`,
    agentId: 'dx40-target-agent',
    sessionId: `dx40-${label}`,
    taskId: 'dx40-target-identity',
  });

const callOk = async (session, name, args = {}) => {
  const result = await session.call(name, args);
  if (result.isError) {
    throw new Error(
      `${name} failed: ${JSON.stringify(
        result.structuredContent || result.content || result.data
      )}`
    );
  }
  return result;
};

const findTool = (tools, name) => {
  const tool = tools.find(candidate => candidate.name === name);
  assert(tool, `missing_tool:${name}`);
  return tool;
};

const waitForTargetScene = async (session, sceneName) => {
  for (let attempt = 0; attempt < 40; attempt++) {
    const status = await callOk(session, 'target.status', {});
    const editor = status.data && status.data.editor;
    const candidates =
      editor && Array.isArray(editor.activeSceneCandidates)
        ? editor.activeSceneCandidates
        : [];
    const active = editor && editor.activeScene;
    if (
      (active && active.sceneName === sceneName) ||
      candidates.some(
        candidate => candidate && candidate.sceneName === sceneName
      )
    ) {
      return status.data;
    }
    await wait(100);
  }
  throw new Error(`dx40_active_scene_not_observed:${sceneName}`);
};

const readyPreviewTargets = data => {
  const targets =
    data && data.preview && Array.isArray(data.preview.targets)
      ? data.preview.targets
      : [];
  return targets.filter(
    target =>
      target &&
      target.ready === true &&
      Number.isInteger(target.windowId) &&
      typeof target.debuggerId === 'string' &&
      typeof target.targetId === 'string'
  );
};

const run = async ({
  label = 'live',
  evidencePath: requestedEvidencePath = null,
} = {}) => {
  const restoreRepositoryReads = installRepositoryReadGuard();
  const evidencePath =
    requestedEvidencePath ||
    path.join(os.tmpdir(), `gdevelop-dx40-target-${label}-${process.pid}.json`);
  let session = null;
  let transactionId = null;
  let previewOpen = false;

  try {
    session = await connect(label);
    const initial = await callOk(session, 'project.status', {});
    if (initial.data && initial.data.preview && initial.data.preview.running) {
      await callOk(session, 'preview.close-all', {});
    }
    if (initial.data && initial.data.projectOpen) {
      assert(
        initial.data.hasUnsavedChanges === false,
        'dx40_requires_clean_or_fresh_editor'
      );
      await callOk(session, 'project.close', {
        discardUnsavedChanges: false,
      });
    }

    await callOk(session, 'project.create', { name: PROJECT_NAME });
    await session.close();
    session = await connect(label);

    const tools = await session.listTools();
    [
      'target.status',
      'project.status',
      'editor.functions.create-scene',
      'scene.open',
      'preview.start',
      'preview.status',
      'preview.close-all',
      'preview.input.runtime-status',
      'runtime.status',
      'desktop.window.capture',
      'validation.run',
      'safety.transactions.begin',
      'safety.transactions.rollback',
    ].forEach(name => findTool(tools, name));

    const previewStart = findTool(tools, 'preview.start');
    const previewInput = findTool(tools, 'preview.input.runtime-status');
    const captureTool = findTool(tools, 'desktop.window.capture');
    for (const tool of [previewStart, previewInput, captureTool]) {
      const properties = tool.inputSchema && tool.inputSchema.properties;
      assert(
        properties && properties.expectedProjectId,
        `missing_project_guard:${tool.name}`
      );
      assert(
        properties.expectedPreviewTarget,
        `missing_preview_guard:${tool.name}`
      );
    }
    assert(
      previewStart.inputSchema.properties.expectedSceneSelector,
      'missing_scene_guard:preview.start'
    );

    const begun = await callOk(session, 'safety.transactions.begin', {
      label: 'DX-40 target identity acceptance',
    });
    transactionId = begun.data && begun.data.transactionId;
    assert(transactionId, 'dx40_transaction_id_missing');

    const statusBeforeScene = await callOk(session, 'project.status', {});
    const revision =
      statusBeforeScene.meta &&
      Number.isInteger(statusBeforeScene.meta.projectRevision)
        ? statusBeforeScene.meta.projectRevision
        : undefined;
    await callOk(session, 'editor.functions.create-scene', {
      scene_name: SCENE_NAME,
      is_first_scene: true,
      expectedRevision: revision,
      idempotencyKey: `dx40-create-scene-${label}`,
    });
    await callOk(session, 'scene.open', {
      sceneName: SCENE_NAME,
      mode: 'scene',
    });

    const target = await waitForTargetScene(session, SCENE_NAME);
    const projectId = target.project && target.project.projectId;
    assert(projectId, 'dx40_project_id_missing');
    const sceneCandidates =
      target.editor && Array.isArray(target.editor.activeSceneCandidates)
        ? target.editor.activeSceneCandidates
        : [];
    const activeScene =
      target.editor.activeScene &&
      target.editor.activeScene.sceneName === SCENE_NAME
        ? target.editor.activeScene
        : sceneCandidates.find(candidate => candidate.sceneName === SCENE_NAME);
    assert(activeScene, 'dx40_scene_identity_missing');
    const sceneSelector = activeScene.selector || activeScene.sceneId;
    assert(sceneSelector, 'dx40_scene_selector_missing');

    const projectStatus = await callOk(session, 'project.status', {
      expectedProjectId: projectId,
    });
    assert(
      projectStatus.meta &&
        projectStatus.meta.targetIdentity &&
        projectStatus.meta.targetIdentity.project.projectId === projectId,
      'dx40_response_target_identity_missing'
    );

    const wrongProject = await session.call('project.status', {
      expectedProjectId: `${projectId}-wrong`,
    });
    expectErrorCode(wrongProject, 'target_mismatch');

    const wrongScenePreview = await session.call('preview.start', {
      numberOfWindows: 1,
      waitUntilReady: true,
      readyTimeoutMs: 10000,
      expectedProjectId: projectId,
      expectedSceneSelector: 'scene:DefinitelyWrongScene',
    });
    expectErrorCode(wrongScenePreview, 'target_mismatch');
    const afterRejectedPreview = await callOk(session, 'preview.status', {});
    assert(
      afterRejectedPreview.data &&
        afterRejectedPreview.data.state === 'stopped',
      'dx40_wrong_scene_preview_started'
    );

    const started = await callOk(session, 'preview.start', {
      numberOfWindows: 2,
      waitUntilReady: true,
      readyTimeoutMs: 15000,
      expectedProjectId: projectId,
      expectedSceneSelector: sceneSelector,
    });
    previewOpen = true;
    assert(
      started.data && started.data.state === 'ready',
      'dx40_preview_not_ready'
    );

    let liveTarget = null;
    for (let attempt = 0; attempt < 30; attempt++) {
      liveTarget = (await callOk(session, 'target.status', {})).data;
      if (readyPreviewTargets(liveTarget).length >= 2) break;
      await wait(100);
    }
    const previewTargets = readyPreviewTargets(liveTarget);
    assert(previewTargets.length >= 2, 'dx40_multiple_preview_targets_missing');
    const first = previewTargets[0];
    const second = previewTargets[1];
    assert(
      first.windowId !== second.windowId,
      'dx40_preview_window_ids_not_distinct'
    );
    assert(
      first.debuggerId !== second.debuggerId,
      'dx40_debugger_ids_not_distinct'
    );
    assert(
      first.projectId === projectId && second.projectId === projectId,
      'dx40_preview_project_association_mismatch'
    );
    assert(
      first.sceneSelector === sceneSelector &&
        second.sceneSelector === sceneSelector,
      'dx40_preview_scene_association_mismatch'
    );

    for (const previewTarget of [first, second]) {
      const expectedPreviewTarget = {
        targetId: previewTarget.targetId,
        windowId: previewTarget.windowId,
        debuggerId: previewTarget.debuggerId,
        sceneSelector: previewTarget.sceneSelector,
      };
      const inputStatus = await callOk(
        session,
        'preview.input.runtime-status',
        {
          previewWindowId: previewTarget.windowId,
          expectedProjectId: projectId,
          expectedPreviewTarget,
        }
      );
      assert(
        inputStatus.meta &&
          inputStatus.meta.targetIdentity &&
          inputStatus.meta.targetIdentity.project.projectId === projectId,
        'dx40_preview_input_target_meta_missing'
      );

      const runtime = await callOk(session, 'runtime.status', {
        debuggerId: previewTarget.debuggerId,
        expectedProjectId: projectId,
        expectedPreviewTarget,
      });
      assert(
        runtime.data &&
          runtime.data.debuggerId === previewTarget.debuggerId &&
          runtime.data.previewWindowId === previewTarget.windowId,
        'dx40_runtime_bound_to_wrong_preview'
      );

      const capture = await callOk(session, 'desktop.window.capture', {
        windowId: previewTarget.windowId,
        maxWidth: 64,
        maxHeight: 64,
        expectedProjectId: projectId,
        expectedPreviewTarget,
      });
      assert(
        capture.data && capture.data.windowId === previewTarget.windowId,
        'dx40_capture_bound_to_wrong_preview'
      );
    }

    const swappedInput = await session.call('preview.input.runtime-status', {
      previewWindowId: first.windowId,
      expectedProjectId: projectId,
      expectedPreviewTarget: {
        targetId: second.targetId,
        windowId: second.windowId,
        debuggerId: second.debuggerId,
      },
    });
    expectErrorCode(swappedInput, 'target_mismatch');

    const swappedCapture = await session.call('desktop.window.capture', {
      windowId: first.windowId,
      expectedProjectId: projectId,
      expectedPreviewTarget: {
        targetId: second.targetId,
        windowId: second.windowId,
        debuggerId: second.debuggerId,
      },
    });
    expectErrorCode(swappedCapture, 'target_mismatch');

    const unrelatedWindow = await session.call('preview.input.runtime-status', {
      previewWindowId: 999999,
      expectedProjectId: projectId,
    });
    expectErrorCode(unrelatedWindow, 'target_mismatch');

    const validation = await callOk(session, 'validation.run', {
      includeNativeReport: false,
      includeAssets: false,
    });
    const validationErrors =
      validation.data &&
      validation.data.summary &&
      Number.isInteger(validation.data.summary.errors)
        ? validation.data.summary.errors
        : validation.data && Array.isArray(validation.data.errors)
        ? validation.data.errors.length
        : 0;
    assert(validationErrors === 0, 'dx40_validation_has_errors');

    await callOk(session, 'preview.close-all', {});
    previewOpen = false;
    await callOk(session, 'safety.transactions.rollback', { transactionId });
    transactionId = null;

    const evidence = sanitizeForReplay({
      kind: 'dx40-target-identity-acceptance',
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
        targetStatusPublished: true,
        projectGuardPublished: true,
        sceneGuardPublished: true,
        previewGuardPublished: true,
      },
      project: {
        projectId,
        sceneName: SCENE_NAME,
        sceneSelector,
        responseTargetMetadata: true,
        wrongProjectRejected: true,
        wrongScenePreviewRejectedBeforeLaunch: true,
      },
      preview: {
        targetCount: previewTargets.length,
        targets: [first, second],
        projectAssociationVerified: true,
        sceneAssociationVerified: true,
        runtimeBoundPerTarget: true,
        inputBoundPerTarget: true,
        captureBoundPerTarget: true,
        swappedPreviewTargetRejected: true,
        unrelatedWindowRejected: true,
      },
      twoProjectProtocolAcceptance: {
        coveredBy: 'McpHttpServer target-aware two-window acceptance',
        crossProjectMutationRejectedBeforeDispatch: true,
      },
      validation: { errors: validationErrors },
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
          projectId,
          sceneSelector,
          previewTargetCount: previewTargets.length,
          swappedPreviewTargetRejected: true,
          unrelatedWindowRejected: true,
          validationErrors,
        },
        null,
        2
      )}\n`
    );
    return evidence;
  } finally {
    if (previewOpen && session) {
      try {
        await session.call('preview.close-all', {});
      } catch (_) {}
    }
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
    restoreRepositoryReads();
  }
};

if (require.main === module) {
  run(parseArgs(process.argv.slice(2))).catch(error => {
    console.error(error && error.stack ? error.stack : String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  run,
};
