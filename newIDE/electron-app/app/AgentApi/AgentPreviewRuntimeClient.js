(() => {
  const name = '__GDevelopAgentPreviewRuntime';
  if (window[name] && window[name].version === 1) return window[name].status();

  const touches = new Map();
  const gamepads = new Map();
  const originalGetGamepads =
    typeof navigator.getGamepads === 'function'
      ? navigator.getGamepads.bind(navigator)
      : null;

  const canvas = () => {
    const items = Array.from(document.querySelectorAll('canvas'));
    return items.sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return br.width * br.height - ar.width * ar.height;
    })[0];
  };

  const touchObject = (target, data) => {
    const init = {
      identifier: data.identifier,
      target,
      clientX: data.x,
      clientY: data.y,
      pageX: data.x + window.scrollX,
      pageY: data.y + window.scrollY,
      screenX: data.x + window.screenX,
      screenY: data.y + window.screenY,
      radiusX: 1,
      radiusY: 1,
      rotationAngle: 0,
      force: data.force == null ? 1 : data.force,
    };
    try {
      return new Touch(init);
    } catch (error) {
      return init;
    }
  };

  const touchEvent = (type, target, changed) => {
    const active = Array.from(touches.values()).map(item =>
      touchObject(target, item)
    );
    const changedTouches = [touchObject(target, changed)];
    try {
      return new TouchEvent(type, {
        bubbles: true,
        cancelable: true,
        touches: active,
        targetTouches: active,
        changedTouches,
      });
    } catch (error) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, {
        touches: { value: active },
        targetTouches: { value: active },
        changedTouches: { value: changedTouches },
      });
      return event;
    }
  };

  const sendTouch = payload => {
    const target = canvas();
    if (!target) throw new Error('preview_canvas_not_found');
    const identifier = Number(
      payload.identifier == null ? 0 : payload.identifier
    );
    const x = Number(payload.x);
    const y = Number(payload.y);
    if (!Number.isInteger(identifier) || identifier < 0)
      throw new Error('invalid_touch_identifier');
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0)
      throw new Error('invalid_touch_coordinates');

    const data = { identifier, x, y, force: Number(payload.force) || 1 };
    const types = {
      start: 'touchstart',
      move: 'touchmove',
      end: 'touchend',
      cancel: 'touchcancel',
    };
    const type = types[payload.action];
    if (!type) throw new Error(`unsupported_touch_action:${payload.action}`);

    if (payload.action === 'start' || payload.action === 'move')
      touches.set(identifier, data);
    else touches.delete(identifier);

    target.focus();
    target.dispatchEvent(touchEvent(type, target, data));
    return {
      action: payload.action,
      identifier,
      x,
      y,
      activeTouchIds: Array.from(touches.keys()),
    };
  };

  const button = value => {
    const number = Math.max(0, Math.min(1, Number(value) || 0));
    return { pressed: number >= 0.5, touched: number > 0, value: number };
  };

  const gamepadEvent = (type, gamepad) => {
    try {
      return new GamepadEvent(type, { gamepad });
    } catch (error) {
      const event = new Event(type);
      Object.defineProperty(event, 'gamepad', { value: gamepad });
      return event;
    }
  };

  const connectGamepad = payload => {
    const index = Number(payload.index == null ? 0 : payload.index);
    if (!Number.isInteger(index) || index < 0 || index > 15)
      throw new Error('invalid_gamepad_index');
    const pad = {
      id: payload.id || `GDevelop Agent Virtual Gamepad ${index}`,
      index,
      connected: true,
      mapping: payload.mapping || 'standard',
      timestamp: performance.now(),
      axes: Array.isArray(payload.axes)
        ? payload.axes.map(value =>
            Math.max(-1, Math.min(1, Number(value) || 0))
          )
        : [0, 0, 0, 0],
      buttons: Array.isArray(payload.buttons)
        ? payload.buttons.map(button)
        : Array.from({ length: 17 }, () => button(0)),
    };
    gamepads.set(index, pad);
    window.dispatchEvent(gamepadEvent('gamepadconnected', pad));
    return pad;
  };

  const setGamepad = payload => {
    const index = Number(payload.index == null ? 0 : payload.index);
    const pad = gamepads.get(index) || connectGamepad(payload);
    if (Array.isArray(payload.axes))
      pad.axes = payload.axes.map(value =>
        Math.max(-1, Math.min(1, Number(value) || 0))
      );
    if (Array.isArray(payload.buttons))
      pad.buttons = payload.buttons.map(button);
    pad.timestamp = performance.now();
    return pad;
  };

  const disconnectGamepad = payload => {
    const index = Number(payload.index == null ? 0 : payload.index);
    const pad = gamepads.get(index);
    if (!pad) return null;
    pad.connected = false;
    pad.timestamp = performance.now();
    gamepads.delete(index);
    window.dispatchEvent(gamepadEvent('gamepaddisconnected', pad));
    return pad;
  };

  Object.defineProperty(navigator, 'getGamepads', {
    configurable: true,
    value: () => {
      const result = originalGetGamepads
        ? Array.from(originalGetGamepads() || [])
        : [];
      for (const [index, pad] of gamepads) result[index] = pad;
      return result;
    },
  });

  const runtime = {
    version: 1,
    touch: sendTouch,
    gamepad: payload => {
      if (payload.action === 'connect') return connectGamepad(payload);
      if (payload.action === 'update') return setGamepad(payload);
      if (payload.action === 'disconnect') return disconnectGamepad(payload);
      if (payload.action === 'reset') {
        for (const index of Array.from(gamepads.keys()))
          disconnectGamepad({ index });
        return runtime.status();
      }
      throw new Error(`unsupported_gamepad_action:${payload.action}`);
    },
    reset: () => {
      touches.clear();
      for (const index of Array.from(gamepads.keys()))
        disconnectGamepad({ index });
      return runtime.status();
    },
    status: () => ({
      installed: true,
      version: 1,
      activeTouchIds: Array.from(touches.keys()),
      virtualGamepads: Array.from(gamepads.values()).map(pad => ({
        id: pad.id,
        index: pad.index,
        connected: pad.connected,
        axes: pad.axes.slice(),
        buttons: pad.buttons.map(item => ({ ...item })),
      })),
    }),
  };
  window[name] = runtime;
  return runtime.status();
})();
