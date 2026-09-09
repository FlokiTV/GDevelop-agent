// @flow
import { AgentError } from '../core/AgentError';
import { shouldHideExtension } from '../../Version';

const gd: libGDevelop = global.gd;

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

const toArray = (vector: any): Array<any> => {
  if (!vector || typeof vector.size !== 'function') return [];
  return Array.from({ length: vector.size() }, (_, index) => vector.at(index));
};

const setStringToArray = (set: any): Array<string> => {
  if (!set || typeof set.toNewVectorString !== 'function') return [];
  // Follow the existing GDevelop.js binding usage: this temporary VectorString
  // is converted immediately and must not be explicitly deleted here.
  return set.toNewVectorString().toJSArray();
};

const normalizeText = (value: any): string =>
  String(value == null ? '' : value)
    .toLowerCase()
    .replace(/[^a-z0-9_:.-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const textMatches = (haystack: string, query: any): boolean => {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) return true;
  const normalizedHaystack = normalizeText(haystack);
  return normalizedQuery
    .split(' ')
    .filter(Boolean)
    .every(term => normalizedHaystack.includes(term));
};

const normalizePagination = (input: any = {}) => {
  const rawLimit = Number(input.limit);
  const rawOffset = Number(input.offset);
  return {
    limit: Number.isFinite(rawLimit)
      ? Math.min(MAX_LIMIT, Math.max(1, Math.round(rawLimit)))
      : DEFAULT_LIMIT,
    offset: Number.isFinite(rawOffset) ? Math.max(0, Math.round(rawOffset)) : 0,
  };
};

const paginate = (items: Array<any>, input: any = {}) => {
  const { limit, offset } = normalizePagination(input);
  const selected = items.slice(offset, offset + limit);
  const nextOffset =
    offset + selected.length < items.length ? offset + selected.length : null;
  return {
    items: selected,
    total: items.length,
    offset,
    limit,
    nextOffset,
  };
};

const normalizeDeprecatedFilter = (
  value: any
): 'exclude' | 'include' | 'only' =>
  value === 'include' || value === 'only' ? value : 'exclude';

const matchesDeprecatedFilter = (
  deprecated: boolean,
  filter: 'exclude' | 'include' | 'only'
): boolean => {
  if (filter === 'include') return true;
  if (filter === 'only') return deprecated;
  return !deprecated;
};

const getExtensionSummary = (extension: gdPlatformExtension) => ({
  name: extension.getName(),
  namespace: extension.getNameSpace(),
  fullName: extension.getFullName(),
  description: extension.getDescription(),
  shortDescription: extension.getShortDescription(),
  category: extension.getCategory(),
  dimension: extension.getDimension(),
  author: extension.getAuthor(),
  license: extension.getLicense(),
  helpPath: extension.getHelpPath(),
  iconUrl: extension.getIconUrl(),
  tags: extension.getTags().toJSArray(),
  deprecated: extension.isDeprecated(),
  deprecationVersion: extension.isDeprecated()
    ? extension.getDeprecationGDVersion()
    : null,
});

const getAllowedValues = (extraInfo: string): Array<any> => {
  const trimmed = String(extraInfo || '').trim();
  if (!trimmed || trimmed[0] !== '[') return [];
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed)
      ? parsed.filter(
          value =>
            value === null ||
            typeof value === 'string' ||
            typeof value === 'number' ||
            typeof value === 'boolean'
        )
      : [];
  } catch (error) {
    return [];
  }
};

export const serializeParameterMetadata = (
  parameter: gdParameterMetadata,
  index: number
): any => {
  const valueType = parameter.getValueTypeMetadata();
  const extraInfo = parameter.getExtraInfo();
  const allowedValues = getAllowedValues(extraInfo);
  const serialized = {
    index,
    name: parameter.getName() || null,
    type: parameter.getType(),
    description: parameter.getDescription() || null,
    longDescription: parameter.getLongDescription() || null,
    hint: parameter.getHint() || null,
    optional: parameter.isOptional(),
    codeOnly: parameter.isCodeOnly(),
    defaultValue: parameter.getDefaultValue(),
    extraInfo: extraInfo || null,
    valueType: {
      name: valueType.getName(),
      extraInfo: valueType.getExtraInfo() || null,
      optional: valueType.isOptional(),
      defaultValue: valueType.getDefaultValue(),
      object: valueType.isObject(),
      behavior: valueType.isBehavior(),
      number: valueType.isNumber(),
      string: valueType.isString(),
      variable: valueType.isVariable(),
      resource: valueType.isResource(),
    },
  };
  return allowedValues.length ? { ...serialized, allowedValues } : serialized;
};

