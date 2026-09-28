(() => {
  const name = '__GDevelopAgentPreviewRuntime';
  if (
    window[name] &&
    window[name].version === 4 &&
    typeof window[name].announceIdentity === 'function'
  ) {
    return window[name].status();
  }

  const touches = new Map();
  let identityWindowId = null;
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

  const getRuntimeGame = () => {
    const captured = window.__GDevelopAgentRuntimeGame;
    if (captured && typeof captured === 'object') return captured;
    const legacy = window.game;
    return legacy && typeof legacy === 'object' ? legacy : null;
  };

  const getCurrentScene = () => {
    const runtimeGame = getRuntimeGame();
    if (!runtimeGame) return null;
    const sceneStack =
      typeof runtimeGame.getSceneStack === 'function'
        ? runtimeGame.getSceneStack()
        : runtimeGame._sceneStack;
    return sceneStack && typeof sceneStack.getCurrentScene === 'function'
      ? sceneStack.getCurrentScene()
      : sceneStack &&
        Array.isArray(sceneStack._stack) &&
        sceneStack._stack.length
      ? sceneStack._stack[sceneStack._stack.length - 1]
      : null;
  };

  const readMethod = (object, methodName, fallback = null) => {
    if (!object || typeof object[methodName] !== 'function') return fallback;
    try {
      const value = object[methodName]();
      return value === undefined ? fallback : value;
    } catch (_) {
      return fallback;
    }
  };

  const getRuntimeCanvas = () => {
    const runtimeGame = getRuntimeGame();
    const renderer =
      runtimeGame && typeof runtimeGame.getRenderer === 'function'
        ? runtimeGame.getRenderer()
        : runtimeGame && runtimeGame._renderer;
    const rendererCanvas =
      renderer && typeof renderer.getCanvas === 'function'
        ? renderer.getCanvas()
        : null;
    return rendererCanvas || canvas();
  };

  const getViewportMetrics = () => {
    const runtimeGame = getRuntimeGame();
    const runtimeCanvas = getRuntimeCanvas();
    const rect =
      runtimeCanvas && typeof runtimeCanvas.getBoundingClientRect === 'function'
        ? runtimeCanvas.getBoundingClientRect()
        : null;
    const gameWidth =
      runtimeGame && typeof runtimeGame.getGameResolutionWidth === 'function'
        ? Number(runtimeGame.getGameResolutionWidth())
        : rect && Number(rect.width);
    const gameHeight =
      runtimeGame && typeof runtimeGame.getGameResolutionHeight === 'function'
        ? Number(runtimeGame.getGameResolutionHeight())
        : rect && Number(rect.height);
    return {
      width: typeof window.innerWidth === 'number' ? window.innerWidth : null,
      height:
        typeof window.innerHeight === 'number' ? window.innerHeight : null,
      devicePixelRatio:
        typeof window.devicePixelRatio === 'number'
          ? window.devicePixelRatio
          : null,
      gameResolution: {
        width: Number.isFinite(gameWidth) && gameWidth > 0 ? gameWidth : null,
        height:
          Number.isFinite(gameHeight) && gameHeight > 0 ? gameHeight : null,
      },
      canvas: rect
        ? {
            x: Number(rect.left) || 0,
            y: Number(rect.top) || 0,
            width: Number(rect.width) || 0,
            height: Number(rect.height) || 0,
          }
        : null,
    };
  };

  const gameToClientPoint = (x, y, metrics = getViewportMetrics()) => {
    if (
      !metrics.canvas ||
      !metrics.gameResolution.width ||
      !metrics.gameResolution.height
    ) {
      return { x, y };
    }
    return {
      x:
        metrics.canvas.x +
        (x * metrics.canvas.width) / metrics.gameResolution.width,
      y:
        metrics.canvas.y +
        (y * metrics.canvas.height) / metrics.gameResolution.height,
    };
  };

  const clientToGamePoint = (x, y, metrics = getViewportMetrics()) => {
    if (
      !metrics.canvas ||
      !metrics.gameResolution.width ||
      !metrics.gameResolution.height ||
      metrics.canvas.width <= 0 ||
      metrics.canvas.height <= 0
    ) {
      return { x, y };
    }
    return {
      x:
        ((x - metrics.canvas.x) * metrics.gameResolution.width) /
        metrics.canvas.width,
      y:
        ((y - metrics.canvas.y) * metrics.gameResolution.height) /
        metrics.canvas.height,
    };
  };

  const sceneToGamePoint = (layer, x, y) => {
    if (!layer) return [x, y];
    if (
      typeof layer.getCameraRotationX === 'function' &&
      typeof layer.getCameraRotationY === 'function' &&
      (Math.abs(Number(layer.getCameraRotationX()) || 0) > 0.001 ||
        Math.abs(Number(layer.getCameraRotationY()) || 0) > 0.001)
    ) {
      const renderer =
        typeof layer.getRenderer === 'function' ? layer.getRenderer() : null;
      const threeCamera =
        renderer && typeof renderer.getThreeCamera === 'function'
          ? renderer.getThreeCamera()
          : null;
      if (
        threeCamera &&
        typeof THREE !== 'undefined' &&
        THREE &&
        typeof THREE.Vector3 === 'function'
      ) {
        threeCamera.updateMatrixWorld();
        const vector = new THREE.Vector3(x, -y, 0);
        vector.project(threeCamera);
        const width = readMethod(layer, 'getWidth', null);
        const height = readMethod(layer, 'getHeight', null);
        if (
          Number.isFinite(vector.x) &&
          Number.isFinite(vector.y) &&
          Number.isFinite(width) &&
          Number.isFinite(height)
        ) {
          return [((vector.x + 1) / 2) * width, ((1 - vector.y) / 2) * height];
        }
      }
    }
    if (typeof layer.convertInverseCoords === 'function') {
      return layer.convertInverseCoords(x, y, 0, [0, 0]);
    }
    return [x, y];
  };

  const sceneToClientPoint = (layer, x, y, metrics = getViewportMetrics()) => {
    const gamePoint = sceneToGamePoint(layer, x, y);
    return gameToClientPoint(gamePoint[0], gamePoint[1], metrics);
  };

  const clientToScenePoint = (layer, x, y, metrics = getViewportMetrics()) => {
    const gamePoint = clientToGamePoint(x, y, metrics);
    if (layer && typeof layer.convertCoords === 'function') {
      const scenePoint = layer.convertCoords(gamePoint.x, gamePoint.y, 0, [
        0,
        0,
      ]);
      return { x: scenePoint[0], y: scenePoint[1] };
    }
    return gamePoint;
  };

  const getObjectName = (instance, fallback = null) => {
    const objectName = readMethod(instance, 'getName', null);
    if (typeof objectName === 'string' && objectName) return objectName;
    if (instance && typeof instance.name === 'string' && instance.name)
      return instance.name;
    return fallback;
  };

  const getObjectLayerName = instance => {
    const layer = readMethod(instance, 'getLayer', null);
    if (typeof layer === 'string') return layer;
    return instance && typeof instance.layer === 'string' ? instance.layer : '';
  };

  const getObjectZOrder = instance => {
    const zOrder = readMethod(instance, 'getZOrder', null);
    if (Number.isFinite(Number(zOrder))) return Number(zOrder);
    return instance && Number.isFinite(Number(instance.zOrder))
      ? Number(instance.zOrder)
      : 0;
  };

  const getObjectEntries = scene => {
    const items =
      scene &&
      scene._instances &&
      scene._instances.items &&
      typeof scene._instances.items === 'object'
        ? scene._instances.items
        : {};
    const entries = [];
    let order = 0;
    Object.keys(items).forEach(objectName => {
      const instances = Array.isArray(items[objectName])
        ? items[objectName].filter(Boolean)
        : [];
      instances.forEach((instance, instanceIndex) => {
        entries.push({
          instance,
          objectName: getObjectName(instance, objectName) || objectName,
          instanceIndex,
          order: order++,
        });
      });
    });
    return entries;
  };

  const getLayerOrder = (scene, layerName) => {
    if (!scene || !Array.isArray(scene._orderedLayers)) return 0;
    let runtimeLayer = null;
    try {
      runtimeLayer =
        typeof scene.getLayer === 'function' ? scene.getLayer(layerName) : null;
    } catch (_) {}
    const index = runtimeLayer
      ? scene._orderedLayers.indexOf(runtimeLayer)
      : -1;
    return index >= 0 ? index : 0;
  };

  const getLayerState = (scene, layerName) => {
    let layer = null;
    try {
      layer =
        scene && typeof scene.getLayer === 'function'
          ? scene.getLayer(layerName)
          : null;
    } catch (_) {}
    const visible =
      layer && typeof layer.isVisible === 'function'
        ? !!layer.isVisible()
        : true;
    return {
      layer,
      visible,
      order: getLayerOrder(scene, layerName),
    };
  };

  const getHitBoxes = instance => {
    if (!instance || typeof instance.getHitBoxes !== 'function') return [];
    try {
      const hitBoxes = instance.getHitBoxes();
      return Array.isArray(hitBoxes)
        ? hitBoxes
            .map(hitBox => ({
              vertices:
                hitBox && Array.isArray(hitBox.vertices)
                  ? hitBox.vertices
                      .map(vertex =>
                        Array.isArray(vertex) &&
                        Number.isFinite(Number(vertex[0])) &&
                        Number.isFinite(Number(vertex[1]))
                          ? [Number(vertex[0]), Number(vertex[1])]
                          : null
                      )
                      .filter(Boolean)
                  : [],
            }))
            .filter(hitBox => hitBox.vertices.length >= 3)
        : [];
    } catch (_) {
      return [];
    }
  };

  const pointOnSegment = (x, y, ax, ay, bx, by) => {
    const cross = (x - ax) * (by - ay) - (y - ay) * (bx - ax);
    if (Math.abs(cross) > 1e-7) return false;
    const dot = (x - ax) * (bx - ax) + (y - ay) * (by - ay);
    if (dot < 0) return false;
    const lengthSquared = (bx - ax) ** 2 + (by - ay) ** 2;
    return dot <= lengthSquared;
  };

  const pointInPolygon = (vertices, x, y) => {
    let inside = false;
    for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
      const xi = vertices[i][0];
      const yi = vertices[i][1];
      const xj = vertices[j][0];
      const yj = vertices[j][1];
      if (pointOnSegment(x, y, xi, yi, xj, yj)) return true;
      const intersects =
        yi > y !== yj > y &&
        x < ((xj - xi) * (y - yi)) / (yj - yi || Number.EPSILON) + xi;
      if (intersects) inside = !inside;
    }
    return inside;
  };

  const getObjectVisibilityState = (scene, entry) => {
    const { instance } = entry;
    const hidden =
      typeof instance.isHidden === 'function'
        ? !!instance.isHidden()
        : !!instance.hidden;
    const livingOnScene = instance.livingOnScene !== false;
    const layerName = getObjectLayerName(instance);
    const layerState = getLayerState(scene, layerName);
    const blockedReasons = [];
    if (hidden) blockedReasons.push('hidden');
    if (!layerState.visible) blockedReasons.push('layer-hidden');
    if (!livingOnScene) blockedReasons.push('not-living-on-scene');
    return {
      hidden,
      livingOnScene,
      layerVisible: layerState.visible,
      visible: !hidden && livingOnScene && layerState.visible,
      blockedReasons,
      layerName,
      layerOrder: layerState.order,
      layer: layerState.layer,
    };
  };

  const getAabb = instance => {
    if (instance && typeof instance.getAABB === 'function') {
      try {
        const aabb = instance.getAABB();
        if (
          aabb &&
          aabb.min &&
          aabb.max &&
          Number.isFinite(Number(aabb.min[0])) &&
          Number.isFinite(Number(aabb.min[1])) &&
          Number.isFinite(Number(aabb.max[0])) &&
          Number.isFinite(Number(aabb.max[1]))
        ) {
          return {
            left: Number(aabb.min[0]),
            top: Number(aabb.min[1]),
            right: Number(aabb.max[0]),
            bottom: Number(aabb.max[1]),
          };
        }
      } catch (_) {}
    }
    const left = Number(readMethod(instance, 'getDrawableX', instance.x || 0));
    const top = Number(readMethod(instance, 'getDrawableY', instance.y || 0));
    const width = Number(readMethod(instance, 'getWidth', 0)) || 0;
    const height = Number(readMethod(instance, 'getHeight', 0)) || 0;
    return { left, top, right: left + width, bottom: top + height };
  };

  const makeObjectIdentity = entry => ({
    objectName: entry.objectName,
    instanceId:
      entry.instance && entry.instance.id != null ? entry.instance.id : null,
    instanceIndex: entry.instanceIndex,
    type: (entry.instance && entry.instance.type) || null,
    layer: getObjectLayerName(entry.instance),
    zOrder: getObjectZOrder(entry.instance),
  });

  const makeGeometry = (scene, entry, metrics = getViewportMetrics()) => {
    const { instance } = entry;
    const visibility = getObjectVisibilityState(scene, entry);
    const hitBoxes = getHitBoxes(instance);
    const sceneAabb = getAabb(instance);
    const layer = visibility.layer;
    const sceneCenter = {
      x: Number(
        readMethod(
          instance,
          'getCenterXInScene',
          (sceneAabb.left + sceneAabb.right) / 2
        )
      ),
      y: Number(
        readMethod(
          instance,
          'getCenterYInScene',
          (sceneAabb.top + sceneAabb.bottom) / 2
        )
      ),
    };
    const viewportHitBoxes = hitBoxes.map(hitBox => ({
      vertices: hitBox.vertices.map(vertex => {
        const point = sceneToClientPoint(layer, vertex[0], vertex[1], metrics);
        return [point.x, point.y];
      }),
    }));
    const viewportVertices = viewportHitBoxes.flatMap(
      hitBox => hitBox.vertices
    );
    if (!viewportVertices.length) {
      [
        [sceneAabb.left, sceneAabb.top],
        [sceneAabb.right, sceneAabb.top],
        [sceneAabb.right, sceneAabb.bottom],
        [sceneAabb.left, sceneAabb.bottom],
      ].forEach(vertex => {
        const point = sceneToClientPoint(layer, vertex[0], vertex[1], metrics);
        viewportVertices.push([point.x, point.y]);
      });
    }
    const xs = viewportVertices.map(vertex => vertex[0]);
    const ys = viewportVertices.map(vertex => vertex[1]);
    const viewportBounds = {
      left: xs.length ? Math.min(...xs) : null,
      top: ys.length ? Math.min(...ys) : null,
      right: xs.length ? Math.max(...xs) : null,
      bottom: ys.length ? Math.max(...ys) : null,
    };
    viewportBounds.width =
      viewportBounds.left == null
        ? null
        : viewportBounds.right - viewportBounds.left;
    viewportBounds.height =
      viewportBounds.top == null
        ? null
        : viewportBounds.bottom - viewportBounds.top;
    const viewportCenter = sceneToClientPoint(
      layer,
      sceneCenter.x,
      sceneCenter.y,
      metrics
    );
    const insideViewport =
      Number.isFinite(viewportCenter.x) &&
      Number.isFinite(viewportCenter.y) &&
      (metrics.width == null ||
        (viewportCenter.x >= 0 && viewportCenter.x < metrics.width)) &&
      (metrics.height == null ||
        (viewportCenter.y >= 0 && viewportCenter.y < metrics.height));
    return {
      identity: makeObjectIdentity(entry),
      size: {
        width: Number(readMethod(instance, 'getWidth', 0)) || 0,
        height: Number(readMethod(instance, 'getHeight', 0)) || 0,
      },
      scene: {
        center: sceneCenter,
        bounds: {
          ...sceneAabb,
          width: sceneAabb.right - sceneAabb.left,
          height: sceneAabb.bottom - sceneAabb.top,
        },
        hitBoxes,
      },
      viewport: {
        center: viewportCenter,
        bounds: viewportBounds,
        hitBoxes: viewportHitBoxes,
        insideViewport,
      },
      state: {
        hidden: visibility.hidden,
        layerVisible: visibility.layerVisible,
        livingOnScene: visibility.livingOnScene,
        visible: visibility.visible,
        hitTestable: hitBoxes.length > 0,
        blockedReasons: visibility.blockedReasons.slice(),
      },
      classification: {
        presentationSurface: visibility.visible ? 'visible' : 'hidden',
        interactionControl:
          visibility.visible && hitBoxes.length > 0 ? 'candidate' : 'blocked',
        disabled: null,
        legacy: null,
        semanticStateAuthority:
          'game-specific-disabled-and-legacy-state-is-not-inferred',
      },
      renderStack: {
        authority: 'runtime-preview',
        layerName: visibility.layerName,
        layerOrder: visibility.layerOrder,
        zOrder: getObjectZOrder(instance),
        runtimeOrder: entry.order,
        ordering: 'layer-order-then-z-order-then-runtime-container-order',
      },
      _sort: {
        layerOrder: visibility.layerOrder,
        zOrder: getObjectZOrder(instance),
        order: entry.order,
      },
    };
  };

  const resolveObjectSelector = (scene, selector) => {
    if (!selector || typeof selector !== 'object') return null;
    const objectName =
      typeof selector.objectName === 'string' && selector.objectName
        ? selector.objectName
        : null;
    const hasInstanceId =
      selector.instanceId !== undefined && selector.instanceId !== null;
    const instanceId = hasInstanceId ? Number(selector.instanceId) : null;
    const entries = getObjectEntries(scene).filter(entry => {
      if (objectName && entry.objectName !== objectName) return false;
      if (
        hasInstanceId &&
        (!Number.isFinite(instanceId) ||
          Number(entry.instance && entry.instance.id) !== instanceId)
      )
        return false;
      return true;
    });
    if (!entries.length) return null;
    const index =
      selector.instanceIndex == null
        ? 0
        : Math.max(0, Math.floor(Number(selector.instanceIndex) || 0));
    return entries[index] || null;
  };

  const hitTestAt = (
    scene,
    clientX,
    clientY,
    metrics = getViewportMetrics()
  ) => {
    const eligible = [];
    const excluded = [];
    for (const entry of getObjectEntries(scene)) {
      const visibility = getObjectVisibilityState(scene, entry);
      const hitBoxes = getHitBoxes(entry.instance);
      if (!hitBoxes.length) continue;
      const scenePoint = clientToScenePoint(
        visibility.layer,
        clientX,
        clientY,
        metrics
      );
      const contains = hitBoxes.some(hitBox =>
        pointInPolygon(hitBox.vertices, scenePoint.x, scenePoint.y)
      );
      if (!contains) continue;
      const geometry = makeGeometry(scene, entry, metrics);
      const candidate = {
        identity: geometry.identity,
        state: geometry.state,
        viewportBounds: geometry.viewport.bounds,
        _sort: geometry._sort,
      };
      if (visibility.visible) eligible.push(candidate);
      else excluded.push(candidate);
    }
    const compareTopmost = (a, b) =>
      b._sort.layerOrder - a._sort.layerOrder ||
      b._sort.zOrder - a._sort.zOrder ||
      b._sort.order - a._sort.order;
    eligible.sort(compareTopmost);
    excluded.sort(compareTopmost);
    const clean = candidate => {
      if (!candidate) return null;
      const { _sort, ...result } = candidate;
      return result;
    };
    return {
      owner: clean(eligible[0] || null),
      candidates: eligible.map(clean),
      excluded: excluded.map(clean),
    };
  };

  const getCursorState = (x, y) => {
    let element = null;
    try {
      element =
        document && typeof document.elementFromPoint === 'function'
          ? document.elementFromPoint(x, y)
          : null;
    } catch (_) {}
    let computedCursor = null;
    try {
      computedCursor =
        element && typeof window.getComputedStyle === 'function'
          ? window.getComputedStyle(element).cursor || null
          : null;
    } catch (_) {}
    const runtimeCanvas = getRuntimeCanvas();
    return {
      cursor: computedCursor,
      elementTag:
        element && typeof element.tagName === 'string'
          ? element.tagName.toLowerCase()
          : null,
      canvasCursor:
        runtimeCanvas && runtimeCanvas.style
          ? runtimeCanvas.style.cursor || null
          : null,
      bodyCursor:
        document && document.body && document.body.style
          ? document.body.style.cursor || null
          : null,
    };
  };

  const inspect = payload => {
    const runtimeGame = getRuntimeGame();
    const scene = getCurrentScene();
    if (!runtimeGame || !scene)
      throw new Error('preview_runtime_scene_not_found');
    const metrics = getViewportMetrics();
    const selector =
      payload && payload.target && typeof payload.target === 'object'
        ? payload.target
        : null;
    const targetEntry = selector
      ? resolveObjectSelector(scene, selector)
      : null;
    const target = targetEntry
      ? makeGeometry(scene, targetEntry, metrics)
      : null;
    let point = null;
    if (
      payload &&
      Number.isFinite(Number(payload.x)) &&
      Number.isFinite(Number(payload.y))
    ) {
      if (payload.coordinateSpace === 'scene') {
        const layerName =
          typeof payload.layer === 'string'
            ? payload.layer
            : target
            ? target.identity.layer
            : '';
        const layerState = getLayerState(scene, layerName);
        point = sceneToClientPoint(
          layerState.layer,
          Number(payload.x),
          Number(payload.y),
          metrics
        );
      } else {
        point = { x: Number(payload.x), y: Number(payload.y) };
      }
    } else if (target) {
      point = {
        x: target.viewport.center.x,
        y: target.viewport.center.y,
      };
    }
    const diagnostics = [];
    if (selector && !target) {
      diagnostics.push({
        code: 'preview_target_not_found',
        message: 'No runtime object instance matched the target selector.',
      });
    }
    if (target) {
      if (target.state.hidden)
        diagnostics.push({
          code: 'preview_target_hidden',
          message: 'The target runtime object is hidden.',
        });
      if (!target.state.layerVisible)
        diagnostics.push({
          code: 'preview_target_layer_hidden',
          message: 'The target runtime layer is hidden.',
        });
      if (!target.state.livingOnScene)
        diagnostics.push({
          code: 'preview_target_not_living',
          message:
            'The target runtime object is no longer living on the scene.',
        });
      if (!target.state.hitTestable)
        diagnostics.push({
          code: 'preview_target_not_hit_testable',
          message: 'The target exposes no runtime hitbox.',
        });
    }
    const insideViewport =
      !!point &&
      (metrics.width == null || (point.x >= 0 && point.x < metrics.width)) &&
      (metrics.height == null || (point.y >= 0 && point.y < metrics.height));
    const insideCanvas =
      !!point &&
      (!metrics.canvas ||
        (point.x >= metrics.canvas.x &&
          point.y >= metrics.canvas.y &&
          point.x < metrics.canvas.x + metrics.canvas.width &&
          point.y < metrics.canvas.y + metrics.canvas.height));
    if (point && !insideViewport)
      diagnostics.push({
        code: 'preview_target_outside_viewport',
        message:
          'The resolved input coordinate is outside the preview viewport.',
      });
    if (point && !insideCanvas)
      diagnostics.push({
        code: 'preview_target_outside_canvas',
        message: 'The resolved input coordinate is outside the game canvas.',
      });
    const hitTest = point
      ? hitTestAt(scene, point.x, point.y, metrics)
      : { owner: null, candidates: [], excluded: [] };
    if (
      target &&
      point &&
      target.state.visible &&
      hitTest.owner &&
      (hitTest.owner.identity.instanceId !== target.identity.instanceId ||
        hitTest.owner.identity.objectName !== target.identity.objectName)
    ) {
      diagnostics.push({
        code: 'preview_target_occluded',
        message:
          'A different visible runtime object owns the hit-test coordinate.',
        owner: hitTest.owner.identity,
      });
    }
    return {
      runtimeSource: 'gdevelop-runtime-object-hit-test-v1',
      viewport: metrics,
      requested: {
        target: selector,
        coordinateSpace:
          payload && payload.coordinateSpace === 'scene' ? 'scene' : 'viewport',
        x:
          payload && Number.isFinite(Number(payload.x))
            ? Number(payload.x)
            : null,
        y:
          payload && Number.isFinite(Number(payload.y))
            ? Number(payload.y)
            : null,
        layer:
          payload && typeof payload.layer === 'string' ? payload.layer : null,
      },
      point: point
        ? {
            x: point.x,
            y: point.y,
            coordinateSpace: 'viewport-css-px',
            insideViewport,
            insideCanvas,
          }
        : null,
      target,
      hitTest,
      pointer: point ? getCursorState(point.x, point.y) : null,
      diagnostics,
    };
  };

  const getFrameStamp = () => {
    const scene = getCurrentScene();
    const timeManager = scene && scene._timeManager;
    return {
      sceneName:
        scene && typeof scene.getName === 'function'
          ? scene.getName()
          : scene && scene._name
          ? scene._name
          : null,
      timeFromStartMs:
        timeManager && Number.isFinite(Number(timeManager._timeFromStart))
          ? Number(timeManager._timeFromStart)
          : null,
      elapsedTimeMs:
        timeManager && Number.isFinite(Number(timeManager._elapsedTime))
          ? Number(timeManager._elapsedTime)
          : null,
    };
  };

  const nextAnimationFrame = () =>
    new Promise((resolve, reject) => {
      if (typeof window.requestAnimationFrame !== 'function') {
        reject(new Error('preview_request_animation_frame_unavailable'));
        return;
      }
      window.requestAnimationFrame(() => resolve());
    });

  const synchronize = async payload => {
    const before = getFrameStamp();
    const maxFrames = clampInteger(payload && payload.maxFrames, 8, 1, 120);
    const timeoutMs = clampInteger(
      payload && payload.timeoutMs,
      1500,
      1,
      10000
    );
    const startedAt = Date.now();
    let after = before;
    let animationFrames = 0;
    while (animationFrames < maxFrames && Date.now() - startedAt <= timeoutMs) {
      await nextAnimationFrame();
      animationFrames += 1;
      after = getFrameStamp();
      const sceneChanged = before.sceneName !== after.sceneName;
      const runtimeAdvanced =
        before.timeFromStartMs != null &&
        after.timeFromStartMs != null &&
        after.timeFromStartMs !== before.timeFromStartMs;
      if (sceneChanged || runtimeAdvanced) {
        return {
          processed: true,
          animationFrames,
          before,
          after,
        };
      }
    }
    return {
      processed: false,
      animationFrames,
      before,
      after,
      reason: 'preview_runtime_frame_not_observed',
    };
  };

  const primitiveVariableValue = variable => {
    const transformed = transformVariable(variable);
    return transformed ? transformed.value : undefined;
  };

  const getConditionActualValue = condition => {
    const scene = getCurrentScene();
    const runtimeGame = getRuntimeGame();
    if (!scene || !runtimeGame) return undefined;
    const container =
      condition && condition.scope === 'global'
        ? runtimeGame._variables
        : scene._variables;
    const items =
      container &&
      container._variables &&
      container._variables.items &&
      typeof container._variables.items === 'object'
        ? container._variables.items
        : {};
    return primitiveVariableValue(items[condition.variable]);
  };

  const valuesEqual = (a, b) => {
    if (a === b) return true;
    if ((a && typeof a === 'object') || (b && typeof b === 'object')) {
      try {
        return JSON.stringify(a) === JSON.stringify(b);
      } catch (_) {}
    }
    return false;
  };

  const evaluateState = condition => {
    if (
      !condition ||
      typeof condition !== 'object' ||
      typeof condition.variable !== 'string' ||
      !condition.variable
    ) {
      throw new Error('invalid_preview_state_condition');
    }
    const scope = condition.scope === 'global' ? 'global' : 'scene';
    const operator =
      typeof condition.operator === 'string' ? condition.operator : 'equals';
    const actual = getConditionActualValue({ ...condition, scope });
    const expected = condition.value;
    let matched = false;
    if (operator === 'equals') matched = valuesEqual(actual, expected);
    else if (operator === 'not-equals')
      matched = !valuesEqual(actual, expected);
    else if (operator === 'gt') matched = Number(actual) > Number(expected);
    else if (operator === 'gte') matched = Number(actual) >= Number(expected);
    else if (operator === 'lt') matched = Number(actual) < Number(expected);
    else if (operator === 'lte') matched = Number(actual) <= Number(expected);
    else if (operator === 'truthy') matched = !!actual;
    else if (operator === 'falsy') matched = !actual;
    else throw new Error('invalid_preview_state_operator');
    return {
      matched,
      scope,
      variable: condition.variable,
      operator,
      expected,
      actual,
      frame: getFrameStamp(),
    };
  };

  const waitForState = async payload => {
    const timeoutMs = clampInteger(
      payload && payload.timeoutMs,
      3000,
      1,
      10000
    );
    const stableFrames = clampInteger(
      payload && payload.stableFrames,
      1,
      1,
      10
    );
    const startedAt = Date.now();
    let stableCount = 0;
    let evaluation = evaluateState(payload || {});
    if (evaluation.matched && stableFrames === 1) {
      return {
        matched: true,
        stableFrames: 1,
        elapsedMs: 0,
        evaluation,
      };
    }
    while (Date.now() - startedAt <= timeoutMs) {
      const frame = await synchronize({ timeoutMs, maxFrames: 8 });
      if (!frame.processed) {
        return {
          matched: false,
          stableFrames: stableCount,
          elapsedMs: Date.now() - startedAt,
          evaluation,
          frame,
          reason: 'preview_runtime_frame_not_observed',
        };
      }
      evaluation = evaluateState(payload || {});
      stableCount = evaluation.matched ? stableCount + 1 : 0;
      if (stableCount >= stableFrames) {
        return {
          matched: true,
          stableFrames: stableCount,
          elapsedMs: Date.now() - startedAt,
          evaluation,
          frame,
        };
      }
    }
    return {
      matched: false,
      stableFrames: stableCount,
      elapsedMs: Date.now() - startedAt,
      evaluation,
      reason: 'preview_state_wait_timeout',
    };
  };

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
    const readOptional = getterName => {
      if (!instance || typeof instance[getterName] !== 'function') return null;
      try {
        const value = instance[getterName]();
        return value === undefined ? null : value;
      } catch (_) {
        return null;
      }
    };
    const text =
      readOptional('getText') !== null
        ? readOptional('getText')
        : readOptional('getString');
    const opacity = readOptional('getOpacity');
    const animation = readOptional('getAnimationName');
    const flippedX = readOptional('isFlippedX');
    const flippedY = readOptional('isFlippedY');
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
      ...(text !== null ? { text } : {}),
      ...(opacity !== null ? { opacity } : {}),
      ...(animation !== null ? { animation } : {}),
      ...(flippedX !== null ? { flippedX } : {}),
      ...(flippedY !== null ? { flippedY } : {}),
      variables: transformVariablesContainer(instance && instance._variables),
      behaviors,
    };
  };

  const snapshot = payload => {
    const runtimeGame = getRuntimeGame();
    if (!runtimeGame) throw new Error('preview_runtime_game_not_found');
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
      viewport: {
        width: typeof window.innerWidth === 'number' ? window.innerWidth : null,
        height:
          typeof window.innerHeight === 'number' ? window.innerHeight : null,
        outerWidth:
          typeof window.outerWidth === 'number' ? window.outerWidth : null,
        outerHeight:
          typeof window.outerHeight === 'number' ? window.outerHeight : null,
        devicePixelRatio:
          typeof window.devicePixelRatio === 'number'
            ? window.devicePixelRatio
            : null,
      },
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

  const announceIdentity = payload => {
    const windowId = Number(payload && payload.windowId);
    if (!Number.isInteger(windowId) || windowId <= 0) {
      throw new Error('invalid_preview_identity_window_id');
    }
    const runtimeGame = getRuntimeGame();
    const debuggerClient =
      runtimeGame && runtimeGame._debuggerClient
        ? runtimeGame._debuggerClient
        : null;
    if (!debuggerClient || typeof debuggerClient._sendMessage !== 'function') {
      return {
        announced: false,
        windowId,
        reason: 'preview_debugger_client_unavailable',
      };
    }
    const websocket = debuggerClient._ws;
    if (
      websocket &&
      typeof WebSocket !== 'undefined' &&
      websocket.readyState !== WebSocket.OPEN
    ) {
      return {
        announced: false,
        windowId,
        reason: 'preview_debugger_connection_not_open',
      };
    }
    identityWindowId = windowId;
    debuggerClient._sendMessage(
      JSON.stringify({
        command: 'agent.preview.identity',
        payload: { windowId },
      })
    );
    return { announced: true, windowId };
  };

  const runtime = {
    version: 4,
    snapshot,
    announceIdentity,
    inspect,
    synchronize,
    evaluateState,
    waitForState,
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
      version: 4,
      identityWindowId,
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
