// @flow
import {
  serializeToJSObject,
  unserializeFromJSObject,
} from '../Utils/Serializer';

const gd: libGDevelop = global.gd;

const fingerprintString = (value: string): string => {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  let third = 0x85ebca6b;
  let fourth = 0xc2b2ae35;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
    third = Math.imul(third ^ code, 0xc2b2ae35);
    fourth = Math.imul(fourth ^ code, 0x27d4eb2f);
  }
  return [first, second, third, fourth]
    .map(hash => (hash >>> 0).toString(16).padStart(8, '0'))
    .join('');
};

const fingerprintValue = (value: any): string =>
  fingerprintString(JSON.stringify(value));

const visitSerializedEvents = (
  eventsJson: Array<any>,
  visitor: (eventJson: any, path: Array<number>) => void,
  parentPath: Array<number> = []
) => {
  eventsJson.forEach((eventJson, index) => {
    const path = [...parentPath, index];
    visitor(eventJson, path);
    if (Array.isArray(eventJson.events)) {
      visitSerializedEvents(eventJson.events, visitor, path);
    }
  });
};

const createCanonicalEventIndex = (eventsJson: Array<any>) => {
  const aiIdCounts = new Map();
  const fingerprintCounts = new Map();
  const conditionFingerprintCounts = new Map();
  const actionFingerprintCounts = new Map();

  const visitInstructions = (
    instructions: any,
    fingerprintCountsForKind: Map<string, number>
  ) => {
    if (!Array.isArray(instructions)) return;
    instructions.forEach(instruction => {
      const fingerprint = fingerprintValue(instruction);
      fingerprintCountsForKind.set(
        fingerprint,
        (fingerprintCountsForKind.get(fingerprint) || 0) + 1
      );
      visitInstructions(
        instruction && instruction.subInstructions,
        fingerprintCountsForKind
      );
    });
  };

  visitSerializedEvents(eventsJson, eventJson => {
    const aiGeneratedEventId =
      typeof eventJson.aiGeneratedEventId === 'string' &&
      eventJson.aiGeneratedEventId
        ? eventJson.aiGeneratedEventId
        : null;
    if (aiGeneratedEventId) {
      aiIdCounts.set(
        aiGeneratedEventId,
        (aiIdCounts.get(aiGeneratedEventId) || 0) + 1
      );
    }
    const fingerprint = fingerprintValue(eventJson);
    fingerprintCounts.set(
      fingerprint,
      (fingerprintCounts.get(fingerprint) || 0) + 1
    );
    visitInstructions(eventJson.conditions, conditionFingerprintCounts);
    visitInstructions(eventJson.whileConditions, conditionFingerprintCounts);
    visitInstructions(eventJson.actions, actionFingerprintCounts);
  });

  const buildInstructions = ({
    instructions,
    kind,
    eventPath,
    parentPath = [],
  }: {|
    instructions: any,
    kind: 'condition' | 'action',
    eventPath: Array<number>,
    parentPath?: Array<number>,
  |}): Array<any> => {
    if (!Array.isArray(instructions)) return [];
    const counts =
      kind === 'condition'
        ? conditionFingerprintCounts
        : actionFingerprintCounts;
    return instructions.map((instructionJson, index) => {
      const path = [...parentPath, index];
      const fingerprint = fingerprintValue(instructionJson);
      const unique = counts.get(fingerprint) === 1;
      const handle = unique
        ? `${kind}:fp:${fingerprint}`
        : `${kind}:fp:${fingerprint}:event:${eventPath.join(
            '.'
          )}:path:${path.join('.')}`;
      const type =
        instructionJson && instructionJson.type
          ? typeof instructionJson.type === 'object'
            ? instructionJson.type.value || null
            : instructionJson.type
          : null;
      return {
        handle,
        path,
        eventPath,
        fingerprint,
        handleKind: unique ? 'fingerprint' : 'fingerprint-path',
        type,
        parameters: Array.isArray(instructionJson.parameters)
          ? instructionJson.parameters
          : [],
        inverted: !!(
          instructionJson &&
          instructionJson.type &&
          typeof instructionJson.type === 'object' &&
          instructionJson.type.inverted
        ),
        await: !!(
          instructionJson &&
          instructionJson.type &&
          typeof instructionJson.type === 'object' &&
          instructionJson.type.await
        ),
        children: buildInstructions({
          instructions: instructionJson && instructionJson.subInstructions,
          kind,
          eventPath,
          parentPath: path,
        }),
      };
    });
  };

  const buildNodes = (
    serializedEvents: Array<any>,
    parentPath: Array<number> = []
  ): Array<any> =>
    serializedEvents.map((eventJson, index) => {
      const path = [...parentPath, index];
      const fingerprint = fingerprintValue(eventJson);
      const aiGeneratedEventId =
        typeof eventJson.aiGeneratedEventId === 'string' &&
        eventJson.aiGeneratedEventId
          ? eventJson.aiGeneratedEventId
          : null;
      const handle =
        aiGeneratedEventId && aiIdCounts.get(aiGeneratedEventId) === 1
          ? `event:id:${encodeURIComponent(aiGeneratedEventId)}`
          : fingerprintCounts.get(fingerprint) === 1
          ? `event:fp:${fingerprint}`
          : `event:fp:${fingerprint}:path:${path.join('.')}`;
      return {
        handle,
        path,
        fingerprint,
        handleKind:
          aiGeneratedEventId && aiIdCounts.get(aiGeneratedEventId) === 1
            ? 'persistent-id'
            : fingerprintCounts.get(fingerprint) === 1
            ? 'fingerprint'
            : 'fingerprint-path',
        type:
          eventJson && eventJson.type && typeof eventJson.type === 'object'
            ? eventJson.type.value || null
            : eventJson.type || null,
        disabled: !!eventJson.disabled,
        folded: !!eventJson.folded,
        aiGeneratedEventId,
        conditions: buildInstructions({
          instructions: eventJson.conditions,
          kind: 'condition',
          eventPath: path,
        }),
        whileConditions: buildInstructions({
          instructions: eventJson.whileConditions,
          kind: 'condition',
          eventPath: path,
        }),
        actions: buildInstructions({
          instructions: eventJson.actions,
          kind: 'action',
          eventPath: path,
        }),
        children: Array.isArray(eventJson.events)
          ? buildNodes(eventJson.events, path)
          : [],
      };
    });

  return {
    events: buildNodes(eventsJson),
    eventsRevision: `events:${fingerprintValue(eventsJson)}`,
  };
};

