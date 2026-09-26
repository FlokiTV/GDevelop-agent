const fs = require('fs');
const os = require('os');
const path = require('path');
const { connectLiveGDevelopMcp, sanitizeForReplay } = require('./McpClient');

const PROJECT_A = 'DX40 Multi Project A';
const PROJECT_B = 'DX40 Multi Project B';
const SCENE_A = 'DX40SceneA';
const SCENE_B = 'DX40SceneB';
const BLOCKED_SCENE = 'DX40CrossProjectMutationShouldNotExist';

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const wait = milliseconds =>
  new Promise(resolve => setTimeout(resolve, milliseconds));

const parseArgs = argv => {
  const options = {
    discoveryPath: process.env.GDEVELOP_MCP_DISCOVERY || null,
    evidencePath: null,
    label: 'live',
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--discovery')
      options.discoveryPath = argv[++index] || null;
    else if (argument === '--evidence')
      options.evidencePath = argv[++index] || null;
    else if (argument === '--label') options.label = argv[++index] || 'live';
    else throw new Error(`unknown_argument:${argument}`);
  }
  return options;
};

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

const expectErrorCode = (result, code) => {
  assert(result && result.isError === true, `expected_error:${code}`);
  const actual =
    result.structuredContent &&
    result.structuredContent.error &&
    result.structuredContent.error.code;
  assert(actual === code, `expected_error:${code}:actual:${actual}`);
  return result.structuredContent.error;
};

const revisionOf = result => {
  const revision = result && result.meta && result.meta.projectRevision;
  assert(Number.isInteger(revision), 'missing_project_revision');
  return revision;
};

const sceneSelectorFrom = (targetStatus, sceneName) => {
  const editor = targetStatus.data && targetStatus.data.editor;
  const candidates = [];
  if (editor && editor.activeScene) candidates.push(editor.activeScene);
  if (editor && Array.isArray(editor.activeSceneCandidates)) {
    candidates.push(...editor.activeSceneCandidates);
  }
  if (editor && editor.lastOpenedScene) candidates.push(editor.lastOpenedScene);
  const match = candidates.find(
    candidate => candidate && candidate.sceneName === sceneName
  );
  assert(match && match.selector, `missing_scene_selector:${sceneName}`);
  return match.selector;
};

const connect = ({ discoveryPath, windowId, suffix }) =>
  connectLiveGDevelopMcp({
    discoveryPath,
    windowId,
    clientId: `gdevelop-dx40-multiproject-${suffix}`,
    agentId: 'dx40-multiproject-agent',
    sessionId: `dx40-multiproject-${suffix}`,
    taskId: 'dx40-target-identity',
  });

