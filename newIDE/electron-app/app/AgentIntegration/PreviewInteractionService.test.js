const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createPreviewInteractionService,
} = require('./PreviewInteractionService');

const makeInspection = payload => {
  const targetName =
    payload && payload.target && payload.target.objectName
      ? payload.target.objectName
      : 'Button';
  const hidden = targetName === 'HiddenButton';
  const x =
    payload && Number.isFinite(Number(payload.x)) ? Number(payload.x) : 100;
  const y =
    payload && Number.isFinite(Number(payload.y)) ? Number(payload.y) : 120;
  const identity = {
    objectName: targetName,
    instanceId: targetName === 'HiddenButton' ? 2 : 1,
    instanceIndex: 0,
    type: 'Sprite',
    layer: '',
    zOrder: 1,
  };
  const target =
    payload && payload.target
      ? {
          identity,
          size: { width: 80, height: 40 },
          scene: {
            center: { x: 100, y: 120 },
            bounds: {
              left: 60,
              top: 100,
              right: 140,
              bottom: 140,
              width: 80,
              height: 40,
            },
            hitBoxes: [
              { vertices: [[60, 100], [140, 100], [140, 140], [60, 140]] },
            ],
          },
          viewport: {
            center: { x, y },
            bounds: {
              left: x - 40,
              top: y - 20,
              right: x + 40,
              bottom: y + 20,
              width: 80,
              height: 40,
            },
            hitBoxes: [
              {
                vertices: [
                  [x - 40, y - 20],
                  [x + 40, y - 20],
                  [x + 40, y + 20],
                  [x - 40, y + 20],
                ],
              },
            ],
            insideViewport: true,
          },
          state: {
            hidden,
            layerVisible: true,
            livingOnScene: true,
            visible: !hidden,
            hitTestable: true,
            blockedReasons: hidden ? ['hidden'] : [],
          },
          classification: {
            presentationSurface: hidden ? 'hidden' : 'visible',
            interactionControl: hidden ? 'blocked' : 'candidate',
            disabled: null,
            legacy: null,
            semanticStateAuthority:
              'game-specific-disabled-and-legacy-state-is-not-inferred',
          },
        }
      : null;
  return {
    runtimeSource: 'gdevelop-runtime-object-hit-test-v1',
    viewport: {
      width: 800,
      height: 600,
      devicePixelRatio: 1.25,
      gameResolution: { width: 800, height: 600 },
      canvas: { x: 0, y: 0, width: 800, height: 600 },
    },
    requested: {
      target: payload && payload.target ? payload.target : null,
      coordinateSpace: 'viewport',
      x: payload && payload.x != null ? Number(payload.x) : null,
      y: payload && payload.y != null ? Number(payload.y) : null,
      layer: null,
    },
    point: {
      x,
      y,
      coordinateSpace: 'viewport-css-px',
      insideViewport: true,
      insideCanvas: true,
    },
    target,
    hitTest: {
      owner: hidden
        ? {
            identity: {
              objectName: 'ReplacementButton',
              instanceId: 3,
              instanceIndex: 0,
              type: 'Sprite',
              layer: '',
              zOrder: 2,
            },
            state: {
              hidden: false,
              layerVisible: true,
              livingOnScene: true,
              visible: true,
              hitTestable: true,
              blockedReasons: [],
            },
          }
        : target
        ? {
            identity,
            state: target.state,
          }
        : null,
      candidates: hidden || !target ? [] : [{ identity, state: target.state }],
      excluded: hidden && target ? [{ identity, state: target.state }] : [],
    },
    pointer: {
      cursor: hidden ? 'default' : 'pointer',
      elementTag: 'canvas',
      canvasCursor: hidden ? 'default' : 'pointer',
      bodyCursor: null,
    },
    diagnostics: hidden
      ? [
          {
            code: 'preview_target_hidden',
            message: 'The target runtime object is hidden.',
          },
        ]
      : [],
  };
};

