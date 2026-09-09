// @flow
import { AgentError } from '../core/AgentError';
import { isExtensionNameTaken } from '../../ProjectManager/EventFunctionExtensionNameVerifier';

const gd: libGDevelop = global.gd;

const toArray = (vector: any, mapper: any = value => value) => {
  const items = [];
  if (!vector || typeof vector.size !== 'function') return items;
  for (let index = 0; index < vector.size(); index++) {
    items.push(mapper(vector.at(index), index));
  }
  return items;
};

const parametersToArray = (
  container: gdParameterMetadataContainer,
  mapper: any
) => {
  const items = [];
  for (let index = 0; index < container.getParametersCount(); index++) {
    items.push(mapper(container.getParameterAt(index), index));
  }
  return items;
};

const eventsFunctionsToArray = (
  container: gdEventsFunctionsContainer,
  mapper: any
) => {
  const items = [];
  for (let index = 0; index < container.getEventsFunctionsCount(); index++) {
    items.push(mapper(container.getEventsFunctionAt(index), index));
  }
  return items;
};

const variantsToArray = (
  container: gdEventsBasedObjectVariantsContainer,
  mapper: any
) => {
  const items = [];
  for (let index = 0; index < container.getVariantsCount(); index++) {
    items.push(mapper(container.getVariantAt(index), index));
  }
  return items;
};

const stringSetToArray = (set: any): Array<string> => {
  if (!set || typeof set.toNewVectorString !== 'function') return [];
  const vector = set.toNewVectorString();
  try {
    return typeof vector.toJSArray === 'function'
      ? vector.toJSArray()
      : toArray(vector, value => String(value));
  } finally {
    if (vector && typeof vector.delete === 'function') vector.delete();
  }
};

const functionTypeToString = (eventsFunction: gdEventsFunction): string => {
  const type = eventsFunction.getFunctionType();
  if (type === gd.EventsFunction.Action) return 'action';
  if (type === gd.EventsFunction.Condition) return 'condition';
  if (type === gd.EventsFunction.Expression) return 'expression';
  if (type === gd.EventsFunction.ExpressionAndCondition)
    return 'expression-and-condition';
  if (type === gd.EventsFunction.ActionWithOperator)
    return 'action-with-operator';
  return `unknown:${String(type)}`;
};

const functionTypeFromString = (type: any): EventsFunction_FunctionType => {
  switch (type) {
    case 'action':
      return gd.EventsFunction.Action;
    case 'condition':
      return gd.EventsFunction.Condition;
    case 'expression':
      return gd.EventsFunction.Expression;
    case 'expression-and-condition':
      return gd.EventsFunction.ExpressionAndCondition;
    case 'action-with-operator':
      return gd.EventsFunction.ActionWithOperator;
    default:
      throw new AgentError({
        code: 'invalid_events_function_type',
        details: { type },
      });
  }
};

const serializeParameter = (parameter: gdParameterMetadata) => ({
  name: parameter.getName(),
  type: parameter.getType(),
  extraInfo: parameter.getExtraInfo(),
  optional: parameter.isOptional(),
  description: parameter.getDescription(),
  longDescription: parameter.getLongDescription(),
  hint: parameter.getHint(),
  codeOnly: parameter.isCodeOnly(),
  defaultValue: parameter.getDefaultValue(),
});

const serializeEventsFunction = (eventsFunction: gdEventsFunction) => {
  const parameters = eventsFunction.getParameters();
  return {
    name: eventsFunction.getName(),
    fullName: eventsFunction.getFullName(),
    description: eventsFunction.getDescription(),
    sentence: eventsFunction.getSentence(),
    group: eventsFunction.getGroup(),
    getterName: eventsFunction.getGetterName(),
    type: functionTypeToString(eventsFunction),
    private: eventsFunction.isPrivate(),
    async: eventsFunction.isAsync(),
    deprecated: eventsFunction.isDeprecated(),
    deprecationMessage: eventsFunction.getDeprecationMessage(),
    helpUrl: eventsFunction.getHelpUrl(),
    eventsCount: eventsFunction.getEvents().getEventsCount(),
    parameters: parametersToArray(parameters, parameter =>
      serializeParameter(parameter)
    ),
  };
};

const serializeBehavior = (behavior: gdEventsBasedBehavior) => ({
  name: behavior.getName(),
  fullName: behavior.getFullName(),
  description: behavior.getDescription(),
  private: behavior.isPrivate(),
  objectType: behavior.getObjectType(),
  previewIconUrl: behavior.getPreviewIconUrl(),
  iconUrl: behavior.getIconUrl(),
  helpPath: behavior.getHelpPath(),
  functions: eventsFunctionsToArray(
    behavior.getEventsFunctions(),
    eventsFunction => serializeEventsFunction(eventsFunction)
  ),
  propertyCount: behavior.getPropertyDescriptors().getCount(),
  sharedPropertyCount: behavior.getSharedPropertyDescriptors().getCount(),
});

const serializeVariant = (variant: gdEventsBasedObjectVariant) => ({
  name: variant.getName(),
  assetStoreAssetId: variant.getAssetStoreAssetId(),
  assetStoreOriginalName: variant.getAssetStoreOriginalName(),
  area: {
    minX: variant.getAreaMinX(),
    minY: variant.getAreaMinY(),
    minZ: variant.getAreaMinZ(),
    maxX: variant.getAreaMaxX(),
    maxY: variant.getAreaMaxY(),
    maxZ: variant.getAreaMaxZ(),
  },
});

const serializeObject = (object: gdEventsBasedObject) => ({
  name: object.getName(),
  fullName: object.getFullName(),
  description: object.getDescription(),
  private: object.isPrivate(),
  previewIconUrl: object.getPreviewIconUrl(),
  iconUrl: object.getIconUrl(),
  helpPath: object.getHelpPath(),
  defaultName: object.getDefaultName(),
  assetStoreTag: object.getAssetStoreTag(),
  renderedIn3D: object.isRenderedIn3D(),
  animatable: object.isAnimatable(),
  textContainer: object.isTextContainer(),
  innerAreaFollowingParentSize: object.isInnerAreaFollowingParentSize(),
  functions: eventsFunctionsToArray(
    object.getEventsFunctions(),
    eventsFunction => serializeEventsFunction(eventsFunction)
  ),
  propertyCount: object.getPropertyDescriptors().getCount(),
  variants: variantsToArray(object.getVariants(), variant =>
    serializeVariant(variant)
  ),
});

const serializeDependency = (dependency: gdDependencyMetadata) => ({
  name: dependency.getName(),
  exportName: dependency.getExportName(),
  version: dependency.getVersion(),
  dependencyType: dependency.getDependencyType(),
});

const serializeSourceFile = (sourceFile: gdSourceFileMetadata) => ({
  resourceName: sourceFile.getResourceName(),
  includePosition: sourceFile.getIncludePosition(),
});

