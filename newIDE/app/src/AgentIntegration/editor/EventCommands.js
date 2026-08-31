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
    name: 'events.apply',
    description:
      'Replace or append canonical serialized events in a live scene and refresh the open Events Sheet.',
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