const serializeParameters = (metadata: any): Array<any> =>
  Array.from({ length: metadata.getParametersCount() }, (_, index) =>
    serializeParameterMetadata(metadata.getParameter(index), index)
  );

const getRequirementsFromParameters = (parameters: Array<any>) => {
  const objectTypes = new Set();
  const behaviorTypes = new Set();
  const resourceTypes = new Set();
  parameters.forEach(parameter => {
    const extraInfo = parameter.extraInfo;
    if (parameter.valueType.object && extraInfo) objectTypes.add(extraInfo);
    if (parameter.valueType.behavior && extraInfo) behaviorTypes.add(extraInfo);
    if (parameter.valueType.resource && extraInfo) resourceTypes.add(extraInfo);
  });
  return {
    objectTypes: [...objectTypes],
    behaviorTypes: [...behaviorTypes],
    resourceTypes: [...resourceTypes],
  };
};

const serializeProperty = (
  name: string,
  property: gdPropertyDescriptor
): any => {
  const choices = toArray(property.getChoices()).map(choice => ({
    value: choice.getValue(),
    label: choice.getLabel(),
  }));
  const measurementUnit = property.getMeasurementUnit();
  return {
    name,
    type: property.getType(),
    defaultValue: property.getValue(),
    label: property.getLabel() || null,
    description: property.getDescription() || null,
    group: property.getGroup() || null,
    choices,
    extraInfo: property.getExtraInfo().toJSArray(),
    hidden: property.isHidden(),
    deprecated: property.isDeprecated(),
    advanced: property.isAdvanced(),
    impactsOtherProperties: property.hasImpactOnOtherProperties(),
    measurementUnit: measurementUnit.isUndefined()
      ? null
      : {
          name: measurementUnit.getName(),
          label: measurementUnit.getLabel(),
          description: measurementUnit.getDescription(),
        },
  };
};

const serializePropertyMap = (
  properties: gdMapStringPropertyDescriptor
): Array<any> =>
  properties
    .keys()
    .toJSArray()
    .sort((left, right) => left.localeCompare(right))
    .map(name => serializeProperty(name, properties.get(name)));

const makeScope = ({
  objectType,
  behaviorType,
}: {|
  objectType?: ?string,
  behaviorType?: ?string,
|} = {}) =>
  objectType
    ? { kind: 'object', objectType }
    : behaviorType
    ? { kind: 'behavior', behaviorType }
    : { kind: 'free' };

const makeInstructionRecord = ({
  kind,
  type,
  metadata,
  extension,
  objectType,
  behaviorType,
}: {|
  kind: 'action' | 'condition',
  type: string,
  metadata: gdInstructionMetadata,
  extension: gdPlatformExtension,
  objectType?: ?string,
  behaviorType?: ?string,
|}) => {
  const parameters = serializeParameters(metadata);
  const deprecationMessage = metadata.getDeprecationMessage();
  return {
    kind,
    id: type,
    displayName: metadata.getFullName(),
    description: metadata.getDescription(),
    sentence: metadata.getSentence(),
    group: metadata.getGroup() || null,
    helpPath: metadata.getHelpPath() || null,
    icon: metadata.getIconFilename() || null,
    smallIcon: metadata.getSmallIconFilename() || null,
    hidden: metadata.isHidden(),
    private: metadata.isPrivate(),
    deprecated: !!deprecationMessage,
    deprecationMessage: deprecationMessage || null,
    async: metadata.isAsync(),
    optionallyAsync: metadata.isOptionallyAsync(),
    canHaveSubInstructions: metadata.canHaveSubInstructions(),
    usageComplexity: metadata.getUsageComplexity(),
    hint: metadata.getHint() || null,
    scope: makeScope({ objectType, behaviorType }),
    extension: getExtensionSummary(extension),
    parameters,
    requirements: getRequirementsFromParameters(parameters),
    eventContexts: {
      scene: metadata.isRelevantForLayoutEvents(),
      function: metadata.isRelevantForFunctionEvents(),
      asynchronousFunction: metadata.isRelevantForAsynchronousFunctionEvents(),
      customObject: metadata.isRelevantForCustomObjectEvents(),
    },
  };
};

