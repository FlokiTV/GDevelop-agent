const fs = require('fs');
const os = require('os');
const path = require('path');
const { connectLiveGDevelopMcp, sanitizeForReplay } = require('./McpClient');

const SCENE_NAME = 'DX23LayoutInspection';
const TEXT_OBJECT_NAME = 'LayoutProbeText';
const QA_VIEWPORT = { width: 1280, height: 720 };
const LONG_TEXT = 'DX23 runtime layout inspection probe '.repeat(40).trim();

const REQUIRED_TOOLS = [
  'project.create',
  'project.close',
  'project.status',
  'scene.open',
  'editor.functions.create-scene',
  'editor.functions.create-object',
  'editor.functions.change-object-property',
  'editor.functions.put-2d-instances',
  'preview.status',
  'preview.start',
  'preview.close-all',
  'preview.viewport.set',
  'preview.layout.capabilities',
  'preview.layout.inspect',
  'preview.layout.assert',
  'preview.capture.region',
  'runtime.inspect',
  'validation.run',
  'safety.transactions.begin',
  'safety.transactions.rollback',
];

const wait = milliseconds =>
  new Promise(resolve => setTimeout(resolve, milliseconds));

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const getRevision = result => {
  const revision =
    result && result.meta && Number.isInteger(result.meta.projectRevision)
      ? result.meta.projectRevision
      : result &&
        result.structuredContent &&
        result.structuredContent.meta &&
        Number.isInteger(result.structuredContent.meta.projectRevision)
      ? result.structuredContent.meta.projectRevision
      : null;
  assert(Number.isInteger(revision), 'dx23_missing_project_revision');
  return revision;
};

const assertRequiredTools = tools => {
  const names = new Set((tools || []).map(tool => tool && tool.name));
  const missing = REQUIRED_TOOLS.filter(name => !names.has(name));
  assert(missing.length === 0, `dx23_missing_tools:${missing.join(',')}`);

  const inspect = (tools || []).find(
    tool => tool && tool.name === 'preview.layout.inspect'
  );
  const layoutAssert = (tools || []).find(
    tool => tool && tool.name === 'preview.layout.assert'
  );
  const capture = (tools || []).find(
    tool => tool && tool.name === 'preview.capture.region'
  );
  assert(
    inspect &&
      inspect.inputSchema &&
      inspect.inputSchema.properties &&
      inspect.inputSchema.properties.targets,
    'dx23_layout_inspect_schema_missing'
  );
  assert(
    layoutAssert &&
      layoutAssert.inputSchema &&
      layoutAssert.inputSchema.properties &&
      layoutAssert.inputSchema.properties.assertions,
    'dx23_layout_assert_schema_missing'
  );
  assert(
    capture &&
      capture.inputSchema &&
      capture.inputSchema.properties &&
      capture.inputSchema.properties.target &&
      capture.inputSchema.properties.region,
    'dx23_capture_region_schema_missing'
  );
};

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