const flattenCanonicalEvents = (events: Array<any>): Array<any> => {
  const flattened = [];
  const visit = nodes => {
    nodes.forEach(node => {
      flattened.push(node);
      visit(node.children || []);
    });
  };
  visit(events);
  return flattened;
};

const makeError = (code: string, message?: string, details?: any): Error => {
  const error: any = new Error(message || code);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
};

const getCanonicalEventsState = (eventsList: gdEventsList) => {
  const eventsJson = serializeToJSObject(eventsList, 'serializeTo', {
    canonicalEventSerialization: true,
  });
  const canonicalIndex = createCanonicalEventIndex(eventsJson);
  return {
    eventsJson,
    eventsRevision: canonicalIndex.eventsRevision,
    events: canonicalIndex.events,
    flatEvents: flattenCanonicalEvents(canonicalIndex.events),
  };
};

const resolveEventsTarget = (project: gdProject, request: any) => {
  const explicitTarget =
    request && request.target && typeof request.target === 'object'
      ? request.target
      : null;
  if (explicitTarget && request && request.sceneName) {
    throw makeError('ambiguous_events_target');
  }

  const target = explicitTarget || {
    kind: 'scene',
    sceneName:
      request && typeof request.sceneName === 'string' ? request.sceneName : '',
  };

  if (target.kind === 'scene') {
    const sceneName =
      typeof target.sceneName === 'string' ? target.sceneName : '';
    const scene = requireScene(project, sceneName);
    return {
      kind: 'scene',
      scene,
      rootEvents: scene.getEvents(),
      responseTarget: { kind: 'scene', sceneName },
      sceneName,
      extensionName: null,
      ownerKind: null,
      ownerName: null,
      functionName: null,
    };
  }

  if (target.kind !== 'extension-function') {
    throw makeError('invalid_events_target_kind', undefined, {
      kind: target.kind,
    });
  }

  const extensionName =
    typeof target.extensionName === 'string' ? target.extensionName : '';
  if (
    !extensionName ||
    !project.hasEventsFunctionsExtensionNamed(extensionName)
  ) {
    throw makeError('project_extension_not_found', undefined, {
      extensionName,
    });
  }
  const extension = project.getEventsFunctionsExtension(extensionName);
  const ownerKind =
    typeof target.ownerKind === 'string' && target.ownerKind
      ? target.ownerKind
      : 'extension';
  const ownerName =
    typeof target.ownerName === 'string' && target.ownerName
      ? target.ownerName
      : null;
  let container = extension.getEventsFunctions();

  if (ownerKind === 'behavior') {
    const behaviors = extension.getEventsBasedBehaviors();
    if (!ownerName || !behaviors.has(ownerName)) {
      throw makeError('events_based_behavior_not_found', undefined, {
        extensionName,
        ownerName,
      });
    }
    container = behaviors.get(ownerName).getEventsFunctions();
  } else if (ownerKind === 'object') {
    const objects = extension.getEventsBasedObjects();
    if (!ownerName || !objects.has(ownerName)) {
      throw makeError('events_based_object_not_found', undefined, {
        extensionName,
        ownerName,
      });
    }
    container = objects.get(ownerName).getEventsFunctions();
  } else if (ownerKind !== 'extension') {
    throw makeError('invalid_events_function_owner', undefined, { ownerKind });
  }

  const functionName =
    typeof target.functionName === 'string' ? target.functionName : '';
  if (!functionName || !container.hasEventsFunctionNamed(functionName)) {
    throw makeError('events_function_not_found', undefined, {
      extensionName,
      ownerKind,
      ownerName,
      functionName,
    });
  }
  const eventsFunction = container.getEventsFunction(functionName);
  return {
    kind: 'extension-function',
    scene: null,
    rootEvents: eventsFunction.getEvents(),
    responseTarget: {
      kind: 'extension-function',
      extensionName,
      ownerKind,
      ...(ownerName ? { ownerName } : {}),
      functionName,
    },
    sceneName: null,
    extensionName,
    ownerKind,
    ownerName,
    functionName,
    extension,
    eventsFunction,
  };
};

