const MAX_SEQUENCE_STEPS = 200;
const MAX_STEP_DELAY_MS = 5000;
const MAX_SEQUENCE_DELAY_MS = 30000;

const ALLOWED_MODIFIERS = new Set([
  'shift',
  'control',
  'ctrl',
  'alt',
  'meta',
  'command',
  'cmd',
  'isKeypad',
  'isAutoRepeat',
  'leftButtonDown',
  'middleButtonDown',
  'rightButtonDown',
  'capsLock',
  'numLock',
  'left',
  'right',
]);

const KEYBOARD_TYPES = new Set(['rawKeyDown', 'keyDown', 'keyUp', 'char']);
const MOUSE_TYPES = new Set([
  'mouseDown',
  'mouseUp',
  'mouseMove',
  'mouseEnter',
  'mouseLeave',
  'contextMenu',
  'mouseWheel',
]);
const MOUSE_BUTTONS = new Set(['left', 'middle', 'right']);

const sleep = milliseconds =>
  milliseconds > 0
    ? new Promise(resolve => setTimeout(resolve, milliseconds))
    : Promise.resolve();

const makeError = (code, message = code) => {
  const error = new Error(message);
  error.code = code;
  return error;
};

const normalizeModifiers = modifiers => {
  if (modifiers == null) return undefined;
  if (!Array.isArray(modifiers)) {
    throw makeError('invalid_input_modifiers');
  }
  const normalized = modifiers.map(modifier => String(modifier));
  const invalidModifier = normalized.find(
    modifier => !ALLOWED_MODIFIERS.has(modifier)
  );
  if (invalidModifier) {
    throw makeError(
      'invalid_input_modifier',
      `invalid_input_modifier:${invalidModifier}`
    );
  }
  return normalized;
};

const requireFiniteNumber = (value, field) => {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw makeError('invalid_input_event', `invalid_input_event:${field}`);
  }
  return number;
};

const normalizeInputEvent = inputEvent => {
  if (
    !inputEvent ||
    typeof inputEvent !== 'object' ||
    Array.isArray(inputEvent)
  ) {
    throw makeError('invalid_input_event');
  }

  const type = inputEvent.type;
  if (KEYBOARD_TYPES.has(type)) {
    if (typeof inputEvent.keyCode !== 'string' || !inputEvent.keyCode) {
      throw makeError('invalid_input_event', 'invalid_input_event:keyCode');
    }
    const event = {
      type,
      keyCode: inputEvent.keyCode,
    };
    const modifiers = normalizeModifiers(inputEvent.modifiers);
    if (modifiers) event.modifiers = modifiers;
    return event;
  }

  if (MOUSE_TYPES.has(type)) {
    const event = {
      type,
      x: Math.round(requireFiniteNumber(inputEvent.x, 'x')),
      y: Math.round(requireFiniteNumber(inputEvent.y, 'y')),
    };
    if (event.x < 0 || event.y < 0) {
      throw makeError('invalid_input_event', 'invalid_input_event:coordinates');
    }

    if (inputEvent.button != null) {
      if (!MOUSE_BUTTONS.has(inputEvent.button)) {
        throw makeError(
          'invalid_input_event',
          `invalid_input_event:button:${String(inputEvent.button)}`
        );
      }
      event.button = inputEvent.button;
    }
    if (inputEvent.clickCount != null) {
      const clickCount = Math.round(
        requireFiniteNumber(inputEvent.clickCount, 'clickCount')
      );
      if (clickCount < 0) {
        throw makeError(
          'invalid_input_event',
          'invalid_input_event:clickCount'
        );
      }
      event.clickCount = clickCount;
    }
    if (type === 'mouseWheel') {
      if (inputEvent.deltaX != null) {
        event.deltaX = requireFiniteNumber(inputEvent.deltaX, 'deltaX');
      }
      if (inputEvent.deltaY != null) {
        event.deltaY = requireFiniteNumber(inputEvent.deltaY, 'deltaY');
      }
      if (inputEvent.wheelTicksX != null) {
        event.wheelTicksX = requireFiniteNumber(
          inputEvent.wheelTicksX,
          'wheelTicksX'
        );
      }
      if (inputEvent.wheelTicksY != null) {
        event.wheelTicksY = requireFiniteNumber(
          inputEvent.wheelTicksY,
          'wheelTicksY'
        );
      }
      if (inputEvent.hasPreciseScrollingDeltas != null) {
        event.hasPreciseScrollingDeltas = !!inputEvent.hasPreciseScrollingDeltas;
      }
      if (inputEvent.canScroll != null)
        event.canScroll = !!inputEvent.canScroll;
    }
    const modifiers = normalizeModifiers(inputEvent.modifiers);
    if (modifiers) event.modifiers = modifiers;
    return event;
  }

  throw makeError(
    'unsupported_input_event_type',
    `unsupported_input_event_type:${String(type)}`
  );
};

