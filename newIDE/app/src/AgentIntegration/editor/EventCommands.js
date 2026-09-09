// @flow
import { AgentError } from '../core/AgentError';
import {
  makeCommandMetadata,
  type CommandDescriptor,
} from '../core/CommandRegistry';

const EVENT_TARGET_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind'],
  properties: {
    kind: { type: 'string', enum: ['scene', 'extension-function'] },
    sceneName: { type: 'string', minLength: 1 },
    extensionName: { type: 'string', minLength: 1 },
    ownerKind: {
      type: 'string',
      enum: ['extension', 'behavior', 'object'],
      default: 'extension',
    },
    ownerName: { type: 'string', minLength: 1 },
    functionName: { type: 'string', minLength: 1 },
  },
};

const EVENT_TARGET_PROPERTIES = {
  // Legacy scene shorthand kept for backwards compatibility. New clients can
  // use `target` for both scene and extension-function event sheets.
  sceneName: { type: 'string', minLength: 1 },
  target: EVENT_TARGET_SCHEMA,
};

const TARGET_ANY_OF = [{ required: ['sceneName'] }, { required: ['target'] }];

const READ_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  anyOf: TARGET_ANY_OF,
  properties: {
    ...EVENT_TARGET_PROPERTIES,
    offset: { type: 'integer', minimum: 0 },
    limit: { type: 'integer', minimum: 1, maximum: 200 },
  },
};

const INSERT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['expectedEventsRevision', 'eventsJson'],
  anyOf: TARGET_ANY_OF,
  properties: {
    ...EVENT_TARGET_PROPERTIES,
    expectedEventsRevision: { type: 'string', minLength: 1 },
    eventsJson: { type: 'array', minItems: 1 },
    parentHandle: { type: 'string', minLength: 1 },
    beforeHandle: { type: 'string', minLength: 1 },
    afterHandle: { type: 'string', minLength: 1 },
  },
};

const DELETE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['expectedEventsRevision', 'handle'],
  anyOf: TARGET_ANY_OF,
  properties: {
    ...EVENT_TARGET_PROPERTIES,
    expectedEventsRevision: { type: 'string', minLength: 1 },
    handle: { type: 'string', minLength: 1 },
  },
};

const MOVE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['expectedEventsRevision', 'handle'],
  anyOf: TARGET_ANY_OF,
  properties: {
    ...EVENT_TARGET_PROPERTIES,
    expectedEventsRevision: { type: 'string', minLength: 1 },
    handle: { type: 'string', minLength: 1 },
    parentHandle: { type: 'string', minLength: 1 },
    beforeHandle: { type: 'string', minLength: 1 },
    afterHandle: { type: 'string', minLength: 1 },
  },
};

const UPDATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['expectedEventsRevision', 'handle', 'eventJson'],
  anyOf: TARGET_ANY_OF,
  properties: {
    ...EVENT_TARGET_PROPERTIES,
    expectedEventsRevision: { type: 'string', minLength: 1 },
    handle: { type: 'string', minLength: 1 },
    eventJson: { type: 'object' },
    preserveSubevents: { type: 'boolean' },
  },
};

const APPLY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['eventsJson'],
  anyOf: TARGET_ANY_OF,
  properties: {
    ...EVENT_TARGET_PROPERTIES,
    eventsJson: { type: 'array' },
    mode: { type: 'string', enum: ['replace', 'append'] },
  },
};

const assertEventsTarget = (input: any) => {
  const hasLegacyScene =
    !!input && typeof input.sceneName === 'string' && !!input.sceneName;
  const target = input && input.target;
  const hasExplicitTarget = !!target && typeof target === 'object';
  if (hasLegacyScene && hasExplicitTarget) {
    throw new AgentError({ code: 'ambiguous_events_target' });
  }
  if (!hasLegacyScene && !hasExplicitTarget) {
    throw new AgentError({ code: 'missing_events_target' });
  }
  if (hasLegacyScene) return;

  if (target.kind === 'scene') {
    if (!target.sceneName || typeof target.sceneName !== 'string') {
      throw new AgentError({ code: 'scene_not_found' });
    }
    return;
  }
  if (target.kind !== 'extension-function') {
    throw new AgentError({
      code: 'invalid_events_target_kind',
      details: { kind: target.kind },
    });
  }
  if (
    !target.extensionName ||
    typeof target.extensionName !== 'string' ||
    !target.functionName ||
    typeof target.functionName !== 'string'
  ) {
    throw new AgentError({ code: 'invalid_extension_function_target' });
  }
  const ownerKind = target.ownerKind || 'extension';
  if (!['extension', 'behavior', 'object'].includes(ownerKind)) {
    throw new AgentError({
      code: 'invalid_events_function_owner',
      details: { ownerKind },
    });
  }
  if (
    ownerKind !== 'extension' &&
    (!target.ownerName || typeof target.ownerName !== 'string')
  ) {
    throw new AgentError({
      code: 'events_function_owner_name_required',
      details: { ownerKind },
    });
  }
};