const makeExpressionRecord = ({
  type,
  metadata,
  extension,
  objectType,
  behaviorType,
}: {|
  type: string,
  metadata: gdExpressionMetadata,
  extension: gdPlatformExtension,
  objectType?: ?string,
  behaviorType?: ?string,
|}) => {
  const parameters = serializeParameters(metadata);
  const deprecationMessage = metadata.getDeprecationMessage();
  return {
    kind: 'expression',
    id: type,
    displayName: metadata.getFullName(),
    description: metadata.getDescription(),
    group: metadata.getGroup() || null,
    helpPath: metadata.getHelpPath() || null,
    smallIcon: metadata.getSmallIconFilename() || null,
    returnType: metadata.getReturnType(),
    hidden: !metadata.isShown(),
    private: metadata.isPrivate(),
    deprecated: metadata.isDeprecated() || !!deprecationMessage,
    deprecationMessage: deprecationMessage || null,
    scope: makeScope({ objectType, behaviorType }),
    extension: getExtensionSummary(extension),
    parameters,
    requirements: getRequirementsFromParameters(parameters),
    eventContexts: {
      scene: metadata.isRelevantForLayoutEvents(),
      function: metadata.isRelevantForFunctionEvents(),
      asynchronousFunction: metadata.isRelevantForAsynchronousFunctionEvents(),
      customObject: metadata.isRelevantForCustomObjectEvents(),
    },
  };
};

const instructionKey = (record: any): string =>
  [
    record.kind,
    record.id,
    record.extension.name,
    record.scope.kind,
    record.scope.objectType || '',
    record.scope.behaviorType || '',
  ].join('|');

const collectMap = ({
  target,
  kind,
  metadataMap,
  extension,
  objectType,
  behaviorType,
}: any) => {
  metadataMap
    .keys()
    .toJSArray()
    .forEach(type => {
      const metadata = metadataMap.get(type);
      const record =
        kind === 'expression'
          ? makeExpressionRecord({
              type,
              metadata,
              extension,
              objectType,
              behaviorType,
            })
          : makeInstructionRecord({
              kind,
              type,
              metadata,
              extension,
              objectType,
              behaviorType,
            });
      target.set(instructionKey(record), record);
    });
};

const collectInstructionCatalog = (project: gdProject): Array<any> => {
  const records: Map<string, any> = new Map();
  const extensions = gd
    .asPlatform(gd.JsPlatform.get())
    .getAllPlatformExtensions();

  for (
    let extensionIndex = 0;
    extensionIndex < extensions.size();
    extensionIndex++
  ) {
    const extension = extensions.at(extensionIndex);
    if (shouldHideExtension(project, extension)) continue;

    collectMap({
      target: records,
      kind: 'action',
      metadataMap: extension.getAllActions(),
      extension,
    });
    collectMap({
      target: records,
      kind: 'condition',
      metadataMap: extension.getAllConditions(),
      extension,
    });
    collectMap({
      target: records,
      kind: 'expression',
      metadataMap: extension.getAllExpressions(),
      extension,
    });
    collectMap({
      target: records,
      kind: 'expression',
      metadataMap: extension.getAllStrExpressions(),
      extension,
    });

    extension
      .getExtensionObjectsTypes()
      .toJSArray()
      .forEach(objectType => {
        const objectMetadata = extension.getObjectMetadata(objectType);
        if (gd.MetadataProvider.isBadObjectMetadata(objectMetadata)) return;
        collectMap({
          target: records,
          kind: 'action',
          metadataMap: objectMetadata.getAllActions(),
          extension,
          objectType,
        });
        collectMap({
          target: records,
          kind: 'condition',
          metadataMap: objectMetadata.getAllConditions(),
          extension,
          objectType,
        });
        collectMap({
          target: records,
          kind: 'expression',
          metadataMap: objectMetadata.getAllExpressions(),
          extension,
          objectType,
        });
        collectMap({
          target: records,
          kind: 'expression',
          metadataMap: objectMetadata.getAllStrExpressions(),
          extension,
          objectType,
        });
      });

    extension
      .getBehaviorsTypes()
      .toJSArray()
      .forEach(behaviorType => {
        const behaviorMetadata = extension.getBehaviorMetadata(behaviorType);
        if (gd.MetadataProvider.isBadBehaviorMetadata(behaviorMetadata)) return;
        collectMap({
          target: records,
          kind: 'action',
          metadataMap: behaviorMetadata.getAllActions(),
          extension,
          behaviorType,
        });
        collectMap({
          target: records,
          kind: 'condition',
          metadataMap: behaviorMetadata.getAllConditions(),
          extension,
          behaviorType,
        });
        collectMap({
          target: records,
          kind: 'expression',
          metadataMap: behaviorMetadata.getAllExpressions(),
          extension,
          behaviorType,
        });
        collectMap({
          target: records,
          kind: 'expression',
          metadataMap: behaviorMetadata.getAllStrExpressions(),
          extension,
          behaviorType,
        });
      });
  }

  return [...records.values()].sort((left, right) => {
    const kindOrder = left.kind.localeCompare(right.kind);
    if (kindOrder) return kindOrder;
    return left.id.localeCompare(right.id);
  });
};

