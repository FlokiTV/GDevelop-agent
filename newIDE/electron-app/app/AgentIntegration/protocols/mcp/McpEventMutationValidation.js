const EVENT_MUTATION_COMMANDS = new Set([
  'events.insert',
  'events.update',
  'events.apply',
]);

const getJsonType = value => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
};

const makeValidationError = ({
  eventType,
  path,
  expected,
  actual,
  minimum,
  maximum,
}) => {
  const error = new Error(
    `Invalid event field ${path || '<root>'} for ${eventType || 'event'}.`
  );
  error.code = 'invalid_event_node_field';
  error.retryable = false;
  error.details = {
    eventType: eventType || null,
    path,
    expected,
    actual,
    ...(minimum !== undefined ? { minimum } : {}),
    ...(maximum !== undefined ? { maximum } : {}),
  };
  return error;
};

const validateKnownJsonValue = ({ value, schema, path, eventType }) => {
  if (!schema || typeof schema !== 'object') return;
  const expectedType = schema.type;
  const actualType = getJsonType(value);
  const numericCompatible =
    expectedType === 'number' &&
    (actualType === 'integer' || actualType === 'number');
  if (
    typeof expectedType === 'string' &&
    expectedType !== actualType &&
    !numericCompatible
  ) {
    throw makeValidationError({
      eventType,
      path: path.join('.'),
      expected: expectedType,
      actual: actualType,
    });
  }
  if (
    typeof value === 'number' &&
    Number.isFinite(schema.minimum) &&
    value < schema.minimum
  ) {
    throw makeValidationError({
      eventType,
      path: path.join('.'),
      expected: `>= ${schema.minimum}`,
      actual: value,
      minimum: schema.minimum,
    });
  }
  if (
    typeof value === 'number' &&
    Number.isFinite(schema.maximum) &&
    value > schema.maximum
  ) {
    throw makeValidationError({
      eventType,
      path: path.join('.'),
      expected: `<= ${schema.maximum}`,
      actual: value,
      maximum: schema.maximum,
    });
  }
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    schema.properties &&
    typeof schema.properties === 'object'
  ) {
    Object.keys(value).forEach(key => {
      if (!Object.prototype.hasOwnProperty.call(schema.properties, key)) return;
      validateKnownJsonValue({
        value: value[key],
        schema: schema.properties[key],
        path: [...path, key],
        eventType,
      });
    });
  }
};