const makeFixture = () => {
  const sentInputEvents = [];
  const executedScripts = [];
  const runtimeCalls = [];
  const previewWindow = {
    id: 12,
    isDestroyed: () => false,
    getTitle: () => 'Preview of Game',
    focus: () => {},
    webContents: {
      getURL: () => 'file:///C:/Temp/GDevelop/preview/index.html',
      focus: () => {},
      sendInputEvent: event => sentInputEvents.push(event),
      executeJavaScript: async source => {
        executedScripts.push(source);
        if (source.startsWith('(() => {')) {
          return { installed: true, version: 4 };
        }
        const match = source.match(
          /^window\["__GDevelopAgentPreviewRuntime"\]\["([^"]+)"\]\((.*)\)$/
        );
        if (!match) return null;
        const method = match[1];
        const payload = JSON.parse(match[2]);
        runtimeCalls.push({ method, payload });
        if (method === 'announceIdentity') {
          return { announced: true, windowId: 12 };
        }
        if (method === 'inspect') return makeInspection(payload);
        if (method === 'synchronize') {
          return {
            processed: true,
            animationFrames: 1,
            before: { sceneName: 'Scene', timeFromStartMs: 100 },
            after: { sceneName: 'Scene', timeFromStartMs: 116 },
          };
        }
        if (method === 'waitForState') {
          return {
            matched: true,
            stableFrames: payload.stableFrames || 1,
            elapsedMs: 16,
            evaluation: {
              matched: true,
              scope: payload.scope || 'scene',
              variable: payload.variable,
              operator: payload.operator || 'equals',
              expected: payload.value,
              actual: payload.value,
            },
          };
        }
        if (method === 'evaluateState') {
          const matched =
            payload.variable === 'Locked' ? true : payload.value !== 'fail';
          return {
            matched,
            scope: payload.scope || 'scene',
            variable: payload.variable,
            operator: payload.operator || 'equals',
            expected: payload.value,
            actual: matched ? payload.value : 'different',
          };
        }
        if (method === 'touch') {
          return {
            action: payload.action,
            identifier: payload.identifier,
            x: payload.x,
            y: payload.y,
            activeTouchIds: [payload.identifier],
          };
        }
        if (method === 'status') return { installed: true, version: 4 };
        if (method === 'reset') return { installed: true, version: 4 };
        return { ok: true };
      },
    },
  };
  const BrowserWindow = {
    fromId: id => (Number(id) === 12 ? previewWindow : null),
  };
  const service = createPreviewInteractionService({
    BrowserWindow,
    windowRegistry: { isRegistered: () => false },
    isRegisteredPreviewWindow: id => Number(id) === 12,
  });
  return {
    service,
    sentInputEvents,
    executedScripts,
    runtimeCalls,
  };
};

test('preserves protocol-independent legacy keyboard/mouse input methods', () => {
  const { service, sentInputEvents } = makeFixture();
  assert.deepEqual(
    service.sendInput({
      windowId: 12,
      event: { type: 'keyDown', keyCode: 'W' },
    }),
    {
      sent: true,
      windowId: 12,
      event: { type: 'keyDown', keyCode: 'W' },
    }
  );
  assert.deepEqual(sentInputEvents, [{ type: 'keyDown', keyCode: 'W' }]);
});

test('inspects runtime target geometry, hit owner and explicit disabled classification', async () => {
  const { service } = makeFixture();
  const inspected = await service.inspect({
    previewWindowId: 12,
    target: { objectName: 'Button' },
    controlState: {
      disabledWhen: {
        scope: 'scene',
        variable: 'Locked',
        operator: 'truthy',
      },
    },
  });
  assert.equal(inspected.target.identity.objectName, 'Button');
  assert.equal(inspected.target.size.width, 80);
  assert.equal(inspected.hitTest.owner.identity.instanceId, 1);
  assert.equal(inspected.pointer.cursor, 'pointer');
  assert.equal(inspected.target.classification.disabled, true);
  assert.equal(
    inspected.target.classification.semanticStateAuthority,
    'explicit-runtime-state-condition'
  );
  assert.equal(
    inspected.diagnostics.some(
      diagnostic => diagnostic.code === 'preview_target_disabled'
    ),
    true
  );
});

