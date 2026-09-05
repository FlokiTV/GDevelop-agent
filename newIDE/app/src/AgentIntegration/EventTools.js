// @flow
import {
  serializeToJSObject,
  unserializeFromJSObject,
} from '../Utils/Serializer';

const gd: libGDevelop = global.gd;

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
    return {
      sceneName,
      eventsJson,
      eventsCount: scene.getEvents().getEventsCount(),
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
