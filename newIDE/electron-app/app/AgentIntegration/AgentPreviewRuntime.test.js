const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {
  createAgentPreviewRuntime,
  validateTouch,
  validateGamepad,
} = require('./AgentPreviewRuntime');

const makeHarness = () => {
  const canvasEvents = [];
  const windowEvents = [];
  const canvas = {
    tagName: 'CANVAS',
    style: { cursor: 'pointer' },
    getBoundingClientRect: () => ({
      left: 10,
      top: 20,
      width: 800,
      height: 600,
    }),
    focus: () => {},
    dispatchEvent: event => {
      canvasEvents.push(event);
      return true;
    },
  };

  class FakeEvent {
    constructor(type, init = {}) {
      this.type = type;
      Object.assign(this, init);
    }
  }
  class FakeTouch {
    constructor(init) {
      Object.assign(this, init);
    }
  }
  class FakeTouchEvent extends FakeEvent {
    constructor(type, init) {
      super(type, init);
    }
  }
  class FakeGamepadEvent extends FakeEvent {
    constructor(type, init) {
      super(type, init);
    }
  }

  const context = {
    console,
    Map,
    Array,
    Object,
    Number,
    String,
    Boolean,
    Math,
    JSON,
    Error,
    Event: FakeEvent,
    Touch: FakeTouch,
    TouchEvent: FakeTouchEvent,
    GamepadEvent: FakeGamepadEvent,
    performance: { now: () => 123 },
    navigator: { getGamepads: () => [] },
    document: {
      body: { style: { cursor: '' } },
      querySelectorAll: selector => (selector === 'canvas' ? [canvas] : []),
      elementFromPoint: () => canvas,
    },
  };
  context.window = context;
  context.window.scrollX = 0;
  context.window.scrollY = 0;
  context.window.innerWidth = 1280;
  context.window.innerHeight = 720;
  context.window.outerWidth = 1296;
  context.window.outerHeight = 759;
  context.window.devicePixelRatio = 1.25;
  context.window.screenX = 0;
  context.window.screenY = 0;
  context.window.dispatchEvent = event => {
    windowEvents.push(event);
    return true;
  };
  context.window.getComputedStyle = element => ({
    cursor:
      element && element.style ? element.style.cursor || 'default' : 'default',
  });
  context.window.requestAnimationFrame = callback => {
    const runtimeGame = context.window.__GDevelopAgentRuntimeGame;
    const sceneStack =
      runtimeGame && typeof runtimeGame.getSceneStack === 'function'
        ? runtimeGame.getSceneStack()
        : null;
    const scene =
      sceneStack && typeof sceneStack.getCurrentScene === 'function'
        ? sceneStack.getCurrentScene()
        : null;
    if (scene && scene._timeManager) {
      scene._timeManager._elapsedTime = 16;
      scene._timeManager._timeFromStart += 16;
    }
    callback(16);
    return 1;
  };
  const vmContext = vm.createContext(context);

  const webContents = {
    getURL: () => 'file:///C:/Temp/GDevelop/preview/index.html',
    focus: () => {},
    executeJavaScript: async source => vm.runInContext(source, vmContext),
  };
  const previewWindow = {
    id: 12,
    isDestroyed: () => false,
    getTitle: () => 'Preview of Runtime Test',
    focus: () => {},
    webContents,
  };
  const BrowserWindow = { fromId: id => (id === 12 ? previewWindow : null) };
  const runtime = createAgentPreviewRuntime({
    BrowserWindow,
    isEditorWindow: () => false,
  });
  return { runtime, context, canvasEvents, windowEvents };
};

test('validates touch and gamepad payloads', () => {
  assert.deepEqual(validateTouch({ action: 'start', x: 10, y: 20 }), {
    action: 'start',
    identifier: 0,
    x: 10,
    y: 20,
    force: 1,
  });
  assert.throws(
    () => validateTouch({ action: 'start', x: -1, y: 2 }),
    /invalid_touch_coordinates/
  );
  assert.deepEqual(validateGamepad({ action: 'connect', index: 1 }), {
    action: 'connect',
    index: 1,
    id: undefined,
    mapping: undefined,
    axes: undefined,
    buttons: undefined,
  });
  assert.throws(
    () => validateGamepad({ action: 'update', index: 20 }),
    /invalid_gamepad_index/
  );
});