const targetResponseFields = (target: any) => ({
  target: target.responseTarget,
  ...(target.kind === 'scene' ? { sceneName: target.sceneName } : {}),
});

const assertExpectedEventsRevision = (
  expectedEventsRevision: any,
  currentEventsRevision: string
) => {
  if (
    typeof expectedEventsRevision !== 'string' ||
    expectedEventsRevision !== currentEventsRevision
  ) {
    throw makeError(
      'events_revision_conflict',
      'The targeted event tree changed since it was read.',
      { expectedEventsRevision, currentEventsRevision }
    );
  }
};

const resolveEventHandle = (
  canonicalState: any,
  handle: any
): Array<number> => {
  if (!handle || typeof handle !== 'string') {
    throw makeError('invalid_event_handle');
  }
  const exact = canonicalState.flatEvents.find(
    event => event.handle === handle
  );
  if (exact) return exact.path;

  const fingerprintMatch = /^event:fp:([0-9a-f]{32})(?::path:([0-9.]+))?$/.exec(
    handle
  );
  if (fingerprintMatch) {
    const fingerprint = fingerprintMatch[1];
    const candidates = canonicalState.flatEvents.filter(
      event => event.fingerprint === fingerprint
    );
    if (candidates.length === 1) return candidates[0].path;
    throw makeError('ambiguous_event_handle', undefined, {
      handle,
      matches: candidates.map(candidate => candidate.path),
    });
  }

  throw makeError('event_handle_not_found', undefined, { handle });
};

