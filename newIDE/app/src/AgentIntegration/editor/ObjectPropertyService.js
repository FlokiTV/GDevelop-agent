// @flow
import { AgentError } from '../core/AgentError';

const gd: libGDevelop = global.gd;

const toArray = (vector: any): Array<any> => {
  if (!vector || typeof vector.size !== 'function') return [];
  return Array.from({ length: vector.size() }, (_, index) => vector.at(index));
};

type Options = {|
  project: ?gdProject,
  metadataDiscoveryService: any,
  editorFunctionService: {| run: (options: any) => Promise<any> |},
  triggerUnsavedChanges: () => void,
  forceUpdate: () => void,
  onInstancesModifiedOutsideEditor: any,
|};

const INSTANCE_PROPERTY_SPECS = [
  { name: 'x', getter: 'getX', setter: 'setX', valueType: 'number' },
  { name: 'y', getter: 'getY', setter: 'setY', valueType: 'number' },
  { name: 'z', getter: 'getZ', setter: 'setZ', valueType: 'number' },
  {
    name: 'angle',
    getter: 'getAngle',
    setter: 'setAngle',
    valueType: 'number',
  },
  {
    name: 'rotationX',
    getter: 'getRotationX',
    setter: 'setRotationX',
    valueType: 'number',
  },
  {
    name: 'rotationY',
    getter: 'getRotationY',
    setter: 'setRotationY',
    valueType: 'number',
  },
  {
    name: 'zOrder',
    getter: 'getZOrder',
    setter: 'setZOrder',
    valueType: 'number',
  },
  {
    name: 'opacity',
    getter: 'getOpacity',
    setter: 'setOpacity',
    valueType: 'number',
    minimum: 0,
    maximum: 255,
  },
  {
    name: 'layer',
    getter: 'getLayer',
    setter: 'setLayer',
    valueType: 'string',
  },
  {
    name: 'locked',
    getter: 'isLocked',
    setter: 'setLocked',
    valueType: 'boolean',
  },
  {
    name: 'sealed',
    getter: 'isSealed',
    setter: 'setSealed',
    valueType: 'boolean',
  },
  {
    name: 'hidden',
    getter: 'isHidden',
    setter: 'setHidden',
    valueType: 'boolean',
  },
  {
    name: 'flippedX',
    getter: 'isFlippedX',
    setter: 'setFlippedX',
    valueType: 'boolean',
  },
  {
    name: 'flippedY',
    getter: 'isFlippedY',
    setter: 'setFlippedY',
    valueType: 'boolean',
  },
  {
    name: 'flippedZ',
    getter: 'isFlippedZ',
    setter: 'setFlippedZ',
    valueType: 'boolean',
  },
  {
    name: 'keepRatio',
    getter: 'shouldKeepRatio',
    setter: 'setShouldKeepRatio',
    valueType: 'boolean',
  },
  {
    name: 'hasCustomSize',
    getter: 'hasCustomSize',
    setter: 'setHasCustomSize',
    valueType: 'boolean',
  },
  {
    name: 'hasCustomDepth',
    getter: 'hasCustomDepth',
    setter: 'setHasCustomDepth',
    valueType: 'boolean',
  },
  {
    name: 'customWidth',
    getter: 'getCustomWidth',
    setter: 'setCustomWidth',
    valueType: 'number',
    minimum: 0,
  },
  {
    name: 'customHeight',
    getter: 'getCustomHeight',
    setter: 'setCustomHeight',
    valueType: 'number',
    minimum: 0,
  },
  {
    name: 'customDepth',
    getter: 'getCustomDepth',
    setter: 'setCustomDepth',
    valueType: 'number',
    minimum: 0,
  },
];

const requireString = (value: any, field: string): string => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AgentError({
      code: 'invalid_property_target',
      message: `${field} must be a non-empty string.`,
      field,
      details: { field, expected: 'non-empty string' },
    });
  }
  return value;
};

const normalizeDescriptorType = (descriptorType: any): string => {
  const normalized =
    typeof descriptorType === 'string' ? descriptorType.toLowerCase() : '';
  if (normalized.includes('bool')) return 'boolean';
  if (
    normalized === 'number' ||
    normalized === 'integer' ||
    normalized.includes('number')
  ) {
    return 'number';
  }
  return 'string';
};

const deserializeValue = (value: any, valueType: string): any => {
  if (valueType === 'number') {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : value;
  }
  if (valueType === 'boolean') {
    if (value === true || value === 'true' || value === '1') return true;
    if (value === false || value === 'false' || value === '0') return false;
  }
  return value;
};