test('installs runtime and dispatches a synthetic touch to the game canvas', async () => {
  const { runtime, canvasEvents } = makeHarness();
  const status = await runtime.ensureInstalled(12);
  assert.equal(status.installed, true);
  assert.equal(status.version, 4);

  const result = await runtime.call(
    12,
    'touch',
    validateTouch({
      action: 'start',
      identifier: 3,
      x: 120,
      y: 240,
    })
  );
  assert.equal(result.result.action, 'start');
  assert.deepEqual(result.result.activeTouchIds, [3]);
  assert.equal(canvasEvents.length, 1);
  assert.equal(canvasEvents[0].type, 'touchstart');
  assert.equal(canvasEvents[0].changedTouches[0].identifier, 3);
});

test('announces the BrowserWindow identity through the preview debugger connection', async () => {
  const { runtime, context } = makeHarness();
  const sentMessages = [];
  context.window.__GDevelopAgentRuntimeGame = {
    _debuggerClient: {
      _sendMessage: message => sentMessages.push(JSON.parse(message)),
    },
  };

  const status = await runtime.ensureInstalled(12, { focus: false });
  assert.equal(status.identity.announced, true);
  assert.equal(status.identity.windowId, 12);
  assert.deepEqual(sentMessages, [
    {
      command: 'agent.preview.identity',
      payload: { windowId: 12 },
    },
  ]);

  const after = await runtime.call(12, 'status', {});
  assert.equal(after.result.identityWindowId, 12);
});

test('virtual gamepad is exposed through navigator.getGamepads', async () => {
  const { runtime, context, windowEvents } = makeHarness();
  await runtime.call(
    12,
    'gamepad',
    validateGamepad({
      action: 'connect',
      index: 0,
      axes: [0.25, -0.5],
      buttons: [1, 0],
    })
  );
  const pads = context.navigator.getGamepads();
  assert.equal(pads[0].connected, true);
  assert.deepEqual(Array.from(pads[0].axes), [0.25, -0.5]);
  assert.equal(pads[0].buttons[0].pressed, true);
  assert.equal(windowEvents[0].type, 'gamepadconnected');

  await runtime.call(
    12,
    'gamepad',
    validateGamepad({
      action: 'update',
      index: 0,
      axes: [1, 0],
      buttons: [0, 1],
    })
  );
  assert.deepEqual(Array.from(context.navigator.getGamepads()[0].axes), [1, 0]);
  assert.equal(context.navigator.getGamepads()[0].buttons[1].pressed, true);
  assert.equal('handleAction' in runtime, false);
});

