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

const makeError = (code: string, message?: string): Error => {
  const error: any = new Error(message || code);
  error.code = code;
  return error;
};

const requireScene = (project: gdProject, sceneName: string): gdLayout => {
  if (!sceneName || !project.hasLayoutNamed(sceneName)) {
    throw makeError('scene_not_found');
  }
  return project.getLayout(sceneName);
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
  triggerUnsavedChanges,
  onSceneEventsModifiedOutsideEditor,
}: {|
  project: gdProject,
  triggerUnsavedChanges: () => void,
  onSceneEventsModifiedOutsideEditor: (changes: any) => void,
|}): any => {
  const readSceneEventsJson = (request: any): any => {
    const sceneName =
      typeof request.sceneName === 'string' ? request.sceneName : '';
    const scene = requireScene(project, sceneName);
    const eventsJson = serializeToJSObject(scene.getEvents(), 'serializeTo', {
      canonicalEventSerialization: true,
    });
    const canonicalIndex = createCanonicalEventIndex(eventsJson);
    return {
      sceneName,
      eventsJson,
      eventsCount: scene.getEvents().getEventsCount(),
      eventsRevision: canonicalIndex.eventsRevision,
      events: canonicalIndex.events,
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
    applySceneEventsJson,
  };
};