const extensionMatches = (record: any, extensionFilter: any): boolean => {
  const filter = normalizeText(extensionFilter);
  if (!filter) return true;
  return [record.extension.name, record.extension.namespace]
    .map(normalizeText)
    .includes(filter);
};

const scopeMatches = (record: any, input: any): boolean => {
  if (input.objectType) {
    const objectType = String(input.objectType);
    if (
      record.scope.objectType !== objectType &&
      !record.requirements.objectTypes.includes(objectType)
    ) {
      return false;
    }
  }
  if (input.behaviorType) {
    const behaviorType = String(input.behaviorType);
    if (
      record.scope.behaviorType !== behaviorType &&
      !record.requirements.behaviorTypes.includes(behaviorType)
    ) {
      return false;
    }
  }
  return true;
};

const instructionSearchText = (record: any): string =>
  [
    record.id,
    record.displayName,
    record.description,
    record.sentence,
    record.group,
    record.extension.name,
    record.extension.namespace,
    record.extension.fullName,
    record.scope.objectType,
    record.scope.behaviorType,
    ...record.parameters.flatMap(parameter => [
      parameter.name,
      parameter.type,
      parameter.description,
      parameter.longDescription,
      parameter.extraInfo,
    ]),
  ]
    .filter(Boolean)
    .join(' ');

const filterInstructionCatalog = (
  records: Array<any>,
  input: any
): Array<any> => {
  const deprecatedFilter = normalizeDeprecatedFilter(input.deprecated);
  const kind = input.kind || 'any';
  return records.filter(record => {
    if (kind !== 'any' && record.kind !== kind) return false;
    if (record.private) return false;
    if (!input.includeHidden && record.hidden) return false;
    if (
      !matchesDeprecatedFilter(
        record.deprecated || record.extension.deprecated,
        deprecatedFilter
      )
    ) {
      return false;
    }
    if (!extensionMatches(record, input.extension)) return false;
    if (!scopeMatches(record, input)) return false;
    return textMatches(instructionSearchText(record), input.query);
  });
};

const makeObjectTypeRecord = (
  extension: gdPlatformExtension,
  type: string,
  metadata: gdObjectMetadata
): any => ({
  kind: 'object',
  type,
  name: metadata.getName(),
  fullName: metadata.getFullName(),
  description: metadata.getDescription(),
  category: metadata.getCategory() || null,
  icon: metadata.getIconFilename() || null,
  helpPath: metadata.getHelpPath() || null,
  assetStoreTag: metadata.getAssetStoreTag() || null,
  hidden: metadata.isHidden(),
  private: metadata.isPrivate(),
  renderedIn3D: metadata.isRenderedIn3D(),
  renderingMode: metadata.isRenderedIn3D() ? '3d' : '2d',
  defaultBehaviors: setStringToArray(metadata.getDefaultBehaviors()),
  extension: getExtensionSummary(extension),
  instructionCounts: {
    actions: metadata
      .getAllActions()
      .keys()
      .size(),
    conditions: metadata
      .getAllConditions()
      .keys()
      .size(),
    expressions:
      metadata
        .getAllExpressions()
        .keys()
        .size() +
      metadata
        .getAllStrExpressions()
        .keys()
        .size(),
  },
});

