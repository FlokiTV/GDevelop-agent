// @flow
import {
  serializeToJSObject,
  unserializeFromJSObject,
} from '../Utils/Serializer';
import { makeOffsetPagination } from './core/Pagination';

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
    instructionKind,
    eventPath,
    parentPath = [],
  }: {|
    instructions: any,
    kind: 'condition' | 'action',
    instructionKind: 'condition' | 'whileCondition' | 'action',
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
          )}:list:${instructionKind}:path:${path.join('.')}`;
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
        instructionKind,
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
          instructionKind,
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
          instructionKind: 'condition',
          eventPath: path,
        }),
        whileConditions: buildInstructions({
          instructions: eventJson.whileConditions,
          kind: 'condition',
          instructionKind: 'whileCondition',
          eventPath: path,
        }),
        actions: buildInstructions({
          instructions: eventJson.actions,
          kind: 'action',
          instructionKind: 'action',
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

const flattenCanonicalInstructions = (events: Array<any>): Array<any> => {
  const flattened = [];
  const visitInstructions = ({
    instructions,
    event,
    parentInstructionHandle = null,
  }) => {
    (instructions || []).forEach(instruction => {
      flattened.push({
        ...instruction,
        eventHandle: event.handle,
        eventPath: event.path,
        parentInstructionHandle,
      });
      visitInstructions({
        instructions: instruction.children || [],
        event,
        parentInstructionHandle: instruction.handle,
      });
    });
  };
  const visitEvents = nodes => {
    (nodes || []).forEach(event => {
      visitInstructions({ instructions: event.conditions, event });
      visitInstructions({ instructions: event.whileConditions, event });
      visitInstructions({ instructions: event.actions, event });
      visitEvents(event.children || []);
    });
  };
  visitEvents(events);
  return flattened;
};

const makeError = (code: string, message?: string, details?: any): Error => {
  const error: any = new Error(message || code);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
};

const getSerializedEventType = (eventJson: any): ?string => {
  if (!eventJson || typeof eventJson !== 'object') return null;
  if (typeof eventJson.type === 'string') return eventJson.type;
  if (
    eventJson.type &&
    typeof eventJson.type === 'object' &&
    typeof eventJson.type.value === 'string'
  ) {
    return eventJson.type.value;
  }
  return null;
};

const assertRgbStyle = (value: any, field: string) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw makeError('invalid_event_style', undefined, {
      field,
      expected: 'rgb',
    });
  }
  const keys = Object.keys(value);
  const unsupportedKey = keys.find(key => !['r', 'g', 'b'].includes(key));
  if (unsupportedKey) {
    throw makeError('invalid_event_style', undefined, {
      field: `${field}.${unsupportedKey}`,
      expected: 'r|g|b',
    });
  }
  ['r', 'g', 'b'].forEach(channel => {
    const channelValue = value[channel];
    if (
      !Number.isInteger(channelValue) ||
      channelValue < 0 ||
      channelValue > 255
    ) {
      throw makeError('invalid_event_style', undefined, {
        field: `${field}.${channel}`,
        expected: 'integer 0..255',
        value: channelValue,
      });
    }
  });
};

const assertStylePatch = (style: any) => {
  if (!style || typeof style !== 'object' || Array.isArray(style)) {
    throw makeError('invalid_event_style');
  }
  const keys = Object.keys(style);
  if (keys.length === 0) throw makeError('invalid_event_style');
  const unsupportedKey = keys.find(
    key => !['background', 'text'].includes(key)
  );
  if (unsupportedKey) {
    throw makeError('invalid_event_style', undefined, {
      field: unsupportedKey,
      expected: 'background|text',
    });
  }
  keys.forEach(key => assertRgbStyle(style[key], key));
};

const getEventStyle = (eventJson: any): any => {
  const eventType = getSerializedEventType(eventJson);
  if (eventType === 'BuiltinCommonInstructions::Group') {
    return {
      background: {
        r: eventJson.colorR,
        g: eventJson.colorG,
        b: eventJson.colorB,
      },
    };
  }
  if (eventType === 'BuiltinCommonInstructions::Comment') {
    const color =
      eventJson.color && typeof eventJson.color === 'object'
        ? eventJson.color
        : {};
    return {
      background: { r: color.r, g: color.g, b: color.b },
      text: { r: color.textR, g: color.textG, b: color.textB },
    };
  }
  throw makeError('event_style_unsupported_event_type', undefined, {
    eventType,
    supportedEventTypes: [
      'BuiltinCommonInstructions::Group',
      'BuiltinCommonInstructions::Comment',
    ],
  });
};

const applyEventStylePatch = (eventJson: any, style: any): any => {
  assertStylePatch(style);
  const eventType = getSerializedEventType(eventJson);
  if (eventType === 'BuiltinCommonInstructions::Group') {
    if (style.text) {
      throw makeError('event_style_field_unsupported', undefined, {
        eventType,
        field: 'text',
        supportedFields: ['background'],
      });
    }
    return {
      ...eventJson,
      ...(style.background
        ? {
            colorR: style.background.r,
            colorG: style.background.g,
            colorB: style.background.b,
          }
        : {}),
    };
  }
  if (eventType === 'BuiltinCommonInstructions::Comment') {
    const currentColor =
      eventJson.color && typeof eventJson.color === 'object'
        ? eventJson.color
        : {};
    return {
      ...eventJson,
      color: {
        ...currentColor,
        ...(style.background
          ? {
              r: style.background.r,
              g: style.background.g,
              b: style.background.b,
            }
          : {}),
        ...(style.text
          ? {
              textR: style.text.r,
              textG: style.text.g,
              textB: style.text.b,
            }
          : {}),
      },
    };
  }
  throw makeError('event_style_unsupported_event_type', undefined, {
    eventType,
    supportedEventTypes: [
      'BuiltinCommonInstructions::Group',
      'BuiltinCommonInstructions::Comment',
    ],
  });
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
    flatInstructions: flattenCanonicalInstructions(canonicalIndex.events),
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

  if (target.kind === 'external-events') {
    const externalEventsName =
      typeof target.externalEventsName === 'string'
        ? target.externalEventsName
        : '';
    if (
      !externalEventsName ||
      !project.hasExternalEventsNamed(externalEventsName)
    ) {
      throw makeError('external_events_not_found', undefined, {
        externalEventsName,
      });
    }
    const externalEvents = project.getExternalEvents(externalEventsName);
    return {
      kind: 'external-events',
      scene: null,
      externalEvents,
      rootEvents: externalEvents.getEvents(),
      responseTarget: { kind: 'external-events', externalEventsName },
      sceneName: null,
      externalEventsName,
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
      {
        conflictScope: 'events',
        expectedEventsRevision,
        actualEventsRevision: currentEventsRevision,
        currentEventsRevision,
      }
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

const resolveInstructionHandle = (canonicalState: any, handle: any): any => {
  if (!handle || typeof handle !== 'string') {
    throw makeError('invalid_instruction_handle');
  }
  const matches = canonicalState.flatInstructions.filter(
    instruction => instruction.handle === handle
  );
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw makeError('ambiguous_instruction_handle', undefined, {
      handle,
      matches: matches.map(match => ({
        eventHandle: match.eventHandle,
        instructionKind: match.instructionKind,
        path: match.path,
      })),
    });
  }
  throw makeError('instruction_handle_not_found', undefined, { handle });
};

const getInstructionListKey = (instructionKind: string): string => {
  if (instructionKind === 'action') return 'actions';
  if (instructionKind === 'condition') return 'conditions';
  if (instructionKind === 'whileCondition') return 'whileConditions';
  throw makeError('invalid_instruction_kind', undefined, { instructionKind });
};

const getInstructionLocation = ({
  eventJson,
  instructionKind,
  path,
}: {|
  eventJson: any,
  instructionKind: string,
  path: Array<number>,
|}): {| list: Array<any>, index: number |} => {
  const key = getInstructionListKey(instructionKind);
  let list = Array.isArray(eventJson[key]) ? eventJson[key] : [];
  if (!path.length) throw makeError('invalid_instruction_path');
  for (let depth = 0; depth < path.length - 1; depth++) {
    const index = path[depth];
    if (index < 0 || index >= list.length) {
      throw makeError('instruction_path_not_found');
    }
    const instruction = list[index];
    list = Array.isArray(instruction.subInstructions)
      ? instruction.subInstructions
      : [];
  }
  const index = path[path.length - 1];
  if (index < 0 || index >= list.length) {
    throw makeError('instruction_path_not_found');
  }
  return { list, index };
};

const cloneCanonicalJson = (value: any): any =>
  JSON.parse(JSON.stringify(value));

const getSerializedInstructionType = (instructionJson: any): ?string => {
  if (!instructionJson || typeof instructionJson !== 'object') return null;
  if (typeof instructionJson.type === 'string') return instructionJson.type;
  if (
    instructionJson.type &&
    typeof instructionJson.type === 'object' &&
    typeof instructionJson.type.value === 'string'
  ) {
    return instructionJson.type.value;
  }
  return null;
};

const findCanonicalInstructionByPath = ({
  canonicalState,
  eventPath,
  instructionKind,
  path,
}: {|
  canonicalState: any,
  eventPath: Array<number>,
  instructionKind: string,
  path: Array<number>,
|}): any =>
  canonicalState.flatInstructions.find(
    instruction =>
      instruction.instructionKind === instructionKind &&
      pathsEqual(instruction.eventPath, eventPath) &&
      pathsEqual(instruction.path, path)
  ) || null;

const getInstructionListForParentPath = ({
  eventJson,
  instructionKind,
  parentPath,
}: {|
  eventJson: any,
  instructionKind: string,
  parentPath: Array<number>,
|}): Array<any> => {
  const key = getInstructionListKey(instructionKind);
  if (!Array.isArray(eventJson[key])) eventJson[key] = [];
  let list = eventJson[key];
  for (const index of parentPath) {
    if (index < 0 || index >= list.length) {
      throw makeError('instruction_path_not_found');
    }
    const instruction = list[index];
    if (!Array.isArray(instruction.subInstructions)) {
      instruction.subInstructions = [];
    }
    list = instruction.subInstructions;
  }
  return list;
};

const summarizeInstruction = (instruction: any): any =>
  instruction
    ? {
        handle: instruction.handle,
        eventHandle: instruction.eventHandle,
        eventPath: instruction.eventPath,
        instructionKind: instruction.instructionKind,
        path: instruction.path,
        type: instruction.type,
        parameters: instruction.parameters,
      }
    : null;

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
  index,
}: {|
  rootEvents: gdEventsList,
  canonicalState: any,
  parentHandle?: ?string,
  beforeHandle?: ?string,
  afterHandle?: ?string,
  index?: ?number,
|}): {|
  targetList: gdEventsList,
  insertionIndex: number,
  parentPath: Array<number>,
  targetPath: ?Array<number>,
|} => {
  const siblingHandles = [beforeHandle, afterHandle].filter(
    handle => typeof handle === 'string' && handle
  );
  if (
    siblingHandles.length > 1 ||
    (siblingHandles.length && parentHandle) ||
    (siblingHandles.length && Number.isInteger(index))
  ) {
    throw makeError('invalid_event_placement');
  }

  let targetList = rootEvents;
  let parentPath = [];
  let targetPath = null;

  if (parentHandle) {
    const parentEventPath = resolveEventHandle(canonicalState, parentHandle);
    const { parentList, index: parentIndex } = getParentListAndIndex(
      rootEvents,
      parentEventPath
    );
    const parentEvent = parentList.getEventAt(parentIndex);
    if (!parentEvent.canHaveSubEvents()) {
      throw makeError('event_cannot_have_subevents', undefined, {
        handle: parentHandle,
      });
    }
    targetList = parentEvent.getSubEvents();
    parentPath = parentEventPath;
    targetPath = parentEventPath;
  } else if (beforeHandle || afterHandle) {
    const targetHandle = beforeHandle || afterHandle;
    const siblingPath = resolveEventHandle(canonicalState, targetHandle);
    const location = getParentListAndIndex(rootEvents, siblingPath);
    return {
      targetList: location.parentList,
      insertionIndex: location.index + (afterHandle ? 1 : 0),
      parentPath: siblingPath.slice(0, -1),
      targetPath: siblingPath,
    };
  }

  const insertionIndex = Number.isInteger(index)
    ? index
    : targetList.getEventsCount();
  if (insertionIndex < 0 || insertionIndex > targetList.getEventsCount()) {
    throw makeError('event_insertion_index_out_of_range', undefined, {
      index: insertionIndex,
      minimum: 0,
      maximum: targetList.getEventsCount(),
    });
  }

  return {
    targetList,
    insertionIndex,
    parentPath,
    targetPath,
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
  metadataDiscoveryService,
  triggerUnsavedChanges,
  onSceneEventsModifiedOutsideEditor,
  forceUpdate,
}: {|
  project: gdProject,
  diagnosticsTools?: ?any,
  metadataDiscoveryService?: ?any,
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
      if (target.kind === 'external-events') {
        return (
          details.locationType === 'external-events' &&
          details.locationName === target.externalEventsName
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

  const resolveInstructionParameterIndex = ({
    instructionJson,
    instructionKind,
    parameterIndex,
    parameterName,
  }: {|
    instructionJson: any,
    instructionKind: string,
    parameterIndex?: any,
    parameterName?: any,
  |}): number => {
    const hasIndex = Number.isInteger(parameterIndex);
    const hasName = typeof parameterName === 'string' && !!parameterName;
    if (hasIndex === hasName) {
      throw makeError('invalid_instruction_parameter_selector', undefined, {
        parameterIndex,
        parameterName,
      });
    }
    const parameters = Array.isArray(instructionJson.parameters)
      ? instructionJson.parameters
      : [];
    if (hasIndex) {
      if (parameterIndex < 0 || parameterIndex >= parameters.length) {
        throw makeError('instruction_parameter_index_out_of_range', undefined, {
          parameterIndex,
          minimum: 0,
          maximum: Math.max(-1, parameters.length - 1),
        });
      }
      return parameterIndex;
    }
    if (
      !metadataDiscoveryService ||
      typeof metadataDiscoveryService.describeInstruction !== 'function'
    ) {
      throw makeError('instruction_parameter_metadata_unavailable', undefined, {
        parameterName,
      });
    }
    const instructionType = getSerializedInstructionType(instructionJson);
    if (!instructionType) {
      throw makeError('invalid_instruction_json', undefined, {
        reason: 'missing_type',
      });
    }
    const metadataKind = instructionKind === 'action' ? 'action' : 'condition';
    let item;
    try {
      const described = metadataDiscoveryService.describeInstruction({
        id: instructionType,
        kind: metadataKind,
        includeHidden: true,
      });
      item = described && described.item;
    } catch (error) {
      throw makeError(
        error && error.code === 'metadata_instruction_ambiguous'
          ? 'instruction_parameter_metadata_ambiguous'
          : 'instruction_parameter_metadata_not_found',
        undefined,
        {
          instructionType,
          instructionKind,
          parameterName,
          metadataErrorCode: error && error.code ? error.code : null,
          metadataDetails: error && error.details ? error.details : null,
        }
      );
    }
    const metadataParameters =
      item && Array.isArray(item.parameters) ? item.parameters : [];
    const matches = metadataParameters.filter(
      parameter => parameter && parameter.name === parameterName
    );
    if (matches.length !== 1) {
      throw makeError(
        matches.length
          ? 'instruction_parameter_name_ambiguous'
          : 'instruction_parameter_name_not_found',
        undefined,
        {
          instructionType,
          instructionKind,
          parameterName,
          availableParameters: metadataParameters.map(parameter => ({
            index: parameter.index,
            name: parameter.name,
          })),
        }
      );
    }
    const resolvedIndex = matches[0].index;
    if (
      !Number.isInteger(resolvedIndex) ||
      resolvedIndex < 0 ||
      resolvedIndex >= parameters.length
    ) {
      throw makeError('instruction_parameter_index_out_of_range', undefined, {
        parameterName,
        parameterIndex: resolvedIndex,
        minimum: 0,
        maximum: Math.max(-1, parameters.length - 1),
      });
    }
    return resolvedIndex;
  };

  const assertParentInstructionCanHaveChildren = ({
    instructionJson,
    instructionKind,
  }: {|
    instructionJson: any,
    instructionKind: string,
  |}) => {
    if (
      !metadataDiscoveryService ||
      typeof metadataDiscoveryService.describeInstruction !== 'function'
    ) {
      return;
    }
    const instructionType = getSerializedInstructionType(instructionJson);
    if (!instructionType) return;
    try {
      const described = metadataDiscoveryService.describeInstruction({
        id: instructionType,
        kind: instructionKind === 'action' ? 'action' : 'condition',
        includeHidden: true,
      });
      const item = described && described.item;
      if (item && item.canHaveSubInstructions === false) {
        throw makeError('instruction_cannot_have_subinstructions', undefined, {
          instructionType,
          instructionKind,
        });
      }
    } catch (error) {
      if (error && error.code === 'instruction_cannot_have_subinstructions') {
        throw error;
      }
      // Ambiguous/unavailable metadata must not make canonical editing
      // impossible. Native deserialization remains the final authority.
    }
  };

  const replacePatchedEvent = ({
    target,
    beforeState,
    eventPath,
    replacementJson,
    operation,
    details,
  }: {|
    target: any,
    beforeState: any,
    eventPath: Array<number>,
    replacementJson: any,
    operation: string,
    details?: any,
  |}): any => {
    const beforeEventJson = getSerializedEventByPath(
      beforeState.eventsJson,
      eventPath
    );
    const changed =
      JSON.stringify(beforeEventJson) !== JSON.stringify(replacementJson);
    const beforeEventNode = findCanonicalNodeByPath(beforeState, eventPath);
    if (!changed) {
      return {
        updated: false,
        changed: false,
        ...targetResponseFields(target),
        beforeEventsRevision: beforeState.eventsRevision,
        eventsRevision: beforeState.eventsRevision,
        event: beforeEventNode
          ? {
              handle: beforeEventNode.handle,
              path: beforeEventNode.path,
              fingerprint: beforeEventNode.fingerprint,
            }
          : { handle: null, path: eventPath, fingerprint: null },
        validation: getPostPatchValidation(target),
        diff: makePatchDiff({
          operation,
          beforeState,
          afterState: beforeState,
          details: { changed: false, ...(details || {}) },
        }),
      };
    }

    const replacementEvents = deserializeEvents(project, [replacementJson]);
    if (replacementEvents.getEventsCount() !== 1) {
      replacementEvents.delete();
      throw makeError('invalid_event_json');
    }
    const targetLocation = getParentListAndIndex(target.rootEvents, eventPath);
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
    const updatedNode = findCanonicalNodeByPath(afterState, eventPath);
    return {
      updated: true,
      changed: true,
      ...targetResponseFields(target),
      beforeEventsRevision: beforeState.eventsRevision,
      eventsRevision: afterState.eventsRevision,
      event: updatedNode
        ? {
            handle: updatedNode.handle,
            path: updatedNode.path,
            fingerprint: updatedNode.fingerprint,
          }
        : { handle: null, path: eventPath, fingerprint: null },
      validation: getPostPatchValidation(target),
      diff: makePatchDiff({
        operation,
        beforeState,
        afterState,
        details: { changed: true, ...(details || {}) },
      }),
      _afterState: afterState,
    };
  };

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
      pagination: makeOffsetPagination({
        offset,
        limit,
        total,
        returned: Math.max(0, end - offset),
      }),
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
      index: request.index,
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
      index: request.index,
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

  const updateEventStyle = (request: any): any => {
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
    const beforeStyle = getEventStyle(targetEventJson);
    const replacementJson = applyEventStylePatch(
      targetEventJson,
      request.style
    );
    const changed =
      JSON.stringify(replacementJson) !== JSON.stringify(targetEventJson);

    if (!changed) {
      const currentNode = findCanonicalNodeByPath(beforeState, path);
      const currentEvent = currentNode
        ? {
            handle: currentNode.handle,
            path: currentNode.path,
            fingerprint: currentNode.fingerprint,
          }
        : { handle: request.handle, path, fingerprint: null };
      return {
        updated: false,
        changed: false,
        ...targetResponseFields(target),
        beforeEventsRevision: beforeState.eventsRevision,
        eventsRevision: beforeState.eventsRevision,
        event: currentEvent,
        beforeStyle,
        afterStyle: beforeStyle,
        validation: getPostPatchValidation(target),
        diff: makePatchDiff({
          operation: 'style-update',
          beforeState,
          afterState: beforeState,
          details: {
            handle: request.handle,
            path,
            changed: false,
            beforeStyle,
            afterStyle: beforeStyle,
          },
        }),
      };
    }

    const replacementEvents = deserializeEvents(project, [replacementJson]);
    if (replacementEvents.getEventsCount() !== 1) {
      replacementEvents.delete();
      throw makeError('invalid_event_json');
    }
    const targetLocation = getParentListAndIndex(target.rootEvents, path);
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
    const afterEventJson = getSerializedEventByPath(
      afterState.eventsJson,
      path
    );
    const afterStyle = getEventStyle(afterEventJson);
    return {
      updated: true,
      changed: true,
      ...targetResponseFields(target),
      beforeEventsRevision: beforeState.eventsRevision,
      eventsRevision: afterState.eventsRevision,
      event: updatedEvent,
      beforeStyle,
      afterStyle,
      validation: getPostPatchValidation(target),
      diff: makePatchDiff({
        operation: 'style-update',
        beforeState,
        afterState,
        details: {
          handle: request.handle,
          path: updatedEvent.path,
          changed: true,
          beforeStyle,
          afterStyle,
        },
      }),
    };
  };

  const patchEvent = (request: any): any => {
    const target = resolveEventsTarget(project, request);
    const beforeState = getCanonicalEventsState(target.rootEvents);
    assertExpectedEventsRevision(
      request.expectedEventsRevision,
      beforeState.eventsRevision
    );
    const operation = request.operation;
    if (
      !operation ||
      typeof operation !== 'object' ||
      Array.isArray(operation)
    ) {
      throw makeError('invalid_event_patch_operation');
    }
    const operationKind =
      typeof operation.kind === 'string' ? operation.kind : '';

    if (operationKind === 'instruction.insert') {
      const eventPath = resolveEventHandle(beforeState, operation.eventHandle);
      const instructionKind = operation.instructionKind;
      getInstructionListKey(instructionKind);
      if (
        !operation.instructionJson ||
        typeof operation.instructionJson !== 'object' ||
        Array.isArray(operation.instructionJson) ||
        !getSerializedInstructionType(operation.instructionJson) ||
        !Array.isArray(operation.instructionJson.parameters) ||
        !Array.isArray(operation.instructionJson.subInstructions)
      ) {
        throw makeError('invalid_instruction_json');
      }

      const siblingHandles = [
        operation.beforeHandle,
        operation.afterHandle,
      ].filter(handle => typeof handle === 'string' && handle);
      if (
        siblingHandles.length > 1 ||
        (siblingHandles.length && operation.parentInstructionHandle) ||
        (siblingHandles.length && Number.isInteger(operation.index))
      ) {
        throw makeError('invalid_instruction_placement');
      }

      const replacementJson = cloneCanonicalJson(
        getSerializedEventByPath(beforeState.eventsJson, eventPath)
      );
      let parentPath = [];
      let insertionIndex;

      if (siblingHandles.length) {
        const sibling = resolveInstructionHandle(
          beforeState,
          operation.beforeHandle || operation.afterHandle
        );
        if (
          sibling.instructionKind !== instructionKind ||
          !pathsEqual(sibling.eventPath, eventPath)
        ) {
          throw makeError('instruction_placement_scope_mismatch', undefined, {
            eventHandle: operation.eventHandle,
            instructionKind,
            siblingHandle: sibling.handle,
            siblingEventHandle: sibling.eventHandle,
            siblingInstructionKind: sibling.instructionKind,
          });
        }
        parentPath = sibling.path.slice(0, -1);
        insertionIndex =
          sibling.path[sibling.path.length - 1] +
          (operation.afterHandle ? 1 : 0);
      } else if (operation.parentInstructionHandle) {
        const parentInstruction = resolveInstructionHandle(
          beforeState,
          operation.parentInstructionHandle
        );
        if (
          parentInstruction.instructionKind !== instructionKind ||
          !pathsEqual(parentInstruction.eventPath, eventPath)
        ) {
          throw makeError('instruction_placement_scope_mismatch', undefined, {
            eventHandle: operation.eventHandle,
            instructionKind,
            parentInstructionHandle: parentInstruction.handle,
            parentEventHandle: parentInstruction.eventHandle,
            parentInstructionKind: parentInstruction.instructionKind,
          });
        }
        const parentLocation = getInstructionLocation({
          eventJson: replacementJson,
          instructionKind,
          path: parentInstruction.path,
        });
        assertParentInstructionCanHaveChildren({
          instructionJson: parentLocation.list[parentLocation.index],
          instructionKind,
        });
        parentPath = parentInstruction.path;
      }

      const targetList = getInstructionListForParentPath({
        eventJson: replacementJson,
        instructionKind,
        parentPath,
      });
      if (!Number.isInteger(insertionIndex)) {
        insertionIndex = Number.isInteger(operation.index)
          ? operation.index
          : targetList.length;
      }
      if (insertionIndex < 0 || insertionIndex > targetList.length) {
        throw makeError('instruction_insertion_index_out_of_range', undefined, {
          index: insertionIndex,
          minimum: 0,
          maximum: targetList.length,
        });
      }
      targetList.splice(
        insertionIndex,
        0,
        cloneCanonicalJson(operation.instructionJson)
      );
      const insertedPath = [...parentPath, insertionIndex];
      const result = replacePatchedEvent({
        target,
        beforeState,
        eventPath,
        replacementJson,
        operation: operationKind,
        details: {
          eventHandle: operation.eventHandle,
          instructionKind,
          insertedPath,
        },
      });
      const afterState = result._afterState || beforeState;
      delete result._afterState;
      const inserted = findCanonicalInstructionByPath({
        canonicalState: afterState,
        eventPath,
        instructionKind,
        path: insertedPath,
      });
      return {
        ...result,
        inserted: !!inserted,
        instruction: summarizeInstruction(inserted),
        diff: {
          ...result.diff,
          instruction: summarizeInstruction(inserted),
        },
      };
    }

    if (operationKind === 'instruction.move') {
      const instruction = resolveInstructionHandle(
        beforeState,
        operation.instructionHandle
      );
      const eventPath = instruction.eventPath;
      const instructionKind = instruction.instructionKind;
      const replacementJson = cloneCanonicalJson(
        getSerializedEventByPath(beforeState.eventsJson, eventPath)
      );
      const siblingHandles = [
        operation.beforeHandle,
        operation.afterHandle,
      ].filter(handle => typeof handle === 'string' && handle);
      if (
        siblingHandles.length > 1 ||
        (siblingHandles.length && operation.parentInstructionHandle) ||
        (siblingHandles.length && Number.isInteger(operation.index))
      ) {
        throw makeError('invalid_instruction_placement');
      }

      let parentPath = [];
      let insertionIndex;
      if (siblingHandles.length) {
        const sibling = resolveInstructionHandle(
          beforeState,
          operation.beforeHandle || operation.afterHandle
        );
        if (
          sibling.handle === instruction.handle ||
          sibling.instructionKind !== instructionKind ||
          !pathsEqual(sibling.eventPath, eventPath)
        ) {
          throw makeError('instruction_placement_scope_mismatch', undefined, {
            instructionHandle: instruction.handle,
            siblingHandle: sibling.handle,
          });
        }
        parentPath = sibling.path.slice(0, -1);
        insertionIndex =
          sibling.path[sibling.path.length - 1] +
          (operation.afterHandle ? 1 : 0);
      } else if (operation.parentInstructionHandle) {
        const parentInstruction = resolveInstructionHandle(
          beforeState,
          operation.parentInstructionHandle
        );
        if (
          parentInstruction.handle === instruction.handle ||
          parentInstruction.instructionKind !== instructionKind ||
          !pathsEqual(parentInstruction.eventPath, eventPath)
        ) {
          throw makeError('instruction_placement_scope_mismatch', undefined, {
            instructionHandle: instruction.handle,
            parentInstructionHandle: parentInstruction.handle,
          });
        }
        const parentLocation = getInstructionLocation({
          eventJson: replacementJson,
          instructionKind,
          path: parentInstruction.path,
        });
        assertParentInstructionCanHaveChildren({
          instructionJson: parentLocation.list[parentLocation.index],
          instructionKind,
        });
        parentPath = parentInstruction.path;
      }

      if (isPathPrefix(instruction.path, parentPath)) {
        throw makeError('invalid_instruction_move_destination');
      }

      const sourceParentPath = instruction.path.slice(0, -1);
      const sourceIndex = instruction.path[instruction.path.length - 1];
      const sourceLocation = getInstructionLocation({
        eventJson: replacementJson,
        instructionKind,
        path: instruction.path,
      });
      const movingInstructionJson = cloneCanonicalJson(
        sourceLocation.list[sourceLocation.index]
      );

      const adjustParentPathAfterRemoval = pathToAdjust => {
        const adjusted = [...pathToAdjust];
        if (
          adjusted.length >= instruction.path.length &&
          pathsEqual(
            adjusted.slice(0, instruction.path.length - 1),
            sourceParentPath
          ) &&
          adjusted[instruction.path.length - 1] > sourceIndex
        ) {
          adjusted[instruction.path.length - 1]--;
        }
        return adjusted;
      };

      if (!Number.isInteger(insertionIndex)) {
        const preRemovalTargetList = getInstructionListForParentPath({
          eventJson: replacementJson,
          instructionKind,
          parentPath,
        });
        insertionIndex = Number.isInteger(operation.index)
          ? operation.index
          : preRemovalTargetList.length;
      }
      if (
        pathsEqual(sourceParentPath, parentPath) &&
        sourceIndex < insertionIndex
      ) {
        insertionIndex--;
      }
      if (
        pathsEqual(sourceParentPath, parentPath) &&
        sourceIndex === insertionIndex
      ) {
        throw makeError('instruction_move_noop');
      }

      sourceLocation.list.splice(sourceLocation.index, 1);
      const adjustedParentPath = adjustParentPathAfterRemoval(parentPath);
      const targetList = getInstructionListForParentPath({
        eventJson: replacementJson,
        instructionKind,
        parentPath: adjustedParentPath,
      });
      if (insertionIndex < 0 || insertionIndex > targetList.length) {
        throw makeError('instruction_insertion_index_out_of_range', undefined, {
          index: insertionIndex,
          minimum: 0,
          maximum: targetList.length,
        });
      }
      targetList.splice(insertionIndex, 0, movingInstructionJson);
      const movedPath = [...adjustedParentPath, insertionIndex];

      const result = replacePatchedEvent({
        target,
        beforeState,
        eventPath,
        replacementJson,
        operation: operationKind,
        details: {
          instructionHandle: instruction.handle,
          instructionKind,
          fromPath: instruction.path,
          toPath: movedPath,
        },
      });
      const afterState = result._afterState || beforeState;
      delete result._afterState;
      const movedInstruction = findCanonicalInstructionByPath({
        canonicalState: afterState,
        eventPath,
        instructionKind,
        path: movedPath,
      });
      return {
        ...result,
        moved: true,
        fromPath: instruction.path,
        instruction: summarizeInstruction(movedInstruction),
      };
    }

    if (operationKind === 'instruction.delete') {
      const instruction = resolveInstructionHandle(
        beforeState,
        operation.instructionHandle
      );
      const eventPath = instruction.eventPath;
      const replacementJson = cloneCanonicalJson(
        getSerializedEventByPath(beforeState.eventsJson, eventPath)
      );
      const location = getInstructionLocation({
        eventJson: replacementJson,
        instructionKind: instruction.instructionKind,
        path: instruction.path,
      });
      const deletedJson = cloneCanonicalJson(location.list[location.index]);
      location.list.splice(location.index, 1);
      const result = replacePatchedEvent({
        target,
        beforeState,
        eventPath,
        replacementJson,
        operation: operationKind,
        details: {
          instruction: summarizeInstruction(instruction),
          deletedType: getSerializedInstructionType(deletedJson),
        },
      });
      delete result._afterState;
      return {
        ...result,
        deleted: true,
        deletedInstruction: summarizeInstruction(instruction),
      };
    }

    if (operationKind === 'instruction.parameter.update') {
      const instruction = resolveInstructionHandle(
        beforeState,
        operation.instructionHandle
      );
      const eventPath = instruction.eventPath;
      const replacementJson = cloneCanonicalJson(
        getSerializedEventByPath(beforeState.eventsJson, eventPath)
      );
      const location = getInstructionLocation({
        eventJson: replacementJson,
        instructionKind: instruction.instructionKind,
        path: instruction.path,
      });
      const instructionJson = location.list[location.index];
      const parameterIndex = resolveInstructionParameterIndex({
        instructionJson,
        instructionKind: instruction.instructionKind,
        parameterIndex: operation.parameterIndex,
        parameterName: operation.parameterName,
      });
      if (typeof operation.value !== 'string') {
        throw makeError('invalid_instruction_parameter_value');
      }
      const beforeValue = instructionJson.parameters[parameterIndex];
      instructionJson.parameters[parameterIndex] = operation.value;
      const result = replacePatchedEvent({
        target,
        beforeState,
        eventPath,
        replacementJson,
        operation: operationKind,
        details: {
          instructionHandle: operation.instructionHandle,
          instructionKind: instruction.instructionKind,
          instructionPath: instruction.path,
          parameterIndex,
          parameterName:
            typeof operation.parameterName === 'string'
              ? operation.parameterName
              : null,
          beforeValue,
          afterValue: operation.value,
        },
      });
      const afterState = result._afterState || beforeState;
      delete result._afterState;
      const updatedInstruction = findCanonicalInstructionByPath({
        canonicalState: afterState,
        eventPath,
        instructionKind: instruction.instructionKind,
        path: instruction.path,
      });
      return {
        ...result,
        instruction: summarizeInstruction(updatedInstruction),
        parameter: {
          index: parameterIndex,
          name:
            typeof operation.parameterName === 'string'
              ? operation.parameterName
              : null,
          beforeValue,
          value: operation.value,
        },
      };
    }

    if (operationKind === 'instruction.flags.update') {
      const instruction = resolveInstructionHandle(
        beforeState,
        operation.instructionHandle
      );
      if (
        instruction.instructionKind !== 'condition' &&
        instruction.instructionKind !== 'whileCondition'
      ) {
        throw makeError('instruction_flag_unsupported', undefined, {
          instructionHandle: operation.instructionHandle,
          instructionKind: instruction.instructionKind,
          flag: 'inverted',
        });
      }
      if (typeof operation.inverted !== 'boolean') {
        throw makeError('invalid_instruction_flag_value', undefined, {
          flag: 'inverted',
        });
      }
      const eventPath = instruction.eventPath;
      const replacementJson = cloneCanonicalJson(
        getSerializedEventByPath(beforeState.eventsJson, eventPath)
      );
      const location = getInstructionLocation({
        eventJson: replacementJson,
        instructionKind: instruction.instructionKind,
        path: instruction.path,
      });
      const instructionJson = location.list[location.index];
      if (
        !instructionJson.type ||
        typeof instructionJson.type !== 'object' ||
        Array.isArray(instructionJson.type)
      ) {
        throw makeError('instruction_flag_unsupported', undefined, {
          instructionHandle: operation.instructionHandle,
          flag: 'inverted',
        });
      }
      const beforeInverted = !!instructionJson.type.inverted;
      instructionJson.type.inverted = operation.inverted;
      const result = replacePatchedEvent({
        target,
        beforeState,
        eventPath,
        replacementJson,
        operation: operationKind,
        details: {
          instructionHandle: operation.instructionHandle,
          instructionKind: instruction.instructionKind,
          instructionPath: instruction.path,
          beforeInverted,
          inverted: operation.inverted,
        },
      });
      const afterState = result._afterState || beforeState;
      delete result._afterState;
      return {
        ...result,
        instruction: summarizeInstruction(
          findCanonicalInstructionByPath({
            canonicalState: afterState,
            eventPath,
            instructionKind: instruction.instructionKind,
            path: instruction.path,
          })
        ),
        flags: {
          before: { inverted: beforeInverted },
          after: { inverted: operation.inverted },
        },
      };
    }

    if (operationKind === 'event.flags.update') {
      const eventPath = resolveEventHandle(beforeState, operation.eventHandle);
      const replacementJson = cloneCanonicalJson(
        getSerializedEventByPath(beforeState.eventsJson, eventPath)
      );
      const requestedFlags = {};
      const beforeFlags = {};
      if (operation.enabled !== undefined) {
        if (
          typeof operation.enabled !== 'boolean' ||
          !Object.prototype.hasOwnProperty.call(replacementJson, 'disabled')
        ) {
          throw makeError('event_flag_unsupported', undefined, {
            eventHandle: operation.eventHandle,
            flag: 'enabled',
          });
        }
        beforeFlags.enabled = !replacementJson.disabled;
        requestedFlags.enabled = operation.enabled;
        replacementJson.disabled = !operation.enabled;
      }
      if (operation.folded !== undefined) {
        if (
          typeof operation.folded !== 'boolean' ||
          !Object.prototype.hasOwnProperty.call(replacementJson, 'folded')
        ) {
          throw makeError('event_flag_unsupported', undefined, {
            eventHandle: operation.eventHandle,
            flag: 'folded',
          });
        }
        beforeFlags.folded = !!replacementJson.folded;
        requestedFlags.folded = operation.folded;
        replacementJson.folded = operation.folded;
      }
      if (!Object.keys(requestedFlags).length) {
        throw makeError('empty_event_flags_patch');
      }
      const result = replacePatchedEvent({
        target,
        beforeState,
        eventPath,
        replacementJson,
        operation: operationKind,
        details: {
          eventHandle: operation.eventHandle,
          beforeFlags,
          flags: requestedFlags,
        },
      });
      delete result._afterState;
      return {
        ...result,
        flags: { before: beforeFlags, after: requestedFlags },
      };
    }

    if (operationKind === 'event.fields.update') {
      const eventPath = resolveEventHandle(beforeState, operation.eventHandle);
      const replacementJson = cloneCanonicalJson(
        getSerializedEventByPath(beforeState.eventsJson, eventPath)
      );
      const fields = operation.fields;
      if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
        throw makeError('invalid_event_fields_patch');
      }
      const keys = Object.keys(fields);
      if (!keys.length) throw makeError('empty_event_fields_patch');
      const supportedFields = ['comment', 'name', 'source'];
      const unsupportedField = keys.find(
        field => !supportedFields.includes(field)
      );
      if (unsupportedField) {
        throw makeError('event_field_unsupported', undefined, {
          field: unsupportedField,
          supportedFields,
        });
      }
      const beforeFields = {};
      keys.forEach(field => {
        if (
          typeof fields[field] !== 'string' ||
          !Object.prototype.hasOwnProperty.call(replacementJson, field)
        ) {
          throw makeError('event_field_unsupported', undefined, {
            eventHandle: operation.eventHandle,
            field,
            supportedFields: supportedFields.filter(candidate =>
              Object.prototype.hasOwnProperty.call(replacementJson, candidate)
            ),
          });
        }
        beforeFields[field] = replacementJson[field];
        replacementJson[field] = fields[field];
      });
      const result = replacePatchedEvent({
        target,
        beforeState,
        eventPath,
        replacementJson,
        operation: operationKind,
        details: {
          eventHandle: operation.eventHandle,
          beforeFields,
          fields,
        },
      });
      delete result._afterState;
      return {
        ...result,
        fields: { before: beforeFields, after: fields },
      };
    }

    throw makeError('unsupported_event_patch_operation', undefined, {
      operation: operationKind,
      supportedOperations: [
        'instruction.insert',
        'instruction.move',
        'instruction.delete',
        'instruction.parameter.update',
        'instruction.flags.update',
        'event.flags.update',
        'event.fields.update',
      ],
    });
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
    updateEventStyle,
    patchEvent,
    applyEventsJson,
    // Compatibility aliases for renderer callers/tests written before event
    // targets were generalized beyond scenes.
    readSceneEventsJson: readEventsJson,
    insertSceneEvents: insertEvents,
    deleteSceneEvent: deleteEvent,
    moveSceneEvent: moveEvent,
    updateSceneEvent: updateEvent,
    updateSceneEventStyle: updateEventStyle,
    applySceneEventsJson: applyEventsJson,
  };
};
