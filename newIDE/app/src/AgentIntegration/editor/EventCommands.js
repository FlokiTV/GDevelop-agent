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
    kind: {
      type: 'string',
      enum: ['scene', 'external-events', 'extension-function'],
    },
    sceneName: { type: 'string', minLength: 1 },
    externalEventsName: { type: 'string', minLength: 1 },
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

const EVENT_NODE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  description:
    'Canonical serialized GDevelop event node. Discover the connected-build contract with events.nodes.describe using this node type before authoring unfamiliar fields.',
  'x-gdevelop-schema-reference': {
    listTool: 'events.nodes.list',
    describeTool: 'events.nodes.describe',
    typeField: 'type',
    strategy: 'connected-build-known-fields-forward-compatible',
  },
};

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
    eventsJson: { type: 'array', minItems: 1, items: EVENT_NODE_JSON_SCHEMA },
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
    eventJson: EVENT_NODE_JSON_SCHEMA,
    preserveSubevents: { type: 'boolean' },
  },
};

const RGB_STYLE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['r', 'g', 'b'],
  properties: {
    r: { type: 'integer', minimum: 0, maximum: 255 },
    g: { type: 'integer', minimum: 0, maximum: 255 },
    b: { type: 'integer', minimum: 0, maximum: 255 },
  },
};

const STYLE_UPDATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['expectedEventsRevision', 'handle', 'style'],
  anyOf: TARGET_ANY_OF,
  properties: {
    ...EVENT_TARGET_PROPERTIES,
    expectedEventsRevision: { type: 'string', minLength: 1 },
    handle: { type: 'string', minLength: 1 },
    style: {
      type: 'object',
      additionalProperties: false,
      minProperties: 1,
      properties: {
        background: RGB_STYLE_SCHEMA,
        text: RGB_STYLE_SCHEMA,
      },
    },
  },
};

const APPLY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['eventsJson'],
  anyOf: TARGET_ANY_OF,
  properties: {
    ...EVENT_TARGET_PROPERTIES,
    eventsJson: { type: 'array', items: EVENT_NODE_JSON_SCHEMA },
    mode: { type: 'string', enum: ['replace', 'append'] },
  },
};

const getProjectedEventNodeSchema = (metadataDiscoveryService: any): any => {
  if (
    metadataDiscoveryService &&
    typeof metadataDiscoveryService.getEventNodeMutationSchema === 'function'
  ) {
    return metadataDiscoveryService.getEventNodeMutationSchema();
  }
  return EVENT_NODE_JSON_SCHEMA;
};

const makeInsertSchema = (metadataDiscoveryService: any): any => ({
  ...INSERT_SCHEMA,
  properties: {
    ...INSERT_SCHEMA.properties,
    eventsJson: {
      ...INSERT_SCHEMA.properties.eventsJson,
      items: getProjectedEventNodeSchema(metadataDiscoveryService),
    },
  },
});

const makeUpdateSchema = (metadataDiscoveryService: any): any => ({
  ...UPDATE_SCHEMA,
  properties: {
    ...UPDATE_SCHEMA.properties,
    eventJson: getProjectedEventNodeSchema(metadataDiscoveryService),
  },
});

const makeApplySchema = (metadataDiscoveryService: any): any => ({
  ...APPLY_SCHEMA,
  properties: {
    ...APPLY_SCHEMA.properties,
    eventsJson: {
      ...APPLY_SCHEMA.properties.eventsJson,
      items: getProjectedEventNodeSchema(metadataDiscoveryService),
    },
  },
});

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
  if (target.kind === 'external-events') {
    if (
      !target.externalEventsName ||
      typeof target.externalEventsName !== 'string'
    ) {
      throw new AgentError({ code: 'external_events_not_found' });
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

const assertEventJsonTree = (eventJson: any, metadataDiscoveryService: any) => {
  if (!eventJson || typeof eventJson !== 'object' || Array.isArray(eventJson)) {
    throw new AgentError({ code: 'invalid_event_json' });
  }
  if (
    metadataDiscoveryService &&
    typeof metadataDiscoveryService.validateEventNodeJson === 'function'
  ) {
    metadataDiscoveryService.validateEventNodeJson(eventJson);
  }
  if (Array.isArray(eventJson.events)) {
    eventJson.events.forEach(child =>
      assertEventJsonTree(child, metadataDiscoveryService)
    );
  }
};

const assertEventsJson = (
  eventsJson: any,
  metadataDiscoveryService: any,
  { allowEmpty = true }: {| allowEmpty?: boolean |} = {}
) => {
  if (!Array.isArray(eventsJson) || (!allowEmpty && eventsJson.length === 0)) {
    throw new AgentError({ code: 'invalid_events_json' });
  }
  eventsJson.forEach(eventJson =>
    assertEventJsonTree(eventJson, metadataDiscoveryService)
  );
};

const assertRgbStyle = (value: any, field: string) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentError({
      code: 'invalid_event_style',
      details: { field, expected: 'rgb' },
    });
  }
  const keys = Object.keys(value);
  const unsupportedKey = keys.find(key => !['r', 'g', 'b'].includes(key));
  if (unsupportedKey) {
    throw new AgentError({
      code: 'invalid_event_style',
      details: { field: `${field}.${unsupportedKey}`, expected: 'r|g|b' },
    });
  }
  ['r', 'g', 'b'].forEach(channel => {
    const channelValue = value[channel];
    if (
      !Number.isInteger(channelValue) ||
      channelValue < 0 ||
      channelValue > 255
    ) {
      throw new AgentError({
        code: 'invalid_event_style',
        details: {
          field: `${field}.${channel}`,
          expected: 'integer 0..255',
          value: channelValue,
        },
      });
    }
  });
};