test('captures a bounded structured runtime snapshot without serializing RuntimeGame', async () => {
  const { runtime, context } = makeHarness();
  const scene = {
    _name: 'Snapshot scene',
    getName: () => 'Snapshot scene',
    _timeManager: {
      _elapsedTime: 20,
      _timeFromStart: 1200,
      _timeScale: 1,
    },
    _variables: {
      _variables: {
        items: {
          Score: { _type: 'number', _value: 7 },
        },
      },
    },
    _instances: {
      items: {
        Player: [
          {
            id: 1,
            name: 'Player',
            type: 'Sprite',
            x: 10,
            y: 20,
            zOrder: 3,
            layer: '',
            livingOnScene: true,
            getText: () => 'Runtime text',
            getOpacity: () => 200,
            _variables: { _variables: { items: {} } },
            _behaviors: [
              {
                name: 'Platformer',
                type: 'PlatformBehavior::PlatformerObjectBehavior',
                _activated: true,
                speed: 42,
                owner: {},
              },
            ],
          },
        ],
        Coin: [
          {
            id: 2,
            name: 'Coin',
            type: 'Sprite',
            x: 30,
            y: 40,
            _variables: { _variables: { items: {} } },
            _behaviors: [],
          },
        ],
      },
    },
  };
  context.__GDevelopAgentRuntimeGame = {
    _paused: false,
    isPaused: () => false,
    _variables: {
      _variables: {
        items: {
          GlobalScore: { _type: 'number', _value: 11 },
        },
      },
    },
    getSceneStack: () => ({
      getCurrentScene: () => scene,
    }),
  };

  const response = await runtime.call(12, 'snapshot', {
    maxInstances: 1,
    objectNames: ['Player'],
  });
  const snapshot = response.result;
  assert.equal(snapshot.snapshotSource, 'bounded-preview-runtime');
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot.viewport)), {
    width: 1280,
    height: 720,
    outerWidth: 1296,
    outerHeight: 759,
    devicePixelRatio: 1.25,
  });
  assert.equal(snapshot.scene.name, 'Snapshot scene');
  assert.equal(snapshot.scene.variables.Score.value, 7);
  assert.equal(snapshot.globalVariables.GlobalScore.value, 11);
  assert.equal(snapshot.objects.Player.count, 1);
  assert.equal(snapshot.objects.Player.instances.length, 1);
  assert.equal(
    snapshot.objects.Player.instances[0].behaviors[0].state.speed,
    42
  );
  assert.equal(snapshot.objects.Player.instances[0].text, 'Runtime text');
  assert.equal(snapshot.objects.Player.instances[0].opacity, 200);
  assert.equal(snapshot.objects.Coin, undefined);
  assert.equal(snapshot.totalInstances, 2);
  assert.equal(snapshot.includedInstances, 1);
  assert.equal(snapshot.truncatedInstances, 1);
});