const run = async ({
  discoveryPath,
  evidencePath: requestedEvidencePath,
  label = 'live',
} = {}) => {
  assert(discoveryPath, 'missing_discovery_path');
  const evidencePath =
    requestedEvidencePath ||
    path.join(
      os.tmpdir(),
      `gdevelop-dx40-multiproject-${label}-${process.pid}.json`
    );

  let root = null;
  let sessionA = null;
  let sessionB = null;
  let previewBOpen = false;

  try {
    root = await connect({ discoveryPath, suffix: 'root' });
    const windowsResult = await callOk(root, 'desktop.windows.list', {});
    const editorWindows = (windowsResult.data || [])
      .filter(window => window && window.editorWindow)
      .sort((left, right) => left.windowId - right.windowId);
    assert(editorWindows.length >= 2, 'dx40_requires_two_editor_windows');
    const windowA = editorWindows[0].windowId;
    const windowB = editorWindows[1].windowId;
    assert(windowA !== windowB, 'dx40_editor_windows_not_distinct');
    await root.close();
    root = null;

    sessionA = await connect({ discoveryPath, windowId: windowA, suffix: 'a' });
    sessionB = await connect({ discoveryPath, windowId: windowB, suffix: 'b' });

    for (const session of [sessionA, sessionB]) {
      const status = await callOk(session, 'project.status', {});
      if (status.data && status.data.preview && status.data.preview.running) {
        await callOk(session, 'preview.close-all', {});
      }
      if (status.data && status.data.projectOpen) {
        await callOk(session, 'project.close', { discardUnsavedChanges: true });
      }
    }

    await callOk(sessionA, 'project.create', { name: PROJECT_A });
    await callOk(sessionB, 'project.create', { name: PROJECT_B });
    await sessionA.close();
    await sessionB.close();
    sessionA = null;
    sessionB = null;
    await wait(600);

    sessionA = await connect({
      discoveryPath,
      windowId: windowA,
      suffix: 'a2',
    });
    sessionB = await connect({
      discoveryPath,
      windowId: windowB,
      suffix: 'b2',
    });

    const projectStatusA = await callOk(sessionA, 'project.status', {});
    const projectStatusB = await callOk(sessionB, 'project.status', {});
    const projectIdA = projectStatusA.data && projectStatusA.data.projectUuid;
    const projectIdB = projectStatusB.data && projectStatusB.data.projectUuid;
    assert(projectIdA && projectIdB, 'dx40_project_ids_missing');
    assert(projectIdA !== projectIdB, 'dx40_project_ids_not_distinct');

    await callOk(sessionA, 'editor.functions.create-scene', {
      scene_name: SCENE_A,
      is_first_scene: true,
      expectedRevision: revisionOf(projectStatusA),
      expectedProjectId: projectIdA,
      idempotencyKey: `dx40-multiproject-a-${label}`,
    });
    await callOk(sessionB, 'editor.functions.create-scene', {
      scene_name: SCENE_B,
      is_first_scene: true,
      expectedRevision: revisionOf(projectStatusB),
      expectedProjectId: projectIdB,
      idempotencyKey: `dx40-multiproject-b-${label}`,
    });
    await callOk(sessionA, 'scene.open', {
      sceneName: SCENE_A,
      mode: 'scene',
      expectedProjectId: projectIdA,
    });
    await callOk(sessionB, 'scene.open', {
      sceneName: SCENE_B,
      mode: 'scene',
      expectedProjectId: projectIdB,
    });
    await wait(300);

    const targetA = await callOk(sessionA, 'target.status', {});
    const targetB = await callOk(sessionB, 'target.status', {});
    const sceneSelectorA = sceneSelectorFrom(targetA, SCENE_A);
    const sceneSelectorB = sceneSelectorFrom(targetB, SCENE_B);

    const blockedMutation = await sessionA.call(
      'editor.functions.create-scene',
      {
        scene_name: BLOCKED_SCENE,
        expectedProjectId: projectIdB,
        expectedRevision: revisionOf(
          await callOk(sessionA, 'project.status', {})
        ),
        idempotencyKey: `dx40-cross-project-blocked-${label}`,
      }
    );
    const mutationError = expectErrorCode(blockedMutation, 'target_mismatch');

    const blockedPreviewLaunch = await sessionA.call('preview.start', {
      numberOfWindows: 1,
      waitUntilReady: true,
      readyTimeoutMs: 10000,
      expectedProjectId: projectIdB,
      expectedSceneSelector: sceneSelectorB,
    });
    const previewLaunchError = expectErrorCode(
      blockedPreviewLaunch,
      'target_mismatch'
    );

    const afterBlockedMutationA = await callOk(sessionA, 'project.status', {});
    const afterBlockedMutationB = await callOk(sessionB, 'project.status', {});
    assert(
      !afterBlockedMutationA.data.sceneNames.includes(BLOCKED_SCENE) &&
        !afterBlockedMutationB.data.sceneNames.includes(BLOCKED_SCENE),
      'dx40_cross_project_mutation_was_applied'
    );
    const previewStatusA = await callOk(sessionA, 'preview.status', {});
    assert(
      previewStatusA.data && previewStatusA.data.state === 'stopped',
      'dx40_cross_project_preview_launch_started_preview'
    );

    const previewStartB = await callOk(sessionB, 'preview.start', {
      numberOfWindows: 1,
      waitUntilReady: true,
      readyTimeoutMs: 15000,
      expectedProjectId: projectIdB,
      expectedSceneSelector: sceneSelectorB,
    });
    previewBOpen = true;
    assert(
      previewStartB.data.state === 'ready',
      'dx40_project_b_preview_not_ready'
    );

    let targetWithPreviewB = null;
    let previewB = null;
    for (let attempt = 0; attempt < 30; attempt++) {
      targetWithPreviewB = await callOk(sessionB, 'target.status', {});
      previewB =
        targetWithPreviewB.data.preview &&
        Array.isArray(targetWithPreviewB.data.preview.targets)
          ? targetWithPreviewB.data.preview.targets.find(
              candidate =>
                candidate &&
                candidate.ready === true &&
                Number.isInteger(candidate.windowId) &&
                typeof candidate.debuggerId === 'string'
            )
          : null;
      if (previewB) break;
      await wait(100);
    }
    assert(previewB, 'dx40_project_b_preview_target_missing');
    assert(
      previewB.projectId === projectIdB,
      'dx40_preview_b_project_mismatch'
    );
    assert(
      previewB.sceneSelector === sceneSelectorB,
      'dx40_preview_b_scene_mismatch'
    );

    const expectedPreviewB = {
      targetId: previewB.targetId,
      windowId: previewB.windowId,
      debuggerId: previewB.debuggerId,
      sceneSelector: previewB.sceneSelector,
    };

    await callOk(sessionB, 'preview.input.runtime-status', {
      previewWindowId: previewB.windowId,
      expectedProjectId: projectIdB,
      expectedPreviewTarget: expectedPreviewB,
    });
    await callOk(sessionB, 'desktop.window.capture', {
      windowId: previewB.windowId,
      maxWidth: 64,
      maxHeight: 64,
      expectedProjectId: projectIdB,
      expectedPreviewTarget: expectedPreviewB,
    });

    const blockedInput = await sessionA.call('preview.input.runtime-status', {
      previewWindowId: previewB.windowId,
      expectedProjectId: projectIdA,
    });
    const inputError = expectErrorCode(blockedInput, 'target_mismatch');

    const blockedCapture = await sessionA.call('desktop.window.capture', {
      windowId: previewB.windowId,
      maxWidth: 64,
      maxHeight: 64,
      expectedProjectId: projectIdA,
    });
    const captureError = expectErrorCode(blockedCapture, 'target_mismatch');

    const blockedRuntime = await sessionA.call('runtime.status', {
      debuggerId: previewB.debuggerId,
      expectedProjectId: projectIdA,
      expectedPreviewTarget: expectedPreviewB,
    });
    const runtimeError = expectErrorCode(blockedRuntime, 'target_mismatch');

    const validationA = await callOk(sessionA, 'validation.run', {
      includeNativeReport: false,
      includeAssets: false,
    });
    const validationB = await callOk(sessionB, 'validation.run', {
      includeNativeReport: false,
      includeAssets: false,
    });
    const errorsOf = result =>
      result.data &&
      result.data.summary &&
      Number.isInteger(result.data.summary.errors)
        ? result.data.summary.errors
        : 0;
    assert(errorsOf(validationA) === 0, 'dx40_project_a_validation_errors');
    assert(errorsOf(validationB) === 0, 'dx40_project_b_validation_errors');

    const evidence = sanitizeForReplay({
      kind: 'dx40-multi-project-target-isolation-acceptance',
      label,
      generatedAt: new Date().toISOString(),
      protocolVersion: sessionA.protocolVersion,
      windows: {
        editorWindowA: windowA,
        editorWindowB: windowB,
        distinct: true,
      },
      projects: {
        projectA: { projectId: projectIdA, sceneSelector: sceneSelectorA },
        projectB: { projectId: projectIdB, sceneSelector: sceneSelectorB },
        distinct: true,
      },
      blockedFromProjectA: {
        crossProjectMutation: {
          rejected: true,
          code: mutationError.code,
          conflictScope:
            mutationError.details && mutationError.details.conflictScope,
        },
        crossProjectPreviewLaunch: {
          rejected: true,
          code: previewLaunchError.code,
          conflictScope:
            previewLaunchError.details &&
            previewLaunchError.details.conflictScope,
        },
        projectBPreviewInput: {
          rejected: true,
          code: inputError.code,
          conflictScope: inputError.details && inputError.details.conflictScope,
        },
        projectBPreviewCapture: {
          rejected: true,
          code: captureError.code,
          conflictScope:
            captureError.details && captureError.details.conflictScope,
        },
        projectBPreviewRuntime: {
          rejected: true,
          code: runtimeError.code,
          conflictScope:
            runtimeError.details && runtimeError.details.conflictScope,
        },
      },
      projectBPreview: {
        windowId: previewB.windowId,
        debuggerId: previewB.debuggerId,
        targetId: previewB.targetId,
        projectId: previewB.projectId,
        sceneSelector: previewB.sceneSelector,
        ownInputSucceeded: true,
        ownCaptureSucceeded: true,
      },
      mutationAbsentFromBothProjects: true,
      validation: {
        projectAErrors: errorsOf(validationA),
        projectBErrors: errorsOf(validationB),
      },
    });

    fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          label,
          evidencePath,
          editorWindows: [windowA, windowB],
          projectIdsDistinct: true,
          blockedCrossProjectMutation: true,
          blockedCrossProjectPreviewLaunch: true,
          blockedProjectBPreviewFromA: true,
          validationErrors: [errorsOf(validationA), errorsOf(validationB)],
        },
        null,
        2
      )}\n`
    );
    return evidence;
  } finally {
    if (previewBOpen && sessionB) {
      try {
        await sessionB.call('preview.close-all', {});
      } catch (_) {}
    }
    for (const session of [sessionA, sessionB]) {
      if (!session) continue;
      try {
        await session.call('project.close', { discardUnsavedChanges: true });
      } catch (_) {}
      try {
        await session.close();
      } catch (_) {}
    }
    if (root) {
      try {
        await root.close();
      } catch (_) {}
    }
  }
};

if (require.main === module) {
  run(parseArgs(process.argv.slice(2))).catch(error => {
    console.error(error && error.stack ? error.stack : String(error));
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, run };