const getEventType = eventJson => {
  if (!eventJson || typeof eventJson !== 'object' || Array.isArray(eventJson)) {
    return null;
  }
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

const getRootEventJsonList = (command, input) => {
  if (!EVENT_MUTATION_COMMANDS.has(command)) return [];
  if (command === 'events.update') {
    return input && input.eventJson ? [input.eventJson] : [];
  }
  return input && Array.isArray(input.eventsJson) ? input.eventsJson : [];
};

const makePatchPreflightError = (code, details = {}) => {
  const error = new Error(code);
  error.code = code;
  error.retryable = code === 'events_revision_conflict';
  error.details = details;
  return error;
};

const indexCanonicalReadState = events => {
  const eventByHandle = new Map();
  const instructionByHandle = new Map();

  const visitInstructions = (instructions, event, instructionKind) => {
    for (const instruction of Array.isArray(instructions) ? instructions : []) {
      if (instruction && typeof instruction.handle === 'string') {
        instructionByHandle.set(instruction.handle, {
          ...instruction,
          eventHandle: event.handle,
          eventPath: event.path,
          instructionKind: instruction.instructionKind || instructionKind,
        });
      }
      visitInstructions(
        instruction && instruction.children,
        event,
        (instruction && instruction.instructionKind) || instructionKind
      );
    }
  };

  const visitEvents = nodes => {
    for (const event of Array.isArray(nodes) ? nodes : []) {
      if (event && typeof event.handle === 'string') {
        eventByHandle.set(event.handle, event);
      }
      visitInstructions(event && event.conditions, event, 'condition');
      visitInstructions(
        event && event.whileConditions,
        event,
        'whileCondition'
      );
      visitInstructions(event && event.actions, event, 'action');
      visitEvents(event && event.children);
    }
  };
  visitEvents(events);
  return { eventByHandle, instructionByHandle };
};

const pathsEqual = (left, right) =>
  Array.isArray(left) &&
  Array.isArray(right) &&
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

const preflightGranularEventPatch = async ({
  input,
  rendererBridge,
  targeting = {},
}) => {
  const operation = input && input.operation;
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
    throw makePatchPreflightError('invalid_event_patch_operation');
  }
  const readInput =
    input && input.target && typeof input.target === 'object'
      ? { target: input.target }
      : { sceneName: input && input.sceneName };
  const readResult = await rendererBridge.executeCommand({
    command: 'events.read',
    input: readInput,
    ...targeting,
  });
  const readData = readResult && readResult.data ? readResult.data : {};
  const actualEventsRevision = readData.eventsRevision;
  if (
    typeof input.expectedEventsRevision !== 'string' ||
    input.expectedEventsRevision !== actualEventsRevision
  ) {
    throw makePatchPreflightError('events_revision_conflict', {
      conflictScope: 'events',
      expectedEventsRevision: input.expectedEventsRevision,
      actualEventsRevision,
      currentEventsRevision: actualEventsRevision,
    });
  }

  const { eventByHandle, instructionByHandle } = indexCanonicalReadState(
    readData.events
  );
  const requireEvent = handle => {
    const event = eventByHandle.get(handle);
    if (!event) {
      throw makePatchPreflightError('event_handle_not_found', { handle });
    }
    return event;
  };
  const requireInstruction = handle => {
    const instruction = instructionByHandle.get(handle);
    if (!instruction) {
      throw makePatchPreflightError('instruction_handle_not_found', { handle });
    }
    return instruction;
  };
  const assertSameInstructionScope = ({ source, target, handleField }) => {
    if (
      source.instructionKind !== target.instructionKind ||
      source.eventHandle !== target.eventHandle
    ) {
      throw makePatchPreflightError('instruction_placement_scope_mismatch', {
        instructionHandle: source.handle,
        [handleField]: target.handle,
        instructionKind: source.instructionKind,
        targetInstructionKind: target.instructionKind,
        eventHandle: source.eventHandle,
        targetEventHandle: target.eventHandle,
      });
    }
  };

  switch (operation.kind) {
    case 'instruction.insert': {
      const event = requireEvent(operation.eventHandle);
      for (const [field, handle] of [
        ['parentInstructionHandle', operation.parentInstructionHandle],
        ['beforeHandle', operation.beforeHandle],
        ['afterHandle', operation.afterHandle],
      ]) {
        if (typeof handle !== 'string' || !handle) continue;
        const targetInstruction = requireInstruction(handle);
        if (
          targetInstruction.eventHandle !== event.handle ||
          targetInstruction.instructionKind !== operation.instructionKind
        ) {
          throw makePatchPreflightError(
            'instruction_placement_scope_mismatch',
            {
              eventHandle: event.handle,
              instructionKind: operation.instructionKind,
              [field]: handle,
              targetEventHandle: targetInstruction.eventHandle,
              targetInstructionKind: targetInstruction.instructionKind,
            }
          );
        }
      }
      break;
    }
    case 'instruction.move': {
      const source = requireInstruction(operation.instructionHandle);
      for (const [field, handle] of [
        ['parentInstructionHandle', operation.parentInstructionHandle],
        ['beforeHandle', operation.beforeHandle],
        ['afterHandle', operation.afterHandle],
      ]) {
        if (typeof handle !== 'string' || !handle) continue;
        const targetInstruction = requireInstruction(handle);
        assertSameInstructionScope({
          source,
          target: targetInstruction,
          handleField: field,
        });
        if (
          field === 'parentInstructionHandle' &&
          Array.isArray(source.path) &&
          Array.isArray(targetInstruction.path) &&
          source.path.length <= targetInstruction.path.length &&
          pathsEqual(
            source.path,
            targetInstruction.path.slice(0, source.path.length)
          )
        ) {
          throw makePatchPreflightError(
            'invalid_instruction_move_destination',
            {
              instructionHandle: source.handle,
              parentInstructionHandle: targetInstruction.handle,
            }
          );
        }
      }
      break;
    }
    case 'instruction.delete':
    case 'instruction.parameter.update':
    case 'instruction.flags.update':
      requireInstruction(operation.instructionHandle);
      break;
    case 'event.flags.update':
    case 'event.fields.update':
      requireEvent(operation.eventHandle);
      break;
    default:
      throw makePatchPreflightError('unsupported_event_patch_operation', {
        operation: operation.kind || null,
      });
  }

  return {
    validated: true,
    validatedPatch: true,
    eventsRevision: actualEventsRevision,
    eventHandleCount: eventByHandle.size,
    instructionHandleCount: instructionByHandle.size,
  };
};

