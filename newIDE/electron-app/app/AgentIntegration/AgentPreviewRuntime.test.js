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
    getBoundingClientRect: () => ({ width: 800, height: 600 }),
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
      querySelectorAll: selector => (selector === 'canvas' ? [canvas] : []),
    },
  };
  context.window = context;
  context.window.scrollX = 0;
  context.window.scrollY = 0;
  context.window.screenX = 0;
  context.window.screenY = 0;
  context.window.dispatchEvent = event => {
    windowEvents.push(event);
    return true;
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
  const status = await runtime.handleAction({
    type: 'preview-runtime-status',
    windowId: 12,
  });
  assert.equal(status.installed, true);
  assert.equal(status.version, 1);

  const result = await runtime.handleAction({
    type: 'preview-touch',
    windowId: 12,
    action: 'start',
    identifier: 3,
    x: 120,
    y: 240,
  });
  assert.equal(result.result.action, 'start');
  assert.deepEqual(result.result.activeTouchIds, [3]);
  assert.equal(canvasEvents.length, 1);
  assert.equal(canvasEvents[0].type, 'touchstart');
  assert.equal(canvasEvents[0].changedTouches[0].identifier, 3);
});

test('virtual gamepad is exposed through navigator.getGamepads', async () => {
  const { runtime, context, windowEvents } = makeHarness();
  await runtime.handleAction({
    type: 'preview-gamepad',
    windowId: 12,
    action: 'connect',
    index: 0,
    axes: [0.25, -0.5],
    buttons: [1, 0],
  });
  const pads = context.navigator.getGamepads();
  assert.equal(pads[0].connected, true);
  assert.deepEqual(Array.from(pads[0].axes), [0.25, -0.5]);
  assert.equal(pads[0].buttons[0].pressed, true);
  assert.equal(windowEvents[0].type, 'gamepadconnected');

  await runtime.handleAction({
    type: 'preview-gamepad',
    windowId: 12,
    action: 'update',
    index: 0,
    axes: [1, 0],
    buttons: [0, 1],
  });
  assert.deepEqual(Array.from(context.navigator.getGamepads()[0].axes), [1, 0]);
  assert.equal(context.navigator.getGamepads()[0].buttons[1].pressed, true);
});