const serializeValue = (value: any, valueType: string): string => {
  if (valueType === 'boolean') return value ? 'true' : 'false';
  return String(value);
};

const makeConstraints = (descriptor: any, valueType: string): any => {
  const choices = toArray(descriptor.getChoices()).map(choice => ({
    value: deserializeValue(choice.getValue(), valueType),
    label: choice.getLabel(),
  }));
  const measurementUnit = descriptor.getMeasurementUnit();
  return {
    ...(choices.length ? { choices } : {}),
    extraInfo: descriptor.getExtraInfo().toJSArray(),
    hidden: descriptor.isHidden(),
    deprecated: descriptor.isDeprecated(),
    advanced: descriptor.isAdvanced(),
    impactsOtherProperties: descriptor.hasImpactOnOtherProperties(),
    measurementUnit: measurementUnit.isUndefined()
      ? null
      : {
          name: measurementUnit.getName(),
          label: measurementUnit.getLabel(),
          description: measurementUnit.getDescription(),
        },
  };
};

const validateTypedValue = ({
  property,
  value,
  field,
}: {|
  property: any,
  value: any,
  field: string,
|}) => {
  const expectedType = property.valueType;
  const actualType = Array.isArray(value)
    ? 'array'
    : value === null
    ? 'null'
    : typeof value;
  const typeMatches =
    expectedType === 'number'
      ? typeof value === 'number' && Number.isFinite(value)
      : typeof value === expectedType;
  if (!typeMatches) {
    throw new AgentError({
      code: 'invalid_property_type',
      message: `${field} must be a ${expectedType} for ${property.path}.`,
      field,
      path: property.path,
      details: {
        field,
        path: property.path,
        expectedType,
        actualType,
        actualValue: value,
      },
    });
  }

  const constraints = property.constraints || {};
  if (typeof constraints.minimum === 'number' && value < constraints.minimum) {
    throw new AgentError({
      code: 'invalid_property_value',
      message: `${property.path} must be >= ${constraints.minimum}.`,
      field,
      path: property.path,
      details: {
        field,
        path: property.path,
        minimum: constraints.minimum,
        actualValue: value,
      },
    });
  }
  if (typeof constraints.maximum === 'number' && value > constraints.maximum) {
    throw new AgentError({
      code: 'invalid_property_value',
      message: `${property.path} must be <= ${constraints.maximum}.`,
      field,
      path: property.path,
      details: {
        field,
        path: property.path,
        maximum: constraints.maximum,
        actualValue: value,
      },
    });
  }
  if (Array.isArray(constraints.choices) && constraints.choices.length) {
    const allowedValues = constraints.choices.map(choice => choice.value);
    if (!allowedValues.includes(value)) {
      throw new AgentError({
        code: 'invalid_property_value',
        message: `${property.path} must be one of the advertised choices.`,
        field,
        path: property.path,
        details: {
          field,
          path: property.path,
          allowedValues,
          actualValue: value,
        },
      });
    }
  }
};

const iterateInstances = (
  container: gdInitialInstancesContainer,
  callback: gdInitialInstance => void
) => {
  const functor = new gd.InitialInstanceJSFunctor();
  // $FlowFixMe[cannot-write]
  functor.invoke = instancePtr => {
    const instance: gdInitialInstance = gd.wrapPointer(
      // $FlowFixMe[incompatible-type]
      instancePtr,
      gd.InitialInstance
    );
    callback(instance);
  };
  // $FlowFixMe[incompatible-type]
  container.iterateOverInstances(functor);
  functor.delete();
};

const compactAction = (action: any): any => ({
  id: action.id,
  displayName: action.displayName,
  description: action.description,
  behaviorType:
    action.scope && action.scope.kind === 'behavior'
      ? action.scope.behaviorType
      : null,
  extension: action.extension,
  parameters: action.parameters,
  eventContexts: action.eventContexts,
  discovery: {
    command: 'events.instructions.describe',
    arguments: {
      id: action.id,
      kind: 'action',
      ...(action.extension && action.extension.name
        ? { extension: action.extension.name }
        : {}),
      ...(action.scope && action.scope.behaviorType
        ? { behaviorType: action.scope.behaviorType }
        : {}),
    },
  },
  authoring: {
    command: 'events.patch',
    instructionId: action.id,
  },
});