const makeBehaviorTypeRecord = (
  extension: gdPlatformExtension,
  type: string,
  metadata: gdBehaviorMetadata,
  detailed: boolean
): any => {
  const properties = detailed
    ? serializePropertyMap(metadata.getProperties())
    : null;
  const sharedProperties = detailed
    ? serializePropertyMap(metadata.getSharedProperties())
    : null;
  return {
    kind: 'behavior',
    type,
    name: metadata.getName(),
    fullName: metadata.getFullName(),
    defaultName: metadata.getDefaultName(),
    description: metadata.getDescription(),
    group: metadata.getGroup() || null,
    icon: metadata.getIconFilename() || null,
    helpPath: metadata.getHelpPath() || null,
    hidden: metadata.isHidden(),
    private: metadata.isPrivate(),
    objectType: metadata.getObjectType() || null,
    requiredBehaviorTypes: metadata.getRequiredBehaviorTypes().toJSArray(),
    relevantForChildObjects: metadata.isRelevantForChildObjects(),
    activatedByDefaultInEditor: metadata.isActivatedByDefaultInEditor(),
    extension: getExtensionSummary(extension),
    propertyCount: metadata
      .getProperties()
      .keys()
      .size(),
    sharedPropertyCount: metadata
      .getSharedProperties()
      .keys()
      .size(),
    ...(detailed ? { properties, sharedProperties } : {}),
    instructionCounts: {
      actions: metadata
        .getAllActions()
        .keys()
        .size(),
      conditions: metadata
        .getAllConditions()
        .keys()
        .size(),
      expressions:
        metadata
          .getAllExpressions()
          .keys()
          .size() +
        metadata
          .getAllStrExpressions()
          .keys()
          .size(),
    },
  };
};

const makeEffectTypeRecord = (
  extension: gdPlatformExtension,
  type: string,
  metadata: gdEffectMetadata,
  detailed: boolean
): any => ({
  kind: 'effect',
  type,
  name: metadata.getType(),
  fullName: metadata.getFullName(),
  description: metadata.getDescription(),
  helpPath: metadata.getHelpPath() || null,
  notWorkingForObjects: metadata.isMarkedAsNotWorkingForObjects(),
  onlyWorkingFor2D: metadata.isMarkedAsOnlyWorkingFor2D(),
  onlyWorkingFor3D: metadata.isMarkedAsOnlyWorkingFor3D(),
  unique: metadata.isMarkedAsUnique(),
  extension: getExtensionSummary(extension),
  propertyCount: metadata
    .getProperties()
    .keys()
    .size(),
  ...(detailed
    ? { properties: serializePropertyMap(metadata.getProperties()) }
    : {}),
});

const getObjectDefaultProperties = (project: gdProject, type: string): any => {
  let container = null;
  try {
    container = new gd.ObjectsContainer(gd.ObjectsContainer.Unknown);
    const object = container.insertNewObject(
      project,
      type,
      '__AgentTypeProbe__',
      0
    );
    if (!object) return { propertySchemaAvailable: false, properties: [] };
    const configuration = object.getConfiguration();
    return {
      propertySchemaAvailable: true,
      properties: serializePropertyMap(configuration.getProperties()),
      animationCount: configuration.getAnimationsCount(),
    };
  } catch (error) {
    return {
      propertySchemaAvailable: false,
      properties: [],
      propertySchemaError: String(
        (error && error.code) ||
          (error && error.message) ||
          'object_property_introspection_failed'
      ),
    };
  } finally {
    if (container) container.delete();
  }
};

