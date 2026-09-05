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
  });

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

const getCanonicalSceneEventsState = (scene: gdLayout) => {
  const eventsJson = serializeToJSObject(scene.getEvents(), 'serializeTo', {
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
      'The scene event tree changed since it was read.',
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
  const exact = canonicalState.flatEvents.find(event => event.handle === handle);
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
    if (!Array.isArray(currentEvents) || index < 0 || index >= currentEvents.length) {
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

const isPathPrefix = (
  prefix: Array<number>,
  path: Array<number>
): boolean =>
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
}: {|
  project: gdProject,
  diagnosticsTools?: ?any,
  triggerUnsavedChanges: () => void,
  onSceneEventsModifiedOutsideEditor: (changes: any) => void,
|}): any => {
  const getPostPatchValidation = (sceneName: string) => {
    if (!diagnosticsTools) return { ok: true, issues: [] };
    const diagnostics = diagnosticsTools.inspect({
      includeNativeReport: false,
      includeAssets: false,
    });
    const issues = (diagnostics.issues || []).filter(issue => {
      if (!issue || issue.category !== 'events-validation') return false;
      const locationName = issue.details && issue.details.locationName;
      return locationName === sceneName || issue.sceneName === sceneName;
    });
    return {
      ok: !issues.some(issue => issue.severity === 'error'),
      issues,
    };
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

  const readSceneEventsJson = (request: any): any => {
    const sceneName =
      typeof request.sceneName === 'string' ? request.sceneName : '';
    const scene = requireScene(project, sceneName);
    const canonicalState = getCanonicalSceneEventsState(scene);
    return {
      sceneName,
      eventsJson: canonicalState.eventsJson,
      eventsCount: scene.getEvents().getEventsCount(),
      eventsRevision: canonicalState.eventsRevision,
      events: canonicalState.events,
    };
  };

  const insertSceneEvents = (request: any): any => {
    const sceneName =
      typeof request.sceneName === 'string' ? request.sceneName : '';
    const scene = requireScene(project, sceneName);
    const beforeState = getCanonicalSceneEventsState(scene);
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
    const rootEvents = scene.getEvents();
    const placement = resolveInsertionLocation({
      rootEvents,
      canonicalState: beforeState,
      parentHandle: request.parentHandle,
      beforeHandle: request.beforeHandle,
      afterHandle: request.afterHandle,
    });
    const { targetList, insertionIndex, parentPath } = placement;

    try {
      targetList.insertEvents(
        incomingEvents,
        0,
        incomingCount,
        insertionIndex
      );
    } finally {
      incomingEvents.delete();
    }

    triggerUnsavedChanges();
    onSceneEventsModifiedOutsideEditor({
      scene,
      newOrChangedAiGeneratedEventIds: aiGeneratedEventIds,
    });

    const afterState = getCanonicalSceneEventsState(scene);
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
      sceneName,
      beforeEventsRevision: beforeState.eventsRevision,
      eventsRevision: afterState.eventsRevision,
      events: inserted,
      validation: getPostPatchValidation(sceneName),
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

  const deleteSceneEvent = (request: any): any => {
    const sceneName =
      typeof request.sceneName === 'string' ? request.sceneName : '';
    const scene = requireScene(project, sceneName);
    const beforeState = getCanonicalSceneEventsState(scene);
    assertExpectedEventsRevision(
      request.expectedEventsRevision,
      beforeState.eventsRevision
    );
    const path = resolveEventHandle(beforeState, request.handle);
    const { parentList, index } = getParentListAndIndex(
      scene.getEvents(),
      path
    );
    const deletedNode = findCanonicalNodeByPath(beforeState, path);
    parentList.removeEventAt(index);

    triggerUnsavedChanges();
    onSceneEventsModifiedOutsideEditor({
      scene,
      newOrChangedAiGeneratedEventIds: new Set(),
    });
    const afterState = getCanonicalSceneEventsState(scene);
    const deletedEvent = deletedNode
      ? {
          handle: deletedNode.handle,
          path: deletedNode.path,
          fingerprint: deletedNode.fingerprint,
        }
      : { handle: request.handle, path, fingerprint: null };
    return {
      deleted: true,
      sceneName,
      deletedEvent,
      beforeEventsRevision: beforeState.eventsRevision,
      eventsRevision: afterState.eventsRevision,
      validation: getPostPatchValidation(sceneName),
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

  const moveSceneEvent = (request: any): any => {
    const sceneName =
      typeof request.sceneName === 'string' ? request.sceneName : '';
    const scene = requireScene(project, sceneName);
    const beforeState = getCanonicalSceneEventsState(scene);
    assertExpectedEventsRevision(
      request.expectedEventsRevision,
      beforeState.eventsRevision
    );
    const rootEvents = scene.getEvents();
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

    triggerUnsavedChanges();
    onSceneEventsModifiedOutsideEditor({
      scene,
      newOrChangedAiGeneratedEventIds: aiGeneratedEventIds,
    });
    const afterState = getCanonicalSceneEventsState(scene);
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
      sceneName,
      beforeEventsRevision: beforeState.eventsRevision,
      eventsRevision: afterState.eventsRevision,
      fromPath: sourcePath,
      event: movedEvent,
      validation: getPostPatchValidation(sceneName),
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

  const updateSceneEvent = (request: any): any => {
    const sceneName =
      typeof request.sceneName === 'string' ? request.sceneName : '';
    const scene = requireScene(project, sceneName);
    const beforeState = getCanonicalSceneEventsState(scene);
    assertExpectedEventsRevision(
      request.expectedEventsRevision,
      beforeState.eventsRevision
    );
    const path = resolveEventHandle(beforeState, request.handle);
    const targetEventJson = getSerializedEventByPath(beforeState.eventsJson, path);
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
    const targetLocation = getParentListAndIndex(scene.getEvents(), path);
    const currentEvent = targetLocation.parentList.getEventAt(targetLocation.index);
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

    triggerUnsavedChanges();
    onSceneEventsModifiedOutsideEditor({
      scene,
      newOrChangedAiGeneratedEventIds: aiGeneratedEventIds,
    });
    const afterState = getCanonicalSceneEventsState(scene);
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
      sceneName,
      beforeEventsRevision: beforeState.eventsRevision,
      eventsRevision: afterState.eventsRevision,
      event: updatedEvent,
      validation: getPostPatchValidation(sceneName),
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

  const applySceneEventsJson = (request: any): any => {
    const sceneName =
      typeof request.sceneName === 'string' ? request.sceneName : '';
    const scene = requireScene(project, sceneName);
    const mode = request.mode === 'append' ? 'append' : 'replace';
    const incomingEvents = deserializeEvents(project, request.eventsJson);
    const targetEvents = scene.getEvents();
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

    triggerUnsavedChanges();
    onSceneEventsModifiedOutsideEditor({
      scene,
      newOrChangedAiGeneratedEventIds: new Set(),
    });

    return {
      applied: true,
      sceneName,
      mode,
      beforeCount,
      incomingCount,
      afterCount: targetEvents.getEventsCount(),
    };
  };

  return {
    readSceneEventsJson,
    insertSceneEvents,
    deleteSceneEvent,
    moveSceneEvent,
    updateSceneEvent,
    applySceneEventsJson,
  };
};