const assertEventStyle = (style: any) => {
  if (!style || typeof style !== 'object' || Array.isArray(style)) {
    throw new AgentError({ code: 'invalid_event_style' });
  }
  const keys = Object.keys(style);
  if (keys.length === 0) throw new AgentError({ code: 'invalid_event_style' });
  const unsupportedKey = keys.find(
    key => !['background', 'text'].includes(key)
  );
  if (unsupportedKey) {
    throw new AgentError({
      code: 'invalid_event_style',
      details: { field: unsupportedKey, expected: 'background|text' },
    });
  }
  keys.forEach(key => assertRgbStyle(style[key], key));
};

export const createEventCommandDescriptors = ({
  eventTools,
  metadataDiscoveryService,
}: {|
  eventTools: any,
  metadataDiscoveryService?: any,
|}): Array<CommandDescriptor> => [
  {
    name: 'events.read',
    description:
      'Read canonical serialized events from a live scene, External Events sheet, or project extension function/method event sheet. Returns stable handles and an eventsRevision for localized edits.',
    inputSchema: READ_SCHEMA,
    metadata: makeCommandMetadata({ requiresProject: true }),
    validateInput: input => assertEventsTarget(input),
    execute: ({ input }) => eventTools.readEventsJson(input),
  },
  {
    name: 'events.insert',
    description:
      'Insert canonical serialized events into the targeted live event tree at root, as subevents, or before/after a stable event handle.',
    inputSchema: makeInsertSchema(metadataDiscoveryService),
    metadata: makeCommandMetadata({
      readOnly: false,
      idempotent: false,
      requiresProject: true,
      modifiesProject: true,
    }),
    validateInput: input => {
      assertEventsTarget(input);
      assertEventsRevision(input.expectedEventsRevision);
      assertEventsJson(input.eventsJson, metadataDiscoveryService, {
        allowEmpty: false,
      });
      assertEventPlacement(input);
    },
    execute: ({ input }) => eventTools.insertEvents(input),
  },
  {
    name: 'events.delete',
    description:
      'Delete one event or subevent by stable handle from a scene, External Events sheet, or extension-function event tree after checking its event revision.',
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
      'Move one event subtree inside the targeted scene, External Events sheet, or extension-function event tree without replacing the full tree.',
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
      'Replace one targeted event node from canonical JSON, preserving its persistent id and subevents by default in scene, External Events, or extension-function scope.',
    inputSchema: makeUpdateSchema(metadataDiscoveryService),
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
      assertEventJsonTree(input.eventJson, metadataDiscoveryService);
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
    name: 'events.style.update',
    description:
      'Patch only the presentation style of a supported event node (currently Group and Comment) without resending its logic or subevents.',
    inputSchema: STYLE_UPDATE_SCHEMA,
    metadata: makeCommandMetadata({
      readOnly: false,
      idempotent: true,
      requiresProject: true,
      modifiesProject: true,
    }),
    validateInput: input => {
      assertEventsTarget(input);
      assertEventsRevision(input.expectedEventsRevision);
      assertEventHandle(input.handle);
      assertEventStyle(input.style);
    },
    execute: ({ input }) => eventTools.updateEventStyle(input),
  },
  {
    name: 'events.apply',
    description:
      'Explicit bulk fallback: replace or append canonical serialized events in a scene, External Events sheet, or extension-function event sheet when localized operations are not suitable.',
    inputSchema: makeApplySchema(metadataDiscoveryService),
    metadata: makeCommandMetadata({
      readOnly: false,
      idempotent: false,
      requiresProject: true,
      modifiesProject: true,
    }),
    validateInput: input => {
      assertEventsTarget(input);
      assertEventsJson(input.eventsJson, metadataDiscoveryService);
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