const isUnknownEventNodeError = error => {
  const code = error && error.code;
  return code === 'metadata_event_node_not_found';
};

const isMetadataUnavailableError = error => {
  const code = error && error.code;
  return code === 'no_project_open' || code === 'renderer_unavailable';
};

const preflightEventMutationInput = async ({
  command,
  input,
  rendererBridge,
  targeting = {},
}) => {
  if (command === 'events.patch') {
    return preflightGranularEventPatch({
      input,
      rendererBridge,
      targeting,
    });
  }

  const roots = getRootEventJsonList(command, input);
  if (!roots.length) return { validated: false, reason: 'not_applicable' };

  const schemaCache = new Map();
  const unknownTypes = new Set();
  let validatedNodes = 0;

  const getSchema = async eventType => {
    if (schemaCache.has(eventType)) return schemaCache.get(eventType);
    if (unknownTypes.has(eventType)) return null;
    try {
      const described = await rendererBridge.executeCommand({
        command: 'events.nodes.describe',
        input: { type: eventType },
        ...targeting,
      });
      const item = described && described.data && described.data.item;
      const schema =
        item && item.schemaAvailable && item.schema ? item.schema : null;
      schemaCache.set(eventType, schema);
      return schema;
    } catch (error) {
      if (isUnknownEventNodeError(error)) {
        unknownTypes.add(eventType);
        return null;
      }
      if (isMetadataUnavailableError(error)) {
        return null;
      }
      throw error;
    }
  };

  const visit = async eventJson => {
    if (
      !eventJson ||
      typeof eventJson !== 'object' ||
      Array.isArray(eventJson)
    ) {
      const error = new Error('Event JSON must be an object.');
      error.code = 'invalid_event_json';
      error.retryable = false;
      throw error;
    }
    const eventType = getEventType(eventJson);
    if (!eventType) {
      throw makeValidationError({
        eventType: null,
        path: 'type',
        expected: 'canonical event type string',
        actual: getJsonType(eventJson.type),
      });
    }
    const schema = await getSchema(eventType);
    if (schema) {
      validateKnownJsonValue({
        value: eventJson,
        schema,
        path: [],
        eventType,
      });
      validatedNodes++;
    }
    if (Array.isArray(eventJson.events)) {
      for (const child of eventJson.events) {
        await visit(child);
      }
    }
  };

  for (const root of roots) {
    await visit(root);
  }

  return {
    validated: validatedNodes > 0,
    validatedNodes,
    knownTypes: [...schemaCache.keys()].sort(),
    unknownTypes: [...unknownTypes].sort(),
  };
};

module.exports = {
  EVENT_MUTATION_COMMANDS,
  getEventType,
  getRootEventJsonList,
  indexCanonicalReadState,
  preflightGranularEventPatch,
  preflightEventMutationInput,
  validateKnownJsonValue,
};