const collectTypes = (
  project: gdProject,
  kind: 'object' | 'behavior' | 'effect'
) => {
  const records = [];
  const extensions = gd
    .asPlatform(gd.JsPlatform.get())
    .getAllPlatformExtensions();
  for (
    let extensionIndex = 0;
    extensionIndex < extensions.size();
    extensionIndex++
  ) {
    const extension = extensions.at(extensionIndex);
    if (shouldHideExtension(project, extension)) continue;
    if (kind === 'object') {
      extension
        .getExtensionObjectsTypes()
        .toJSArray()
        .forEach(type => {
          const metadata = extension.getObjectMetadata(type);
          if (!gd.MetadataProvider.isBadObjectMetadata(metadata)) {
            records.push(makeObjectTypeRecord(extension, type, metadata));
          }
        });
    } else if (kind === 'behavior') {
      extension
        .getBehaviorsTypes()
        .toJSArray()
        .forEach(type => {
          const metadata = extension.getBehaviorMetadata(type);
          if (!gd.MetadataProvider.isBadBehaviorMetadata(metadata)) {
            records.push(
              makeBehaviorTypeRecord(extension, type, metadata, false)
            );
          }
        });
    } else {
      extension
        .getExtensionEffectTypes()
        .toJSArray()
        .forEach(type => {
          const metadata = extension.getEffectMetadata(type);
          if (!gd.MetadataProvider.isBadEffectMetadata(metadata)) {
            records.push(
              makeEffectTypeRecord(extension, type, metadata, false)
            );
          }
        });
    }
  }
  return records.sort((left, right) => left.type.localeCompare(right.type));
};

const typeSearchText = (record: any): string =>
  [
    record.type,
    record.name,
    record.fullName,
    record.description,
    record.category,
    record.group,
    record.assetStoreTag,
    record.objectType,
    ...(record.defaultBehaviors || []),
    ...(record.requiredBehaviorTypes || []),
    record.extension.name,
    record.extension.namespace,
    record.extension.fullName,
    record.extension.description,
    ...(record.extension.tags || []),
  ]
    .filter(Boolean)
    .join(' ');

const filterTypes = (records: Array<any>, input: any): Array<any> => {
  const deprecatedFilter = normalizeDeprecatedFilter(input.deprecated);
  return records.filter(record => {
    if (record.private) return false;
    if (!input.includeHidden && record.hidden) return false;
    if (!matchesDeprecatedFilter(record.extension.deprecated, deprecatedFilter))
      return false;
    if (!extensionMatches(record, input.extension)) return false;
    if (input.renderingMode && input.renderingMode !== 'any') {
      if (
        record.kind === 'object' &&
        record.renderingMode !== input.renderingMode
      ) {
        return false;
      }
      if (record.kind === 'effect') {
        if (input.renderingMode === '2d' && record.onlyWorkingFor3D)
          return false;
        if (input.renderingMode === '3d' && record.onlyWorkingFor2D)
          return false;
      }
    }
    if (input.objectType && record.kind === 'behavior') {
      if (record.objectType && record.objectType !== input.objectType)
        return false;
    }
    return textMatches(typeSearchText(record), input.query);
  });
};

const findTypeRecord = ({
  project,
  kind,
  type,
  extensionFilter,
}: {|
  project: gdProject,
  kind: 'object' | 'behavior' | 'effect',
  type: string,
  extensionFilter?: any,
|}) => {
  const matches = collectTypes(project, kind).filter(
    record =>
      !record.private &&
      record.type === type &&
      extensionMatches(record, extensionFilter)
  );
  if (!matches.length) {
    throw new AgentError({
      code: 'metadata_type_not_found',
      message: `${kind} type not found: ${type}`,
      details: { kind, type },
    });
  }
  if (matches.length > 1) {
    throw new AgentError({
      code: 'metadata_type_ambiguous',
      message: `${kind} type is ambiguous: ${type}`,
      details: {
        kind,
        type,
        candidates: matches.map(record => ({
          type: record.type,
          extension: record.extension.name,
        })),
      },
    });
  }
  return matches[0];
};

