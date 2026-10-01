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
  'objects.definitions.create',
  'objects.definitions.rename',
  'objects.groups.create',
  'objects.groups.members.add',
  'objects.groups.get',
  'scene.instances.create',
  'scene.instances.get',
  'events.instructions.search',
  'events.read',
  'events.insert',
  'references.graph.capabilities',
  'references.graph.query',
  'references.graph.usages',
  'references.graph.impact',
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
  assert(Number.isInteger(revision), 'dx37_missing_project_revision');
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
        'dx37_clean_room_repository_read_forbidden:' + path.basename(resolved)
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
    'gdevelop-dx37-reference-graph-' + process.pid + '.json'
  ),
} = {}) => {
  const rootDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gdevelop-dx37-reference-graph-')
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
        'dx37_tool_failed:' +
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
      idempotencyKey: 'dx37-' + name + '-' + revision + '-' + replay.length,
    });
    if (transactionId) {
      const meta =
        result.meta ||
        (result.structuredContent && result.structuredContent.meta) ||
        null;
      assert(
        meta && meta.transactionId === transactionId,
        'dx37_transaction_metadata_missing:' + name
      );
    }
    return result;
  };

  try {
    session = await connectLiveGDevelopMcp({
      clientId: 'gdevelop-dx37-reference-graph-' + label,
      confirmDestructiveOperations: true,
    });
    const tools = await session.listTools();
    for (const name of REQUIRED_TOOLS) {
      assert(
        tools.some(tool => tool.name === name),
        'dx37_missing_tool:' + name
      );
    }

    const initialStatus = getData(await call('project.status'));
    assert(
      !initialStatus || initialStatus.projectOpen !== true,
      'dx37_requires_fresh_editor'
    );

    await call('project.create', {
      name: 'DX37 Reference Graph Acceptance',
      idempotencyKey: 'dx37-create-project',
    });
    projectOpen = true;
    await call('project.save-as', {
      filePath: projectFile,
      name: 'DX37 Reference Graph Acceptance',
    });

    const statusAfterCreate = getData(await call('project.status'));
    const sceneName =
      statusAfterCreate &&
      Array.isArray(statusAfterCreate.sceneNames) &&
      statusAfterCreate.sceneNames[0];
    assert(sceneName, 'dx37_scene_missing');

    const begun = getData(
      await call('safety.transactions.begin', {
        label: 'DX-37 reference graph acceptance',
      })
    );
    transactionId = begun && begun.transactionId;
    assert(transactionId, 'dx37_transaction_missing');

    const objectTypes = getData(
      await call('editor.types.objects.list', {
        query: 'Text',
        limit: 100,
      })
    );
    const textType = (objectTypes.items || []).find(
      item => item.type === 'TextObject::Text'
    );
    assert(textType, 'dx37_text_object_type_not_discovered');

    const objectName = 'DX37Hero';
    const renamedName = 'DX37HeroRenamed';
    const groupName = 'DX37Actors';

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
    const objectSelector =
      created &&
      created.object &&
      created.object.identity &&
      created.object.identity.selector;
    assert(objectId && objectSelector, 'dx37_object_identity_missing');

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
        position: { x: 80, y: 100 },
      })
    );
    const instanceId =
      instance &&
      instance.instance &&
      (instance.instance.instanceId ||
        (instance.instance.identity && instance.instance.identity.instanceId));
    assert(instanceId, 'dx37_instance_id_missing');

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
    assert(setX, 'dx37_setx_not_discovered');

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

    const capabilities = getData(await call('references.graph.capabilities'));
    assert(
      capabilities &&
        Array.isArray(capabilities.nodeKinds) &&
        capabilities.nodeKinds.some(
          item => item.kind === 'object-definition'
        ) &&
        capabilities.nodeKinds.some(item => item.kind === 'scene-instance') &&
        capabilities.nodeKinds.some(item => item.kind === 'event-action') &&
        capabilities.traversal &&
        capabilities.traversal.boundedDepth === true,
      'dx37_capabilities_missing'
    );

    const usages = getData(
      await call('references.graph.usages', {
        selector: objectSelector,
        maxDepth: 1,
        limit: 200,
      })
    );
    assert(
      usages &&
        usages.root &&
        usages.root.selector === objectSelector &&
        usages.root.name === objectName,
      'dx37_root_resolution_failed'
    );
    const kinds = new Set((usages.edges || []).map(edge => edge.referenceKind));
    assert(kinds.has('instance-of-object'), 'dx37_instance_edge_missing');
    assert(kinds.has('group-member'), 'dx37_group_edge_missing');
    assert(
      kinds.has('event-parameter-object'),
      'dx37_event_parameter_edge_missing'
    );
    const eventEdge = (usages.edges || []).find(
      edge => edge.referenceKind === 'event-parameter-object'
    );
    assert(
      eventEdge &&
        eventEdge.location &&
        eventEdge.location.eventHandle &&
        eventEdge.location.instructionHandle,
      'dx37_exact_event_location_missing'
    );

    const transitive = getData(
      await call('references.graph.query', {
        selector: objectSelector,
        direction: 'both',
        maxDepth: 2,
        limit: 2,
        offset: 0,
      })
    );
    assert(
      transitive &&
        transitive.totalEdges >= usages.edges.length &&
        transitive.edges.length <= 2 &&
        transitive.traversal &&
        transitive.traversal.visitedNodeCount > 1 &&
        transitive.graphRevision,
      'dx37_transitive_pagination_failed'
    );

    // The clean-room agent must inspect impact before issuing the rename.
    const renameImpact = getData(
      await call('references.graph.impact', {
        selector: objectSelector,
        operation: 'rename',
        maxDepth: 2,
      })
    );
    assert(
      renameImpact &&
        renameImpact.target &&
        renameImpact.target.selector === objectSelector &&
        renameImpact.affectedReferenceCount >= 3 &&
        renameImpact.safelyRewritableCount >= 3 &&
        renameImpact.graphRevision &&
        renameImpact.projectModified === false,
      'dx37_rename_impact_missing'
    );

    const renameCallIndex = replay.length;
    const renamed = getData(
      await mutate('objects.definitions.rename', {
        objectId,
        newObjectName: renamedName,
      })
    );
    assert(
      renamed && renamed.renamed && renamed.objectId === objectId,
      'dx37_object_rename_failed'
    );

    const impactCallIndex = replay.findIndex(
      item => item.name === 'references.graph.impact'
    );
    assert(
      impactCallIndex >= 0 && impactCallIndex < renameCallIndex,
      'dx37_rename_occurred_before_impact_analysis'
    );

    const after = getData(
      await call('references.graph.usages', {
        selector: objectSelector,
        maxDepth: 1,
        limit: 200,
      })
    );
    assert(
      after &&
        after.root &&
        after.root.selector === objectSelector &&
        after.root.name === renamedName,
      'dx37_persistent_selector_not_preserved_after_rename'
    );
    const afterKinds = new Set(
      (after.edges || []).map(edge => edge.referenceKind)
    );
    assert(
      afterKinds.has('instance-of-object') &&
        afterKinds.has('group-member') &&
        afterKinds.has('event-parameter-object'),
      'dx37_references_lost_after_rename'
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
      'dx37_group_refactor_missing'
    );
    const instanceAfter = getData(
      await call('scene.instances.get', { sceneName, instanceId })
    );
    assert(
      instanceAfter &&
        instanceAfter.instance &&
        instanceAfter.instance.objectName === renamedName,
      'dx37_instance_refactor_missing'
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
      'dx37_event_refactor_missing'
    );

    const validation = getData(await call('validation.run'));
    const validationErrors = validationErrorCount(validation);
    assert(
      validationErrors === 0,
      'dx37_validation_errors:' + validationErrors
    );

    const rollback = getData(
      await call('safety.transactions.rollback', { transactionId })
    );
    assert(
      rollback && rollback.rolledBack !== false,
      'dx37_transaction_rollback_failed'
    );
    transactionId = null;

    await call('project.close', { discardUnsavedChanges: false });
    projectOpen = false;

    const evidence = {
      label,
      protocolVersion: session.protocolVersion,
      objectSelector,
      objectId,
      objectInboundKinds: Array.from(kinds).sort(),
      exactEventLocation: {
        eventHandle: eventEdge.location.eventHandle,
        instructionHandle: eventEdge.location.instructionHandle,
        parameterIndex: eventEdge.location.parameterIndex,
      },
      graphRevisionBeforeRename: renameImpact.graphRevision,
      impactBeforeRename: true,
      impactAffectedReferenceCount: renameImpact.affectedReferenceCount,
      impactSafelyRewritableCount: renameImpact.safelyRewritableCount,
      renameOccurredAfterImpact: true,
      selectorStableAcrossRename: after.root.selector === objectSelector,
      renamedName: after.root.name,
      refactorPreservedInstanceGroupEvent: true,
      transitiveTraversal: {
        totalEdges: transitive.totalEdges,
        pageSize: transitive.edges.length,
        visitedNodeCount: transitive.traversal.visitedNodeCount,
        cyclesDetected: transitive.traversal.cyclesDetected,
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