const serializeExtension = (extension: gdEventsFunctionsExtension) => ({
  name: extension.getName(),
  namespace: extension.getNamespace(),
  version: extension.getVersion(),
  fullName: extension.getFullName(),
  shortDescription: extension.getShortDescription(),
  description: extension.getDescription(),
  dimension: extension.getDimension(),
  category: extension.getCategory(),
  author: extension.getAuthor(),
  previewIconUrl: extension.getPreviewIconUrl(),
  iconUrl: extension.getIconUrl(),
  helpPath: extension.getHelpPath(),
  origin: {
    name: extension.getOriginName(),
    identifier: extension.getOriginIdentifier(),
  },
  dependencies: toArray(extension.getAllDependencies(), dependency =>
    serializeDependency(dependency)
  ),
  sourceFiles: toArray(extension.getAllSourceFiles(), sourceFile =>
    serializeSourceFile(sourceFile)
  ),
  functions: eventsFunctionsToArray(
    extension.getEventsFunctions(),
    eventsFunction => serializeEventsFunction(eventsFunction)
  ),
  behaviors: toArray(extension.getEventsBasedBehaviors(), behavior =>
    serializeBehavior(behavior)
  ),
  objects: toArray(extension.getEventsBasedObjects(), object =>
    serializeObject(object)
  ),
});

const requireSafeIdentifier = (
  name: any,
  field: string,
  code: string = 'invalid_extension_identifier'
): string => {
  if (typeof name !== 'string' || !name.trim()) {
    throw new AgentError({ code, details: { field } });
  }
  const trimmed = name.trim();
  const safe = gd.Project.getSafeName(trimmed);
  if (!safe || safe !== trimmed) {
    throw new AgentError({
      code,
      hint: 'Use a GDevelop-safe identifier without spaces or punctuation.',
      details: { field, requested: name, safeSuggestion: safe },
    });
  }
  return safe;
};

const requireSafeName = (name: any, field: string): string => {
  if (typeof name !== 'string' || !name.trim()) {
    throw new AgentError({
      code: 'invalid_extension_name',
      details: { field },
    });
  }
  const trimmed = name.trim();
  const safe = gd.Project.getSafeName(trimmed);
  if (!safe || safe !== trimmed) {
    throw new AgentError({
      code: 'invalid_extension_name',
      hint: 'Use a GDevelop-safe identifier without spaces or punctuation.',
      details: { field, requested: name, safeSuggestion: safe },
    });
  }
  return safe;
};

type Options = {|
  project: ?gdProject,
  triggerUnsavedChanges: () => void,
  forceUpdate: () => void,
  eventsFunctionsExtensionsState?: ?any,
|};