export const createMetadataDiscoveryService = ({
  project,
}: {|
  project: gdProject,
|}) => {
  // Rebuild metadata on every request. Project EventsFunctionsExtensions and
  // installed extension metadata can change while the editor remains open.
  // Returning a stale process-local catalog would make live discovery unsafe.
  const getInstructionCatalog = () => collectInstructionCatalog(project);

  const searchInstructions = (input: any = {}) => {
    const filtered = filterInstructionCatalog(getInstructionCatalog(), input);
    return {
      ...paginate(filtered, input),
      filters: {
        kind: input.kind || 'any',
        query: input.query || '',
        extension: input.extension || null,
        objectType: input.objectType || null,
        behaviorType: input.behaviorType || null,
        deprecated: normalizeDeprecatedFilter(input.deprecated),
        includeHidden: !!input.includeHidden,
      },
    };
  };

  const describeInstruction = (input: any = {}) => {
    const id = typeof input.id === 'string' ? input.id : '';
    if (!id) throw new AgentError({ code: 'missing_metadata_instruction_id' });
    const kind = input.kind || 'any';
    const matches = getInstructionCatalog().filter(record => {
      if (record.id !== id) return false;
      if (kind !== 'any' && record.kind !== kind) return false;
      if (record.private) return false;
      if (!input.includeHidden && record.hidden) return false;
      if (!extensionMatches(record, input.extension)) return false;
      return scopeMatches(record, input);
    });
    if (!matches.length) {
      throw new AgentError({
        code: 'metadata_instruction_not_found',
        message: `Instruction/expression not found: ${id}`,
        details: { id, kind },
      });
    }
    if (matches.length > 1) {
      throw new AgentError({
        code: 'metadata_instruction_ambiguous',
        message: `Instruction/expression is ambiguous: ${id}`,
        hint:
          'Pass kind, extension, objectType or behaviorType to select one candidate.',
        details: {
          id,
          candidates: matches.map(record => ({
            kind: record.kind,
            id: record.id,
            extension: record.extension.name,
            scope: record.scope,
          })),
        },
      });
    }
    return { item: matches[0] };
  };

  const listTypes = (
    kind: 'object' | 'behavior' | 'effect',
    input: any = {}
  ) => ({
    ...paginate(filterTypes(collectTypes(project, kind), input), input),
    filters: {
      query: input.query || '',
      extension: input.extension || null,
      deprecated: normalizeDeprecatedFilter(input.deprecated),
      includeHidden: !!input.includeHidden,
      renderingMode: input.renderingMode || 'any',
      objectType: input.objectType || null,
    },
  });

  const describeType = (
    kind: 'object' | 'behavior' | 'effect',
    input: any = {}
  ) => {
    const type = typeof input.type === 'string' ? input.type : '';
    if (!type) throw new AgentError({ code: 'missing_metadata_type' });
    const summary = findTypeRecord({
      project,
      kind,
      type,
      extensionFilter: input.extension,
    });
    const extensionAndMetadata =
      kind === 'object'
        ? gd.MetadataProvider.getExtensionAndObjectMetadata(
            gd.JsPlatform.get(),
            type
          )
        : kind === 'behavior'
        ? gd.MetadataProvider.getExtensionAndBehaviorMetadata(
            gd.JsPlatform.get(),
            type
          )
        : null;
    const extension = extensionAndMetadata
      ? extensionAndMetadata.getExtension()
      : toArray(
          gd.asPlatform(gd.JsPlatform.get()).getAllPlatformExtensions()
        ).find(candidate => candidate.getName() === summary.extension.name);

    let item;
    if (kind === 'object') {
      item = {
        ...summary,
        ...getObjectDefaultProperties(project, type),
      };
    } else if (kind === 'behavior') {
      const metadata = extensionAndMetadata.getMetadata();
      item = makeBehaviorTypeRecord(extension, type, metadata, true);
    } else {
      if (!extension) {
        throw new AgentError({ code: 'metadata_extension_not_found' });
      }
      const metadata = extension.getEffectMetadata(type);
      item = makeEffectTypeRecord(extension, type, metadata, true);
    }
    return { item };
  };

  return {
    searchInstructions,
    describeInstruction,
    listObjectTypes: input => listTypes('object', input),
    describeObjectType: input => describeType('object', input),
    listBehaviorTypes: input => listTypes('behavior', input),
    describeBehaviorType: input => describeType('behavior', input),
    listEffectTypes: input => listTypes('effect', input),
    describeEffectType: input => describeType('effect', input),
  };
};

export const metadataDiscoveryInternals = {
  normalizePagination,
  getAllowedValues,
  serializePropertyMap,
  collectInstructionCatalog,
  collectTypes,
  shouldHideExtension,
};