test('click is split across processed runtime frames and returns observable interaction state', async () => {
  const { service, sentInputEvents, runtimeCalls } = makeFixture();
  const result = await service.interact({
    previewWindowId: 12,
    action: 'click',
    target: { objectName: 'Button' },
    waitFor: {
      scope: 'scene',
      variable: 'Tab',
      operator: 'equals',
      value: 'shop',
      timeoutMs: 1000,
      stableFrames: 1,
    },
    assertAfter: {
      scope: 'scene',
      variable: 'Tab',
      operator: 'equals',
      value: 'shop',
    },
  });
  assert.deepEqual(sentInputEvents.map(event => event.type), [
    'mouseMove',
    'mouseDown',
    'mouseUp',
  ]);
  assert.equal(result.dispatched.length, 3);
  assert.equal(
    result.dispatched.every(step => step.synchronization.processed),
    true
  );
  assert.deepEqual(result.source.coordinates, {
    x: 100,
    y: 120,
    coordinateSpace: 'viewport-css-px',
  });
  assert.equal(result.source.target.identity.objectName, 'Button');
  assert.equal(result.observation.hoverOwner.identity.objectName, 'Button');
  assert.deepEqual(result.observation.pressedButtons, []);
  assert.equal(result.observation.click.dispatched, true);
  assert.equal(
    result.observation.click.effectAuthority,
    'runtime-state-observation'
  );
  assert.equal(result.observation.waitFor.matched, true);
  assert.equal(result.observation.assertAfter.matched, true);
  assert.equal(
    runtimeCalls.filter(call => call.method === 'synchronize').length,
    3
  );
});

test('double-click and drag use canonical phases with no fixed-delay sequence', async () => {
  const { service, sentInputEvents } = makeFixture();
  const doubled = await service.interact({
    previewWindowId: 12,
    action: 'double-click',
    x: 25,
    y: 30,
  });
  assert.equal(doubled.dispatched.length, 5);
  assert.deepEqual(
    sentInputEvents.slice(0, 5).map(event => event.clickCount || 0),
    [0, 1, 1, 2, 2]
  );

  sentInputEvents.length = 0;
  const dragged = await service.interact({
    previewWindowId: 12,
    action: 'drag',
    x: 10,
    y: 20,
    toX: 50,
    toY: 60,
    dragSteps: 2,
  });
  assert.deepEqual(sentInputEvents.map(event => event.type), [
    'mouseMove',
    'mouseDown',
    'mouseMove',
    'mouseMove',
    'mouseUp',
  ]);
  assert.deepEqual(sentInputEvents[2].modifiers, ['leftButtonDown']);
  assert.equal(dragged.destination.coordinates.x, 50);
  assert.equal(dragged.destination.coordinates.y, 60);
});

test('hidden target is rejected with structured diagnostics before input dispatch', async () => {
  const { service, sentInputEvents } = makeFixture();
  await assert.rejects(
    service.interact({
      previewWindowId: 12,
      action: 'click',
      target: { objectName: 'HiddenButton' },
    }),
    error =>
      error &&
      error.code === 'preview_target_hidden' &&
      error.details &&
      error.details.hitTest &&
      error.details.hitTest.owner.identity.objectName === 'ReplacementButton'
  );
  assert.deepEqual(sentInputEvents, []);
});

test('exposes runtime/touch methods directly alongside canonical interaction', async () => {
  const { service, executedScripts } = makeFixture();
  const status = await service.getRuntimeStatus({ windowId: 12 });
  assert.equal(status.windowId, 12);
  assert.equal(status.version, 4);

  await service.sendTouch({
    windowId: 12,
    action: 'start',
    identifier: 1,
    x: 10,
    y: 20,
  });
  assert.ok(executedScripts.some(source => source.includes('touch')));
  assert.equal(typeof service.sendTouch, 'function');
  assert.equal(typeof service.inspect, 'function');
  assert.equal(typeof service.interact, 'function');
});