test('inspects scaled runtime hitboxes and excludes hidden stale controls from hit ownership', async () => {
  const { runtime, context } = makeHarness();
  const layer = {
    isVisible: () => true,
    getCameraRotationX: () => 0,
    getCameraRotationY: () => 0,
    getWidth: () => 400,
    getHeight: () => 300,
    convertInverseCoords: (x, y, z, result) => {
      result[0] = x;
      result[1] = y;
      return result;
    },
    convertCoords: (x, y, z, result) => {
      result[0] = x;
      result[1] = y;
      return result;
    },
  };
  const makeObject = ({ name, id, hidden, zOrder }) => ({
    id,
    name,
    type: 'Sprite',
    livingOnScene: true,
    getName: () => name,
    getLayer: () => '',
    getZOrder: () => zOrder,
    isHidden: () => hidden,
    getWidth: () => 40,
    getHeight: () => 40,
    getCenterXInScene: () => 60,
    getCenterYInScene: () => 50,
    getDrawableX: () => 40,
    getDrawableY: () => 30,
    getAABB: () => ({ min: [40, 30], max: [80, 70] }),
    getHitBoxes: () => [{ vertices: [[40, 30], [80, 30], [80, 70], [40, 70]] }],
    _variables: { _variables: { items: {} } },
    _behaviors: [],
  });
  const stale = makeObject({
    name: 'LegacyButton',
    id: 1,
    hidden: true,
    zOrder: 99,
  });
  const replacement = makeObject({
    name: 'VisibleButton',
    id: 2,
    hidden: false,
    zOrder: 1,
  });
  const noHit = {
    ...makeObject({
      name: 'NoHitButton',
      id: 3,
      hidden: false,
      zOrder: 0,
    }),
    getHitBoxes: () => [],
  };
  const scene = {
    _name: 'Interaction',
    getName: () => 'Interaction',
    _timeManager: {
      _elapsedTime: 16,
      _timeFromStart: 100,
      _timeScale: 1,
    },
    _variables: {
      _variables: {
        items: {
          Tab: { _type: 'string', _str: 'shop' },
        },
      },
    },
    _instances: {
      items: {
        LegacyButton: [stale],
        VisibleButton: [replacement],
        NoHitButton: [noHit],
      },
    },
    _orderedLayers: [layer],
    getLayer: () => layer,
  };
  context.window.__GDevelopAgentRuntimeGame = {
    getGameResolutionWidth: () => 400,
    getGameResolutionHeight: () => 300,
    getRenderer: () => ({
      getCanvas: () => context.document.querySelectorAll('canvas')[0],
    }),
    getSceneStack: () => ({
      getCurrentScene: () => scene,
    }),
    _variables: { _variables: { items: {} } },
  };

  const inspected = await runtime.call(12, 'inspect', {
    target: { objectName: 'VisibleButton' },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(inspected.result.point)), {
    x: 130,
    y: 120,
    coordinateSpace: 'viewport-css-px',
    insideViewport: true,
    insideCanvas: true,
  });
  assert.equal(inspected.result.target.size.width, 40);
  assert.equal(inspected.result.target.viewport.bounds.width, 80);
  assert.equal(inspected.result.target.viewport.bounds.height, 80);
  assert.equal(
    inspected.result.hitTest.owner.identity.objectName,
    'VisibleButton'
  );
  assert.equal(inspected.result.hitTest.excluded.length, 1);
  assert.equal(
    inspected.result.hitTest.excluded[0].identity.objectName,
    'LegacyButton'
  );
  assert.deepEqual(
    Array.from(inspected.result.hitTest.excluded[0].state.blockedReasons),
    ['hidden']
  );
  assert.equal(inspected.result.pointer.cursor, 'pointer');
  assert.equal(inspected.result.viewport.devicePixelRatio, 1.25);

  const hidden = await runtime.call(12, 'inspect', {
    target: { objectName: 'LegacyButton' },
  });
  assert.equal(
    hidden.result.diagnostics.some(
      diagnostic => diagnostic.code === 'preview_target_hidden'
    ),
    true
  );
  assert.equal(
    hidden.result.hitTest.owner.identity.objectName,
    'VisibleButton'
  );

  const noHitResult = await runtime.call(12, 'inspect', {
    target: { objectName: 'NoHitButton' },
  });
  assert.equal(
    noHitResult.result.diagnostics.some(
      diagnostic => diagnostic.code === 'preview_target_not_hit_testable'
    ),
    true
  );

  const outside = await runtime.call(12, 'inspect', {
    x: 2000,
    y: 2000,
    coordinateSpace: 'viewport',
  });
  assert.equal(
    outside.result.diagnostics.some(
      diagnostic => diagnostic.code === 'preview_target_outside_viewport'
    ),
    true
  );
  assert.equal(
    outside.result.diagnostics.some(
      diagnostic => diagnostic.code === 'preview_target_outside_canvas'
    ),
    true
  );

  const synchronized = await runtime.call(12, 'synchronize', {
    maxFrames: 2,
    timeoutMs: 100,
  });
  assert.equal(synchronized.result.processed, true);
  assert.ok(synchronized.result.after.timeFromStartMs > 100);

  const state = await runtime.call(12, 'waitForState', {
    scope: 'scene',
    variable: 'Tab',
    operator: 'equals',
    value: 'shop',
    timeoutMs: 100,
    stableFrames: 1,
  });
  assert.equal(state.result.matched, true);
  assert.equal(state.result.evaluation.actual, 'shop');
});

test('captured RuntimeGame identity is authoritative over a stale window.game alias', async () => {
  const { runtime, context } = makeHarness();
  const capturedMessages = [];
  const staleMessages = [];

  context.window.__GDevelopAgentRuntimeGame = {
    _debuggerClient: {
      _sendMessage: message => capturedMessages.push(JSON.parse(message)),
    },
  };
  context.window.game = {
    _debuggerClient: {
      _sendMessage: message => staleMessages.push(JSON.parse(message)),
    },
  };

  const status = await runtime.ensureInstalled(12, { focus: false });
  assert.equal(status.version, 4);
  assert.equal(status.identity.announced, true);
  assert.equal(capturedMessages.length, 1);
  assert.equal(staleMessages.length, 0);
});
