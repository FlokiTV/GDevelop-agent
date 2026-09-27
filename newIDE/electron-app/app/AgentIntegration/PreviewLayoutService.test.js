const assert = require('node:assert/strict');
const test = require('node:test');
const { createPreviewLayoutService } = require('./PreviewLayoutService');

const viewport = {
  width: 1280,
  height: 720,
  devicePixelRatio: 1,
  gameResolution: { width: 1280, height: 720 },
  canvas: { x: 0, y: 0, width: 1280, height: 720 },
};

const makeRuntimeTarget = ({
  objectName,
  instanceId,
  instanceIndex = 0,
  layer = 'UI',
  type = 'Sprite',
  left,
  top,
  right,
  bottom,
  visible = true,
}) => ({
  identity: {
    objectName,
    instanceId,
    instanceIndex,
    type,
    layer,
    zOrder: instanceIndex,
  },
  size: { width: right - left, height: bottom - top },
  scene: {
    bounds: {
      left,
      top,
      right,
      bottom,
      width: right - left,
      height: bottom - top,
    },
    hitBoxes: [
      {
        vertices: [[left, top], [right, top], [right, bottom], [left, bottom]],
      },
    ],
  },
  viewport: {
    bounds: {
      left,
      top,
      right,
      bottom,
      width: right - left,
      height: bottom - top,
    },
    hitBoxes: [
      {
        vertices: [[left, top], [right, top], [right, bottom], [left, bottom]],
      },
    ],
    center: { x: (left + right) / 2, y: (top + bottom) / 2 },
    insideViewport: left >= 0 && top >= 0 && right <= 1280 && bottom <= 720,
  },
  state: {
    hidden: !visible,
    layerVisible: true,
    livingOnScene: true,
    visible,
    hitTestable: true,
    blockedReasons: visible ? [] : ['object_hidden'],
  },
  classification: {
    presentationSurface: visible ? 'visible' : 'hidden',
  },
});

const makeHarness = ({ objects, viewportMetrics = viewport }) => {
  const captures = [];
  const byKey = new Map();
  const snapshotObjects = {};
  objects.forEach((object, index) => {
    const key = `${object.objectName}:${object.instanceId}`;
    byKey.set(
      key,
      makeRuntimeTarget({
        ...object,
        instanceIndex:
          object.instanceIndex == null ? index : object.instanceIndex,
      })
    );
    if (!snapshotObjects[object.objectName]) {
      snapshotObjects[object.objectName] = {
        count: 0,
        instances: [],
        truncated: false,
      };
    }
    const group = snapshotObjects[object.objectName];
    group.count += 1;
    group.instances.push({
      id: object.instanceId,
      name: object.objectName,
      type: object.type || 'Sprite',
      x: object.left,
      y: object.top,
      z: 0,
      angle: 0,
      zOrder: object.instanceIndex || 0,
      layer: object.layer || 'UI',
      hidden: object.visible === false,
      livingOnScene: true,
      ...(Object.prototype.hasOwnProperty.call(object, 'text')
        ? { text: object.text }
        : {}),
      variables: {},
      behaviors: [],
    });
  });

  const service = createPreviewLayoutService({
    previewInteractionService: {
      getRuntimeSnapshot: async () => ({
        snapshotSource: 'test',
        viewport: viewportMetrics,
        scene: {
          name: 'LayoutScene',
          elapsedTimeMs: 16,
          timeFromStartMs: 100,
        },
        objects: snapshotObjects,
        totalInstances: objects.length,
        includedInstances: objects.length,
        truncatedInstances: 0,
      }),
      inspect: async input => {
        if (!input.target) {
          return {
            previewWindowId: input.previewWindowId,
            viewport: viewportMetrics,
            target: null,
            diagnostics: [],
          };
        }
        const selector = input.target;
        let target = null;
        if (selector.instanceId != null) {
          for (const value of byKey.values()) {
            if (
              (!selector.objectName ||
                value.identity.objectName === selector.objectName) &&
              value.identity.instanceId === selector.instanceId
            ) {
              target = value;
              break;
            }
          }
        } else if (selector.objectName) {
          const matches = Array.from(byKey.values()).filter(
            value => value.identity.objectName === selector.objectName
          );
          target = matches[selector.instanceIndex || 0] || null;
        }
        return {
          previewWindowId: input.previewWindowId,
          viewport: viewportMetrics,
          target,
          diagnostics: target ? [] : [{ code: 'preview_target_not_found' }],
        };
      },
    },
    windowCaptureService: {
      capture: async input => {
        captures.push(input);
        return {
          windowId: input.windowId,
          mimeType: 'image/png',
          region: input.region,
          captureMethod: 'capturePage',
          attempts: 1,
          readiness: { ready: true },
          outputSize: {
            width: input.region.width,
            height: input.region.height,
          },
          data: Buffer.from('png'),
        };
      },
    },
  });

  return { service, captures };
};