const run = async ({
  label = 'live',
  evidencePath = path.join(
    os.tmpdir(),
    `gdevelop-dx23-layout-inspection-${process.pid}.json`
  ),
} = {}) => {
  const session = await connectLiveGDevelopMcp({
    clientId: `gdevelop-dx23-layout-${label}`,
  });
  let transactionId = null;
  let previewStarted = false;
  let revision = null;
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

  const call = async (name, args = {}, requestOptions = {}) => {
    const result = await session.call(name, args, requestOptions);
    record(name, args, result);
    if (result.isError) {
      throw new Error(
        `${name} failed: ${JSON.stringify(
          result.structuredContent || result.content || result.data
        )}`
      );
    }
    return result;
  };

  const mutate = async (name, args, key) => {
    const result = await call(name, {
      ...args,
      ...(Number.isInteger(revision) ? { expectedRevision: revision } : {}),
      idempotencyKey: key,
    });
    revision = getRevision(result);
    return result;
  };

  try {
    const tools = await session.listTools();
    assertRequiredTools(tools);

    const before = await call('project.status');
    if (before.data && before.data.projectOpen) {
      assert(
        before.data.hasUnsavedChanges === false,
        'dx23_requires_clean_or_fresh_editor'
      );
      await call('project.close', {
        ...(before.meta && Number.isInteger(before.meta.projectRevision)
          ? { expectedRevision: before.meta.projectRevision }
          : {}),
        idempotencyKey: 'dx23-close-clean-auto-open-project',
      });
    }

    await call('project.create', {
      name: 'DX23 Runtime Layout Inspection Acceptance',
      idempotencyKey: 'dx23-create-project',
    });

    const tx = await call('safety.transactions.begin', {
      label: 'DX-23 runtime layout inspection acceptance',
    });
    transactionId = tx.data && tx.data.transactionId;
    assert(transactionId, 'dx23_transaction_missing');

    await mutate(
      'editor.functions.create-scene',
      { scene_name: SCENE_NAME },
      'dx23-create-scene'
    );
    await call('scene.open', { sceneName: SCENE_NAME, mode: 'scene' });
    await wait(250);

    await mutate(
      'editor.functions.create-object',
      {
        scene_name: SCENE_NAME,
        object_name: TEXT_OBJECT_NAME,
        object_type: 'TextObject::Text',
        description: 'DX-23 temporary structural layout fixture',
      },
      'dx23-create-text-object'
    );
    await mutate(
      'editor.functions.change-object-property',
      {
        scene_name: SCENE_NAME,
        object_name: TEXT_OBJECT_NAME,
        changed_properties: [{ property_name: 'text', new_value: LONG_TEXT }],
      },
      'dx23-set-long-text'
    );
    await mutate(
      'editor.functions.put-2d-instances',
      {
        scene_name: SCENE_NAME,
        layer_name: '',
        brush_kind: 'point',
        brush_position: '10,120',
        object_name: TEXT_OBJECT_NAME,
        new_instances_count: 1,
      },
      'dx23-place-text'
    );

    const validation = await call('validation.run', {
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
    assert(validationErrors === 0, 'dx23_validation_has_errors');

    const previewBefore = await call('preview.status');
    if (previewBefore.data && previewBefore.data.running) {
      await call('preview.close-all');
      await wait(250);
    }

    const started = await call('preview.start', {
      numberOfWindows: 1,
      waitUntilReady: true,
      readyTimeoutMs: 15000,
    });
    previewStarted = true;

    let target = getReadyPreviewTarget(started.data);
    if (!target) {
      for (let attempt = 0; attempt < 30 && !target; attempt++) {
        await wait(250);
        const status = await call('preview.status');
        target = getReadyPreviewTarget(status.data);
      }
    }
    assert(target, 'dx23_ready_preview_target_missing');

    const resized = await call('preview.viewport.set', {
      previewWindowId: target.windowId,
      width: QA_VIEWPORT.width,
      height: QA_VIEWPORT.height,
      waitUntilApplied: true,
      timeoutMs: 5000,
      restoreWindowState: true,
      focus: false,
    });
    assert(
      resized.data &&
        resized.data.exact === true &&
        resized.data.actualViewport &&
        resized.data.actualViewport.width === QA_VIEWPORT.width &&
        resized.data.actualViewport.height === QA_VIEWPORT.height,
      'dx23_viewport_resize_failed'
    );

    let runtimeReady = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        const ready = await call('runtime.inspect', {
          selector: {
            kind: 'object-count',
            objectName: TEXT_OBJECT_NAME,
          },
        });
        if (ready.data && ready.data.value === 1) {
          runtimeReady = true;
          break;
        }
      } catch (_) {}
      await wait(200);
    }
    assert(runtimeReady, 'dx23_runtime_preview_not_ready');

    const projectBeforeReadOnly = await call('project.status');
    const revisionBeforeReadOnly = projectBeforeReadOnly.data.projectRevision;

    const capabilities = await call('preview.layout.capabilities');
    assert(
      capabilities.data &&
        capabilities.data.geometry &&
        capabilities.data.geometry.transformedBounds === true &&
        capabilities.data.capture &&
        capabilities.data.capture.command === 'preview.capture.region',
      'dx23_layout_capabilities_invalid'
    );

    const regions = [
      {
        name: 'narrow-card',
        x: 0,
        y: 100,
        width: 180,
        height: 80,
      },
    ];
    const targets = [
      {
        id: 'probe',
        kind: 'object',
        objectName: TEXT_OBJECT_NAME,
        instanceIndex: 0,
      },
    ];

    const inspected = await call('preview.layout.inspect', {
      previewWindowId: target.windowId,
      targets,
      regions,
    });
    const inspectedTarget =
      inspected.data &&
      Array.isArray(inspected.data.targets) &&
      inspected.data.targets[0];
    assert(inspectedTarget, 'dx23_layout_target_missing');
    assert(
      inspectedTarget.identity &&
        inspectedTarget.identity.objectName === TEXT_OBJECT_NAME,
      'dx23_layout_identity_mismatch'
    );
    assert(
      inspectedTarget.bounds &&
        inspectedTarget.bounds.viewport &&
        inspectedTarget.bounds.transformedViewport,
      'dx23_layout_bounds_missing'
    );
    assert(
      inspectedTarget.visibility && inspectedTarget.visibility.visible === true,
      'dx23_layout_visibility_missing'
    );
    assert(
      inspectedTarget.clipping &&
        inspectedTarget.clipping.viewport &&
        ['partial', 'offscreen'].includes(
          inspectedTarget.clipping.viewport.status
        ),
      `dx23_expected_clipping_missing:${JSON.stringify(
        inspectedTarget.clipping
      )}`
    );

    const asserted = await call('preview.layout.assert', {
      previewWindowId: target.windowId,
      targets,
      regions,
      assertions: [
        {
          id: 'viewport-clipping',
          type: 'not-clipped',
          targets: ['probe'],
        },
        {
          id: 'text-fit',
          type: 'text-fit',
          textTarget: 'probe',
          region: 'narrow-card',
          padding: 4,
        },
      ],
    });
    const violationCodes =
      asserted.data && Array.isArray(asserted.data.violations)
        ? asserted.data.violations.map(violation => violation.code)
        : [];
    assert(
      asserted.data && asserted.data.passed === false,
      'dx23_bad_layout_passed'
    );
    assert(
      violationCodes.includes('preview_layout_clipped') ||
        violationCodes.includes('preview_layout_offscreen'),
      `dx23_clipping_violation_missing:${violationCodes.join(',')}`
    );
    assert(
      violationCodes.includes('preview_layout_text_overflow'),
      `dx23_text_overflow_missing:${violationCodes.join(',')}`
    );

    const capture = await call(
      'preview.capture.region',
      {
        previewWindowId: target.windowId,
        target: {
          objectName: TEXT_OBJECT_NAME,
          instanceIndex: 0,
        },
        clampToViewport: true,
      },
      { timeout: 120000 }
    );
    const imageContent = (capture.content || []).find(
      item => item && item.type === 'image'
    );
    assert(
      imageContent &&
        imageContent.mimeType === 'image/png' &&
        typeof imageContent.data === 'string' &&
        imageContent.data.length > 0,
      'dx23_region_capture_image_missing'
    );
    assert(
      capture.data &&
        capture.data.source &&
        capture.data.source.kind === 'runtime-object' &&
        capture.data.source.target &&
        capture.data.source.target.identity &&
        capture.data.source.target.identity.objectName === TEXT_OBJECT_NAME,
      'dx23_region_capture_identity_missing'
    );
    assert(
      capture.data.actualRegion &&
        capture.data.actualRegion.width > 0 &&
        capture.data.actualRegion.height > 0 &&
        capture.data.actualRegion.x >= 0 &&
        capture.data.actualRegion.y >= 0 &&
        capture.data.actualRegion.x + capture.data.actualRegion.width <=
          QA_VIEWPORT.width &&
        capture.data.actualRegion.y + capture.data.actualRegion.height <=
          QA_VIEWPORT.height,
      `dx23_region_capture_bounds_invalid:${JSON.stringify(
        capture.data && capture.data.actualRegion
      )}`
    );
    assert(
      Number.isInteger(capture.data.byteLength) && capture.data.byteLength > 0,
      'dx23_region_capture_bytes_missing'
    );

    const projectAfterReadOnly = await call('project.status');
    const revisionAfterReadOnly = projectAfterReadOnly.data.projectRevision;
    assert(
      revisionBeforeReadOnly === revisionAfterReadOnly,
      `dx23_read_only_revision_changed:${revisionBeforeReadOnly}->${revisionAfterReadOnly}`
    );

    const evidence = sanitizeForReplay({
      kind: 'dx23-runtime-layout-inspection-acceptance',
      label,
      protocolVersion: session.protocolVersion,
      fixture: {
        sceneName: SCENE_NAME,
        objectName: TEXT_OBJECT_NAME,
        eventSheetInstrumentation: false,
        qaJsCodeInstrumentation: false,
      },
      viewport: resized.data.actualViewport,
      inspect: {
        identity: inspectedTarget.identity,
        bounds: inspectedTarget.bounds,
        visibility: inspectedTarget.visibility,
        clipping: inspectedTarget.clipping,
      },
      assertions: {
        passed: asserted.data.passed,
        violationCodes,
      },
      capture: {
        requestedRegion: capture.data.requestedRegion,
        actualRegion: capture.data.actualRegion,
        clampedToViewport: capture.data.clampedToViewport,
        byteLength: capture.data.byteLength,
        mimeType: imageContent.mimeType,
      },
      readOnlyProjectRevision: {
        before: revisionBeforeReadOnly,
        after: revisionAfterReadOnly,
        unchanged: revisionBeforeReadOnly === revisionAfterReadOnly,
      },
      validationErrors,
      replay,
    });
    fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));

    if (previewStarted) {
      await call('preview.close-all');
      previewStarted = false;
    }
    await call('safety.transactions.rollback', { transactionId });
    transactionId = null;
    const cleanAfterRollback = await call('project.status');
    assert(
      cleanAfterRollback.data &&
        cleanAfterRollback.data.hasUnsavedChanges === false,
      'dx23_fixture_project_not_clean_after_rollback'
    );
    await call('project.close', {
      idempotencyKey: 'dx23-close-fixture-project',
    });

    console.log(
      JSON.stringify(
        {
          ok: true,
          label,
          protocolVersion: session.protocolVersion,
          viewport: evidence.viewport,
          identity: evidence.inspect.identity,
          clipping: evidence.inspect.clipping.viewport.status,
          violationCodes,
          capture: evidence.capture,
          readOnlyProjectRevision: evidence.readOnlyProjectRevision,
          validationErrors,
          evidencePath,
        },
        null,
        2
      )
    );
  } finally {
    if (previewStarted) {
      try {
        await session.call('preview.close-all', {});
      } catch (_) {}
    }
    if (transactionId) {
      try {
        await session.call('safety.transactions.rollback', { transactionId });
      } catch (_) {}
    }
    await session.close();
  }
};

if (require.main === module) {
  let label = 'live';
  let evidencePath;
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--label') label = args[++index];
    else if (args[index] === '--evidence') evidencePath = args[++index];
    else throw new Error(`unknown_argument:${args[index]}`);
  }
  run({ label, ...(evidencePath ? { evidencePath } : {}) }).catch(error => {
    console.error(error && error.stack ? error.stack : String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  LONG_TEXT,
  QA_VIEWPORT,
  REQUIRED_TOOLS,
  SCENE_NAME,
  TEXT_OBJECT_NAME,
  assertRequiredTools,
  getReadyPreviewTarget,
  run,
};