const getParentListAndIndex = (
  rootEvents: gdEventsList,
  path: Array<number>
): {| parentList: gdEventsList, index: number |} => {
  if (!path.length) throw makeError('invalid_event_path');
  let parentList = rootEvents;
  for (let depth = 0; depth < path.length - 1; depth++) {
    const index = path[depth];
    if (index < 0 || index >= parentList.getEventsCount()) {
      throw makeError('event_path_not_found');
    }
    const parentEvent = parentList.getEventAt(index);
    if (!parentEvent.canHaveSubEvents()) {
      throw makeError('event_cannot_have_subevents');
    }
    parentList = parentEvent.getSubEvents();
  }
  const index = path[path.length - 1];
  if (index < 0 || index >= parentList.getEventsCount()) {
    throw makeError('event_path_not_found');
  }
  return { parentList, index };
};

const requireScene = (project: gdProject, sceneName: string): gdLayout => {
  if (!sceneName || !project.hasLayoutNamed(sceneName)) {
    throw makeError('scene_not_found');
  }
  return project.getLayout(sceneName);
};

const getSerializedEventByPath = (
  eventsJson: Array<any>,
  path: Array<number>
): any => {
  let currentEvents = eventsJson;
  let eventJson = null;
  for (let depth = 0; depth < path.length; depth++) {
    const index = path[depth];
    if (
      !Array.isArray(currentEvents) ||
      index < 0 ||
      index >= currentEvents.length
    ) {
      throw makeError('event_path_not_found');
    }
    eventJson = currentEvents[index];
    currentEvents = Array.isArray(eventJson.events) ? eventJson.events : [];
  }
  return eventJson;
};

const pathsEqual = (left: Array<number>, right: Array<number>): boolean =>
  left.length === right.length &&
  left.every((index, depth) => index === right[depth]);

const isPathPrefix = (prefix: Array<number>, path: Array<number>): boolean =>
  prefix.length <= path.length &&
  prefix.every((index, depth) => index === path[depth]);

const findCanonicalNodeByPath = (
  canonicalState: any,
  path: Array<number>
): any =>
  canonicalState.flatEvents.find(event => pathsEqual(event.path, path)) || null;

const resolveInsertionLocation = ({
  rootEvents,
  canonicalState,
  parentHandle,
  beforeHandle,
  afterHandle,
}: {|
  rootEvents: gdEventsList,
  canonicalState: any,
  parentHandle?: ?string,
  beforeHandle?: ?string,
  afterHandle?: ?string,
|}): {|
  targetList: gdEventsList,
  insertionIndex: number,
  parentPath: Array<number>,
  targetPath: ?Array<number>,
|} => {
  const placementHandles = [parentHandle, beforeHandle, afterHandle].filter(
    handle => typeof handle === 'string' && handle
  );
  if (placementHandles.length > 1) {
    throw makeError('invalid_event_placement');
  }

  if (parentHandle) {
    const parentEventPath = resolveEventHandle(canonicalState, parentHandle);
    const { parentList, index } = getParentListAndIndex(
      rootEvents,
      parentEventPath
    );
    const parentEvent = parentList.getEventAt(index);
    if (!parentEvent.canHaveSubEvents()) {
      throw makeError('event_cannot_have_subevents', undefined, {
        handle: parentHandle,
      });
    }
    const targetList = parentEvent.getSubEvents();
    return {
      targetList,
      insertionIndex: targetList.getEventsCount(),
      parentPath: parentEventPath,
      targetPath: parentEventPath,
    };
  }

  if (beforeHandle || afterHandle) {
    const targetHandle = beforeHandle || afterHandle;
    const targetPath = resolveEventHandle(canonicalState, targetHandle);
    const location = getParentListAndIndex(rootEvents, targetPath);
    return {
      targetList: location.parentList,
      insertionIndex: location.index + (afterHandle ? 1 : 0),
      parentPath: targetPath.slice(0, -1),
      targetPath,
    };
  }

  return {
    targetList: rootEvents,
    insertionIndex: rootEvents.getEventsCount(),
    parentPath: [],
    targetPath: null,
  };
};

