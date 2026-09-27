const fs = require('fs');
const os = require('os');
const path = require('path');
const { connectLiveGDevelopMcp, sanitizeForReplay } = require('./McpClient');

const PROJECT_NAME = 'DX33 Project Structure Acceptance';
const SCENE_A = 'DX33 Scene A';
const SCENE_B = 'DX33 Scene B';
const SCENE_COPY = 'DX33 Scene B Copy';
const SCENE_RENAMED = 'DX33 Scene B Renamed';
const EXTERNAL_REFERENCED = 'DX33 Referenced Events';
const EXTERNAL_RENAMED = 'DX33 Referenced Events Renamed';
const EXTERNAL_UNREFERENCED = 'DX33 Unreferenced Events';

const wait = milliseconds =>
  new Promise(resolve => setTimeout(resolve, milliseconds));

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
    clientId: `gdevelop-dx33-${label}`,
    agentId: 'dx33-project-structure-agent',
    sessionId: `dx33-${label}`,
    taskId: 'dx33-project-structure',
  });

const getRevision = async session => {
  const status = await callOk(session, 'project.status', {});
  assert(
    status.meta && Number.isInteger(status.meta.projectRevision),
    'missing_project_revision'
  );
  return status.meta.projectRevision;
};

const readEvents = (session, sceneName) =>
  callOk(session, 'events.read', { sceneName });

const getLinkTargets = eventsJson => {
  const targets = [];
  const visit = events => {
    if (!Array.isArray(events)) return;
    events.forEach(event => {
      if (
        event &&
        event.type === 'BuiltinCommonInstructions::Link' &&
        typeof event.target === 'string'
      ) {
        targets.push(event.target);
      }
      if (event && Array.isArray(event.events)) visit(event.events);
    });
  };
  visit(eventsJson);
  return targets;
};

const waitForSceneTarget = async (session, expectedSelector) => {
  for (let attempt = 0; attempt < 40; attempt++) {
    const status = await callOk(session, 'target.status', {});
    const editor = status.data && status.data.editor;
    const active = editor && editor.activeScene;
    const candidates =
      editor && Array.isArray(editor.activeSceneCandidates)
        ? editor.activeSceneCandidates
        : [];
    if (
      (active && active.selector === expectedSelector) ||
      candidates.some(candidate => candidate.selector === expectedSelector)
    ) {
      return status.data;
    }
    await wait(100);
  }
  throw new Error(`active_scene_selector_not_observed:${expectedSelector}`);
};