test('discovers object, layer and named-region layout with clipping and visibility', async () => {
  const { service } = makeHarness({
    objects: [
      {
        objectName: 'Partial',
        instanceId: 1,
        left: 1240,
        top: 100,
        right: 1320,
        bottom: 160,
        layer: 'UI',
      },
      {
        objectName: 'VisibleButton',
        instanceId: 2,
        left: 100,
        top: 100,
        right: 220,
        bottom: 160,
        layer: 'UI',
      },
      {
        objectName: 'LegacyButton',
        instanceId: 3,
        left: 100,
        top: 100,
        right: 220,
        bottom: 160,
        layer: 'UI',
        visible: false,
      },
    ],
  });

  const capabilities = service.capabilities();
  assert.equal(capabilities.selectors.layer.supported, true);
  assert.equal(capabilities.capture.command, 'preview.capture.region');
  assert.equal(
    capabilities.visualQaIntegration.replacesPerceptualReview,
    false
  );

  const result = await service.inspect({
    previewWindowId: 9,
    regions: [{ name: 'sidebar', x: 900, y: 0, width: 380, height: 720 }],
    targets: [
      { id: 'partial', kind: 'object', objectName: 'Partial' },
      { id: 'ui-layer', kind: 'layer', layer: 'UI' },
      { id: 'sidebar', kind: 'region', region: 'sidebar' },
    ],
  });

  const partial = result.targets.find(target => target.targetId === 'partial');
  assert.equal(partial.clipping.viewport.status, 'partial');
  assert.deepEqual(partial.clipping.viewport.clippedEdges, ['right']);
  assert.equal(partial.bounds.transformedViewport.width, 80);

  const legacy = result.targets.find(
    target =>
      target.identity &&
      target.identity.objectName === 'LegacyButton' &&
      target.selectorId === 'ui-layer'
  );
  assert.equal(legacy.visibility.visible, false);
  assert.equal(legacy.classification.presentationSurface, 'hidden');

  const sidebar = result.targets.find(target => target.targetId === 'sidebar');
  assert.equal(sidebar.kind, 'region');
  assert.equal(sidebar.bounds.viewport.left, 900);
  assert.equal(result.coordinateSpace, 'viewport-css-px');
});

test('reports deterministic clipping, overlap, safe-area and text-fit violations', async () => {
  const { service } = makeHarness({
    objects: [
      {
        objectName: 'Button',
        instanceId: 1,
        left: 100,
        top: 100,
        right: 220,
        bottom: 150,
      },
      {
        objectName: 'Label',
        instanceId: 2,
        type: 'TextObject::Text',
        text: 'A label that is too wide',
        left: 90,
        top: 110,
        right: 235,
        bottom: 145,
      },
      {
        objectName: 'Overlap',
        instanceId: 3,
        left: 200,
        top: 120,
        right: 300,
        bottom: 180,
      },
      {
        objectName: 'HiddenLegacy',
        instanceId: 4,
        left: 100,
        top: 100,
        right: 220,
        bottom: 150,
        visible: false,
      },
      {
        objectName: 'Clipped',
        instanceId: 5,
        left: -20,
        top: 20,
        right: 60,
        bottom: 80,
      },
    ],
  });

  const result = await service.assert({
    previewWindowId: 2,
    regions: [
      { name: 'gameplay-safe', x: 180, y: 100, width: 200, height: 160 },
    ],
    targets: [
      { id: 'button', objectName: 'Button' },
      { id: 'label', objectName: 'Label' },
      { id: 'overlap', objectName: 'Overlap' },
      { id: 'hidden', objectName: 'HiddenLegacy' },
      { id: 'clipped', objectName: 'Clipped' },
    ],
    assertions: [
      { id: 'viewport', type: 'not-clipped', targets: ['clipped'] },
      {
        id: 'overlap-check',
        type: 'no-overlap',
        targets: ['button', 'overlap', 'hidden'],
      },
      {
        id: 'safe',
        type: 'safe-area',
        targets: ['button'],
        region: 'gameplay-safe',
      },
      {
        id: 'label-fit',
        type: 'text-fit',
        textTarget: 'label',
        container: 'button',
        padding: 4,
      },
    ],
  });

  assert.equal(result.passed, false);
  assert.ok(result.violations.some(v => v.code === 'preview_layout_clipped'));
  const overlap = result.violations.find(
    v => v.code === 'preview_layout_overlap'
  );
  assert.ok(overlap);
  assert.deepEqual(overlap.targets.map(target => target.targetId).sort(), [
    'button',
    'overlap',
  ]);
  assert.ok(overlap.intersection.width > 0);
  assert.ok(
    result.violations.some(v => v.code === 'preview_layout_safe_area_intrusion')
  );
  assert.ok(
    result.violations.some(v => v.code === 'preview_layout_text_overflow')
  );
  assert.equal(
    result.violations.some(v =>
      v.targets.some(target => target.targetId === 'hidden')
    ),
    false
  );
});