const assertEventsRevision = (eventsRevision: any) => {
  if (!eventsRevision || typeof eventsRevision !== 'string') {
    throw new AgentError({ code: 'missing_events_revision' });
  }
};

const assertEventHandle = (handle: any) => {
  if (!handle || typeof handle !== 'string') {
    throw new AgentError({ code: 'invalid_event_handle' });
  }
};

const assertEventPlacement = (input: any) => {
  const placements = [
    input.parentHandle,
    input.beforeHandle,
    input.afterHandle,
  ].filter(value => typeof value === 'string' && value);
  if (placements.length > 1) {
    throw new AgentError({ code: 'invalid_event_placement' });
  }
};

export const createEventCommandDescriptors = ({
  eventTools,
}: {|
  eventTools: any,
|}): Array<CommandDescriptor> => [
  {
    name: 'events.read',
    description:
      'Read canonical serialized events from a live scene or a project extension function/method event sheet. Returns stable handles and an eventsRevision for localized edits.',
    inputSchema: READ_SCHEMA,
    metadata: makeCommandMetadata({ requiresProject: true }),
    validateInput: input => assertEventsTarget(input),
    execute: ({ input }) => eventTools.readEventsJson(input),
  },
  {
    name: 'events.insert',
    description:
      'Insert canonical serialized events into the targeted live event tree at root, as subevents, or before/after a stable event handle.',
    inputSchema: INSERT_SCHEMA,
    metadata: makeCommandMetadata({
      readOnly: false,
      idempotent: false,
      requiresProject: true,
      modifiesProject: true,
    }),
    validateInput: input => {
      assertEventsTarget(input);
      assertEventsRevision(input.expectedEventsRevision);
      if (!Array.isArray(input.eventsJson) || input.eventsJson.length === 0) {
        throw new AgentError({ code: 'invalid_events_json' });
      }
      assertEventPlacement(input);
    },
    execute: ({ input }) => eventTools.insertEvents(input),
  },
  {
    name: 'events.delete',
    description:
      'Delete one event or subevent by stable handle from a scene or extension-function event tree after checking its event revision.',
    inputSchema: DELETE_SCHEMA,
    metadata: makeCommandMetadata({
      readOnly: false,
      destructive: true,
      idempotent: false,
      requiresProject: true,
      modifiesProject: true,
    }),
    validateInput: input => {
      assertEventsTarget(input);
      assertEventsRevision(input.expectedEventsRevision);
      assertEventHandle(input.handle);
    },
    execute: ({ input }) => eventTools.deleteEvent(input),
  },
  {
    name: 'events.move',
    description:
      'Move one event subtree inside the targeted scene or extension-function event tree without replacing the full tree.',
    inputSchema: MOVE_SCHEMA,
    metadata: makeCommandMetadata({
      readOnly: false,
      idempotent: false,
      requiresProject: true,
      modifiesProject: true,
    }),
    validateInput: input => {
      assertEventsTarget(input);
      assertEventsRevision(input.expectedEventsRevision);
      assertEventHandle(input.handle);
      assertEventPlacement(input);
    },
    execute: ({ input }) => eventTools.moveEvent(input),
  },
  {
    name: 'events.update',
    description:
      'Replace one targeted event node from canonical JSON, preserving its persistent id and subevents by default in either scene or extension-function scope.',
    inputSchema: UPDATE_SCHEMA,
    metadata: makeCommandMetadata({
      readOnly: false,
      idempotent: false,
      requiresProject: true,
      modifiesProject: true,
    }),
    validateInput: input => {
      assertEventsTarget(input);
      assertEventsRevision(input.expectedEventsRevision);
      assertEventHandle(input.handle);
      if (!input.eventJson || typeof input.eventJson !== 'object') {
        throw new AgentError({ code: 'invalid_event_json' });
      }
      if (
        input.preserveSubevents !== undefined &&
        typeof input.preserveSubevents !== 'boolean'
      ) {
        throw new AgentError({ code: 'invalid_preserve_subevents' });
      }
    },
    execute: ({ input }) => eventTools.updateEvent(input),
  },
  {
    name: 'events.apply',
    description:
      'Explicit bulk fallback: replace or append canonical serialized events in a scene or extension-function event sheet when localized operations are not suitable.',
    inputSchema: APPLY_SCHEMA,
    metadata: makeCommandMetadata({
      readOnly: false,
      idempotent: false,
      requiresProject: true,
      modifiesProject: true,
    }),
    validateInput: input => {
      assertEventsTarget(input);
      if (!Array.isArray(input.eventsJson)) {
        throw new AgentError({ code: 'invalid_events_json' });
      }
      if (
        input.mode !== undefined &&
        input.mode !== 'replace' &&
        input.mode !== 'append'
      ) {
        throw new AgentError({ code: 'invalid_events_mode' });
      }
    },
    execute: ({ input }) => eventTools.applyEventsJson(input),
  },
];
