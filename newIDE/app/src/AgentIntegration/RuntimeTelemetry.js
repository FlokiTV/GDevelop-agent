// @flow

const DEFAULT_REQUEST_TIMEOUT_MS = 2500;
const DEFAULT_MAX_INSTANCES = 200;
const MAX_INSTANCES = 1000;
const MAX_LOGS_PER_DEBUGGER = 200;
const MAX_PROFILER_SECTIONS = 200;
const MAX_WAIT_MS = 30000;
const MIN_POLL_MS = 100;
const MAX_POLL_MS = 5000;

const makeError = (code: string, message?: string): Error => {
  const error: any = new Error(message || code);
  error.code = code;
  return error;
};

const sleep = (milliseconds: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, milliseconds));

const clampInteger = (
  value: any,
  fallback: number,
  minimum: number,
  maximum: number
): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(parsed)));
};

const transformVariable = (variable: any): any => {
  if (!variable || typeof variable !== 'object') return null;

  const type = variable._type;
  if (type === 'string') return { type, value: variable._str || '' };
  if (type === 'number') return { type, value: Number(variable._value) || 0 };
  if (type === 'boolean') return { type, value: !!variable._bool };
  if (type === 'structure') {
    const children = variable._children || {};
    const value = {};
    Object.keys(children).forEach(name => {
      value[name] = transformVariable(children[name]);
    });
    return { type, value };
  }
  if (type === 'array') {
    const children = Array.isArray(variable._childrenArray)
      ? variable._childrenArray
      : [];
    return { type, value: children.map(transformVariable) };
  }

  // Compatibility with older debugger dumps, before variables had `_type`.
  if (variable._isStructure) {
    const children = variable._children || {};
    const value = {};
    Object.keys(children).forEach(name => {
      value[name] = transformVariable(children[name]);
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

export const transformVariablesContainer = (variablesContainer: any): any => {
  const items =
    variablesContainer &&
    variablesContainer._variables &&
    variablesContainer._variables.items;
  if (!items || typeof items !== 'object') return {};
  const variables = {};
  Object.keys(items).forEach(name => {
    variables[name] = transformVariable(items[name]);
  });
  return variables;
};

const summarizeBehavior = (behavior: any): any => {
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

const summarizeInstance = (instance: any): any => {
  const z =
    typeof instance.z === 'number'
      ? instance.z
      : typeof instance._z === 'number'
      ? instance._z
      : 0;
  const behaviors = Array.isArray(instance._behaviors)
    ? instance._behaviors.map(summarizeBehavior).filter(Boolean)
    : [];
  const text =
    typeof instance.text === 'string'
      ? instance.text
      : typeof instance._str === 'string'
      ? instance._str
      : null;
  const opacity =
    typeof instance.opacity === 'number'
      ? instance.opacity
      : typeof instance._opacity === 'number'
      ? instance._opacity
      : null;
  const animation =
    typeof instance.animation === 'string'
      ? instance.animation
      : typeof instance._animationName === 'string'
      ? instance._animationName
      : null;
  return {
    id: instance.id != null ? instance.id : null,
    name: instance.name || null,
    type: instance.type || null,
    x: typeof instance.x === 'number' ? instance.x : 0,
    y: typeof instance.y === 'number' ? instance.y : 0,
    z,
    angle: typeof instance.angle === 'number' ? instance.angle : 0,
    zOrder: typeof instance.zOrder === 'number' ? instance.zOrder : 0,
    layer: typeof instance.layer === 'string' ? instance.layer : '',
    hidden: !!instance.hidden,
    livingOnScene: instance.livingOnScene !== false,
    ...(text !== null ? { text } : {}),
    ...(opacity !== null ? { opacity } : {}),
    ...(animation !== null ? { animation } : {}),
    variables: transformVariablesContainer(instance._variables),
    behaviors,
  };
};

type SnapshotOptions = {|
  debuggerId?: string,
  maxInstances?: number,
  objectNames?: Array<string>,
|};

export const summarizeRuntimeDump = (
  dump: any,
  options?: SnapshotOptions = {}
): any => {
  if (!dump || typeof dump !== 'object')
    throw makeError('invalid_runtime_dump');
  const stack =
    dump._sceneStack && Array.isArray(dump._sceneStack._stack)
      ? dump._sceneStack._stack
      : [];
  const currentScene = stack.length ? stack[stack.length - 1] : null;
  const timeManager = currentScene && currentScene._timeManager;
  const elapsedTimeMs =
    timeManager && typeof timeManager._elapsedTime === 'number'
      ? timeManager._elapsedTime
      : null;
  const maxInstances = clampInteger(
    options.maxInstances,
    DEFAULT_MAX_INSTANCES,
    1,
    MAX_INSTANCES
  );
  const requestedObjectNames = Array.isArray(options.objectNames)
    ? new Set(options.objectNames.filter(name => typeof name === 'string'))
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

  return {
    paused: !!dump._paused,
    scene: currentScene
      ? {
          name: currentScene._name || null,
          elapsedTimeMs,
          timeFromStartMs:
            timeManager && typeof timeManager._timeFromStart === 'number'
              ? timeManager._timeFromStart
              : null,
          timeScale:
            timeManager && typeof timeManager._timeScale === 'number'
              ? timeManager._timeScale
              : null,
          fpsApprox:
            elapsedTimeMs &&
            elapsedTimeMs > 0 &&
            timeManager &&
            typeof timeManager._timeScale === 'number' &&
            timeManager._timeScale > 0
              ? (1000 * timeManager._timeScale) / elapsedTimeMs
              : null,
          variables: transformVariablesContainer(currentScene._variables),
        }
      : null,
    globalVariables: transformVariablesContainer(dump._variables),
    objects,
    totalInstances,
    includedInstances,
    truncatedInstances: Math.max(0, totalInstances - includedInstances),
  };
};

const getPathValue = (root: any, path: any): any => {
  const parts = Array.isArray(path)
    ? path
    : typeof path === 'string'
    ? path.split('.').filter(Boolean)
    : [];
  if (!parts.length) throw makeError('invalid_assertion_path');
  let value = root;
  for (const part of parts) {
    if (value == null || (typeof value !== 'object' && !Array.isArray(value))) {
      return undefined;
    }
    value = value[part];
  }
  return value;
};

const parseVariableSelectorPath = (path: any): Array<string | number> => {
  if (typeof path !== 'string' || !path.trim()) {
    throw makeError(
      'invalid_runtime_variable_selector',
      'Variable selectors require a non-empty path.'
    );
  }
  const parts = [];
  const source = path.trim();
  let current = '';
  let index = 0;
  const pushCurrent = () => {
    const trimmed = current.trim();
    if (trimmed) parts.push(trimmed);
    current = '';
  };
  while (index < source.length) {
    const character = source[index];
    if (character === '.') {
      pushCurrent();
      index += 1;
      continue;
    }
    if (character === '[') {
      pushCurrent();
      index += 1;
      let rawIndex = '';
      while (index < source.length && source[index] !== ']') {
        rawIndex += source[index++];
      }
      if (index >= source.length || source[index] !== ']') {
        throw makeError(
          'invalid_runtime_variable_selector',
          'Variable array selectors must use a closing ].'
        );
      }
      if (!/^\d+$/.test(rawIndex.trim())) {
        throw makeError(
          'invalid_runtime_variable_selector',
          'Variable array selectors require a non-negative integer index.'
        );
      }
      parts.push(parseInt(rawIndex.trim(), 10));
      index += 1;
      continue;
    }
    current += character;
    index += 1;
  }
  pushCurrent();
  if (!parts.length) {
    throw makeError(
      'invalid_runtime_variable_selector',
      'Variable selectors require a non-empty path.'
    );
  }
  return parts;
};

const makeMissingSelection = (
  code: string,
  message: string,
  selector: any,
  allowMissing: boolean
): any => {
  if (!allowMissing) throw makeError(code, message);
  return {
    found: false,
    value: undefined,
    valueType: null,
    selector,
    diagnostic: { code, message },
  };
};

const selectVariableValue = ({
  variables,
  path,
  selector,
  allowMissing,
}: {|
  variables: any,
  path: any,
  selector: any,
  allowMissing: boolean,
|}): any => {
  const parts = parseVariableSelectorPath(path);
  const rootName = parts[0];
  if (typeof rootName !== 'string' || !variables || !variables[rootName]) {
    return makeMissingSelection(
      'runtime_variable_not_found',
      `Runtime variable "${String(path)}" was not found.`,
      selector,
      allowMissing
    );
  }
  let variable = variables[rootName];
  for (const part of parts.slice(1)) {
    if (!variable || typeof variable !== 'object') {
      return makeMissingSelection(
        'runtime_variable_path_not_found',
        `Runtime variable path "${String(path)}" was not found.`,
        selector,
        allowMissing
      );
    }
    if (typeof part === 'number') {
      if (
        variable.type !== 'array' ||
        !Array.isArray(variable.value) ||
        !variable.value[part]
      ) {
        return makeMissingSelection(
          'runtime_variable_path_not_found',
          `Runtime variable path "${String(path)}" was not found.`,
          selector,
          allowMissing
        );
      }
      variable = variable.value[part];
    } else {
      if (
        variable.type !== 'structure' ||
        !variable.value ||
        typeof variable.value !== 'object' ||
        !variable.value[part]
      ) {
        return makeMissingSelection(
          'runtime_variable_path_not_found',
          `Runtime variable path "${String(path)}" was not found.`,
          selector,
          allowMissing
        );
      }
      variable = variable.value[part];
    }
  }
  return {
    found: true,
    value: variable ? variable.value : undefined,
    valueType: variable && variable.type ? variable.type : null,
    selector,
  };
};

const selectRuntimeInstance = (
  snapshot: any,
  selector: any,
  allowMissing: boolean
): any => {
  const objectName =
    selector && typeof selector.objectName === 'string'
      ? selector.objectName.trim()
      : '';
  if (!objectName) {
    throw makeError(
      'invalid_runtime_selector',
      'Object selectors require objectName.'
    );
  }
  const objectEntry = snapshot.objects && snapshot.objects[objectName];
  if (!objectEntry) {
    return makeMissingSelection(
      'runtime_object_not_found',
      `Runtime object "${objectName}" was not found.`,
      selector,
      allowMissing
    );
  }
  const instances = Array.isArray(objectEntry.instances)
    ? objectEntry.instances
    : [];
  let instance = null;
  let instanceIndex = null;
  if (
    selector.instanceId !== undefined &&
    selector.instanceId !== null &&
    String(selector.instanceId) !== ''
  ) {
    instanceIndex = instances.findIndex(
      candidate =>
        String(candidate && candidate.id) === String(selector.instanceId)
    );
    instance = instanceIndex >= 0 ? instances[instanceIndex] : null;
  } else {
    instanceIndex = Number.isInteger(selector.instanceIndex)
      ? selector.instanceIndex
      : 0;
    instance =
      instanceIndex >= 0 && instanceIndex < instances.length
        ? instances[instanceIndex]
        : null;
  }
  if (!instance) {
    return makeMissingSelection(
      'runtime_instance_not_found',
      `Runtime instance for object "${objectName}" was not found.`,
      selector,
      allowMissing
    );
  }
  return {
    found: true,
    instance,
    instanceIndex,
    objectName,
  };
};

export const selectRuntimeValue = (
  snapshot: any,
  selector: any,
  options: {| allowMissing?: boolean |} = {}
): any => {
  if (!snapshot || typeof snapshot !== 'object') {
    throw makeError('invalid_runtime_snapshot');
  }
  if (!selector || typeof selector !== 'object') {
    throw makeError('invalid_runtime_selector');
  }
  const allowMissing = options.allowMissing === true;
  const kind = selector.kind;

  if (kind === 'global-variable') {
    return selectVariableValue({
      variables: snapshot.globalVariables,
      path: selector.path,
      selector,
      allowMissing,
    });
  }

  if (kind === 'scene-variable') {
    if (!snapshot.scene) {
      return makeMissingSelection(
        'runtime_scene_unavailable',
        'No runtime scene is available.',
        selector,
        allowMissing
      );
    }
    return selectVariableValue({
      variables: snapshot.scene.variables,
      path: selector.path,
      selector,
      allowMissing,
    });
  }

  if (kind === 'object-count') {
    const objectName =
      typeof selector.objectName === 'string' ? selector.objectName.trim() : '';
    if (!objectName) {
      throw makeError(
        'invalid_runtime_selector',
        'object-count selectors require objectName.'
      );
    }
    const objectEntry = snapshot.objects && snapshot.objects[objectName];
    if (!objectEntry) {
      return makeMissingSelection(
        'runtime_object_not_found',
        `Runtime object "${objectName}" was not found.`,
        selector,
        allowMissing
      );
    }
    return {
      found: true,
      value: Number(objectEntry.count) || 0,
      valueType: 'number',
      selector,
    };
  }

  if (
    kind === 'object-instance' ||
    kind === 'object-property' ||
    kind === 'object-variable'
  ) {
    const selected = selectRuntimeInstance(snapshot, selector, allowMissing);
    if (!selected.found) return selected;
    const { instance, instanceIndex, objectName } = selected;

    if (kind === 'object-instance') {
      return {
        found: true,
        value: instance,
        valueType: 'object',
        selector,
        objectName,
        instanceIndex,
        instanceId: instance.id,
      };
    }

    if (kind === 'object-property') {
      const property =
        typeof selector.property === 'string' ? selector.property.trim() : '';
      if (!property) {
        throw makeError(
          'invalid_runtime_selector',
          'object-property selectors require property.'
        );
      }
      if (!Object.prototype.hasOwnProperty.call(instance, property)) {
        return makeMissingSelection(
          'runtime_property_not_found',
          `Runtime property "${property}" was not found on object "${objectName}".`,
          selector,
          allowMissing
        );
      }
      const value = instance[property];
      return {
        found: true,
        value,
        valueType:
          value === null
            ? 'null'
            : Array.isArray(value)
            ? 'array'
            : typeof value,
        selector,
        objectName,
        instanceIndex,
        instanceId: instance.id,
      };
    }

    return {
      ...selectVariableValue({
        variables: instance.variables,
        path: selector.path,
        selector,
        allowMissing,
      }),
      objectName,
      instanceIndex,
      instanceId: instance.id,
    };
  }

  throw makeError(
    'unsupported_runtime_selector_kind',
    `Unsupported runtime selector kind: ${String(kind)}.`
  );
};

const getSelectorObjectName = (selector: any): ?string =>
  selector &&
  [
    'object-count',
    'object-instance',
    'object-property',
    'object-variable',
  ].includes(selector.kind) &&
  typeof selector.objectName === 'string' &&
  selector.objectName.trim()
    ? selector.objectName.trim()
    : null;

const makeTargetedSnapshotRequest = (request: any, selector: any): any => {
  const objectName = getSelectorObjectName(selector);
  if (!objectName) return request;
  const requestedIndex =
    selector && Number.isInteger(selector.instanceIndex)
      ? selector.instanceIndex
      : 0;
  return {
    ...request,
    objectNames: [objectName],
    maxInstances: Math.max(
      clampInteger(
        request.maxInstances,
        DEFAULT_MAX_INSTANCES,
        1,
        MAX_INSTANCES
      ),
      Math.min(MAX_INSTANCES, requestedIndex + 1)
    ),
  };
};

export const evaluateRuntimeCondition = (
  snapshot: any,
  condition: any
): any => {
  if (!condition || typeof condition !== 'object') {
    throw makeError('invalid_runtime_condition');
  }
  const selection = condition.selector
    ? selectRuntimeValue(snapshot, condition.selector, { allowMissing: true })
    : null;
  const actual = selection
    ? selection.value
    : getPathValue(snapshot, condition.path);
  const expected = condition.value;
  const operator = condition.operator || 'equals';
  let passed = false;
  if (operator === 'equals' || operator === 'eq') passed = actual === expected;
  else if (operator === 'notEquals' || operator === 'neq')
    passed = actual !== expected;
  else if (operator === 'gt') passed = actual > expected;
  else if (operator === 'gte') passed = actual >= expected;
  else if (operator === 'lt') passed = actual < expected;
  else if (operator === 'lte') passed = actual <= expected;
  else if (operator === 'contains') {
    passed =
      (typeof actual === 'string' && actual.includes(String(expected))) ||
      (Array.isArray(actual) && actual.includes(expected));
  } else if (operator === 'exists') passed = actual !== undefined;
  else if (operator === 'not-exists') passed = actual === undefined;
  else if (operator === 'truthy') passed = !!actual;
  else if (operator === 'falsy') passed = !actual;
  else throw makeError(`unsupported_runtime_operator:${String(operator)}`);
  return {
    passed,
    ...(condition.selector
      ? {
          selector: condition.selector,
          actualType: selection && selection.valueType,
          ...(selection && selection.diagnostic
            ? { diagnostic: selection.diagnostic }
            : {}),
        }
      : { path: condition.path }),
    operator,
    expected,
    actual,
  };
};

export const summarizeProfilerOutput = (output: any): any => {
  if (!output || typeof output !== 'object') {
    throw makeError('invalid_profiler_output');
  }
  const root = output.framesAverageMeasures;
  if (!root || typeof root !== 'object') {
    throw makeError('invalid_profiler_output');
  }
  const sections = [];
  const visit = (section: any, path: string) => {
    const subsections =
      section && section.subsections && typeof section.subsections === 'object'
        ? section.subsections
        : {};
    Object.keys(subsections).forEach(name => {
      if (sections.length >= MAX_PROFILER_SECTIONS) return;
      const child = subsections[name];
      const fullName = path ? `${path} > ${name}` : name;
      sections.push({
        name: fullName,
        averageTimeMs: child && typeof child.time === 'number' ? child.time : 0,
      });
      visit(child, fullName);
    });
  };
  visit(root, '');
  sections.sort((left, right) => right.averageTimeMs - left.averageTimeMs);
  const averageFrameTimeMs = typeof root.time === 'number' ? root.time : null;
  return {
    averageFrameTimeMs,
    estimatedFps:
      averageFrameTimeMs && averageFrameTimeMs > 0
        ? 1000 / averageFrameTimeMs
        : null,
    sections,
    sectionsTruncated: sections.length >= MAX_PROFILER_SECTIONS,
    stats: output.stats && typeof output.stats === 'object' ? output.stats : {},
    limitations: {
      frameDistribution: false,
      maxSectionTimes: false,
      hint:
        'Use runtime.profile.run for bounded frame distribution, worst-frame and max-section telemetry.',
    },
  };
};

type Waiter = {|
  id: string,
  command: string,
  resolve: any => void,
  reject: Error => void,
  timeout: TimeoutID,
|};

export const createRuntimeTelemetry = (
  previewDebuggerServer: any,
  options: any = {}
): any => {
  if (!previewDebuggerServer) throw makeError('preview_debugger_unavailable');
  const snapshotProvider =
    options && typeof options.snapshotProvider === 'function'
      ? options.snapshotProvider
      : null;
  const previewLifecycleTracker =
    options && options.previewLifecycleTracker
      ? options.previewLifecycleTracker
      : null;
  const logsByDebugger: Map<string, Array<any>> = new Map();
  const profilingByDebugger: Map<string, boolean> = new Map();
  const profilerOutputByDebugger: Map<string, any> = new Map();
  const waiters: Array<Waiter> = [];
  let disposed = false;

  const addLog = (id: string, log: any) => {
    let logs = logsByDebugger.get(id);
    if (!logs) {
      logs = [];
      logsByDebugger.set(id, logs);
    }
    logs.push(log);
    if (logs.length > MAX_LOGS_PER_DEBUGGER) {
      logs.splice(0, logs.length - MAX_LOGS_PER_DEBUGGER);
    }
  };

  const resolveWaiters = (id: string, parsedMessage: any) => {
    for (let index = waiters.length - 1; index >= 0; index--) {
      const waiter = waiters[index];
      if (waiter.id !== id || waiter.command !== parsedMessage.command)
        continue;
      clearTimeout(waiter.timeout);
      waiters.splice(index, 1);
      waiter.resolve(parsedMessage.payload);
    }
  };

  const unregisterCallbacks = previewDebuggerServer.registerCallbacks({
    onErrorReceived: error => {
      const ids = previewDebuggerServer.getExistingPreviewDebuggerIds
        ? previewDebuggerServer.getExistingPreviewDebuggerIds()
        : [];
      ids.forEach(id =>
        addLog(id, {
          type: 'error',
          group: 'Debugger server',
          message: String(error && error.message ? error.message : error),
          timestamp: Date.now(),
        })
      );
    },
    onConnectionClosed: ({ id }) => {
      logsByDebugger.delete(id);
      profilingByDebugger.delete(id);
      profilerOutputByDebugger.delete(id);
    },
    onConnectionOpened: () => {},
    onConnectionErrored: ({ id, errorMessage }) => {
      addLog(id, {
        type: 'error',
        group: 'Debugger connection',
        message: String(errorMessage || 'Debugger connection error'),
        timestamp: Date.now(),
      });
    },
    onServerStateChanged: () => {},
    onHandleParsedMessage: ({ id, parsedMessage }) => {
      if (!parsedMessage) return;
      if (parsedMessage.command === 'console.log') {
        addLog(id, parsedMessage.payload);
      } else if (parsedMessage.command === 'game.crashed') {
        const exception =
          parsedMessage.payload && parsedMessage.payload.exception
            ? parsedMessage.payload.exception
            : null;
        addLog(id, {
          type: 'error',
          group: 'Game crash',
          message:
            (exception && (exception.message || exception.stack)) ||
            'The preview crashed.',
          timestamp: Date.now(),
        });
      } else if (parsedMessage.command === 'hotReloader.logs') {
        const logs =
          parsedMessage.payload && Array.isArray(parsedMessage.payload.logs)
            ? parsedMessage.payload.logs
            : [];
        logs.forEach(log =>
          addLog(id, {
            type: log && log.type ? log.type : 'info',
            group: 'Hot reload',
            message: String(
              (log && (log.message || log.text || log.log)) || 'Hot reload log'
            ),
            timestamp: Date.now(),
          })
        );
      } else if (parsedMessage.command === 'profiler.started') {
        profilingByDebugger.set(id, true);
      } else if (parsedMessage.command === 'profiler.output') {
        profilerOutputByDebugger.set(id, parsedMessage.payload);
      } else if (parsedMessage.command === 'profiler.stopped') {
        profilingByDebugger.set(id, false);
      }
      resolveWaiters(id, parsedMessage);
    },
  });

  const getPreviewDebuggerIds = (): Array<string> => {
    const ids = previewDebuggerServer.getExistingPreviewDebuggerIds
      ? previewDebuggerServer.getExistingPreviewDebuggerIds()
      : previewDebuggerServer.getExistingDebuggerIds
      ? previewDebuggerServer.getExistingDebuggerIds()
      : [];
    return Array.isArray(ids) ? ids : [];
  };

  const getLifecycleContext = (debuggerId?: ?string): any => {
    if (!previewLifecycleTracker) {
      return { lifecycle: null, target: null, previewWindowId: null };
    }
    const lifecycle = previewLifecycleTracker.getStatus();
    const target = debuggerId
      ? (lifecycle.targets || []).find(
          candidate => candidate && candidate.debuggerId === debuggerId
        ) || null
      : null;
    return {
      lifecycle,
      target,
      previewWindowId:
        target && Number.isInteger(target.windowId) ? target.windowId : null,
    };
  };

  const makeUnavailableError = (): Error => {
    const { lifecycle } = getLifecycleContext();
    if (lifecycle && lifecycle.state === 'failed') {
      const error: any = makeError(
        'preview_runtime_failed',
        'Preview window/debugger lifecycle failed before runtime telemetry became ready.'
      );
      error.details = lifecycle;
      return error;
    }
    if (lifecycle && lifecycle.state && lifecycle.state !== 'stopped') {
      const error: any = makeError(
        'preview_runtime_not_ready',
        `Preview exists but runtime telemetry is not ready (state: ${
          lifecycle.state
        }).`
      );
      error.details = lifecycle;
      return error;
    }
    return makeError('preview_not_running');
  };

  const selectDebuggerId = (requestedId?: ?string): string => {
    const ids = getPreviewDebuggerIds();
    if (requestedId) {
      if (!ids.includes(requestedId)) {
        if (!ids.length) throw makeUnavailableError();
        throw makeError('preview_debugger_not_found');
      }
      return requestedId;
    }
    if (!ids.length) throw makeUnavailableError();
    // Preview debugger ids are kept in connection order by the native preview
    // debugger server. During hot reload, the old websocket can overlap briefly
    // with the newly connected one. Prefer the newest connection so telemetry
    // stays targetable throughout that transition. Callers that need a specific
    // preview window can still pass debuggerId explicitly.
    return ids[ids.length - 1];
  };

  const requestMessage = (
    debuggerId: string,
    command: string,
    expectedCommand: string,
    timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS
  ): Promise<any> => {
    if (disposed)
      return Promise.reject(makeError('runtime_telemetry_disposed'));
    return new Promise((resolve, reject) => {
      const waiter: any = {
        id: debuggerId,
        command: expectedCommand,
        resolve,
        reject,
        timeout: null,
      };
      waiter.timeout = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index !== -1) waiters.splice(index, 1);
        reject(makeError(`runtime_telemetry_timeout:${expectedCommand}`));
      }, timeoutMs);
      waiters.push(waiter);
      previewDebuggerServer.sendMessage(debuggerId, { command });
    });
  };

  const requestMessageWithRetry = async (
    debuggerId: string,
    command: string,
    expectedCommand: string,
    timeoutMs: number
  ): Promise<any> => {
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await requestMessage(
          debuggerId,
          command,
          expectedCommand,
          timeoutMs
        );
      } catch (error) {
        lastError = error;
        const code = String(
          (error && error.code) || (error && error.message) || error || ''
        );
        if (!code.startsWith('runtime_telemetry_timeout:') || attempt === 1) {
          throw error;
        }
        await sleep(150);
      }
    }
    throw lastError || makeError('runtime_telemetry_failed');
  };

  const getStatus = async (request: any = {}): Promise<any> => {
    const debuggerId = selectDebuggerId(request.debuggerId);
    const status = await requestMessageWithRetry(
      debuggerId,
      'getStatus',
      'status',
      DEFAULT_REQUEST_TIMEOUT_MS
    );
    const { lifecycle, target, previewWindowId } = getLifecycleContext(
      debuggerId
    );
    return {
      debuggerId,
      ...(previewWindowId !== null ? { previewWindowId } : {}),
      ...(lifecycle ? { lifecycleState: lifecycle.state } : {}),
      ...(target ? { lifecycleTarget: target } : {}),
      ...status,
    };
  };

  const getSnapshot = async (request: any = {}): Promise<any> => {
    const debuggerId = selectDebuggerId(request.debuggerId);
    const { lifecycle, target, previewWindowId } = getLifecycleContext(
      debuggerId
    );
    const snapshotRequest =
      previewWindowId !== null && request.previewWindowId == null
        ? { ...request, previewWindowId }
        : request;
    let snapshotProviderError = null;
    if (snapshotProvider) {
      try {
        const snapshot = await snapshotProvider(snapshotRequest);
        if (!snapshot || typeof snapshot !== 'object') {
          throw makeError('invalid_runtime_snapshot');
        }
        return {
          debuggerId,
          capturedAt: Date.now(),
          ...(previewWindowId !== null ? { previewWindowId } : {}),
          ...(lifecycle ? { lifecycleState: lifecycle.state } : {}),
          ...(target ? { lifecycleTarget: target } : {}),
          ...snapshot,
        };
      } catch (error) {
        snapshotProviderError = error;
      }
    }
    const dump = await requestMessageWithRetry(
      debuggerId,
      'refresh',
      'dump',
      clampInteger(
        request.requestTimeoutMs,
        DEFAULT_REQUEST_TIMEOUT_MS,
        250,
        10000
      )
    );
    return {
      debuggerId,
      capturedAt: Date.now(),
      ...(previewWindowId !== null ? { previewWindowId } : {}),
      ...(lifecycle ? { lifecycleState: lifecycle.state } : {}),
      ...(target ? { lifecycleTarget: target } : {}),
      ...(snapshotProviderError
        ? {
            snapshotSource: 'debugger-dump-fallback',
            snapshotProviderErrorCode: String(
              (snapshotProviderError && snapshotProviderError.code) ||
                (snapshotProviderError && snapshotProviderError.message) ||
                'preview_runtime_snapshot_failed'
            ),
          }
        : {}),
      ...summarizeRuntimeDump(dump, request),
    };
  };

  const inspectRuntime = async (request: any = {}): Promise<any> => {
    const selector = request.selector;
    if (!selector || typeof selector !== 'object') {
      throw makeError(
        'invalid_runtime_selector',
        'runtime.inspect requires a selector.'
      );
    }
    const snapshot = await getSnapshot(
      makeTargetedSnapshotRequest(request, selector)
    );
    const selection = selectRuntimeValue(snapshot, selector);
    return {
      debuggerId: snapshot.debuggerId,
      capturedAt: snapshot.capturedAt,
      snapshotSource: snapshot.snapshotSource || 'debugger-dump',
      sceneName: snapshot.scene ? snapshot.scene.name : null,
      ...selection,
    };
  };

  const getLogs = (request: any = {}): any => {
    const debuggerId = selectDebuggerId(request.debuggerId);
    const limit = clampInteger(request.limit, 50, 1, MAX_LOGS_PER_DEBUGGER);
    const logs = logsByDebugger.get(debuggerId) || [];
    const selectedLogs = logs.slice(Math.max(0, logs.length - limit));
    const { lifecycle, target, previewWindowId } = getLifecycleContext(
      debuggerId
    );
    return {
      debuggerId,
      ...(previewWindowId !== null ? { previewWindowId } : {}),
      ...(lifecycle ? { lifecycleState: lifecycle.state } : {}),
      ...(target ? { lifecycleTarget: target } : {}),
      total: logs.length,
      logs: selectedLogs,
      errors: selectedLogs.filter(log => log && log.type === 'error').length,
      warnings: selectedLogs.filter(
        log => log && (log.type === 'warning' || log.type === 'warn')
      ).length,
    };
  };

  const getProfilerStatus = (request: any = {}): any => {
    const debuggerId = selectDebuggerId(request.debuggerId);
    const rawOutput = profilerOutputByDebugger.get(debuggerId) || null;
    return {
      debuggerId,
      profiling: profilingByDebugger.get(debuggerId) === true,
      hasOutput: !!rawOutput,
      lastOutput: rawOutput ? summarizeProfilerOutput(rawOutput) : null,
    };
  };

  const startProfiler = async (request: any = {}): Promise<any> => {
    const debuggerId = selectDebuggerId(request.debuggerId);
    if (profilingByDebugger.get(debuggerId) === true) {
      return { debuggerId, profiling: true, alreadyRunning: true };
    }
    profilerOutputByDebugger.delete(debuggerId);
    await requestMessageWithRetry(
      debuggerId,
      'profiler.start',
      'profiler.started',
      clampInteger(
        request.requestTimeoutMs,
        DEFAULT_REQUEST_TIMEOUT_MS,
        250,
        10000
      )
    );
    profilingByDebugger.set(debuggerId, true);
    return { debuggerId, profiling: true, alreadyRunning: false };
  };

  const stopProfiler = async (request: any = {}): Promise<any> => {
    const debuggerId = selectDebuggerId(request.debuggerId);
    const output = await requestMessageWithRetry(
      debuggerId,
      'profiler.stop',
      'profiler.output',
      clampInteger(
        request.requestTimeoutMs,
        DEFAULT_REQUEST_TIMEOUT_MS,
        250,
        10000
      )
    );
    profilerOutputByDebugger.set(debuggerId, output);
    profilingByDebugger.set(debuggerId, false);
    return {
      debuggerId,
      profiling: false,
      output: summarizeProfilerOutput(output),
    };
  };

  const assertRuntime = async (request: any = {}): Promise<any> => {
    const selector =
      request.condition &&
      typeof request.condition === 'object' &&
      request.condition.selector
        ? request.condition.selector
        : null;
    const snapshot = await getSnapshot(
      selector ? makeTargetedSnapshotRequest(request, selector) : request
    );
    return {
      ...evaluateRuntimeCondition(snapshot, request.condition),
      debuggerId: snapshot.debuggerId,
      snapshot,
    };
  };

  const waitFor = async (request: any = {}): Promise<any> => {
    const timeoutMs = clampInteger(request.timeoutMs, 5000, 100, MAX_WAIT_MS);
    const intervalMs = clampInteger(
      request.intervalMs,
      250,
      MIN_POLL_MS,
      MAX_POLL_MS
    );
    const selector =
      request.condition &&
      typeof request.condition === 'object' &&
      request.condition.selector
        ? request.condition.selector
        : null;
    const startedAt = Date.now();
    let attempts = 0;
    let lastResult = null;
    let lastSnapshot = null;
    while (Date.now() - startedAt <= timeoutMs) {
      attempts += 1;
      lastSnapshot = await getSnapshot(
        selector ? makeTargetedSnapshotRequest(request, selector) : request
      );
      lastResult = evaluateRuntimeCondition(lastSnapshot, request.condition);
      if (lastResult.passed) {
        return {
          ...lastResult,
          debuggerId: lastSnapshot.debuggerId,
          attempts,
          elapsedMs: Date.now() - startedAt,
          timedOut: false,
          snapshot: lastSnapshot,
        };
      }
      await sleep(intervalMs);
    }
    return {
      ...(lastResult || { passed: false }),
      debuggerId: lastSnapshot ? lastSnapshot.debuggerId : null,
      attempts,
      elapsedMs: Date.now() - startedAt,
      timedOut: true,
      snapshot: lastSnapshot,
    };
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (unregisterCallbacks) unregisterCallbacks();
    while (waiters.length) {
      const waiter = waiters.pop();
      if (!waiter) continue;
      clearTimeout(waiter.timeout);
      waiter.reject(makeError('runtime_telemetry_disposed'));
    }
    logsByDebugger.clear();
    profilingByDebugger.clear();
    profilerOutputByDebugger.clear();
  };

  return {
    getPreviewDebuggerIds,
    getStatus,
    getSnapshot,
    inspectRuntime,
    getLogs,
    getProfilerStatus,
    startProfiler,
    stopProfiler,
    assertRuntime,
    waitFor,
    dispose,
  };
};