export const createExtensionAuthoringService = ({
  project,
  triggerUnsavedChanges,
  forceUpdate,
  eventsFunctionsExtensionsState,
}: Options) => {
  const requireProject = (): gdProject => {
    if (!project) throw new AgentError({ code: 'no_project_open' });
    return project;
  };

  const requireLifecycle = () => {
    if (
      !eventsFunctionsExtensionsState ||
      typeof eventsFunctionsExtensionsState.reloadProjectEventsFunctionsExtensions !==
        'function'
    ) {
      throw new AgentError({
        code: 'extension_lifecycle_unavailable',
        recovery: 'Retry from the full GDevelop editor integration.',
      });
    }
    return eventsFunctionsExtensionsState;
  };

  const requireExtension = (name: any): gdEventsFunctionsExtension => {
    const currentProject = requireProject();
    if (
      typeof name !== 'string' ||
      !name ||
      !currentProject.hasEventsFunctionsExtensionNamed(name)
    ) {
      throw new AgentError({
        code: 'project_extension_not_found',
        details: { name },
      });
    }
    return currentProject.getEventsFunctionsExtension(name);
  };

  const requireFunctionOwner = ({
    extensionName,
    ownerKind = 'extension',
    ownerName,
  }: any) => {
    const extension = requireExtension(extensionName);
    if (ownerKind === 'extension') {
      return {
        extension,
        ownerKind,
        ownerName: null,
        behavior: null,
        object: null,
        container: extension.getEventsFunctions(),
      };
    }
    if (ownerKind === 'behavior') {
      const behaviors = extension.getEventsBasedBehaviors();
      if (
        typeof ownerName !== 'string' ||
        !ownerName ||
        !behaviors.has(ownerName)
      ) {
        throw new AgentError({
          code: 'events_based_behavior_not_found',
          details: { extensionName, ownerName },
        });
      }
      const behavior = behaviors.get(ownerName);
      return {
        extension,
        ownerKind,
        ownerName,
        behavior,
        object: null,
        container: behavior.getEventsFunctions(),
      };
    }
    if (ownerKind === 'object') {
      const objects = extension.getEventsBasedObjects();
      if (
        typeof ownerName !== 'string' ||
        !ownerName ||
        !objects.has(ownerName)
      ) {
        throw new AgentError({
          code: 'events_based_object_not_found',
          details: { extensionName, ownerName },
        });
      }
      const object = objects.get(ownerName);
      return {
        extension,
        ownerKind,
        ownerName,
        behavior: null,
        object,
        container: object.getEventsFunctions(),
      };
    }
    throw new AgentError({
      code: 'invalid_events_function_owner',
      details: { ownerKind },
    });
  };

  const requireEventsFunction = (input: any) => {
    const owner = requireFunctionOwner(input);
    const name = input && input.name;
    if (
      typeof name !== 'string' ||
      !name ||
      !owner.container.hasEventsFunctionNamed(name)
    ) {
      throw new AgentError({
        code: 'events_function_not_found',
        details: {
          extensionName: input && input.extensionName,
          ownerKind: owner.ownerKind,
          ownerName: owner.ownerName,
          name,
        },
      });
    }
    return {
      ...owner,
      eventsFunction: owner.container.getEventsFunction(name),
    };
  };

  const isLifecycleFunction = (
    owner: any,
    eventsFunction: gdEventsFunction
  ) => {
    const name = eventsFunction.getName();
    if (owner.ownerKind === 'behavior') {
      return gd.MetadataDeclarationHelper.isBehaviorLifecycleEventsFunction(
        name
      );
    }
    if (owner.ownerKind === 'object') {
      return gd.MetadataDeclarationHelper.isObjectLifecycleEventsFunction(name);
    }
    return gd.MetadataDeclarationHelper.isExtensionLifecycleEventsFunction(
      name
    );
  };

  const firstEditableParameterIndex = (owner: any): number => {
    if (owner.ownerKind === 'behavior') return 2;
    if (owner.ownerKind === 'object') return 1;
    return 0;
  };

  const assertParameterMutable = (
    owner: any,
    eventsFunction: gdEventsFunction,
    parameterIndex?: ?number
  ) => {
    if (
      eventsFunction.getFunctionType() === gd.EventsFunction.ActionWithOperator
    ) {
      throw new AgentError({ code: 'events_function_parameters_frozen' });
    }
    if (
      owner.ownerKind !== 'extension' &&
      isLifecycleFunction(owner, eventsFunction)
    ) {
      throw new AgentError({
        code: 'events_function_parameters_frozen',
        details: { reason: 'lifecycle_function' },
      });
    }
    if (
      parameterIndex !== undefined &&
      parameterIndex !== null &&
      parameterIndex < firstEditableParameterIndex(owner)
    ) {
      throw new AgentError({
        code: 'events_function_parameter_required',
        details: {
          parameterIndex,
          firstEditableParameterIndex: firstEditableParameterIndex(owner),
        },
      });
    }
  };

  const withFunctionScopedContainers = (
    owner: any,
    eventsFunction: gdEventsFunction,
    callback: (gdProjectScopedContainers, gdObjectsContainer) => any
  ) => {
    const currentProject = requireProject();
    const parameterObjectsContainer = new gd.ObjectsContainer(
      gd.ObjectsContainer.Function
    );
    const parameterVariablesContainer = new gd.VariablesContainer(
      gd.VariablesContainer.Parameters
    );
    const propertyVariablesContainer = new gd.VariablesContainer(
      gd.VariablesContainer.Properties
    );
    const parameterResourcesContainer = new gd.ResourcesContainer(
      gd.ResourcesContainer.Parameters
    );
    const propertyResourcesContainer = new gd.ResourcesContainer(
      gd.ResourcesContainer.Properties
    );
    gd.ParameterMetadataTools.parametersToObjectsContainer(
      currentProject,
      eventsFunction.getParameters(),
      parameterObjectsContainer
    );

    let scopedContainers;
    try {
      if (owner.ownerKind === 'behavior') {
        scopedContainers = gd.ProjectScopedContainers.makeNewProjectScopedContainersForBehaviorEventsFunction(
          currentProject,
          owner.extension,
          owner.behavior,
          eventsFunction,
          parameterObjectsContainer,
          parameterVariablesContainer,
          propertyVariablesContainer,
          parameterResourcesContainer,
          propertyResourcesContainer
        );
      } else if (owner.ownerKind === 'object') {
        scopedContainers = gd.ProjectScopedContainers.makeNewProjectScopedContainersForObjectEventsFunction(
          currentProject,
          owner.extension,
          owner.object,
          eventsFunction,
          parameterObjectsContainer,
          parameterVariablesContainer,
          propertyVariablesContainer,
          parameterResourcesContainer,
          propertyResourcesContainer
        );
      } else {
        scopedContainers = gd.ProjectScopedContainers.makeNewProjectScopedContainersForFreeEventsFunction(
          currentProject,
          owner.extension,
          eventsFunction,
          parameterObjectsContainer,
          parameterVariablesContainer,
          parameterResourcesContainer
        );
      }
      return callback(scopedContainers, parameterObjectsContainer);
    } finally {
      // ProjectScopedContainers created by these factory helpers borrows/wraps
      // the temporary containers. The editor's ProjectScopedContainersAccessor
      // intentionally does not delete the returned wrapper; deleting it here
      // invalidates the borrowed containers in libGD and causes a double free.
      propertyResourcesContainer.delete();
      parameterResourcesContainer.delete();
      propertyVariablesContainer.delete();
      parameterVariablesContainer.delete();
      parameterObjectsContainer.delete();
    }
  };

  const validateParameterName = (
    owner: any,
    eventsFunction: gdEventsFunction,
    requestedName: any,
    currentName?: ?string
  ): string => {
    const name = requireSafeIdentifier(
      requestedName,
      'parameterName',
      'invalid_events_function_parameter_name'
    );
    if (currentName === name) return name;
    const parameters = eventsFunction.getParameters();
    if (parameters.hasParameterNamed(name)) {
      throw new AgentError({
        code: 'events_function_parameter_name_taken',
        details: { name },
      });
    }
    withFunctionScopedContainers(owner, eventsFunction, scopedContainers => {
      const variablesContainersList = scopedContainers.getVariablesContainersList();
      const objectsContainersList = scopedContainers.getObjectsContainersList();
      if (
        variablesContainersList.has(name) ||
        objectsContainersList.hasObjectNamed(name)
      ) {
        throw new AgentError({
          code: 'events_function_parameter_name_taken',
          details: { name, reason: 'scope_collision' },
        });
      }
    });
    return name;
  };

  const applyFunctionMetadata = (
    eventsFunction: gdEventsFunction,
    input: any
  ) => {
    if (typeof input.fullName === 'string')
      eventsFunction.setFullName(input.fullName);
    if (typeof input.description === 'string')
      eventsFunction.setDescription(input.description);
    if (typeof input.sentence === 'string')
      eventsFunction.setSentence(input.sentence);
    if (typeof input.group === 'string') eventsFunction.setGroup(input.group);
    if (typeof input.getterName === 'string')
      eventsFunction.setGetterName(input.getterName);
    if (typeof input.private === 'boolean')
      eventsFunction.setPrivate(input.private);
    if (typeof input.async === 'boolean') eventsFunction.setAsync(input.async);
    if (typeof input.helpUrl === 'string')
      eventsFunction.setHelpUrl(input.helpUrl);
    if (typeof input.deprecated === 'boolean')
      eventsFunction.setDeprecated(input.deprecated);
    if (typeof input.deprecationMessage === 'string')
      eventsFunction.setDeprecationMessage(input.deprecationMessage);
  };

  const applyParameterMetadata = (
    parameter: gdParameterMetadata,
    input: any
  ) => {
    if (typeof input.extraInfo === 'string')
      parameter.setExtraInfo(input.extraInfo);
    if (typeof input.optional === 'boolean')
      parameter.setOptional(input.optional);
    if (typeof input.description === 'string')
      parameter.setDescription(input.description);
    if (typeof input.longDescription === 'string')
      parameter.setLongDescription(input.longDescription);
    if (typeof input.hint === 'string') parameter.setHint(input.hint);
    if (typeof input.codeOnly === 'boolean')
      parameter.setCodeOnly(input.codeOnly);
    if (typeof input.defaultValue === 'string')
      parameter.setDefaultValue(input.defaultValue);
  };

  const applyBehaviorMetadata = (
    behavior: gdEventsBasedBehavior,
    input: any
  ) => {
    if (typeof input.fullName === 'string')
      behavior.setFullName(input.fullName);
    if (typeof input.description === 'string')
      behavior.setDescription(input.description);
    if (typeof input.private === 'boolean') behavior.setPrivate(input.private);
    if (typeof input.previewIconUrl === 'string')
      behavior.setPreviewIconUrl(input.previewIconUrl);
    if (typeof input.iconUrl === 'string') behavior.setIconUrl(input.iconUrl);
    if (typeof input.helpPath === 'string')
      behavior.setHelpPath(input.helpPath);
    if (typeof input.objectType === 'string')
      behavior.setObjectType(input.objectType);
  };

  const applyObjectMetadata = (object: gdEventsBasedObject, input: any) => {
    if (typeof input.fullName === 'string') object.setFullName(input.fullName);
    if (typeof input.description === 'string')
      object.setDescription(input.description);
    if (typeof input.private === 'boolean') object.setPrivate(input.private);
    if (typeof input.previewIconUrl === 'string')
      object.setPreviewIconUrl(input.previewIconUrl);
    if (typeof input.iconUrl === 'string') object.setIconUrl(input.iconUrl);
    if (typeof input.helpPath === 'string') object.setHelpPath(input.helpPath);
    if (typeof input.defaultName === 'string')
      object.setDefaultName(gd.Project.getSafeName(input.defaultName));
    if (typeof input.assetStoreTag === 'string')
      object.setAssetStoreTag(input.assetStoreTag);
    if (typeof input.renderedIn3D === 'boolean')
      object.markAsRenderedIn3D(input.renderedIn3D);
    if (typeof input.animatable === 'boolean')
      object.markAsAnimatable(input.animatable);
    if (typeof input.textContainer === 'boolean')
      object.markAsTextContainer(input.textContainer);
    if (typeof input.innerAreaFollowingParentSize === 'boolean')
      object.markAsInnerAreaFollowingParentSize(
        input.innerAreaFollowingParentSize
      );
  };

  const applyVariantMetadata = (
    variant: gdEventsBasedObjectVariant,
    input: any
  ) => {
    if (typeof input.assetStoreAssetId === 'string')
      variant.setAssetStoreAssetId(input.assetStoreAssetId);
    if (typeof input.assetStoreOriginalName === 'string')
      variant.setAssetStoreOriginalName(input.assetStoreOriginalName);
    if (input && input.area && typeof input.area === 'object') {
      const { minX, minY, minZ, maxX, maxY, maxZ } = input.area;
      if (typeof minX === 'number') variant.setAreaMinX(minX);
      if (typeof minY === 'number') variant.setAreaMinY(minY);
      if (typeof minZ === 'number') variant.setAreaMinZ(minZ);
      if (typeof maxX === 'number') variant.setAreaMaxX(maxX);
      if (typeof maxY === 'number') variant.setAreaMaxY(maxY);
      if (typeof maxZ === 'number') variant.setAreaMaxZ(maxZ);
    }
  };

  const requireObject = ({ extensionName, name }: any) => {
    const extension = requireExtension(extensionName);
    const objects = extension.getEventsBasedObjects();
    if (typeof name !== 'string' || !name || !objects.has(name)) {
      throw new AgentError({
        code: 'events_based_object_not_found',
        details: { extensionName, name },
      });
    }
    return { extension, objects, object: objects.get(name) };
  };

  const requireVariantName = (name: any, field: string = 'variantName') => {
    if (typeof name !== 'string' || !name.trim() || name.includes('::')) {
      throw new AgentError({
        code: 'invalid_events_based_object_variant_name',
        hint: 'Use a non-empty variant name that does not contain "::".',
        details: { field, requested: name },
      });
    }
    return name.trim();
  };

  const requireVariant = ({ extensionName, name, variantName }: any) => {
    const objectInfo = requireObject({ extensionName, name });
    const variants = objectInfo.object.getVariants();
    if (
      typeof variantName !== 'string' ||
      !variantName ||
      !variants.hasVariantNamed(variantName)
    ) {
      throw new AgentError({
        code: 'events_based_object_variant_not_found',
        details: { extensionName, name, variantName },
      });
    }
    return {
      ...objectInfo,
      variants,
      variant: variants.getVariant(variantName),
    };
  };

  const requireBehavior = ({ extensionName, name }: any) => {
    const extension = requireExtension(extensionName);
    const behaviors = extension.getEventsBasedBehaviors();
    if (typeof name !== 'string' || !name || !behaviors.has(name)) {
      throw new AgentError({
        code: 'events_based_behavior_not_found',
        details: { extensionName, name },
      });
    }
    return { extension, behaviors, behavior: behaviors.get(name) };
  };

  const waitForLifecycle = async () => {
    const lifecycle = requireLifecycle();
    if (typeof lifecycle.ensureLoadFinished === 'function') {
      await lifecycle.ensureLoadFinished();
    }
    return lifecycle;
  };

  const finishMutation = async ({ operation }: { operation: string }) => {
    const currentProject = requireProject();
    const lifecycle = requireLifecycle();
    triggerUnsavedChanges();
    forceUpdate();
    try {
      await lifecycle.reloadProjectEventsFunctionsExtensions(currentProject);
    } catch (cause) {
      throw new AgentError({
        code: 'extension_reload_failed',
        message: `Extension mutation "${operation}" was applied but the generated extension reload failed.`,
        recovery:
          'Use a checkpoint/transaction rollback, fix the extension definition, then retry.',
        details: { operation, mutationApplied: true },
        cause,
      });
    }
  };

  const getDeleteBlockers = (extension: gdEventsFunctionsExtension) => {
    const currentProject = requireProject();
    const dependentVector = gd.UsedExtensionsFinder.findExtensionsDependentOn(
      currentProject,
      extension
    );
    let dependentExtensions = [];
    try {
      dependentExtensions =
        typeof dependentVector.toJSArray === 'function'
          ? dependentVector.toJSArray()
          : toArray(dependentVector, value => String(value));
    } finally {
      if (dependentVector && typeof dependentVector.delete === 'function') {
        dependentVector.delete();
      }
    }

    const usageResult = gd.UsedExtensionsFinder.scanProject(currentProject);
    let usedByProject = false;
    try {
      usedByProject = stringSetToArray(
        usageResult.getUsedExtensions()
      ).includes(extension.getName());
    } finally {
      if (usageResult && typeof usageResult.delete === 'function') {
        usageResult.delete();
      }
    }

    return {
      usedByProject,
      dependentExtensions: dependentExtensions.sort(),
    };
  };

  return {
    listProjectExtensions: () => {
      const currentProject = requireProject();
      const items = [];
      for (
        let index = 0;
        index < currentProject.getEventsFunctionsExtensionsCount();
        index++
      ) {
        const extension = currentProject.getEventsFunctionsExtensionAt(index);
        items.push({
          name: extension.getName(),
          fullName: extension.getFullName(),
          description: extension.getDescription(),
          version: extension.getVersion(),
          namespace: extension.getNamespace(),
          functionCount: extension
            .getEventsFunctions()
            .getEventsFunctionsCount(),
          behaviorCount: extension.getEventsBasedBehaviors().getCount(),
          objectCount: extension.getEventsBasedObjects().getCount(),
        });
      }
      items.sort((left, right) => left.name.localeCompare(right.name));
      return { items, total: items.length };
    },

    inspectProjectExtension: ({ name }: any) => ({
      extension: serializeExtension(requireExtension(name)),
    }),

    listEventsFunctions: (input: any) => {
      const owner = requireFunctionOwner(input);
      const items = eventsFunctionsToArray(owner.container, eventsFunction =>
        serializeEventsFunction(eventsFunction)
      );
      return {
        owner: {
          extensionName: owner.extension.getName(),
          kind: owner.ownerKind,
          name: owner.ownerName,
        },
        items,
        total: items.length,
      };
    },

    inspectEventsFunction: (input: any) => {
      const owner = requireEventsFunction(input);
      return {
        owner: {
          extensionName: owner.extension.getName(),
          kind: owner.ownerKind,
          name: owner.ownerName,
        },
        eventsFunction: serializeEventsFunction(owner.eventsFunction),
      };
    },

    createEventsFunction: async (input: any) => {
      await waitForLifecycle();
      const owner = requireFunctionOwner(input);
      const name = requireSafeIdentifier(
        input && input.name,
        'name',
        'invalid_events_function_name'
      );
      if (owner.container.hasEventsFunctionNamed(name)) {
        throw new AgentError({
          code: 'events_function_name_taken',
          details: { name },
        });
      }
      const functionType = functionTypeFromString(
        (input && input.type) || 'action'
      );
      const eventsFunction = owner.container.insertNewEventsFunction(
        name,
        owner.container.getEventsFunctionsCount()
      );
      eventsFunction.setFunctionType(functionType);
      applyFunctionMetadata(eventsFunction, input || {});

      if (eventsFunction.isCondition() && !eventsFunction.isExpression()) {
        gd.PropertyFunctionGenerator.generateConditionSkeleton(
          requireProject(),
          eventsFunction
        );
      } else if (eventsFunction.isExpression()) {
        gd.PropertyFunctionGenerator.generateExpressionSkeleton(
          requireProject(),
          eventsFunction
        );
      }
      if (owner.ownerKind === 'behavior') {
        gd.WholeProjectRefactorer.ensureBehaviorEventsFunctionsProperParameters(
          owner.extension,
          owner.behavior
        );
      } else if (owner.ownerKind === 'object') {
        gd.WholeProjectRefactorer.ensureObjectEventsFunctionsProperParameters(
          owner.extension,
          owner.object
        );
      }

      await finishMutation({ operation: 'function-create' });
      return {
        created: true,
        owner: {
          extensionName: owner.extension.getName(),
          kind: owner.ownerKind,
          name: owner.ownerName,
        },
        eventsFunction: serializeEventsFunction(eventsFunction),
      };
    },

    updateEventsFunction: async (input: any) => {
      await waitForLifecycle();
      const owner = requireEventsFunction(input);
      const eventsFunction = owner.eventsFunction;
      if (input && input.type !== undefined) {
        const requestedType = functionTypeFromString(input.type);
        if (
          requestedType !== eventsFunction.getFunctionType() &&
          !input.allowBreakingTypeChange
        ) {
          throw new AgentError({
            code: 'events_function_type_change_requires_opt_in',
            hint:
              'Set allowBreakingTypeChange=true only after checking all call sites, because changing action/condition/expression kind can invalidate references.',
            details: {
              currentType: functionTypeToString(eventsFunction),
              requestedType: input.type,
            },
          });
        }
        eventsFunction.setFunctionType(requestedType);
      }
      applyFunctionMetadata(eventsFunction, input || {});
      await finishMutation({ operation: 'function-update' });
      return {
        updated: true,
        eventsFunction: serializeEventsFunction(eventsFunction),
      };
    },

    renameEventsFunction: async (input: any) => {
      await waitForLifecycle();
      const currentProject = requireProject();
      const owner = requireEventsFunction(input);
      const eventsFunction = owner.eventsFunction;
      if (isLifecycleFunction(owner, eventsFunction)) {
        throw new AgentError({
          code: 'events_function_lifecycle_name_locked',
          details: {
            name: eventsFunction.getName(),
            ownerKind: owner.ownerKind,
          },
        });
      }
      const newName = requireSafeIdentifier(
        input && input.newName,
        'newName',
        'invalid_events_function_name'
      );
      const oldName = eventsFunction.getName();
      if (newName === oldName) {
        return {
          renamed: false,
          oldName,
          newName,
          eventsFunction: serializeEventsFunction(eventsFunction),
        };
      }
      if (owner.container.hasEventsFunctionNamed(newName)) {
        throw new AgentError({
          code: 'events_function_name_taken',
          details: { name: newName },
        });
      }
      const targetLifecycle =
        owner.ownerKind === 'behavior'
          ? gd.MetadataDeclarationHelper.isBehaviorLifecycleEventsFunction(
              newName
            )
          : owner.ownerKind === 'object'
          ? gd.MetadataDeclarationHelper.isObjectLifecycleEventsFunction(
              newName
            )
          : gd.MetadataDeclarationHelper.isExtensionLifecycleEventsFunction(
              newName
            );
      if (targetLifecycle) {
        throw new AgentError({
          code: 'events_function_lifecycle_name_reserved',
          details: { newName, ownerKind: owner.ownerKind },
        });
      }

      if (owner.ownerKind === 'behavior') {
        gd.WholeProjectRefactorer.renameBehaviorEventsFunction(
          currentProject,
          owner.extension,
          owner.behavior,
          oldName,
          newName
        );
      } else if (owner.ownerKind === 'object') {
        gd.WholeProjectRefactorer.renameObjectEventsFunction(
          currentProject,
          owner.extension,
          owner.object,
          oldName,
          newName
        );
      } else {
        gd.WholeProjectRefactorer.renameEventsFunction(
          currentProject,
          owner.extension,
          oldName,
          newName
        );
      }
      eventsFunction.setName(newName);
      await finishMutation({ operation: 'function-rename' });
      return {
        renamed: true,
        oldName,
        newName,
        eventsFunction: serializeEventsFunction(eventsFunction),
      };
    },

    deleteEventsFunction: async ({
      allowReferenced = false,
      ...input
    }: any) => {
      await waitForLifecycle();
      const owner = requireEventsFunction(input);
      if (!allowReferenced) {
        throw new AgentError({
          code: 'events_function_delete_requires_reference_opt_in',
          hint:
            'GDevelop does not expose an authoritative direct-call usage finder for one custom function. Re-run with allowReferenced=true only after inspecting call sites or inside a rollback transaction.',
          details: { name: owner.eventsFunction.getName() },
        });
      }
      const name = owner.eventsFunction.getName();
      owner.container.removeEventsFunction(name);
      await finishMutation({ operation: 'function-delete' });
      return { deleted: true, name, allowedReferenced: true };
    },

    createEventsFunctionParameter: async (input: any) => {
      await waitForLifecycle();
      const owner = requireEventsFunction(input);
      const eventsFunction = owner.eventsFunction;
      const parameters = eventsFunction.getParameters();
      assertParameterMutable(owner, eventsFunction);
      const parameterName = validateParameterName(
        owner,
        eventsFunction,
        input && input.parameterName
      );
      const firstEditable = firstEditableParameterIndex(owner);
      const requestedIndex =
        input && Number.isInteger(input.index)
          ? input.index
          : parameters.getParametersCount();
      if (
        requestedIndex < firstEditable ||
        requestedIndex > parameters.getParametersCount()
      ) {
        throw new AgentError({
          code: 'invalid_events_function_parameter_index',
          details: {
            index: requestedIndex,
            firstEditableParameterIndex: firstEditable,
            parameterCount: parameters.getParametersCount(),
          },
        });
      }
      const parameter = parameters.insertNewParameter(
        parameterName,
        requestedIndex
      );
      const requestedType =
        input && typeof input.type === 'string' && input.type
          ? input.type
          : 'objectList';
      parameter.setType(
        requestedType === 'number' ? 'expression' : requestedType
      );
      applyParameterMetadata(parameter, input || {});
      await finishMutation({ operation: 'function-parameter-create' });
      return {
        created: true,
        index: requestedIndex,
        parameter: serializeParameter(parameter),
      };
    },

    updateEventsFunctionParameter: async (input: any) => {
      await waitForLifecycle();
      const currentProject = requireProject();
      const owner = requireEventsFunction(input);
      const eventsFunction = owner.eventsFunction;
      const parameters = eventsFunction.getParameters();
      const parameterName = input && input.parameterName;
      if (
        typeof parameterName !== 'string' ||
        !parameters.hasParameterNamed(parameterName)
      ) {
        throw new AgentError({
          code: 'events_function_parameter_not_found',
          details: { parameterName },
        });
      }
      const parameter = parameters.getParameter(parameterName);
      const index = parameters.getParameterPosition(parameter);
      assertParameterMutable(owner, eventsFunction, index);
      const oldType = parameter.getType();
      const oldExtraInfo = parameter.getExtraInfo();
      if (input && typeof input.type === 'string' && input.type) {
        parameter.setType(input.type === 'number' ? 'expression' : input.type);
      }
      applyParameterMetadata(parameter, input || {});
      if (
        oldType !== parameter.getType() ||
        oldExtraInfo !== parameter.getExtraInfo()
      ) {
        withFunctionScopedContainers(
          owner,
          eventsFunction,
          (scopedContainers, parameterObjectsContainer) =>
            gd.WholeProjectRefactorer.changeParameterType(
              currentProject,
              scopedContainers,
              eventsFunction,
              parameterObjectsContainer,
              parameter.getName()
            )
        );
      }
      await finishMutation({ operation: 'function-parameter-update' });
      return { updated: true, parameter: serializeParameter(parameter) };
    },

    renameEventsFunctionParameter: async (input: any) => {
      await waitForLifecycle();
      const currentProject = requireProject();
      const owner = requireEventsFunction(input);
      const eventsFunction = owner.eventsFunction;
      const parameters = eventsFunction.getParameters();
      const parameterName = input && input.parameterName;
      if (
        typeof parameterName !== 'string' ||
        !parameters.hasParameterNamed(parameterName)
      ) {
        throw new AgentError({
          code: 'events_function_parameter_not_found',
          details: { parameterName },
        });
      }
      const parameter = parameters.getParameter(parameterName);
      const index = parameters.getParameterPosition(parameter);
      assertParameterMutable(owner, eventsFunction, index);
      const newName = validateParameterName(
        owner,
        eventsFunction,
        input && input.newName,
        parameterName
      );
      if (newName === parameterName) {
        return {
          renamed: false,
          oldName: parameterName,
          newName,
          parameter: serializeParameter(parameter),
        };
      }
      withFunctionScopedContainers(
        owner,
        eventsFunction,
        (scopedContainers, parameterObjectsContainer) =>
          gd.WholeProjectRefactorer.renameParameter(
            currentProject,
            scopedContainers,
            eventsFunction,
            parameterObjectsContainer,
            parameterName,
            newName
          )
      );
      parameter.setName(newName);
      await finishMutation({ operation: 'function-parameter-rename' });
      return {
        renamed: true,
        oldName: parameterName,
        newName,
        parameter: serializeParameter(parameter),
      };
    },

    deleteEventsFunctionParameter: async (input: any) => {
      await waitForLifecycle();
      const owner = requireEventsFunction(input);
      const eventsFunction = owner.eventsFunction;
      const parameters = eventsFunction.getParameters();
      const parameterName = input && input.parameterName;
      if (
        typeof parameterName !== 'string' ||
        !parameters.hasParameterNamed(parameterName)
      ) {
        throw new AgentError({
          code: 'events_function_parameter_not_found',
          details: { parameterName },
        });
      }
      const parameter = parameters.getParameter(parameterName);
      assertParameterMutable(
        owner,
        eventsFunction,
        parameters.getParameterPosition(parameter)
      );
      parameters.removeParameter(parameterName);
      await finishMutation({ operation: 'function-parameter-delete' });
      return { deleted: true, parameterName };
    },

    moveEventsFunctionParameter: async (input: any) => {
      await waitForLifecycle();
      const currentProject = requireProject();
      const owner = requireEventsFunction(input);
      const eventsFunction = owner.eventsFunction;
      const parameters = eventsFunction.getParameters();
      const oldIndex = input && input.oldIndex;
      const newIndex = input && input.newIndex;
      if (
        !Number.isInteger(oldIndex) ||
        !Number.isInteger(newIndex) ||
        oldIndex < 0 ||
        newIndex < 0 ||
        oldIndex >= parameters.getParametersCount() ||
        newIndex >= parameters.getParametersCount()
      ) {
        throw new AgentError({
          code: 'invalid_events_function_parameter_index',
          details: {
            oldIndex,
            newIndex,
            parameterCount: parameters.getParametersCount(),
          },
        });
      }
      assertParameterMutable(owner, eventsFunction, oldIndex);
      assertParameterMutable(owner, eventsFunction, newIndex);
      if (oldIndex === newIndex) {
        return { moved: false, oldIndex, newIndex };
      }
      if (owner.ownerKind === 'behavior') {
        gd.WholeProjectRefactorer.moveBehaviorEventsFunctionParameter(
          currentProject,
          owner.extension,
          owner.behavior,
          eventsFunction.getName(),
          oldIndex,
          newIndex
        );
      } else if (owner.ownerKind === 'object') {
        gd.WholeProjectRefactorer.moveObjectEventsFunctionParameter(
          currentProject,
          owner.extension,
          owner.object,
          eventsFunction.getName(),
          oldIndex,
          newIndex
        );
      } else {
        gd.WholeProjectRefactorer.moveEventsFunctionParameter(
          currentProject,
          owner.extension,
          eventsFunction.getName(),
          oldIndex + 1,
          newIndex + 1
        );
      }
      parameters.moveParameter(oldIndex, newIndex);
      await finishMutation({ operation: 'function-parameter-move' });
      return { moved: true, oldIndex, newIndex };
    },

    listEventsBasedBehaviors: ({ extensionName }: any) => {
      const extension = requireExtension(extensionName);
      const items = toArray(extension.getEventsBasedBehaviors(), behavior =>
        serializeBehavior(behavior)
      );
      return { items, total: items.length };
    },

    inspectEventsBasedBehavior: (input: any) => ({
      behavior: serializeBehavior(requireBehavior(input).behavior),
    }),

    createEventsBasedBehavior: async (input: any) => {
      await waitForLifecycle();
      const extension = requireExtension(input && input.extensionName);
      const behaviors = extension.getEventsBasedBehaviors();
      const name = requireSafeIdentifier(
        input && input.name,
        'name',
        'invalid_events_based_behavior_name'
      );
      if (behaviors.has(name)) {
        throw new AgentError({
          code: 'events_based_behavior_name_taken',
          details: { name },
        });
      }
      const behavior = behaviors.insertNew(name, behaviors.getCount());
      applyBehaviorMetadata(behavior, input || {});
      gd.WholeProjectRefactorer.ensureBehaviorEventsFunctionsProperParameters(
        extension,
        behavior
      );
      await finishMutation({ operation: 'behavior-create' });
      return { created: true, behavior: serializeBehavior(behavior) };
    },

    updateEventsBasedBehavior: async (input: any) => {
      await waitForLifecycle();
      const currentProject = requireProject();
      const { extension, behavior } = requireBehavior(input);
      applyBehaviorMetadata(behavior, input || {});
      gd.WholeProjectRefactorer.ensureBehaviorEventsFunctionsProperParameters(
        extension,
        behavior
      );
      await finishMutation({ operation: 'behavior-update' });
      const fixedRequiredProperties = gd.WholeProjectRefactorer.fixInvalidRequiredBehaviorProperties(
        currentProject
      );
      if (fixedRequiredProperties) {
        triggerUnsavedChanges();
        forceUpdate();
      }
      return {
        updated: true,
        fixedRequiredProperties: !!fixedRequiredProperties,
        behavior: serializeBehavior(behavior),
      };
    },

    renameEventsBasedBehavior: async (input: any) => {
      await waitForLifecycle();
      const currentProject = requireProject();
      const { extension, behaviors, behavior } = requireBehavior(input);
      const newName = requireSafeIdentifier(
        input && input.newName,
        'newName',
        'invalid_events_based_behavior_name'
      );
      const oldName = behavior.getName();
      if (newName === oldName) {
        return {
          renamed: false,
          oldName,
          newName,
          behavior: serializeBehavior(behavior),
        };
      }
      if (behaviors.has(newName)) {
        throw new AgentError({
          code: 'events_based_behavior_name_taken',
          details: { name: newName },
        });
      }
      gd.WholeProjectRefactorer.renameEventsBasedBehavior(
        currentProject,
        extension,
        oldName,
        newName
      );
      behavior.setName(newName);
      gd.WholeProjectRefactorer.ensureBehaviorEventsFunctionsProperParameters(
        extension,
        behavior
      );
      await finishMutation({ operation: 'behavior-rename' });
      return {
        renamed: true,
        oldName,
        newName,
        behavior: serializeBehavior(behavior),
      };
    },

    deleteEventsBasedBehavior: async ({
      allowReferenced = false,
      ...input
    }: any) => {
      await waitForLifecycle();
      const { behaviors, behavior } = requireBehavior(input);
      if (!allowReferenced) {
        throw new AgentError({
          code: 'events_based_behavior_delete_requires_reference_opt_in',
          hint:
            'GDevelop does not expose an authoritative project-wide finder for one behavior type. Re-run with allowReferenced=true only after inspecting object usages or inside a rollback transaction.',
          details: { name: behavior.getName() },
        });
      }
      const name = behavior.getName();
      behaviors.remove(name);
      await finishMutation({ operation: 'behavior-delete' });
      return { deleted: true, name, allowedReferenced: true };
    },

    listEventsBasedObjects: ({ extensionName }: any) => {
      const extension = requireExtension(extensionName);
      const items = toArray(extension.getEventsBasedObjects(), object =>
        serializeObject(object)
      );
      return { items, total: items.length };
    },

    inspectEventsBasedObject: (input: any) => ({
      object: serializeObject(requireObject(input).object),
    }),

    createEventsBasedObject: async (input: any) => {
      await waitForLifecycle();
      const extension = requireExtension(input && input.extensionName);
      const objects = extension.getEventsBasedObjects();
      const name = requireSafeIdentifier(
        input && input.name,
        'name',
        'invalid_events_based_object_name'
      );
      if (objects.has(name)) {
        throw new AgentError({
          code: 'events_based_object_name_taken',
          details: { name },
        });
      }
      const object = objects.insertNew(name, objects.getCount());
      applyObjectMetadata(object, input || {});
      gd.WholeProjectRefactorer.ensureObjectEventsFunctionsProperParameters(
        extension,
        object
      );
      await finishMutation({ operation: 'object-create' });
      return { created: true, object: serializeObject(object) };
    },

    updateEventsBasedObject: async (input: any) => {
      await waitForLifecycle();
      const { extension, object } = requireObject(input);
      applyObjectMetadata(object, input || {});
      gd.WholeProjectRefactorer.ensureObjectEventsFunctionsProperParameters(
        extension,
        object
      );
      await finishMutation({ operation: 'object-update' });
      return { updated: true, object: serializeObject(object) };
    },

    renameEventsBasedObject: async (input: any) => {
      await waitForLifecycle();
      const currentProject = requireProject();
      const { extension, objects, object } = requireObject(input);
      const newName = requireSafeIdentifier(
        input && input.newName,
        'newName',
        'invalid_events_based_object_name'
      );
      const oldName = object.getName();
      if (newName === oldName) {
        return {
          renamed: false,
          oldName,
          newName,
          object: serializeObject(object),
        };
      }
      if (objects.has(newName)) {
        throw new AgentError({
          code: 'events_based_object_name_taken',
          details: { name: newName },
        });
      }
      gd.WholeProjectRefactorer.renameEventsBasedObject(
        currentProject,
        extension,
        oldName,
        newName
      );
      object.setName(newName);
      gd.WholeProjectRefactorer.ensureObjectEventsFunctionsProperParameters(
        extension,
        object
      );
      await finishMutation({ operation: 'object-rename' });
      return {
        renamed: true,
        oldName,
        newName,
        object: serializeObject(object),
      };
    },

    deleteEventsBasedObject: async ({
      allowReferenced = false,
      ...input
    }: any) => {
      await waitForLifecycle();
      const currentProject = requireProject();
      const { extension, objects, object } = requireObject(input);
      const canonicalType = gd.PlatformExtension.getObjectFullType(
        extension.getName(),
        object.getName()
      );
      const usedByProject = gd.UsedObjectTypeFinder.scanProject(
        currentProject,
        canonicalType
      );
      const dependentObjects = [];
      for (
        let extensionIndex = 0;
        extensionIndex < currentProject.getEventsFunctionsExtensionsCount();
        extensionIndex++
      ) {
        const candidateExtension = currentProject.getEventsFunctionsExtensionAt(
          extensionIndex
        );
        const candidateObjects = candidateExtension.getEventsBasedObjects();
        for (
          let objectIndex = 0;
          objectIndex < candidateObjects.getCount();
          objectIndex++
        ) {
          const candidateObject = candidateObjects.getAt(objectIndex);
          if (gd.compare(candidateObject, object)) continue;
          if (
            gd.EventsBasedObjectDependencyFinder.isDependentFromEventsBasedObject(
              currentProject,
              candidateObject,
              object
            )
          ) {
            dependentObjects.push(
              gd.PlatformExtension.getObjectFullType(
                candidateExtension.getName(),
                candidateObject.getName()
              )
            );
          }
        }
      }
      if (!allowReferenced && (usedByProject || dependentObjects.length > 0)) {
        throw new AgentError({
          code: 'events_based_object_in_use',
          hint:
            'Remove project usages/dependent custom objects first, or set allowReferenced=true only when broken references are intentional.',
          details: {
            canonicalType,
            usedByProject: !!usedByProject,
            dependentObjects: dependentObjects.sort(),
          },
        });
      }
      const name = object.getName();
      objects.remove(name);
      await finishMutation({ operation: 'object-delete' });
      return {
        deleted: true,
        name,
        canonicalType,
        allowedReferenced: !!allowReferenced,
        blockers: {
          usedByProject: !!usedByProject,
          dependentObjects: dependentObjects.sort(),
        },
      };
    },

    listEventsBasedObjectVariants: (input: any) => {
      const { object } = requireObject(input);
      const variants = object.getVariants();
      const items = variantsToArray(variants, variant =>
        serializeVariant(variant)
      );
      return {
        defaultVariant: serializeVariant(object.getDefaultVariant()),
        items,
        total: items.length,
      };
    },

    inspectEventsBasedObjectVariant: (input: any) => ({
      variant: serializeVariant(requireVariant(input).variant),
    }),

    createEventsBasedObjectVariant: async (input: any) => {
      await waitForLifecycle();
      const { object } = requireObject(input);
      const variants = object.getVariants();
      const variantName = requireVariantName(input && input.variantName);
      if (variants.hasVariantNamed(variantName)) {
        throw new AgentError({
          code: 'events_based_object_variant_name_taken',
          details: { variantName },
        });
      }
      const requestedIndex =
        input && Number.isInteger(input.index)
          ? input.index
          : variants.getVariantsCount();
      if (requestedIndex < 0 || requestedIndex > variants.getVariantsCount()) {
        throw new AgentError({
          code: 'invalid_events_based_object_variant_index',
          details: {
            index: requestedIndex,
            variantCount: variants.getVariantsCount(),
          },
        });
      }
      const variant = variants.insertNewVariant(variantName, requestedIndex);
      applyVariantMetadata(variant, input || {});
      await finishMutation({ operation: 'object-variant-create' });
      return {
        created: true,
        index: requestedIndex,
        variant: serializeVariant(variant),
      };
    },

    updateEventsBasedObjectVariant: async (input: any) => {
      await waitForLifecycle();
      const { variant } = requireVariant(input);
      applyVariantMetadata(variant, input || {});
      await finishMutation({ operation: 'object-variant-update' });
      return { updated: true, variant: serializeVariant(variant) };
    },

    renameEventsBasedObjectVariant: async ({
      allowReferenced = false,
      ...input
    }: any) => {
      await waitForLifecycle();
      const { variants, variant } = requireVariant(input);
      if (!allowReferenced) {
        throw new AgentError({
          code: 'events_based_object_variant_rename_requires_reference_opt_in',
          hint:
            'Variant names are stored by custom-object configurations and GDevelop exposes no project-wide variant-reference refactorer. Re-run with allowReferenced=true only after checking configurations or inside a rollback transaction.',
          details: { variantName: variant.getName() },
        });
      }
      const newName = requireVariantName(input && input.newName, 'newName');
      const oldName = variant.getName();
      if (newName === oldName) {
        return {
          renamed: false,
          oldName,
          newName,
          variant: serializeVariant(variant),
        };
      }
      if (variants.hasVariantNamed(newName)) {
        throw new AgentError({
          code: 'events_based_object_variant_name_taken',
          details: { variantName: newName },
        });
      }
      variant.setName(newName);
      await finishMutation({ operation: 'object-variant-rename' });
      return {
        renamed: true,
        oldName,
        newName,
        allowedReferenced: true,
        variant: serializeVariant(variant),
      };
    },

    deleteEventsBasedObjectVariant: async ({
      allowReferenced = false,
      ...input
    }: any) => {
      await waitForLifecycle();
      const { variants, variant } = requireVariant(input);
      if (!allowReferenced) {
        throw new AgentError({
          code: 'events_based_object_variant_delete_requires_reference_opt_in',
          hint:
            'Variant references are stored in custom-object configurations and have no authoritative project-wide finder. Re-run with allowReferenced=true only after checking configurations or inside a rollback transaction.',
          details: { variantName: variant.getName() },
        });
      }
      const variantName = variant.getName();
      variants.removeVariant(variantName);
      await finishMutation({ operation: 'object-variant-delete' });
      return { deleted: true, variantName, allowedReferenced: true };
    },

    moveEventsBasedObjectVariant: async (input: any) => {
      await waitForLifecycle();
      const { object } = requireObject(input);
      const variants = object.getVariants();
      const oldIndex = input && input.oldIndex;
      const newIndex = input && input.newIndex;
      const count = variants.getVariantsCount();
      if (
        !Number.isInteger(oldIndex) ||
        !Number.isInteger(newIndex) ||
        oldIndex < 0 ||
        newIndex < 0 ||
        oldIndex >= count ||
        newIndex >= count
      ) {
        throw new AgentError({
          code: 'invalid_events_based_object_variant_index',
          details: { oldIndex, newIndex, variantCount: count },
        });
      }
      if (oldIndex === newIndex) return { moved: false, oldIndex, newIndex };
      variants.moveVariant(oldIndex, newIndex);
      await finishMutation({ operation: 'object-variant-move' });
      return { moved: true, oldIndex, newIndex };
    },

    createProjectExtension: async (input: any) => {
      const currentProject = requireProject();
      await waitForLifecycle();
      const name = requireSafeName(input && input.name, 'name');
      if (isExtensionNameTaken(name, currentProject)) {
        throw new AgentError({
          code: 'project_extension_name_taken',
          details: { name },
        });
      }

      const extension = currentProject.insertNewEventsFunctionsExtension(
        name,
        currentProject.getEventsFunctionsExtensionsCount()
      );
      extension.setFullName(
        typeof input.fullName === 'string' && input.fullName
          ? input.fullName
          : name
      );
      if (typeof input.namespace === 'string')
        extension.setNamespace(input.namespace);
      if (typeof input.version === 'string')
        extension.setVersion(input.version);
      if (typeof input.shortDescription === 'string')
        extension.setShortDescription(input.shortDescription);
      if (typeof input.description === 'string')
        extension.setDescription(input.description);
      if (typeof input.dimension === 'string')
        extension.setDimension(input.dimension);
      if (typeof input.category === 'string')
        extension.setCategory(input.category);
      if (typeof input.author === 'string') extension.setAuthor(input.author);
      if (typeof input.previewIconUrl === 'string')
        extension.setPreviewIconUrl(input.previewIconUrl);
      if (typeof input.iconUrl === 'string')
        extension.setIconUrl(input.iconUrl);
      if (typeof input.helpPath === 'string')
        extension.setHelpPath(input.helpPath);

      await finishMutation({ operation: 'create' });
      return { created: true, extension: serializeExtension(extension) };
    },

    renameProjectExtension: async ({ name, newName }: any) => {
      const currentProject = requireProject();
      await waitForLifecycle();
      const extension = requireExtension(name);
      const safeNewName = requireSafeName(newName, 'newName');
      if (safeNewName === extension.getName()) {
        return {
          renamed: false,
          oldName: name,
          newName: safeNewName,
          extension: serializeExtension(extension),
        };
      }
      if (isExtensionNameTaken(safeNewName, currentProject)) {
        throw new AgentError({
          code: 'project_extension_name_taken',
          details: { name: safeNewName },
        });
      }

      const oldName = extension.getName();
      gd.WholeProjectRefactorer.renameEventsFunctionsExtension(
        currentProject,
        extension,
        oldName,
        safeNewName
      );
      extension.setName(safeNewName);
      await finishMutation({ operation: 'rename' });
      return {
        renamed: true,
        oldName,
        newName: safeNewName,
        extension: serializeExtension(extension),
      };
    },

    deleteProjectExtension: async ({ name, allowReferenced = false }: any) => {
      const currentProject = requireProject();
      await waitForLifecycle();
      const extension = requireExtension(name);
      const blockers = getDeleteBlockers(extension);
      if (
        !allowReferenced &&
        (blockers.usedByProject || blockers.dependentExtensions.length > 0)
      ) {
        throw new AgentError({
          code: 'project_extension_in_use',
          hint:
            'Remove project usages/dependent extensions first, or set allowReferenced=true only when broken references are intentional.',
          details: { name, ...blockers },
        });
      }

      const deletedName = extension.getName();
      currentProject.removeEventsFunctionsExtension(deletedName);
      await finishMutation({ operation: 'delete' });
      return {
        deleted: true,
        name: deletedName,
        allowedReferenced: !!allowReferenced,
        blockers,
      };
    },
  };
};

export const extensionAuthoringInternals = {
  functionTypeToString,
  requireSafeName,
  serializeExtension,
  stringSetToArray,
};