const run = async ({
  label = 'live',
  evidencePath: requestedEvidencePath = null,
} = {}) => {
  const restoreRepositoryReads = installRepositoryReadGuard();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gdevelop-dx33-'));
  const savePath = path.join(tempDir, 'DX33ProjectStructure.json');
  const evidencePath =
    requestedEvidencePath ||
    path.join(os.tmpdir(), `gdevelop-dx33-${label}-${process.pid}.json`);
  let session = null;
  let previewOpen = false;

  try {
    session = await connect(label);
    const initial = await callOk(session, 'project.status', {});
    assert(
      !initial.data || initial.data.projectOpen === false,
      'dx33_requires_fresh_editor_without_open_project'
    );

    await callOk(session, 'project.create', { name: PROJECT_NAME });
    await session.close();
    session = await connect(label);

    const tools = await session.listTools();
    [
      'project.scenes.list',
      'project.scenes.get',
      'project.scenes.usages',
      'project.scenes.create',
      'project.scenes.duplicate',
      'project.scenes.rename',
      'project.scenes.reorder',
      'project.scenes.delete',
      'external-events.list',
      'external-events.inspect',
      'external-events.usages',
      'external-events.create',
      'external-events.duplicate',
      'external-events.rename',
      'external-events.reorder',
      'external-events.delete',
      'events.read',
      'events.insert',
      'target.status',
      'scene.open',
      'preview.start',
      'preview.close-all',
      'runtime.status',
      'project.save-as',
      'project.reload',
      'validation.run',
    ].forEach(name => findTool(tools, name));

    const sceneListTool = findTool(tools, 'project.scenes.list');
    const sceneRenameTool = findTool(tools, 'project.scenes.rename');
    const externalListTool = findTool(tools, 'external-events.list');
    assert(
      sceneListTool.outputSchema || sceneListTool.inputSchema,
      'scene_list_schema_missing'
    );
    assert(
      sceneRenameTool.inputSchema.properties.sceneId &&
        sceneRenameTool.inputSchema.properties.selector &&
        sceneRenameTool.inputSchema.properties.expectedRevision,
      'scene_stable_target_schema_missing'
    );
    assert(
      externalListTool.inputSchema && externalListTool.inputSchema.properties,
      'external_events_schema_missing'
    );

    let revision = await getRevision(session);
    const sceneAResult = await callOk(session, 'project.scenes.create', {
      name: SCENE_A,
      position: 0,
      expectedRevision: revision,
    });
    const sceneA = sceneAResult.data.scene;
    revision = sceneAResult.meta.projectRevision;

    const sceneBResult = await callOk(session, 'project.scenes.create', {
      name: SCENE_B,
      position: 1,
      expectedRevision: revision,
    });
    const sceneB = sceneBResult.data.scene;
    revision = sceneBResult.meta.projectRevision;

    const duplicate = await callOk(session, 'project.scenes.duplicate', {
      sceneId: sceneB.sceneId,
      newName: SCENE_COPY,
      position: 2,
      expectedRevision: revision,
    });
    const sceneCopy = duplicate.data.scene;
    revision = duplicate.meta.projectRevision;
    assert(
      sceneCopy.sceneId && sceneCopy.sceneId !== sceneB.sceneId,
      'duplicate_scene_identity_not_unique'
    );

    const referencedExternal = await callOk(session, 'external-events.create', {
      name: EXTERNAL_REFERENCED,
      associatedLayout: SCENE_COPY,
      expectedRevision: revision,
    });
    const referencedExternalItem = referencedExternal.data.externalEvents;
    revision = referencedExternal.meta.projectRevision;

    const unreferencedExternal = await callOk(
      session,
      'external-events.create',
      {
        name: EXTERNAL_UNREFERENCED,
        expectedRevision: revision,
      }
    );
    const unreferencedExternalItem = unreferencedExternal.data.externalEvents;
    revision = unreferencedExternal.meta.projectRevision;

    let events = await readEvents(session, SCENE_A);
    const inserted = await callOk(session, 'events.insert', {
      sceneName: SCENE_A,
      expectedEventsRevision: events.data.eventsRevision,
      expectedRevision: revision,
      eventsJson: [
        {
          type: 'BuiltinCommonInstructions::Link',
          target: SCENE_COPY,
        },
        {
          type: 'BuiltinCommonInstructions::Link',
          target: EXTERNAL_REFERENCED,
        },
      ],
    });
    revision = inserted.meta.projectRevision;

    const sceneUsage = await callOk(session, 'project.scenes.usages', {
      sceneId: sceneCopy.sceneId,
    });
    assert(
      sceneUsage.data.total >= 2 &&
        sceneUsage.data.references.some(
          reference => reference.kind === 'event-reference'
        ) &&
        sceneUsage.data.references.some(
          reference => reference.kind === 'external-events-associated-scene'
        ),
      'scene_usage_did_not_find_native_references'
    );

    const renamedScene = await callOk(session, 'project.scenes.rename', {
      sceneId: sceneCopy.sceneId,
      newName: SCENE_RENAMED,
      expectedRevision: revision,
    });
    revision = renamedScene.meta.projectRevision;
    assert(
      renamedScene.data.preservedSceneId === sceneCopy.sceneId &&
        renamedScene.data.scene.sceneId === sceneCopy.sceneId &&
        renamedScene.data.scene.selector === sceneCopy.selector,
      'scene_identity_changed_on_rename'
    );

    events = await readEvents(session, SCENE_A);
    let linkTargets = getLinkTargets(events.data.eventsJson);
    assert(
      linkTargets.includes(SCENE_RENAMED) && !linkTargets.includes(SCENE_COPY),
      'scene_link_reference_not_refactored'
    );

    const externalAfterSceneRename = await callOk(
      session,
      'external-events.inspect',
      { externalEventsId: referencedExternalItem.externalEventsId }
    );
    assert(
      externalAfterSceneRename.data.externalEvents.associatedLayout ===
        SCENE_RENAMED,
      'external_events_scene_association_not_refactored'
    );

    const reordered = await callOk(session, 'project.scenes.reorder', {
      sceneId: sceneCopy.sceneId,
      position: 0,
      expectedRevision: revision,
    });
    revision = reordered.meta.projectRevision;
    const scenesAfterReorder = await callOk(session, 'project.scenes.list', {});
    assert(
      scenesAfterReorder.data.items[0].sceneId === sceneCopy.sceneId &&
        scenesAfterReorder.data.items.some(
          item => item.sceneId === sceneA.sceneId && item.name === SCENE_A
        ) &&
        scenesAfterReorder.data.items.some(
          item => item.sceneId === sceneB.sceneId && item.name === SCENE_B
        ),
      'scene_reorder_changed_unrelated_identity'
    );

    const externalUsage = await callOk(session, 'external-events.usages', {
      externalEventsId: referencedExternalItem.externalEventsId,
    });
    assert(
      externalUsage.data.total >= 1 &&
        externalUsage.data.references.some(
          reference => reference.kind === 'event-reference'
        ),
      'external_events_usage_missing_link'
    );

    const renamedExternal = await callOk(session, 'external-events.rename', {
      externalEventsId: referencedExternalItem.externalEventsId,
      newName: EXTERNAL_RENAMED,
      expectedRevision: revision,
    });
    revision = renamedExternal.meta.projectRevision;
    assert(
      renamedExternal.data.preservedExternalEventsId ===
        referencedExternalItem.externalEventsId,
      'external_events_identity_changed_on_rename'
    );

    events = await readEvents(session, SCENE_A);
    linkTargets = getLinkTargets(events.data.eventsJson);
    assert(
      linkTargets.includes(EXTERNAL_RENAMED) &&
        !linkTargets.includes(EXTERNAL_REFERENCED),
      'external_events_link_reference_not_refactored'
    );

    const referencedDryRun = await callOk(session, 'external-events.delete', {
      externalEventsId: referencedExternalItem.externalEventsId,
      dryRun: true,
      expectedRevision: revision,
    });
    assert(
      referencedDryRun.data.blockerCount >= 1 &&
        referencedDryRun.data.blockers.some(
          reference => reference.kind === 'event-reference'
        ),
      'referenced_external_events_dry_run_missing_blocker'
    );
    assert(
      referencedDryRun.meta &&
        referencedDryRun.meta.modifiesProject === false &&
        referencedDryRun.meta.projectRevision === revision,
      'external_events_dry_run_advanced_revision'
    );

    const blockedDelete = await session.call('external-events.delete', {
      externalEventsId: referencedExternalItem.externalEventsId,
      expectedRevision: revision,
    });
    expectErrorCode(blockedDelete, 'external_events_delete_blocked');
    const revisionAfterBlockedDelete = await getRevision(session);
    assert(
      revisionAfterBlockedDelete === revision,
      'blocked_external_delete_changed_revision'
    );

    const deletedUnreferenced = await callOk(
      session,
      'external-events.delete',
      {
        externalEventsId: unreferencedExternalItem.externalEventsId,
        expectedRevision: revision,
      }
    );
    revision = deletedUnreferenced.meta.projectRevision;
    assert(
      deletedUnreferenced.data.deleted === true,
      'unreferenced_external_events_not_deleted'
    );

    const projectStatus = await callOk(session, 'project.status', {});
    const projectId =
      projectStatus.data.projectUuid ||
      (projectStatus.meta &&
        projectStatus.meta.targetIdentity &&
        projectStatus.meta.targetIdentity.project.projectId);
    assert(projectId, 'project_id_missing');

    const save = await callOk(session, 'project.save-as', {
      filePath: savePath,
      name: PROJECT_NAME,
      expectedProjectId: projectId,
    });
    assert(save.data && save.data.saved === true, 'dx33_save_as_failed');
    assert(fs.existsSync(savePath), 'dx33_saved_project_missing');

    const persistentBeforeReload = {
      sceneId: sceneCopy.sceneId,
      sceneSelector: sceneCopy.selector,
      externalEventsId: referencedExternalItem.externalEventsId,
      externalEventsSelector: referencedExternalItem.selector,
    };

    const reload = await callOk(session, 'project.reload', {
      expectedProjectId: projectId,
      expectedProjectRevision: save.data.projectRevision,
      expectedPersistedHash: save.data.persistedHash,
    });
    assert(reload.data && reload.data.reloaded === true, 'dx33_reload_failed');

    await session.close();
    session = await connect(label);

    const scenesReloaded = await callOk(session, 'project.scenes.list', {});
    const renamedSceneReloaded = scenesReloaded.data.items.find(
      item => item.name === SCENE_RENAMED
    );
    assert(
      renamedSceneReloaded &&
        renamedSceneReloaded.sceneId === persistentBeforeReload.sceneId &&
        renamedSceneReloaded.selector === persistentBeforeReload.sceneSelector,
      'scene_identity_not_persisted_after_reload'
    );

    const externalReloaded = await callOk(session, 'external-events.list', {});
    const referencedExternalReloaded = externalReloaded.data.items.find(
      item => item.name === EXTERNAL_RENAMED
    );
    assert(
      referencedExternalReloaded &&
        referencedExternalReloaded.externalEventsId ===
          persistentBeforeReload.externalEventsId &&
        referencedExternalReloaded.selector ===
          persistentBeforeReload.externalEventsSelector,
      'external_events_identity_not_persisted_after_reload'
    );

    events = await readEvents(session, SCENE_A);
    linkTargets = getLinkTargets(events.data.eventsJson);
    assert(
      linkTargets.includes(SCENE_RENAMED) &&
        linkTargets.includes(EXTERNAL_RENAMED),
      'event_references_not_persisted_after_reload'
    );

    await callOk(session, 'scene.open', {
      sceneName: SCENE_RENAMED,
      mode: 'scene',
    });
    const target = await waitForSceneTarget(
      session,
      persistentBeforeReload.sceneSelector
    );
    assert(
      target.project.scenes.some(
        item =>
          item.sceneId === persistentBeforeReload.sceneId &&
          item.sceneName === SCENE_RENAMED
      ),
      'target_status_missing_persistent_scene_identity'
    );

    await callOk(session, 'preview.start', {
      numberOfWindows: 1,
      waitUntilReady: true,
      readyTimeoutMs: 15000,
      expectedProjectId: projectId,
      expectedSceneSelector: persistentBeforeReload.sceneSelector,
    });
    previewOpen = true;
    let previewTarget = null;
    for (let attempt = 0; attempt < 30; attempt++) {
      const previewIdentity = await callOk(session, 'target.status', {});
      const previewTargets =
        previewIdentity.data &&
        previewIdentity.data.preview &&
        Array.isArray(previewIdentity.data.preview.targets)
          ? previewIdentity.data.preview.targets
          : [];
      previewTarget = previewTargets.find(
        candidate =>
          candidate &&
          candidate.ready &&
          candidate.sceneName === SCENE_RENAMED &&
          candidate.sceneSelector === persistentBeforeReload.sceneSelector
      );
      if (previewTarget) break;
      await wait(100);
    }
    assert(previewTarget, 'dx33_preview_target_not_ready');

    const runtime = await callOk(session, 'runtime.status', {
      debuggerId: previewTarget.debuggerId,
      expectedProjectId: projectId,
      expectedSceneSelector: persistentBeforeReload.sceneSelector,
    });
    assert(
      runtime.data && runtime.data.debuggerId === previewTarget.debuggerId,
      'runtime_not_bound_to_persistent_scene_target'
    );

    await callOk(session, 'preview.close-all', {});
    previewOpen = false;

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
    assert(validationErrors === 0, 'dx33_validation_has_errors');

    const evidence = sanitizeForReplay({
      kind: 'dx33-project-structure-acceptance',
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
        sceneLifecyclePublished: true,
        externalEventsLifecyclePublished: true,
        stableTargetSchemasPublished: true,
      },
      sceneLifecycle: {
        sourceSceneId: sceneB.sceneId,
        duplicatedSceneId: sceneCopy.sceneId,
        duplicateHasDistinctIdentity: true,
        renamedSceneName: SCENE_RENAMED,
        renamePreservedIdentity: true,
        eventReferenceRefactored: true,
        externalEventsAssociationRefactored: true,
        reorderPreservedUnrelatedIdentities: true,
        persistedAcrossReload: true,
      },
      externalEventsLifecycle: {
        referencedId: referencedExternalItem.externalEventsId,
        renamePreservedIdentity: true,
        eventReferenceRefactored: true,
        dryRunFoundBlockers: referencedDryRun.data.blockerCount,
        referencedDeleteBlocked: true,
        unreferencedDeleteSucceeded: true,
        persistedAcrossReload: true,
      },
      targetIntegration: {
        sceneSelector: persistentBeforeReload.sceneSelector,
        targetStatusUsesPersistentIdentity: true,
        previewStartPinnedByPersistentSelector: true,
        runtimePinnedByPersistentSelector: true,
      },
      revisionOwnership: {
        expectedRevisionUsedOnMutations: true,
        blockedDeleteDidNotAdvanceRevision: true,
        canonicalStructuredErrorObserved: 'external_events_delete_blocked',
      },
      persistence: {
        saved: true,
        reloaded: true,
        eventReferencesSurvivedReload: true,
      },
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
          sceneSelector: persistentBeforeReload.sceneSelector,
          externalEventsSelector: persistentBeforeReload.externalEventsSelector,
          validationErrors,
          referencedDeleteBlocked: true,
          unreferencedDeleteSucceeded: true,
          persistedAcrossReload: true,
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
  run(parseArgs(process.argv.slice(2))).catch(error => {
    console.error(error && error.stack ? error.stack : String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  getLinkTargets,
  parseArgs,
  run,
};