const isLikelyPreviewWindow = (
  window,
  isEditorWindow,
  isRegisteredPreviewWindow
) => {
  if (!window || window.isDestroyed()) return false;
  if (isEditorWindow(window.id)) return false;
  if (isRegisteredPreviewWindow) return !!isRegisteredPreviewWindow(window.id);
  const title = String(window.getTitle ? window.getTitle() : '');
  const url = String(
    window.webContents && window.webContents.getURL
      ? window.webContents.getURL()
      : ''
  );
  return (
    title.startsWith('Preview of ') ||
    /(?:^|[/\\])(preview|gameplay-test-preview|in-game-editor-preview)(?:[/\\])index\.html(?:[?#]|$)/i.test(
      url
    )
  );
};

const resolvePreviewWindow = ({
  BrowserWindow,
  isEditorWindow,
  isRegisteredPreviewWindow,
  windowId,
}) => {
  if (windowId == null || windowId === '') {
    throw makeError('missing_preview_window_id');
  }
  const numericWindowId = Number(windowId);
  if (!Number.isInteger(numericWindowId) || numericWindowId <= 0) {
    throw makeError('invalid_preview_window_id');
  }
  const window = BrowserWindow.fromId(numericWindowId);
  if (
    !isLikelyPreviewWindow(window, isEditorWindow, isRegisteredPreviewWindow)
  ) {
    throw makeError('preview_window_not_found');
  }
  return window;
};

const getDelayMs = value => {
  if (value == null) return 0;
  const delayMs = Math.round(requireFiniteNumber(value, 'delayMs'));
  if (delayMs < 0 || delayMs > MAX_STEP_DELAY_MS) {
    throw makeError('invalid_input_delay');
  }
  return delayMs;
};

const createPreviewInputTools = ({
  BrowserWindow,
  isEditorWindow,
  isRegisteredPreviewWindow,
}) => {
  const pressedKeysByWindow = new Map();
  const pressedButtonsByWindow = new Map();
  const lastMousePositionByWindow = new Map();

  const trackInput = (windowId, event) => {
    if (KEYBOARD_TYPES.has(event.type)) {
      let pressedKeys = pressedKeysByWindow.get(windowId);
      if (!pressedKeys) {
        pressedKeys = new Set();
        pressedKeysByWindow.set(windowId, pressedKeys);
      }
      if (event.type === 'keyUp') pressedKeys.delete(event.keyCode);
      else if (event.type === 'keyDown' || event.type === 'rawKeyDown') {
        pressedKeys.add(event.keyCode);
      }
    }

    if (MOUSE_TYPES.has(event.type)) {
      lastMousePositionByWindow.set(windowId, { x: event.x, y: event.y });
      if (!event.button) return;
      let pressedButtons = pressedButtonsByWindow.get(windowId);
      if (!pressedButtons) {
        pressedButtons = new Set();
        pressedButtonsByWindow.set(windowId, pressedButtons);
      }
      if (event.type === 'mouseUp') pressedButtons.delete(event.button);
      else if (event.type === 'mouseDown') pressedButtons.add(event.button);
    }
  };

  const sendInput = ({ windowId, inputEvent }) => {
    const targetWindow = resolvePreviewWindow({
      BrowserWindow,
      isEditorWindow,
      isRegisteredPreviewWindow,
      windowId,
    });
    const event = normalizeInputEvent(inputEvent);
    targetWindow.focus();
    targetWindow.webContents.focus();
    targetWindow.webContents.sendInputEvent(event);
    trackInput(targetWindow.id, event);
    return {
      sent: true,
      windowId: targetWindow.id,
      event,
    };
  };

  const sendSequence = async ({ windowId, steps }) => {
    const targetWindow = resolvePreviewWindow({
      BrowserWindow,
      isEditorWindow,
      isRegisteredPreviewWindow,
      windowId,
    });
    if (!Array.isArray(steps) || steps.length === 0) {
      throw makeError('missing_input_sequence_steps');
    }
    if (steps.length > MAX_SEQUENCE_STEPS) {
      throw makeError('too_many_input_sequence_steps');
    }

    const normalizedSteps = steps.map((step, index) => {
      if (!step || typeof step !== 'object' || Array.isArray(step)) {
        throw makeError(
          'invalid_input_sequence_step',
          `invalid_input_sequence_step:${index}`
        );
      }
      try {
        return {
          event: normalizeInputEvent(step.event || step.inputEvent),
          delayMs: getDelayMs(step.delayMs),
        };
      } catch (error) {
        if (!error.stepIndex) error.stepIndex = index;
        throw error;
      }
    });
    const totalDelayMs = normalizedSteps.reduce(
      (total, step) => total + step.delayMs,
      0
    );
    if (totalDelayMs > MAX_SEQUENCE_DELAY_MS) {
      throw makeError('input_sequence_too_long');
    }

    targetWindow.focus();
    targetWindow.webContents.focus();
    for (const step of normalizedSteps) {
      targetWindow.webContents.sendInputEvent(step.event);
      trackInput(targetWindow.id, step.event);
      await sleep(step.delayMs);
    }
    return {
      sent: true,
      windowId: targetWindow.id,
      steps: normalizedSteps.length,
      totalDelayMs,
    };
  };

  const resetInput = ({ windowId }) => {
    const targetWindow = resolvePreviewWindow({
      BrowserWindow,
      isEditorWindow,
      isRegisteredPreviewWindow,
      windowId,
    });
    targetWindow.focus();
    targetWindow.webContents.focus();

    const releasedKeys = Array.from(
      pressedKeysByWindow.get(targetWindow.id) || []
    );
    for (const keyCode of releasedKeys) {
      targetWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode });
    }

    const mousePosition = lastMousePositionByWindow.get(targetWindow.id) || {
      x: 0,
      y: 0,
    };
    const releasedButtons = Array.from(
      pressedButtonsByWindow.get(targetWindow.id) || []
    );
    for (const button of releasedButtons) {
      targetWindow.webContents.sendInputEvent({
        type: 'mouseUp',
        button,
        clickCount: 1,
        x: mousePosition.x,
        y: mousePosition.y,
      });
    }

    pressedKeysByWindow.delete(targetWindow.id);
    pressedButtonsByWindow.delete(targetWindow.id);
    return {
      reset: true,
      windowId: targetWindow.id,
      releasedKeys,
      releasedButtons,
    };
  };

  return {
    sendInput,
    sendSequence,
    resetInput,
  };
};

module.exports = {
  createPreviewInputTools,
  normalizeInputEvent,
  isLikelyPreviewWindow,
};