test('passes corrected row layout with allowlist, minimum-gap and alignment assertions', async () => {
  const { service } = makeHarness({
    objects: [
      {
        objectName: 'TabA',
        instanceId: 1,
        left: 100,
        top: 100,
        right: 180,
        bottom: 140,
      },
      {
        objectName: 'TabB',
        instanceId: 2,
        left: 196,
        top: 100,
        right: 276,
        bottom: 140,
      },
      {
        objectName: 'TabC',
        instanceId: 3,
        left: 292,
        top: 100,
        right: 372,
        bottom: 140,
      },
      {
        objectName: 'Badge',
        instanceId: 4,
        left: 350,
        top: 110,
        right: 390,
        bottom: 130,
      },
    ],
  });

  const result = await service.assert({
    previewWindowId: 3,
    regions: [{ name: 'header', x: 80, y: 80, width: 340, height: 100 }],
    targets: [
      { id: 'a', objectName: 'TabA' },
      { id: 'b', objectName: 'TabB' },
      { id: 'c', objectName: 'TabC' },
      { id: 'badge', objectName: 'Badge' },
    ],
    assertions: [
      {
        id: 'row-gap',
        type: 'min-gap',
        targets: ['a', 'b', 'c'],
        axis: 'horizontal',
        minimum: 16,
      },
      {
        id: 'row-align',
        type: 'align',
        targets: ['a', 'b', 'c'],
        edge: 'top',
        tolerance: 0,
      },
      {
        id: 'header-bounds',
        type: 'within',
        targets: ['a', 'b', 'c', 'badge'],
        region: 'header',
      },
      {
        id: 'intentional-badge',
        type: 'no-overlap',
        targets: ['c', 'badge'],
        allowPairs: [['c', 'badge']],
      },
    ],
  });

  assert.equal(result.passed, true);
  assert.equal(result.summary.failed, 0);
  assert.equal(result.violations.length, 0);
});

test('captures an object region with viewport clamp and returns the actual crop', async () => {
  const { service, captures } = makeHarness({
    objects: [
      {
        objectName: 'EdgeCard',
        instanceId: 10,
        left: 1240.2,
        top: 680.4,
        right: 1300.8,
        bottom: 740.6,
      },
    ],
  });

  const result = await service.captureRegion({
    previewWindowId: 7,
    target: { objectName: 'EdgeCard' },
    padding: 4,
  });

  assert.equal(result.source.kind, 'runtime-object');
  assert.deepEqual(result.actualRegion, {
    x: 1236,
    y: 676,
    width: 44,
    height: 44,
  });
  assert.equal(result.clampedToViewport, true);
  assert.deepEqual(captures[0].region, result.actualRegion);
  assert.ok(Buffer.isBuffer(result.imageBuffer));
});

test('captures an explicit region without resolving a runtime object', async () => {
  const { service, captures } = makeHarness({ objects: [] });
  const result = await service.captureRegion({
    previewWindowId: 8,
    region: { x: 20.2, y: 30.4, width: 99.2, height: 40.1 },
  });

  assert.equal(result.source.kind, 'explicit-region');
  assert.deepEqual(result.actualRegion, {
    x: 20,
    y: 30,
    width: 100,
    height: 41,
  });
  assert.deepEqual(captures[0].region, result.actualRegion);
});

