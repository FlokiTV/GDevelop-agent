// @flow

const DEFAULT_REQUEST_TIMEOUT_MS = 2500;
const DEFAULT_MAX_INSTANCES = 200;
const MAX_INSTANCES = 1000;
const MAX_LOGS_PER_DEBUGGER = 200;
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

export const evaluateRuntimeCondition = (
  snapshot: any,
  condition: any
): any => {
  if (!condition || typeof condition !== 'object') {
    throw makeError('invalid_runtime_condition');
  }
  const actual = getPathValue(snapshot, condition.path);
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
  return { passed, path: condition.path, operator, expected, actual };
};

type Waiter = {|
  id: string,
  command: string,
  resolve: any => void,
  reject: Error => void,
  timeout: TimeoutID,
|};

export const createRuntimeTelemetry = (previewDebuggerServer: any): any => {
  if (!previewDebuggerServer) throw makeError('preview_debugger_unavailable');
  const logsByDebugger: Map<string, Array<any>> = new Map();
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

  const selectDebuggerId = (requestedId?: ?string): string => {
    const ids = getPreviewDebuggerIds();
    if (requestedId) {
      if (!ids.includes(requestedId))
        throw makeError('preview_debugger_not_found');
      return requestedId;
    }
    if (!ids.length) throw makeError('preview_not_running');
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
    return { debuggerId, ...status };
  };

  const getSnapshot = async (request: any = {}): Promise<any> => {
    const debuggerId = selectDebuggerId(request.debuggerId);
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
      ...summarizeRuntimeDump(dump, request),
    };
  };

  const getLogs = (request: any = {}): any => {
    const debuggerId = selectDebuggerId(request.debuggerId);
    const limit = clampInteger(request.limit, 50, 1, MAX_LOGS_PER_DEBUGGER);
    const logs = logsByDebugger.get(debuggerId) || [];
    const selectedLogs = logs.slice(Math.max(0, logs.length - limit));
    return {
      debuggerId,
      total: logs.length,
      logs: selectedLogs,
      errors: selectedLogs.filter(log => log && log.type === 'error').length,
      warnings: selectedLogs.filter(
        log => log && (log.type === 'warning' || log.type === 'warn')
      ).length,
    };
  };

  const assertRuntime = async (request: any = {}): Promise<any> => {
    const snapshot = await getSnapshot(request);
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
    const startedAt = Date.now();
    let attempts = 0;
    let lastResult = null;
    let lastSnapshot = null;
    while (Date.now() - startedAt <= timeoutMs) {
      attempts += 1;
      lastSnapshot = await getSnapshot(request);
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
  };

  return {
    getPreviewDebuggerIds,
    getStatus,
    getSnapshot,
    getLogs,
    assertRuntime,
    waitFor,
    dispose,
  };
};
