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
  preflightEventMutationInput,
  validateKnownJsonValue,
};