test('runs clipped/overlap/text-fit acceptance across the DX-23 viewport matrix and passes corrected layouts', async () => {
  const viewports = [
    [1280, 720],
    [1366, 768],
    [1440, 900],
    [1600, 900],
    [1920, 1080],
  ];

  for (const [width, height] of viewports) {
    const viewportMetrics = {
      width,
      height,
      devicePixelRatio: 1,
      gameResolution: { width, height },
      canvas: { x: 0, y: 0, width, height },
    };
    const bad = makeHarness({
      viewportMetrics,
      objects: [
        {
          objectName: 'Card',
          instanceId: 1,
          left: 100,
          top: 100,
          right: 300,
          bottom: 180,
        },
        {
          objectName: 'Label',
          instanceId: 2,
          type: 'TextObject::Text',
          text: 'overflow',
          left: 90,
          top: 115,
          right: 315,
          bottom: 160,
        },
        {
          objectName: 'Overlap',
          instanceId: 3,
          left: 260,
          top: 130,
          right: 360,
          bottom: 200,
        },
        {
          objectName: 'Clipped',
          instanceId: 4,
          left: width - 30,
          top: height - 80,
          right: width + 40,
          bottom: height - 20,
        },
      ],
    });
    const badResult = await bad.service.assert({
      previewWindowId: 50,
      targets: [
        { id: 'card', objectName: 'Card' },
        { id: 'label', objectName: 'Label' },
        { id: 'overlap', objectName: 'Overlap' },
        { id: 'clipped', objectName: 'Clipped' },
      ],
      assertions: [
        { id: 'clip', type: 'not-clipped', targets: ['clipped'] },
        {
          id: 'overlap',
          type: 'no-overlap',
          targets: ['card', 'overlap'],
        },
        {
          id: 'fit',
          type: 'text-fit',
          textTarget: 'label',
          container: 'card',
          padding: 4,
        },
      ],
    });
    assert.equal(badResult.passed, false, `${width}x${height} bad layout`);
    assert.equal(
      badResult.violations.some(v => v.code === 'preview_layout_clipped'),
      true,
      `${width}x${height} clipping`
    );
    assert.equal(
      badResult.violations.some(v => v.code === 'preview_layout_overlap'),
      true,
      `${width}x${height} overlap`
    );
    assert.equal(
      badResult.violations.some(v => v.code === 'preview_layout_text_overflow'),
      true,
      `${width}x${height} text-fit`
    );

    const good = makeHarness({
      viewportMetrics,
      objects: [
        {
          objectName: 'Card',
          instanceId: 11,
          left: 100,
          top: 100,
          right: 320,
          bottom: 190,
        },
        {
          objectName: 'Label',
          instanceId: 12,
          type: 'TextObject::Text',
          text: 'fits',
          left: 120,
          top: 120,
          right: 280,
          bottom: 160,
        },
        {
          objectName: 'Sibling',
          instanceId: 13,
          left: 340,
          top: 100,
          right: 440,
          bottom: 190,
        },
        {
          objectName: 'Edge',
          instanceId: 14,
          left: width - 100,
          top: height - 100,
          right: width - 20,
          bottom: height - 20,
        },
      ],
    });
    const goodResult = await good.service.assert({
      previewWindowId: 51,
      targets: [
        { id: 'card', objectName: 'Card' },
        { id: 'label', objectName: 'Label' },
        { id: 'sibling', objectName: 'Sibling' },
        { id: 'edge', objectName: 'Edge' },
      ],
      assertions: [
        { id: 'clip', type: 'not-clipped', targets: ['edge'] },
        {
          id: 'overlap',
          type: 'no-overlap',
          targets: ['card', 'sibling'],
        },
        {
          id: 'gap',
          type: 'min-gap',
          targets: ['card', 'sibling'],
          axis: 'horizontal',
          minimum: 20,
        },
        {
          id: 'align',
          type: 'align',
          targets: ['card', 'sibling'],
          edge: 'top',
          tolerance: 0,
        },
        {
          id: 'fit',
          type: 'text-fit',
          textTarget: 'label',
          container: 'card',
          padding: 4,
        },
      ],
    });
    assert.equal(
      goodResult.passed,
      true,
      `${width}x${height} corrected layout`
    );
  }
});

test('computes named-region clipping even without runtime object selectors', async () => {
  const { service } = makeHarness({ objects: [] });
  const result = await service.inspect({
    previewWindowId: 60,
    regions: [{ name: 'edge', x: 1260, y: 700, width: 40, height: 40 }],
    targets: [{ id: 'edge-region', kind: 'region', region: 'edge' }],
  });
  assert.equal(result.viewport.width, 1280);
  assert.equal(result.targets[0].clipping.viewport.status, 'partial');
  assert.deepEqual(result.targets[0].clipping.viewport.clippedEdges, [
    'right',
    'bottom',
  ]);
});