const collectAiGeneratedEventIds = (
  eventsList: gdEventsList,
  ids: Set<string> = new Set()
): Set<string> => {
  for (let index = 0; index < eventsList.getEventsCount(); index++) {
    const event = eventsList.getEventAt(index);
    const id = event.getAiGeneratedEventId();
    if (id) ids.add(id);
    if (event.canHaveSubEvents()) {
      collectAiGeneratedEventIds(event.getSubEvents(), ids);
    }
  }
  return ids;
};

const deserializeEvents = (
  project: gdProject,
  eventsJson: any
): gdEventsList => {
  if (!Array.isArray(eventsJson)) throw makeError('invalid_events_json');
  const eventsList = new gd.EventsList();
  try {
    unserializeFromJSObject(eventsList, eventsJson, 'unserializeFrom', project);
    return eventsList;
  } catch (error) {
    eventsList.delete();
    throw makeError(
      'invalid_events_json',
      `invalid_events_json:${
        error && error.message ? error.message : String(error)
      }`
    );
  }
};

export const createEventTools = ({
  project,
  diagnosticsTools,
  triggerUnsavedChanges,
  onSceneEventsModifiedOutsideEditor,
  forceUpdate,
}: {|
  project: gdProject,
  diagnosticsTools?: ?any,
  triggerUnsavedChanges: () => void,
  onSceneEventsModifiedOutsideEditor: (changes: any) => void,
  forceUpdate?: ?() => void,
|}): any => {
  const getPostPatchValidation = (target: any) => {
    if (!diagnosticsTools) return { ok: true, issues: [] };
    const diagnostics = diagnosticsTools.inspect({
      includeNativeReport: false,
      includeAssets: false,
    });
    const issues = (diagnostics.issues || []).filter(issue => {
      if (!issue || issue.category !== 'events-validation') return false;
      const details = issue.details || {};
      if (target.kind === 'scene') {
        return (
          (details.locationType === undefined ||
            details.locationType === 'scene') &&
          (details.locationName === target.sceneName ||
            issue.sceneName === target.sceneName)
        );
      }
      if (
        details.locationType !== 'extension' ||
        details.extensionName !== target.extensionName ||
        details.functionName !== target.functionName
      ) {
        return false;
      }
      if (target.ownerKind === 'behavior') {
        return details.behaviorName === target.ownerName;
      }
      if (target.ownerKind === 'object') {
        return (
          details.objectName === target.ownerName ||
          issue.objectName === target.ownerName
        );
      }
      return !details.behaviorName && !details.objectName && !issue.objectName;
    });
    return {
      ok: !issues.some(issue => issue.severity === 'error'),
      issues,
    };
  };

  const notifyTargetEventsModified = (
    target: any,
    newOrChangedAiGeneratedEventIds: Set<string>
  ) => {
    triggerUnsavedChanges();
    if (target.kind === 'scene') {
      onSceneEventsModifiedOutsideEditor({
        scene: target.scene,
        newOrChangedAiGeneratedEventIds,
      });
    } else if (forceUpdate) {
      forceUpdate();
    }
  };

  const makePatchDiff = ({
    operation,
    beforeState,
    afterState,
    details,
  }: {|
    operation: string,
    beforeState: any,
    afterState: any,
    details?: any,
  |}) => ({
    operation,
    beforeEventsRevision: beforeState.eventsRevision,
    eventsRevision: afterState.eventsRevision,
    beforeEventCount: beforeState.flatEvents.length,
    afterEventCount: afterState.flatEvents.length,
    ...(details || {}),
  });

  const readEventsJson = (request: any): any => {
    const target = resolveEventsTarget(project, request);
    const canonicalState = getCanonicalEventsState(target.rootEvents);
    const total = canonicalState.events.length;
    const hasPagination =
      Number.isInteger(request.offset) || Number.isInteger(request.limit);
    if (!hasPagination) {
      return {
        ...targetResponseFields(target),
        eventsJson: canonicalState.eventsJson,
        eventsCount: target.rootEvents.getEventsCount(),
        eventsRevision: canonicalState.eventsRevision,
        events: canonicalState.events,
      };
    }

    const offset = Number.isInteger(request.offset)
      ? Math.max(0, request.offset)
      : 0;
    const limit = Number.isInteger(request.limit)
      ? Math.min(200, Math.max(1, request.limit))
      : 50;
    const end = Math.min(total, offset + limit);
    return {
      ...targetResponseFields(target),
      eventsJson: canonicalState.eventsJson.slice(offset, end),
      eventsCount: target.rootEvents.getEventsCount(),
      eventsRevision: canonicalState.eventsRevision,
      events: canonicalState.events.slice(offset, end),
      pagination: {
        offset,
        limit,
        total,
        returned: Math.max(0, end - offset),
        hasMore: end < total,
        nextOffset: end < total ? end : null,
      },
    };
  };

  const insertEvents = (request: any): any => {
    const target = resolveEventsTarget(project, request);
    const beforeState = getCanonicalEventsState(target.rootEvents);
    assertExpectedEventsRevision(
      request.expectedEventsRevision,
      beforeState.eventsRevision
    );

    const incomingEvents = deserializeEvents(project, request.eventsJson);
    const incomingCount = incomingEvents.getEventsCount();
    if (incomingCount === 0) {
      incomingEvents.delete();
      throw makeError('empty_events_patch');
    }
    const aiGeneratedEventIds = collectAiGeneratedEventIds(incomingEvents);
    const placement = resolveInsertionLocation({
      rootEvents: target.rootEvents,
      canonicalState: beforeState,
      parentHandle: request.parentHandle,
      beforeHandle: request.beforeHandle,
      afterHandle: request.afterHandle,
    });
    const { targetList, insertionIndex, parentPath } = placement;

    try {
      targetList.insertEvents(incomingEvents, 0, incomingCount, insertionIndex);
    } finally {
      incomingEvents.delete();
    }

    notifyTargetEventsModified(target, aiGeneratedEventIds);

    const afterState = getCanonicalEventsState(target.rootEvents);
    const inserted = Array.from({ length: incomingCount }, (_, offset) => {
      const path = [...parentPath, insertionIndex + offset];
      const node = findCanonicalNodeByPath(afterState, path);
      return node
        ? {
            handle: node.handle,
            path: node.path,
            fingerprint: node.fingerprint,
          }
        : { handle: null, path, fingerprint: null };
    });
    return {
      inserted: incomingCount,
      ...targetResponseFields(target),
      beforeEventsRevision: beforeState.eventsRevision,
      eventsRevision: afterState.eventsRevision,
      events: inserted,
      validation: getPostPatchValidation(target),
      diff: makePatchDiff({
        operation: 'insert',
        beforeState,
        afterState,
        details: {
          inserted: inserted.map(event => ({
            handle: event.handle,
            path: event.path,
          })),
        },
      }),
    };
  };

  const deleteEvent = (request: any): any => {
    const target = resolveEventsTarget(project, request);
    const beforeState = getCanonicalEventsState(target.rootEvents);
    assertExpectedEventsRevision(
      request.expectedEventsRevision,
      beforeState.eventsRevision
    );
    const path = resolveEventHandle(beforeState, request.handle);
    const { parentList, index } = getParentListAndIndex(
      target.rootEvents,
      path
    );
    const deletedNode = findCanonicalNodeByPath(beforeState, path);
    parentList.removeEventAt(index);

    notifyTargetEventsModified(target, new Set());
    const afterState = getCanonicalEventsState(target.rootEvents);
    const deletedEvent = deletedNode
      ? {
          handle: deletedNode.handle,
          path: deletedNode.path,
          fingerprint: deletedNode.fingerprint,
        }
      : { handle: request.handle, path, fingerprint: null };
    return {
      deleted: true,
      ...targetResponseFields(target),
      deletedEvent,
      beforeEventsRevision: beforeState.eventsRevision,
      eventsRevision: afterState.eventsRevision,
      validation: getPostPatchValidation(target),
      diff: makePatchDiff({
        operation: 'delete',
        beforeState,
        afterState,
        details: {
          deleted: { handle: deletedEvent.handle, path: deletedEvent.path },
        },
      }),
    };
  };

  const moveEvent = (request: any): any => {
    const target = resolveEventsTarget(project, request);
    const beforeState = getCanonicalEventsState(target.rootEvents);
    assertExpectedEventsRevision(
      request.expectedEventsRevision,
      beforeState.eventsRevision
    );
    const rootEvents = target.rootEvents;
    const sourcePath = resolveEventHandle(beforeState, request.handle);
    const sourceParentPath = sourcePath.slice(0, -1);
    const sourceLocation = getParentListAndIndex(rootEvents, sourcePath);
    const placement = resolveInsertionLocation({
      rootEvents,
      canonicalState: beforeState,
      parentHandle: request.parentHandle,
      beforeHandle: request.beforeHandle,
      afterHandle: request.afterHandle,
    });

    if (
      placement.targetPath &&
      (pathsEqual(sourcePath, placement.targetPath) ||
        isPathPrefix(sourcePath, placement.targetPath))
    ) {
      throw makeError('invalid_event_move_destination');
    }

    let insertionIndex = placement.insertionIndex;
    if (
      pathsEqual(sourceParentPath, placement.parentPath) &&
      sourceLocation.index < insertionIndex
    ) {
      insertionIndex--;
    }
    if (
      pathsEqual(sourceParentPath, placement.parentPath) &&
      sourceLocation.index === insertionIndex
    ) {
      throw makeError('event_move_noop');
    }

    const sourceEventJson = getSerializedEventByPath(
      beforeState.eventsJson,
      sourcePath
    );
    const movingEvents = deserializeEvents(project, [sourceEventJson]);
    const aiGeneratedEventIds = collectAiGeneratedEventIds(movingEvents);
    try {
      sourceLocation.parentList.removeEventAt(sourceLocation.index);
      placement.targetList.insertEvents(
        movingEvents,
        0,
        movingEvents.getEventsCount(),
        insertionIndex
      );
    } finally {
      movingEvents.delete();
    }

    notifyTargetEventsModified(target, aiGeneratedEventIds);
    const afterState = getCanonicalEventsState(target.rootEvents);
    const newPath = [...placement.parentPath, insertionIndex];
    const movedNode = findCanonicalNodeByPath(afterState, newPath);
    const movedEvent = movedNode
      ? {
          handle: movedNode.handle,
          path: movedNode.path,
          fingerprint: movedNode.fingerprint,
        }
      : { handle: null, path: newPath, fingerprint: null };
    return {
      moved: true,
      ...targetResponseFields(target),
      beforeEventsRevision: beforeState.eventsRevision,
      eventsRevision: afterState.eventsRevision,
      fromPath: sourcePath,
      event: movedEvent,
      validation: getPostPatchValidation(target),
      diff: makePatchDiff({
        operation: 'move',
        beforeState,
        afterState,
        details: {
          handle: request.handle,
          fromPath: sourcePath,
          toPath: movedEvent.path,
        },
      }),
    };
  };

  const updateEvent = (request: any): any => {
    const target = resolveEventsTarget(project, request);
    const beforeState = getCanonicalEventsState(target.rootEvents);
    assertExpectedEventsRevision(
      request.expectedEventsRevision,
      beforeState.eventsRevision
    );
    const path = resolveEventHandle(beforeState, request.handle);
    const targetEventJson = getSerializedEventByPath(
      beforeState.eventsJson,
      path
    );
    if (!request.eventJson || typeof request.eventJson !== 'object') {
      throw makeError('invalid_event_json');
    }
    const preserveSubevents = request.preserveSubevents !== false;
    const replacementJson = { ...request.eventJson };
    if (
      targetEventJson.aiGeneratedEventId &&
      !replacementJson.aiGeneratedEventId
    ) {
      replacementJson.aiGeneratedEventId = targetEventJson.aiGeneratedEventId;
    }
    if (preserveSubevents && Array.isArray(targetEventJson.events)) {
      replacementJson.events = targetEventJson.events;
    }

    const replacementEvents = deserializeEvents(project, [replacementJson]);
    if (replacementEvents.getEventsCount() !== 1) {
      replacementEvents.delete();
      throw makeError('invalid_event_json');
    }
    const targetLocation = getParentListAndIndex(target.rootEvents, path);
    const currentEvent = targetLocation.parentList.getEventAt(
      targetLocation.index
    );
    const replacementEvent = replacementEvents.getEventAt(0);
    if (
      preserveSubevents &&
      currentEvent.canHaveSubEvents() &&
      currentEvent.getSubEvents().getEventsCount() > 0 &&
      !replacementEvent.canHaveSubEvents()
    ) {
      replacementEvents.delete();
      throw makeError('event_update_would_drop_subevents');
    }
    const aiGeneratedEventIds = collectAiGeneratedEventIds(replacementEvents);
    try {
      targetLocation.parentList.removeEventAt(targetLocation.index);
      targetLocation.parentList.insertEvents(
        replacementEvents,
        0,
        1,
        targetLocation.index
      );
    } finally {
      replacementEvents.delete();
    }

    notifyTargetEventsModified(target, aiGeneratedEventIds);
    const afterState = getCanonicalEventsState(target.rootEvents);
    const updatedNode = findCanonicalNodeByPath(afterState, path);
    const updatedEvent = updatedNode
      ? {
          handle: updatedNode.handle,
          path: updatedNode.path,
          fingerprint: updatedNode.fingerprint,
        }
      : { handle: null, path, fingerprint: null };
    return {
      updated: true,
      ...targetResponseFields(target),
      beforeEventsRevision: beforeState.eventsRevision,
      eventsRevision: afterState.eventsRevision,
      event: updatedEvent,
      validation: getPostPatchValidation(target),
      diff: makePatchDiff({
        operation: 'update',
        beforeState,
        afterState,
        details: {
          handle: request.handle,
          path: updatedEvent.path,
          preserveSubevents,
        },
      }),
    };
  };

  const applyEventsJson = (request: any): any => {
    const target = resolveEventsTarget(project, request);
    const mode = request.mode === 'append' ? 'append' : 'replace';
    const incomingEvents = deserializeEvents(project, request.eventsJson);
    const targetEvents = target.rootEvents;
    const beforeCount = targetEvents.getEventsCount();
    const incomingCount = incomingEvents.getEventsCount();

    try {
      if (mode === 'replace') {
        unserializeFromJSObject(
          targetEvents,
          request.eventsJson,
          'unserializeFrom',
          project
        );
      } else if (incomingCount > 0) {
        targetEvents.insertEvents(
          incomingEvents,
          0,
          incomingCount,
          targetEvents.getEventsCount()
        );
      }
    } finally {
      incomingEvents.delete();
    }

    notifyTargetEventsModified(target, new Set());

    return {
      applied: true,
      ...targetResponseFields(target),
      mode,
      beforeCount,
      incomingCount,
      afterCount: targetEvents.getEventsCount(),
    };
  };

  return {
    readEventsJson,
    insertEvents,
    deleteEvent,
    moveEvent,
    updateEvent,
    applyEventsJson,
    // Compatibility aliases for renderer callers/tests written before event
    // targets were generalized beyond scenes.
    readSceneEventsJson: readEventsJson,
    insertSceneEvents: insertEvents,
    deleteSceneEvent: deleteEvent,
    moveSceneEvent: moveEvent,
    updateSceneEvent: updateEvent,
    applySceneEventsJson: applyEventsJson,
  };
};