export const createObjectPropertyService = ({
  project,
  metadataDiscoveryService,
  editorFunctionService,
  triggerUnsavedChanges,
  forceUpdate,
  onInstancesModifiedOutsideEditor,
}: Options) => {
  const requireProject = (): gdProject => {
    if (!project) throw new AgentError({ code: 'no_project_open' });
    return project;
  };

  const requireScene = (sceneName: any): gdLayout => {
    const currentProject = requireProject();
    const name = requireString(sceneName, 'sceneName');
    if (!currentProject.hasLayoutNamed(name)) {
      throw new AgentError({
        code: 'scene_not_found',
        message: `Scene not found: "${name}".`,
        field: 'sceneName',
        details: { field: 'sceneName', sceneName: name },
      });
    }
    return currentProject.getLayout(name);
  };

  const resolveObject = ({
    objectName,
    sceneName,
    objectScope = 'auto',
  }: any): any => {
    const currentProject = requireProject();
    const name = requireString(objectName, 'objectName');
    const globals = currentProject.getObjects();

    if (objectScope === 'global') {
      if (!globals.hasObjectNamed(name)) {
        throw new AgentError({
          code: 'object_not_found',
          message: `Global object not found: "${name}".`,
          field: 'objectName',
          details: { field: 'objectName', objectName: name, objectScope },
        });
      }
      return {
        object: globals.getObject(name),
        objectScope: 'global',
        scene: null,
      };
    }

    if (objectScope !== 'auto' && objectScope !== 'scene') {
      throw new AgentError({
        code: 'invalid_property_target',
        field: 'objectScope',
        details: {
          field: 'objectScope',
          allowedValues: ['auto', 'global', 'scene'],
        },
      });
    }

    if (sceneName) {
      const scene = requireScene(sceneName);
      const sceneObjects = scene.getObjects();
      if (sceneObjects.hasObjectNamed(name)) {
        return {
          object: sceneObjects.getObject(name),
          objectScope: 'scene',
          scene,
        };
      }
      if (objectScope === 'scene') {
        throw new AgentError({
          code: 'object_not_found',
          message: `Scene object not found: "${name}" in "${scene.getName()}".`,
          field: 'objectName',
          details: {
            field: 'objectName',
            objectName: name,
            objectScope,
            sceneName: scene.getName(),
          },
        });
      }
      if (globals.hasObjectNamed(name)) {
        return {
          object: globals.getObject(name),
          objectScope: 'global',
          scene,
        };
      }
    } else if (objectScope === 'scene') {
      throw new AgentError({
        code: 'invalid_property_target',
        message: 'sceneName is required when objectScope=scene.',
        field: 'sceneName',
        details: { field: 'sceneName', objectScope },
      });
    }

    if (globals.hasObjectNamed(name)) {
      return {
        object: globals.getObject(name),
        objectScope: 'global',
        scene: null,
      };
    }

    throw new AgentError({
      code: 'object_not_found',
      message: `Object not found: "${name}".`,
      field: 'objectName',
      details: { field: 'objectName', objectName: name, objectScope },
    });
  };

  const requireInstance = ({
    sceneName,
    instanceId,
    objectName,
  }: any): {| scene: gdLayout, instance: gdInitialInstance |} => {
    const scene = requireScene(sceneName);
    const id = requireString(instanceId, 'instanceId');
    const matches = [];
    iterateInstances(scene.getInitialInstances(), instance => {
      const persistentUuid = instance.getPersistentUuid();
      if (persistentUuid === id || persistentUuid.startsWith(id)) {
        matches.push(instance);
      }
    });
    if (matches.length === 0) {
      throw new AgentError({
        code: 'scene_instance_not_found',
        field: 'instanceId',
        details: {
          field: 'instanceId',
          sceneName: scene.getName(),
          instanceId: id,
        },
      });
    }
    if (matches.length > 1) {
      throw new AgentError({
        code: 'ambiguous_instance_id',
        field: 'instanceId',
        details: {
          field: 'instanceId',
          sceneName: scene.getName(),
          instanceId: id,
        },
      });
    }
    const instance = matches[0];
    if (
      typeof objectName === 'string' &&
      objectName &&
      instance.getObjectName() !== objectName
    ) {
      throw new AgentError({
        code: 'instance_object_mismatch',
        field: 'objectName',
        details: {
          field: 'objectName',
          sceneName: scene.getName(),
          instanceId: id,
          expectedObjectName: objectName,
          actualObjectName: instance.getObjectName(),
        },
      });
    }
    return { scene, instance };
  };

  const getDefaultObjectProperties = (object: gdObject): Map<string, any> => {
    try {
      const described = metadataDiscoveryService.describeObjectType({
        type: object.getType(),
      }).item;
      return new Map(
        (described && Array.isArray(described.properties)
          ? described.properties
          : []
        ).map(property => [property.name, property])
      );
    } catch (error) {
      return new Map();
    }
  };

  const getDefaultBehaviorProperties = (
    behaviorType: string,
    shared: boolean
  ): Map<string, any> => {
    try {
      const described = metadataDiscoveryService.describeBehaviorType({
        type: behaviorType,
      }).item;
      const properties =
        described &&
        Array.isArray(
          shared ? described.sharedProperties : described.properties
        )
          ? shared
            ? described.sharedProperties
            : described.properties
          : [];
      return new Map(properties.map(property => [property.name, property]));
    } catch (error) {
      return new Map();
    }
  };

  const serializeDescriptorProperty = ({
    name,
    descriptor,
    path,
    defaultRecord,
    backend,
    layer = 'definition',
    writable = true,
    readOnlyReason = null,
  }: any): any => {
    const descriptorType = descriptor.getType();
    const valueType = normalizeDescriptorType(descriptorType);
    const currentSerializedValue = descriptor.getValue();
    const defaultSerializedValue =
      defaultRecord && defaultRecord.defaultValue !== undefined
        ? defaultRecord.defaultValue
        : undefined;
    return {
      name,
      path,
      layer,
      descriptorType,
      valueType,
      currentValue: deserializeValue(currentSerializedValue, valueType),
      currentSerializedValue,
      ...(defaultSerializedValue !== undefined
        ? {
            defaultValue: deserializeValue(defaultSerializedValue, valueType),
            defaultSerializedValue,
          }
        : {}),
      label: descriptor.getLabel() || null,
      description: descriptor.getDescription() || null,
      group: descriptor.getGroup() || null,
      writable,
      readOnlyReason,
      constraints: makeConstraints(descriptor, valueType),
      mutation: writable
        ? {
            command: 'objects.properties.set',
            path,
            backend,
          }
        : null,
    };
  };

  const getBehaviorActions = (behaviorType: string): Array<any> => {
    try {
      const result = metadataDiscoveryService.searchInstructions({
        kind: 'action',
        behaviorType,
        deprecated: 'include',
        includeHidden: true,
        limit: 100,
      });
      return (result.items || []).map(compactAction);
    } catch (error) {
      return [];
    }
  };

  const describeAttachedBehaviors = ({
    object,
    scene,
  }: {|
    object: gdObject,
    scene: ?gdLayout,
  |}): Array<any> =>
    object
      .getAllBehaviorNames()
      .toJSArray()
      .sort((left, right) => left.localeCompare(right))
      .map(name => {
        const behavior = object.getBehavior(name);
        const type = behavior.getTypeName();
        const defaults = getDefaultBehaviorProperties(type, false);
        const properties = behavior
          .getProperties()
          .keys()
          .toJSArray()
          .sort((left, right) => left.localeCompare(right))
          .map(propertyName =>
            serializeDescriptorProperty({
              name: propertyName,
              descriptor: behavior.getProperties().get(propertyName),
              path: `behaviors.${name}.properties.${propertyName}`,
              defaultRecord: defaults.get(propertyName),
              backend: {
                kind: 'editor-function',
                command: 'editor.functions.change-behavior-property',
                functionName: 'change_behavior_property',
                changedPropertiesField: 'changed_properties',
                propertyName,
              },
            })
          );
        const actions = getBehaviorActions(type);
        return {
          name,
          type,
          capability: type.includes('Capability::'),
          properties,
          authoritativeActions: actions,
        };
      });

  const makeRuntimeOnlyProperties = (behaviors: Array<any>): Array<any> => {
    const runtimeProperties = [];
    behaviors.forEach(behavior => {
      const normalizedType = String(behavior.type || '').toLowerCase();
      if (
        normalizedType !==
        'resizablecapability::resizablebehavior'.toLowerCase()
      ) {
        return;
      }
      ['width', 'height'].forEach(propertyName => {
        const suffix = `set${propertyName}`;
        const action =
          behavior.authoritativeActions.find(candidate =>
            String(candidate.id || '')
              .toLowerCase()
              .endsWith(suffix)
          ) ||
          behavior.authoritativeActions.find(candidate =>
            String(candidate.displayName || '')
              .toLowerCase()
              .includes(propertyName)
          ) ||
          null;
        runtimeProperties.push({
          name: propertyName,
          path: `runtime.${propertyName}`,
          layer: 'runtime-only',
          valueType: 'number',
          currentValue: null,
          defaultValue: null,
          writable: false,
          readOnlyReason: 'runtime-capability-backed',
          constraints: {},
          mutation: null,
          authoritativeMutation: action
            ? {
                kind: 'behavior-capability-action',
                behaviorName: behavior.name,
                behaviorType: behavior.type,
                action,
                guidance:
                  'Author this behavior action in events; generic object-definition property mutation is not authoritative for this runtime dimension.',
              }
            : {
                kind: 'behavior-capability',
                behaviorName: behavior.name,
                behaviorType: behavior.type,
                discovery: {
                  command: 'events.instructions.search',
                  arguments: {
                    kind: 'action',
                    behaviorType: behavior.type,
                    query: propertyName,
                  },
                },
              },
        });
      });
    });
    return runtimeProperties;
  };

  const describeDefinition = (input: any): any => {
    const resolved = resolveObject(input);
    const { object, objectScope, scene } = resolved;
    const properties = object.getConfiguration().getProperties();
    const defaults = getDefaultObjectProperties(object);
    const serializedProperties = properties
      .keys()
      .toJSArray()
      .sort((left, right) => left.localeCompare(right))
      .map(name =>
        serializeDescriptorProperty({
          name,
          descriptor: properties.get(name),
          path: `configuration.${name}`,
          defaultRecord: defaults.get(name),
          backend: {
            kind: 'editor-function',
            command: 'editor.functions.change-object-property',
            functionName: 'change_object_property',
            changedPropertiesField: 'changed_properties',
            propertyName: name,
          },
        })
      );
    const behaviors = describeAttachedBehaviors({ object, scene });
    return {
      target: {
        kind: 'object-definition',
        objectName: object.getName(),
        objectType: object.getType(),
        objectScope,
        ...(scene ? { sceneName: scene.getName() } : {}),
      },
      propertyLayers: {
        definition:
          'Serialized object configuration stored on the object definition.',
        instance: 'Serialized initial-instance overrides stored in a scene.',
        runtimeOnly:
          'Runtime state or capability-backed dimensions authored through events rather than generic object-definition properties.',
      },
      properties: serializedProperties,
      behaviors,
      runtimeOnlyProperties: makeRuntimeOnlyProperties(behaviors),
    };
  };

  const describeBehavior = (input: any): any => {
    const resolved = resolveObject(input);
    const { object, objectScope, scene } = resolved;
    const behaviorName = requireString(input.behaviorName, 'behaviorName');
    if (!object.hasBehaviorNamed(behaviorName)) {
      throw new AgentError({
        code: 'behavior_not_found',
        field: 'behaviorName',
        details: {
          field: 'behaviorName',
          objectName: object.getName(),
          behaviorName,
        },
      });
    }
    const behavior = object.getBehavior(behaviorName);
    const behaviorType = behavior.getTypeName();
    const defaults = getDefaultBehaviorProperties(behaviorType, false);
    const directProperties = behavior
      .getProperties()
      .keys()
      .toJSArray()
      .sort((left, right) => left.localeCompare(right))
      .map(name =>
        serializeDescriptorProperty({
          name,
          descriptor: behavior.getProperties().get(name),
          path: `behaviors.${behaviorName}.properties.${name}`,
          defaultRecord: defaults.get(name),
          backend: {
            kind: 'editor-function',
            command: 'editor.functions.change-behavior-property',
            functionName: 'change_behavior_property',
            changedPropertiesField: 'changed_properties',
            propertyName: name,
          },
        })
      );

    let sharedProperties = [];
    if (
      scene &&
      scene
        .getAllBehaviorSharedDataNames()
        .toJSArray()
        .includes(behaviorName)
    ) {
      const sharedData = scene.getBehaviorSharedData(behaviorName);
      const sharedDefaults = getDefaultBehaviorProperties(behaviorType, true);
      const directNames = new Set(
        directProperties.map(property => property.name)
      );
      sharedProperties = sharedData
        .getProperties()
        .keys()
        .toJSArray()
        .sort((left, right) => left.localeCompare(right))
        .map(name =>
          serializeDescriptorProperty({
            name,
            descriptor: sharedData.getProperties().get(name),
            path: `behaviors.${behaviorName}.sharedProperties.${name}`,
            defaultRecord: sharedDefaults.get(name),
            writable: !directNames.has(name),
            readOnlyReason: directNames.has(name)
              ? 'shadowed-by-behavior-property-in-legacy-changed_properties-path'
              : null,
            backend: {
              kind: 'editor-function',
              command: 'editor.functions.change-behavior-property',
              functionName: 'change_behavior_property',
              changedPropertiesField: 'changed_properties',
              propertyName: name,
            },
          })
        );
    }

    return {
      target: {
        kind: 'behavior',
        objectName: object.getName(),
        objectType: object.getType(),
        objectScope,
        behaviorName,
        behaviorType,
        ...(scene ? { sceneName: scene.getName() } : {}),
      },
      properties: directProperties,
      sharedProperties,
      authoritativeActions: getBehaviorActions(behaviorType),
    };
  };

  const describeInstance = (input: any): any => {
    const { scene, instance } = requireInstance(input);
    const properties = INSTANCE_PROPERTY_SPECS.map(spec => ({
      name: spec.name,
      path: `instance.${spec.name}`,
      layer: 'instance',
      descriptorType: spec.valueType,
      valueType: spec.valueType,
      currentValue: instance[spec.getter](),
      writable: true,
      readOnlyReason: null,
      constraints: {
        ...(typeof spec.minimum === 'number' ? { minimum: spec.minimum } : {}),
        ...(typeof spec.maximum === 'number' ? { maximum: spec.maximum } : {}),
      },
      mutation: {
        command: 'objects.properties.set',
        path: `instance.${spec.name}`,
        backend: {
          kind: 'native-initial-instance-setter',
          setter: spec.setter,
        },
      },
    }));
    properties.unshift(
      {
        name: 'id',
        path: 'instance.id',
        layer: 'instance',
        descriptorType: 'string',
        valueType: 'string',
        currentValue: instance.getPersistentUuid(),
        writable: false,
        readOnlyReason: 'persistent-identity',
        constraints: {},
        mutation: null,
      },
      {
        name: 'objectName',
        path: 'instance.objectName',
        layer: 'instance',
        descriptorType: 'string',
        valueType: 'string',
        currentValue: instance.getObjectName(),
        writable: false,
        readOnlyReason: 'instance-object-identity',
        constraints: {},
        mutation: null,
      }
    );

    let object = null;
    if (scene.getObjects().hasObjectNamed(instance.getObjectName())) {
      object = scene.getObjects().getObject(instance.getObjectName());
    } else if (
      requireProject()
        .getObjects()
        .hasObjectNamed(instance.getObjectName())
    ) {
      object = requireProject()
        .getObjects()
        .getObject(instance.getObjectName());
    }
    const customPropertyMap = instance.getCustomProperties(
      requireProject().getObjects(),
      scene.getObjects()
    );
    const customProperties = customPropertyMap
      .keys()
      .toJSArray()
      .sort((left, right) => left.localeCompare(right))
      .map(name => {
        const customProperty = customPropertyMap.get(name);
        return serializeDescriptorProperty({
          name,
          descriptor: customProperty,
          path: `instance.custom.${name}`,
          layer: 'instance',
          backend: {
            kind: 'native-initial-instance-custom-property',
            propertyName: name,
          },
        });
      });
    properties.push(...customProperties);

    const behaviors = object
      ? describeAttachedBehaviors({ object, scene })
      : [];

    return {
      target: {
        kind: 'scene-instance',
        sceneName: scene.getName(),
        instanceId: instance.getPersistentUuid(),
        objectName: instance.getObjectName(),
        ...(object ? { objectType: object.getType() } : {}),
      },
      properties,
      behaviors,
      runtimeOnlyProperties: makeRuntimeOnlyProperties(behaviors),
    };
  };

  const describe = (input: any): any => {
    const targetKind = input.targetKind || 'object-definition';
    let result;
    if (targetKind === 'object-definition') {
      result = describeDefinition(input);
    } else if (targetKind === 'scene-instance') {
      result = describeInstance(input);
    } else if (targetKind === 'behavior') {
      result = describeBehavior(input);
    } else {
      throw new AgentError({
        code: 'invalid_property_target',
        field: 'targetKind',
        details: {
          field: 'targetKind',
          allowedValues: ['object-definition', 'scene-instance', 'behavior'],
        },
      });
    }

    return {
      ...result,
      schemaSource: 'connected-build-live-descriptors',
      forwardCompatibility:
        'Unknown extension/custom-object property names are discovered from live gdPropertyDescriptor maps. Unknown descriptor types remain string-serialized instead of being dropped.',
      mutationContract: {
        command: 'objects.properties.set',
        changes: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['path', 'value'],
            additionalProperties: false,
            properties: {
              path: { type: 'string', minLength: 1 },
              value: {
                anyOf: [
                  { type: 'string' },
                  { type: 'number' },
                  { type: 'boolean' },
                ],
              },
            },
          },
        },
        legacyChangedProperties: {
          shape: {
            type: 'array',
            items: {
              type: 'object',
              required: ['property_name', 'new_value'],
              additionalProperties: false,
              properties: {
                property_name: { type: 'string', minLength: 1 },
                new_value: { type: 'string' },
              },
            },
          },
          definitionCommand: 'editor.functions.change-object-property',
          behaviorCommand: 'editor.functions.change-behavior-property',
        },
        concurrencyAndSafety:
          'Mutations use AgentHost project revision, semantic revisions, idempotency and active transaction ownership metadata.',
      },
    };
  };

  const findPropertyForMutation = (
    described: any,
    path: string,
    field: string
  ): any => {
    const candidateCollections = [
      described.properties,
      described.sharedProperties,
    ].filter(Array.isArray);
    const allProperties = [].concat(...candidateCollections);
    const property = allProperties.find(candidate => candidate.path === path);
    if (property && property.writable) return property;

    const nonWritable =
      property ||
      (Array.isArray(described.runtimeOnlyProperties)
        ? described.runtimeOnlyProperties.find(
            candidate => candidate.path === path
          )
        : null);
    if (nonWritable) {
      throw new AgentError({
        code: 'unsupported_property_mutation',
        message: `${path} is not writable through generic typed property mutation.`,
        field,
        path,
        hint:
          nonWritable.authoritativeMutation &&
          nonWritable.authoritativeMutation.guidance
            ? nonWritable.authoritativeMutation.guidance
            : 'Use the authoritative mutation path returned by objects.properties.describe.',
        details: {
          field,
          path,
          reason: nonWritable.readOnlyReason || 'read-only',
          authoritativeMutation: nonWritable.authoritativeMutation || null,
        },
      });
    }

    throw new AgentError({
      code: 'unknown_property_path',
      message: `Unknown property path: ${path}.`,
      field,
      path,
      details: {
        field,
        path,
        availablePaths: allProperties
          .filter(candidate => candidate.writable)
          .map(candidate => candidate.path),
        runtimeOnlyPaths: Array.isArray(described.runtimeOnlyProperties)
          ? described.runtimeOnlyProperties.map(candidate => candidate.path)
          : [],
      },
    });
  };

  const assertChanges = (changes: any): Array<any> => {
    if (!Array.isArray(changes) || changes.length === 0) {
      throw new AgentError({
        code: 'invalid_property_changes',
        field: 'changes',
        details: { field: 'changes', expected: 'non-empty array' },
      });
    }
    return changes;
  };

  const mutateDefinitionOrBehavior = async ({
    input,
    described,
    validatedChanges,
    signal,
  }: any): Promise<any> => {
    const target = described.target;
    const isBehavior = target.kind === 'behavior';
    const functionName = isBehavior
      ? 'change_behavior_property'
      : 'change_object_property';
    const args = {
      object_name: target.objectName,
      changed_properties: validatedChanges.map(change => ({
        property_name: change.property.name,
        new_value: serializeValue(change.value, change.property.valueType),
      })),
      ...(target.objectScope === 'scene' && target.sceneName
        ? { scene_name: target.sceneName }
        : {}),
      ...(isBehavior ? { behavior_name: target.behaviorName } : {}),
    };
    const execution = await editorFunctionService.run({
      signal,
      save: false,
      calls: [{ name: functionName, arguments: args }],
    });
    const failedResult = Array.isArray(execution.results)
      ? execution.results.find(
          result =>
            result && result.status === 'finished' && result.success === false
        )
      : null;
    if (failedResult) {
      throw new AgentError({
        code: 'property_mutation_failed',
        message:
          'The canonical EditorFunction rejected the preflighted property mutation.',
        details: {
          functionName,
          target,
          output: failedResult.output,
        },
      });
    }
    const noChangeResult = Array.isArray(execution.results)
      ? execution.results.find(
          result =>
            result &&
            result.status === 'finished' &&
            result.success === true &&
            result.output &&
            result.output.nothingChanged === true
        )
      : null;
    const requestedBehaviorChanges = isBehavior
      ? validatedChanges.filter(
          change => change.property.currentValue !== change.value
        )
      : [];
    if (noChangeResult && requestedBehaviorChanges.length > 0) {
      const firstRejectedChange = requestedBehaviorChanges[0];
      throw new AgentError({
        code: 'property_mutation_failed',
        message:
          'The canonical behavior EditorFunction did not apply the requested property mutation.',
        field: `${firstRejectedChange.field}.value`,
        path: firstRejectedChange.property.path,
        details: {
          field: `${firstRejectedChange.field}.value`,
          path: firstRejectedChange.property.path,
          functionName,
          target,
          reason: 'editor-function-nothing-changed',
          output: noChangeResult.output,
          requestedChanges: requestedBehaviorChanges.map(change => ({
            path: change.property.path,
            before: change.property.currentValue,
            requested: change.value,
          })),
        },
      });
    }
    return {
      backend: {
        kind: 'editor-function',
        functionName,
        command: isBehavior
          ? 'editor.functions.change-behavior-property'
          : 'editor.functions.change-object-property',
        arguments: args,
      },
      execution,
    };
  };

  const mutateInstance = ({ input, described, validatedChanges }: any): any => {
    const { scene, instance } = requireInstance({
      sceneName: described.target.sceneName,
      instanceId: described.target.instanceId,
      objectName: described.target.objectName,
    });

    validatedChanges.forEach(change => {
      const spec = INSTANCE_PROPERTY_SPECS.find(
        candidate => `instance.${candidate.name}` === change.property.path
      );
      if (!spec) {
        const backend =
          change.property.mutation && change.property.mutation.backend;
        if (
          backend &&
          backend.kind === 'native-initial-instance-custom-property' &&
          typeof backend.propertyName === 'string'
        ) {
          const serializedValue = serializeValue(
            change.value,
            change.property.valueType
          );
          instance.updateCustomProperty(
            backend.propertyName,
            serializedValue,
            requireProject().getObjects(),
            scene.getObjects()
          );
          const propertiesAfterUpdate = instance.getCustomProperties(
            requireProject().getObjects(),
            scene.getObjects()
          );
          const updated =
            propertiesAfterUpdate.has(backend.propertyName) &&
            deserializeValue(
              propertiesAfterUpdate.get(backend.propertyName).getValue(),
              change.property.valueType
            ) === change.value;
          if (!updated) {
            throw new AgentError({
              code: 'property_mutation_failed',
              field: change.field,
              path: change.property.path,
              details: {
                field: change.field,
                path: change.property.path,
                backend,
                reason: 'initial-instance-custom-property-rejected',
              },
            });
          }
          return;
        }
        throw new AgentError({
          code: 'unsupported_property_mutation',
          field: change.field,
          path: change.property.path,
          details: {
            field: change.field,
            path: change.property.path,
            reason: 'no-native-instance-setter',
          },
        });
      }
      if (
        spec.name === 'layer' &&
        change.value !== '' &&
        !scene.getLayers().hasLayerNamed(change.value)
      ) {
        throw new AgentError({
          code: 'invalid_property_value',
          field: change.field,
          path: change.property.path,
          details: {
            field: change.field,
            path: change.property.path,
            reason: 'layer-not-found',
            sceneName: scene.getName(),
            actualValue: change.value,
          },
        });
      }
      instance[spec.setter](change.value);
    });

    triggerUnsavedChanges();
    forceUpdate();
    onInstancesModifiedOutsideEditor({ scene });
    return {
      backend: {
        kind: 'native-initial-instance-mutation',
        operations: validatedChanges.map(
          change => change.property.mutation.backend
        ),
      },
    };
  };

  const set = async (input: any, requestContext: any = {}): Promise<any> => {
    const described = describe(input);
    const changes = assertChanges(input.changes);
    const seenPaths = new Set();
    const validatedChanges = changes.map((change, index) => {
      const field = `changes[${index}]`;
      if (!change || typeof change !== 'object' || Array.isArray(change)) {
        throw new AgentError({
          code: 'invalid_property_change',
          field,
          details: { field, expected: 'object' },
        });
      }
      const pathField = `${field}.path`;
      const path = requireString(change.path, pathField);
      if (seenPaths.has(path)) {
        throw new AgentError({
          code: 'invalid_property_change',
          message: `Duplicate property path: ${path}.`,
          field: pathField,
          path,
          details: { field: pathField, path, reason: 'duplicate-path' },
        });
      }
      seenPaths.add(path);
      if (!Object.prototype.hasOwnProperty.call(change, 'value')) {
        throw new AgentError({
          code: 'invalid_property_change',
          field: `${field}.value`,
          path,
          details: { field: `${field}.value`, path, reason: 'missing-value' },
        });
      }
      const property = findPropertyForMutation(described, path, pathField);
      validateTypedValue({
        property,
        value: change.value,
        field: `${field}.value`,
      });
      return { property, value: change.value, field };
    });

    const mutation =
      described.target.kind === 'scene-instance'
        ? mutateInstance({ input, described, validatedChanges })
        : await mutateDefinitionOrBehavior({
            input,
            described,
            validatedChanges,
            signal: requestContext && requestContext.signal,
          });

    const after = describe({
      ...input,
      changes: undefined,
    });
    return {
      updated: true,
      target: after.target,
      applied: validatedChanges.map(change => ({
        path: change.property.path,
        value: change.value,
        authoritativeBackend: change.property.mutation.backend,
      })),
      mutation,
      after,
    };
  };

  return { describe, set };
};

export const objectPropertyInternals = {
  INSTANCE_PROPERTY_SPECS,
  normalizeDescriptorType,
  deserializeValue,
  serializeValue,
  validateTypedValue,
};
