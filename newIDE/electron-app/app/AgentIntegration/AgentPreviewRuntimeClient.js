(() => {
  const name = '__GDevelopAgentPreviewRuntime';
  if (window[name] && window[name].version === 2) return window[name].status();

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

  const clampInteger = (value, fallback, minimum, maximum) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(maximum, Math.max(minimum, Math.round(parsed)));
  };

  const transformVariable = (variable, depth = 0) => {
    if (!variable || typeof variable !== 'object' || depth > 12) return null;
    const type = variable._type;
    if (type === 'string') return { type, value: variable._str || '' };
    if (type === 'number') return { type, value: Number(variable._value) || 0 };
    if (type === 'boolean') return { type, value: !!variable._bool };
    if (type === 'structure') {
      const children = variable._children || {};
      const value = {};
      Object.keys(children)
        .slice(0, 200)
        .forEach(name => {
          value[name] = transformVariable(children[name], depth + 1);
        });
      return { type, value };
    }
    if (type === 'array') {
      const children = Array.isArray(variable._childrenArray)
        ? variable._childrenArray.slice(0, 200)
        : [];
      return {
        type,
        value: children.map(item => transformVariable(item, depth + 1)),
      };
    }
    if (variable._isStructure) {
      const children = variable._children || {};
      const value = {};
      Object.keys(children)
        .slice(0, 200)
        .forEach(name => {
          value[name] = transformVariable(children[name], depth + 1);
        });
      return { type: 'structure', value };
    }
    if (variable._numberDirty && !variable._stringDirty) {
      return { type: 'string', value: variable._str || '' };
    }
    return {
      type: 'number',
      value: Number.isFinite(Number(variable._value))
        ? Number(variable._value)
        : 0,
    };
  };

  const transformVariablesContainer = container => {
    const items =
      container &&
      container._variables &&
      container._variables.items &&
      typeof container._variables.items === 'object'
        ? container._variables.items
        : {};
    const variables = {};
    Object.keys(items)
      .slice(0, 500)
      .forEach(name => {
        variables[name] = transformVariable(items[name]);
      });
    return variables;
  };

  const summarizeBehavior = behavior => {
    if (!behavior || typeof behavior !== 'object') return null;
    const state = {};
    Object.keys(behavior)
      .filter(
        key =>
          key !== 'owner' &&
          key !== 'name' &&
          key !== 'type' &&
          key !== '_manager' &&
          key !== '_runtimeScene'
      )
      .slice(0, 40)
      .forEach(key => {
        const value = behavior[key];
        if (
          value === null ||
          typeof value === 'string' ||
          typeof value === 'number' ||
          typeof value === 'boolean'
        ) {
          state[key] = value;
        }
      });
    return {
      name: behavior.name || null,
      type: behavior.type || null,
      activated:
        typeof behavior._activated === 'boolean' ? behavior._activated : null,
      state,
    };
  };

  const summarizeInstance = instance => {
    const behaviors = Array.isArray(instance && instance._behaviors)
      ? instance._behaviors.map(summarizeBehavior).filter(Boolean)
      : [];
    return {
      id: instance && instance.id != null ? instance.id : null,
      name: (instance && instance.name) || null,
      type: (instance && instance.type) || null,
      x: instance && typeof instance.x === 'number' ? instance.x : 0,
      y: instance && typeof instance.y === 'number' ? instance.y : 0,
      z:
        instance && typeof instance.z === 'number'
          ? instance.z
          : instance && typeof instance._z === 'number'
          ? instance._z
          : 0,
      angle:
        instance && typeof instance.angle === 'number' ? instance.angle : 0,
      zOrder:
        instance && typeof instance.zOrder === 'number' ? instance.zOrder : 0,
      layer:
        instance && typeof instance.layer === 'string' ? instance.layer : '',
      hidden: !!(instance && instance.hidden),
      livingOnScene: !instance || instance.livingOnScene !== false,
      variables: transformVariablesContainer(instance && instance._variables),
      behaviors,
    };
  };

  const snapshot = payload => {
    const runtimeGame = window.game;
    if (!runtimeGame || typeof runtimeGame !== 'object')
      throw new Error('preview_runtime_game_not_found');
    const sceneStack =
      typeof runtimeGame.getSceneStack === 'function'
        ? runtimeGame.getSceneStack()
        : runtimeGame._sceneStack;
    const currentScene =
      sceneStack && typeof sceneStack.getCurrentScene === 'function'
        ? sceneStack.getCurrentScene()
        : sceneStack &&
          Array.isArray(sceneStack._stack) &&
          sceneStack._stack.length
        ? sceneStack._stack[sceneStack._stack.length - 1]
        : null;
    const maxInstances = clampInteger(
      payload && payload.maxInstances,
      200,
      1,
      1000
    );
    const requestedObjectNames =
      payload && Array.isArray(payload.objectNames)
        ? new Set(
            payload.objectNames
              .filter(name => typeof name === 'string' && name.length <= 500)
              .slice(0, 200)
          )
        : null;
    const items =
      currentScene &&
      currentScene._instances &&
      currentScene._instances.items &&
      typeof currentScene._instances.items === 'object'
        ? currentScene._instances.items
        : {};
    let includedInstances = 0;
    let totalInstances = 0;
    const objects = {};
    Object.keys(items).forEach(objectName => {
      const instances = Array.isArray(items[objectName])
        ? items[objectName].filter(Boolean)
        : [];
      totalInstances += instances.length;
      if (requestedObjectNames && !requestedObjectNames.has(objectName)) return;
      const remaining = Math.max(0, maxInstances - includedInstances);
      const selectedInstances = instances.slice(0, remaining);
      includedInstances += selectedInstances.length;
      objects[objectName] = {
        count: instances.length,
        instances: selectedInstances.map(summarizeInstance),
        truncated: selectedInstances.length < instances.length,
      };
    });
    const timeManager = currentScene && currentScene._timeManager;
    const elapsedTimeMs =
      timeManager && typeof timeManager._elapsedTime === 'number'
        ? timeManager._elapsedTime
        : null;
    const timeScale =
      timeManager && typeof timeManager._timeScale === 'number'
        ? timeManager._timeScale
        : null;
    return {
      snapshotSource: 'bounded-preview-runtime',
      paused:
        typeof runtimeGame.isPaused === 'function'
          ? !!runtimeGame.isPaused()
          : !!runtimeGame._paused,
      scene: currentScene
        ? {
            name:
              typeof currentScene.getName === 'function'
                ? currentScene.getName()
                : currentScene._name || null,
            elapsedTimeMs,
            timeFromStartMs:
              timeManager && typeof timeManager._timeFromStart === 'number'
                ? timeManager._timeFromStart
                : null,
            timeScale,
            fpsApprox:
              elapsedTimeMs && elapsedTimeMs > 0 && timeScale && timeScale > 0
                ? (1000 * timeScale) / elapsedTimeMs
                : null,
            variables: transformVariablesContainer(currentScene._variables),
          }
        : null,
      globalVariables: transformVariablesContainer(runtimeGame._variables),
      objects,
      totalInstances,
      includedInstances,
      truncatedInstances: Math.max(0, totalInstances - includedInstances),
    };
  };

  const runtime = {
    version: 2,
    snapshot,
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
      version: 2,
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
