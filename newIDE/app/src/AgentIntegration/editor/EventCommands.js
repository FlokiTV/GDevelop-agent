// @flow
import { AgentError } from '../core/AgentError';
import {
  makeCommandMetadata,
  type CommandDescriptor,
} from '../core/CommandRegistry';

const READ_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['sceneName'],
  properties: { sceneName: { type: 'string', minLength: 1 } },
};

const INSERT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['sceneName', 'expectedEventsRevision', 'eventsJson'],
  properties: {
    sceneName: { type: 'string', minLength: 1 },
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
  required: ['sceneName', 'expectedEventsRevision', 'handle'],
  properties: {
    sceneName: { type: 'string', minLength: 1 },
    expectedEventsRevision: { type: 'string', minLength: 1 },
    handle: { type: 'string', minLength: 1 },
  },
};

const MOVE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['sceneName', 'expectedEventsRevision', 'handle'],
  properties: {
    sceneName: { type: 'string', minLength: 1 },
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
  required: ['sceneName', 'expectedEventsRevision', 'handle', 'eventJson'],
  properties: {
    sceneName: { type: 'string', minLength: 1 },
    expectedEventsRevision: { type: 'string', minLength: 1 },
    handle: { type: 'string', minLength: 1 },
    eventJson: { type: 'object' },
    preserveSubevents: { type: 'boolean' },
  },
};

const APPLY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['sceneName', 'eventsJson'],
  properties: {
    sceneName: { type: 'string', minLength: 1 },
    eventsJson: { type: 'array' },
    mode: { type: 'string', enum: ['replace', 'append'] },
  },
};

const assertSceneName = (sceneName: any) => {
  if (!sceneName || typeof sceneName !== 'string') {
    throw new AgentError({ code: 'scene_not_found' });
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
      'Read the canonical serialized event list for a scene in the live GDevelop project.',
    inputSchema: READ_SCHEMA,
    metadata: makeCommandMetadata({ requiresProject: true }),
    validateInput: input => assertSceneName(input.sceneName),
    execute: ({ input }) => eventTools.readSceneEventsJson(input),
  },
  {
    name: 'events.insert',
    description:
      'Insert canonical serialized events into the live event tree at root, as subevents, or before/after a stable event handle.',
    inputSchema: INSERT_SCHEMA,
    metadata: makeCommandMetadata({
      readOnly: false,
      idempotent: false,
      requiresProject: true,
      modifiesProject: true,
    }),
    validateInput: input => {
      assertSceneName(input.sceneName);
      assertEventsRevision(input.expectedEventsRevision);
      if (!Array.isArray(input.eventsJson) || input.eventsJson.length === 0) {
        throw new AgentError({ code: 'invalid_events_json' });
      }
      assertEventPlacement(input);
    },
    execute: ({ input }) => eventTools.insertSceneEvents(input),
  },
  {
    name: 'events.delete',
    description:
      'Delete one event or subevent by stable handle from the live event tree after checking the scene event revision.',
    inputSchema: DELETE_SCHEMA,
    metadata: makeCommandMetadata({
      readOnly: false,
      destructive: true,
      idempotent: false,
      requiresProject: true,
      modifiesProject: true,
    }),
    validateInput: input => {
      assertSceneName(input.sceneName);
      assertEventsRevision(input.expectedEventsRevision);
      assertEventHandle(input.handle);
    },
    execute: ({ input }) => eventTools.deleteSceneEvent(input),
  },
  {
    name: 'events.move',
    description:
      'Move one event subtree to root, into another event, or before/after another stable handle without replacing the event tree.',
    inputSchema: MOVE_SCHEMA,
    metadata: makeCommandMetadata({
      readOnly: false,
      idempotent: false,
      requiresProject: true,
      modifiesProject: true,
    }),
    validateInput: input => {
      assertSceneName(input.sceneName);
      assertEventsRevision(input.expectedEventsRevision);
      assertEventHandle(input.handle);
      assertEventPlacement(input);
    },
    execute: ({ input }) => eventTools.moveSceneEvent(input),
  },
  {
    name: 'events.update',
    description:
      'Replace only one targeted event node from canonical JSON, preserving its persistent id and subevents by default.',
    inputSchema: UPDATE_SCHEMA,
    metadata: makeCommandMetadata({
      readOnly: false,
      idempotent: false,
      requiresProject: true,
      modifiesProject: true,
    }),
    validateInput: input => {
      assertSceneName(input.sceneName);
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
    execute: ({ input }) => eventTools.updateSceneEvent(input),
  },
  {
    name: 'events.apply',
    description:
      'Explicit bulk fallback: replace or append canonical serialized events when a localized events.insert/delete/update/move operation is not suitable.',
    inputSchema: APPLY_SCHEMA,
    metadata: makeCommandMetadata({
      readOnly: false,
      idempotent: false,
      requiresProject: true,
      modifiesProject: true,
    }),
    validateInput: input => {
      assertSceneName(input.sceneName);
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
    execute: ({ input }) => eventTools.applySceneEventsJson(input),
  },
];
