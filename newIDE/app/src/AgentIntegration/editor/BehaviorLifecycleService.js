// @flow
import { AgentError } from '../core/AgentError';

const gd: libGDevelop = global.gd;

const requireString = (value: any, field: string): string => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AgentError({
      code: 'missing_behavior_lifecycle_field',
      field,
      details: { field },
    });
  }
  return value.trim();
};

const toSortedStrings = (vector: any): Array<string> =>
  vector && typeof vector.toJSArray === 'function'
    ? vector
        .toJSArray()
        .map(String)
        .sort((left, right) => left.localeCompare(right))
    : [];

const iterateInstances = (
  instances: gdInitialInstancesContainer,
  callback: gdInitialInstance => void
) => {
  const functor = new gd.InitialInstanceJSFunctor();
  // $FlowFixMe[cannot-write]
  functor.invoke = instancePtr => {
    callback(gd.wrapPointer(instancePtr, gd.InitialInstance));
  };
  instances.iterateOverInstances(functor);
  functor.delete();
};

const compactOperation = (record: any): any => ({
  kind: record.kind,
  id: record.id,
  displayName: record.displayName,
  description: record.description,
  group: record.group,
  deprecated: !!record.deprecated,
  parameters: record.parameters || [],
  requirements: record.requirements || null,
  discovery: record.discovery || {
    command: 'events.instructions.describe',
    arguments: {
      id: record.id,
      kind: record.kind,
      behaviorType:
        record.scope && record.scope.behaviorType
          ? record.scope.behaviorType
          : undefined,
    },
  },
  authoring: record.authoring || {
    command: 'events.patch',
    instructionId: record.id,
  },
});

export const createBehaviorLifecycleService = ({
  project,
  metadataDiscoveryService,
  objectPropertyService,
  triggerUnsavedChanges,
  forceUpdate,
  onObjectsModifiedOutsideEditor,
}: {|
  project: gdProject,
  metadataDiscoveryService: any,
  objectPropertyService: any,
  triggerUnsavedChanges: () => void,
  forceUpdate: () => void,
  onObjectsModifiedOutsideEditor?: any,
|}) => {
  const platform = project.getCurrentPlatform();

  const resolveObject = (input: any) => {
    const objectName = requireString(input && input.objectName, 'objectName');
    const requestedScope =
      input && typeof input.objectScope === 'string'
        ? input.objectScope
        : 'auto';
    if (!['auto', 'global', 'scene'].includes(requestedScope)) {
      throw new AgentError({
        code: 'invalid_behavior_object_scope',
        field: 'objectScope',
        details: {
          field: 'objectScope',
          allowedValues: ['auto', 'global', 'scene'],
        },
      });
    }

    const sceneName =
      input && typeof input.sceneName === 'string' && input.sceneName
        ? input.sceneName
        : null;
    let scene = null;
    if (sceneName) {
      if (!project.hasLayoutNamed(sceneName)) {
        throw new AgentError({
          code: 'scene_not_found',
          field: 'sceneName',
          details: { sceneName },
        });
      }
      scene = project.getLayout(sceneName);
      if (
        requestedScope !== 'global' &&
        scene.getObjects().hasObjectNamed(objectName)
      ) {
        return {
          object: scene.getObjects().getObject(objectName),
          objectScope: 'scene',
          scene,
        };
      }
      if (requestedScope === 'scene') {
        throw new AgentError({
          code: 'object_not_found',
          field: 'objectName',
          details: { objectName, objectScope: 'scene', sceneName },
        });
      }
    } else if (requestedScope === 'scene') {
      throw new AgentError({
        code: 'missing_behavior_lifecycle_field',
        field: 'sceneName',
        details: { field: 'sceneName', objectScope: 'scene' },
      });
    }

    if (project.getObjects().hasObjectNamed(objectName)) {
      return {
        object: project.getObjects().getObject(objectName),
        objectScope: 'global',
        scene: null,
      };
    }

    throw new AgentError({
      code: 'object_not_found',
      field: 'objectName',
      details: {
        objectName,
        objectScope: requestedScope,
        ...(sceneName ? { sceneName } : {}),
      },
    });
  };

  const describeType = (behaviorType: string): any =>
    metadataDiscoveryService.describeBehaviorType({
      type: requireString(behaviorType, 'behaviorType'),
    }).item;

  const getObjectMetadata = (objectType: string): ?gdObjectMetadata => {
    const metadata = gd.MetadataProvider.getObjectMetadata(
      platform,
      objectType
    );
    return gd.MetadataProvider.isBadObjectMetadata(metadata) ? null : metadata;
  };

  const getDefaultBehaviorTypes = (objectType: string): Array<string> => {
    const metadata = getObjectMetadata(objectType);
    if (!metadata) return [];
    const defaults = metadata.getDefaultBehaviors();
    return defaults && typeof defaults.toNewVectorString === 'function'
      ? defaults
          .toNewVectorString()
          .toJSArray()
          .map(String)
          .sort((left, right) => left.localeCompare(right))
      : [];
  };

  const findBehaviorNamesByType = (
    object: gdObject,
    behaviorType: string
  ): Array<string> =>
    toSortedStrings(object.getAllBehaviorNames()).filter(
      name => object.getBehavior(name).getTypeName() === behaviorType
    );

  const findMissingRequiredCapabilities = (
    object: gdObject,
    typeRecord: any
  ): Array<any> => {
    const attachedTypes = new Set(
      toSortedStrings(object.getAllBehaviorNames()).map(name =>
        object.getBehavior(name).getTypeName()
      )
    );
    return (typeRecord.requiredBehaviors || [])
      .filter(required => required.capability === true)
      .filter(required => !attachedTypes.has(required.type))
      .map(required => ({
        type: required.type,
        fullName: required.fullName,
      }));
  };

  const getCompatibility = (object: gdObject, typeRecord: any): any => {
    const behaviorType = typeRecord.type;
    const objectType = object.getType();
    const attachedNames = findBehaviorNamesByType(object, behaviorType);
    const defaultBehaviorTypes = getDefaultBehaviorTypes(objectType);
    const nativeCompatible = gd.ObjectTools.isBehaviorCompatibleWithObject(
      platform,
      objectType,
      behaviorType
    );
    const missingRequiredCapabilities = findMissingRequiredCapabilities(
      object,
      typeRecord
    );
    const diagnostics = [];

    if (typeRecord.objectType && typeRecord.objectType !== objectType) {
      diagnostics.push({
        code: 'behavior_object_type_mismatch',
        field: 'behaviorType',
        expectedObjectType: typeRecord.objectType,
        actualObjectType: objectType,
      });
    }
    missingRequiredCapabilities.forEach(required => {
      diagnostics.push({
        code: 'missing_required_capability',
        field: 'behaviorType',
        requiredBehaviorType: required.type,
        requiredBehaviorFullName: required.fullName,
      });
    });
    if (!nativeCompatible && diagnostics.length === 0) {
      diagnostics.push({
        code: 'behavior_incompatible_with_object',
        field: 'behaviorType',
        objectType,
        behaviorType,
      });
    }

    const capability = !!(
      typeRecord.capabilityInterface || typeRecord.hidden === true
    );
    const providedByObjectType = defaultBehaviorTypes.includes(behaviorType);
    if (capability && !providedByObjectType) {
      diagnostics.push({
        code: 'capability_not_provided_by_object_type',
        behaviorType,
        objectType,
        defaultBehaviorTypes,
      });
    }

    return {
      nativeCompatible,
      compatible: nativeCompatible,
      attachable:
        nativeCompatible &&
        missingRequiredCapabilities.length === 0 &&
        (!capability || providedByObjectType),
      capability,
      providedByObjectType,
      defaultBehaviorTypes,
      attachedNames,
      missingRequiredCapabilities,
      diagnostics,
      authoritativeCheck:
        'gd.ObjectTools.isBehaviorCompatibleWithObject(connectedPlatform, objectType, behaviorType)',
    };
  };

  const getOperations = (behaviorType: string): any => {
    const search = kind => {
      try {
        const result = metadataDiscoveryService.searchInstructions({
          kind,
          behaviorType,
          deprecated: 'include',
          includeHidden: true,
          limit: 100,
          offset: 0,
        });
        return (result.items || []).map(compactOperation);
      } catch (error) {
        return [];
      }
    };
    return {
      actions: search('action'),
      conditions: search('condition'),
      expressions: search('expression'),
      discovery: {
        command: 'events.instructions.search',
        arguments: { behaviorType },
        describeCommand: 'events.instructions.describe',
        authoringCommand: 'events.patch',
      },
    };
  };

  const getInstanceOverrides = (
    objectName: string,
    behaviorNames: Array<string>,
    objectScope: string,
    scopedScene: ?gdLayout
  ): Array<any> => {
    const names = new Set(behaviorNames);
    const results = [];
    const inspectScene = scene => {
      iterateInstances(scene.getInitialInstances(), instance => {
        if (instance.getObjectName() !== objectName) return;
        names.forEach(behaviorName => {
          if (!instance.hasBehaviorOverridingNamed(behaviorName)) return;
          results.push({
            sceneName: scene.getName(),
            instanceId: instance.getPersistentUuid(),
            objectName,
            behaviorName,
          });
        });
      });
    };
    if (objectScope === 'scene' && scopedScene) {
      inspectScene(scopedScene);
    } else {
      for (let index = 0; index < project.getLayoutsCount(); index++) {
        inspectScene(project.getLayoutAt(index));
      }
    }
    return results.sort((left, right) =>
      [left.sceneName, left.instanceId, left.behaviorName]
        .join('|')
        .localeCompare(
          [right.sceneName, right.instanceId, right.behaviorName].join('|')
        )
    );
  };

  const notifyStructuralMutation = ({ objectScope, scene }: any) => {
    if (objectScope === 'scene' && scene) {
      scene.updateBehaviorsSharedData(project);
    } else {
      gd.WholeProjectRefactorer.updateBehaviorsSharedData(project);
    }
    triggerUnsavedChanges();
    forceUpdate();
    if (objectScope === 'scene' && scene && onObjectsModifiedOutsideEditor) {
      onObjectsModifiedOutsideEditor({
        scene,
        isNewObjectTypeUsed: false,
      });
    }
  };

  const serializeAttachedBehavior = ({
    object,
    behaviorName,
    objectScope,
    scene,
    includeOperations = false,
  }: any): any => {
    const behavior = object.getBehavior(behaviorName);
    const behaviorType = behavior.getTypeName();
    const typeRecord = describeType(behaviorType);
    const propertySchema = objectPropertyService.describe({
      targetKind: 'behavior',
      objectName: object.getName(),
      objectScope,
      ...(scene ? { sceneName: scene.getName() } : {}),
      behaviorName,
    });
    const dependentBehaviorNames = gd.WholeProjectRefactorer.findDependentBehaviorNames(
      project,
      object,
      behaviorName
    ).toJSArray();
    const defaultBehaviorTypes = getDefaultBehaviorTypes(object.getType());
    const capability = !!(
      typeRecord.capabilityInterface || typeRecord.hidden === true
    );

    return {
      name: behaviorName,
      type: behaviorType,
      defaultBehavior:
        behavior.isDefaultBehavior() ||
        defaultBehaviorTypes.includes(behaviorType),
      capability,
      capabilityInterface: capability
        ? {
            ...(typeRecord.capabilityInterface || {
              kind: 'hidden-behavior-capability',
              behaviorType,
            }),
            providedByObjectType: defaultBehaviorTypes.includes(behaviorType),
          }
        : null,
      extension: typeRecord.extension,
      metadata: {
        fullName: typeRecord.fullName,
        description: typeRecord.description,
        requiredBehaviorTypes: typeRecord.requiredBehaviorTypes || [],
        requiredCapabilityTypes: typeRecord.requiredCapabilityTypes || [],
        compatibilityRules: typeRecord.compatibilityRules,
      },
      dependencies: {
        requiredBehaviorTypes: typeRecord.requiredBehaviorTypes || [],
        dependentBehaviorNames: dependentBehaviorNames
          .map(String)
          .sort((left, right) => left.localeCompare(right)),
      },
      properties: propertySchema.properties || [],
      sharedProperties: propertySchema.sharedProperties || [],
      propertyDiscovery: {
        command: 'objects.properties.describe',
        arguments: {
          targetKind: 'behavior',
          objectName: object.getName(),
          objectScope,
          ...(scene ? { sceneName: scene.getName() } : {}),
          behaviorName,
        },
      },
      propertyMutation: {
        command: 'objects.behaviors.update',
        delegatesTo: 'objects.properties.set',
      },
      operations: includeOperations ? getOperations(behaviorType) : null,
      operationDiscovery: typeRecord.operationDiscovery,
    };
  };

  const list = (input: any = {}): any => {
    const { object, objectScope, scene } = resolveObject(input);
    const names = toSortedStrings(object.getAllBehaviorNames());
    const items = names.map(behaviorName =>
      serializeAttachedBehavior({
        object,
        behaviorName,
        objectScope,
        scene,
        includeOperations: false,
      })
    );
    return {
      target: {
        objectName: object.getName(),
        objectType: object.getType(),
        objectScope,
        ...(scene ? { sceneName: scene.getName() } : {}),
      },
      items,
      summary: {
        total: items.length,
        capabilities: items.filter(item => item.capability).length,
        configurable: items.filter(
          item => item.properties.length || item.sharedProperties.length
        ).length,
      },
      capabilityInterfaces: items
        .filter(item => item.capability)
        .map(item => ({
          behaviorName: item.name,
          behaviorType: item.type,
          interface: item.capabilityInterface,
          operationDiscovery: item.operationDiscovery,
        })),
    };
  };

  const available = (input: any = {}): any => {
    const { object, objectScope, scene } = resolveObject(input);
    const allItems = [];
    let offset = 0;
    do {
      const page = metadataDiscoveryService.listBehaviorTypes({
        query: input.query || '',
        deprecated: input.deprecated || 'exclude',
        includeHidden:
          input.includeCapabilities === true || input.includeHidden === true,
        limit: 100,
        offset,
      });
      (page.items || []).forEach(typeRecord => {
        const compatibility = getCompatibility(object, typeRecord);
        if (input.compatibleOnly !== false && !compatibility.compatible) return;
        allItems.push({
          ...typeRecord,
          compatibility,
          attachment: {
            attachedNames: compatibility.attachedNames,
            alreadyAttached: compatibility.attachedNames.length > 0,
            providedByObjectType: compatibility.providedByObjectType,
            addable:
              compatibility.attachable &&
              compatibility.attachedNames.length === 0,
          },
        });
      });
      if (page.nextOffset === null || page.nextOffset === undefined) break;
      offset = page.nextOffset;
    } while (offset < 10000);

    const rawOffset = Number(input.offset);
    const rawLimit = Number(input.limit);
    const resultOffset = Number.isFinite(rawOffset)
      ? Math.max(0, Math.round(rawOffset))
      : 0;
    const limit = Number.isFinite(rawLimit)
      ? Math.min(100, Math.max(1, Math.round(rawLimit)))
      : 25;
    const items = allItems.slice(resultOffset, resultOffset + limit);
    return {
      target: {
        objectName: object.getName(),
        objectType: object.getType(),
        objectScope,
        ...(scene ? { sceneName: scene.getName() } : {}),
      },
      items,
      total: allItems.length,
      offset: resultOffset,
      limit,
      nextOffset:
        resultOffset + items.length < allItems.length
          ? resultOffset + items.length
          : null,
      compatibilityAuthority: 'gd.ObjectTools.isBehaviorCompatibleWithObject',
      forwardCompatibility:
        'Candidates are enumerated from connected-build extension metadata on every call; extension/custom behavior types are not hardcoded.',
    };
  };

  const describe = (input: any): any => {
    const { object, objectScope, scene } = resolveObject(input);
    const behaviorName = requireString(input.behaviorName, 'behaviorName');
    if (!object.hasBehaviorNamed(behaviorName)) {
      throw new AgentError({
        code: 'behavior_not_found',
        field: 'behaviorName',
        details: {
          objectName: object.getName(),
          behaviorName,
        },
      });
    }
    const item = serializeAttachedBehavior({
      object,
      behaviorName,
      objectScope,
      scene,
      includeOperations: true,
    });
    return {
      target: {
        objectName: object.getName(),
        objectType: object.getType(),
        objectScope,
        ...(scene ? { sceneName: scene.getName() } : {}),
      },
      behavior: item,
      instanceOverrides: getInstanceOverrides(
        object.getName(),
        [behaviorName],
        objectScope,
        scene
      ),
      referenceCoverage: {
        requiredBehaviorDependencies: 'authoritative',
        initialInstanceOverrides: 'authoritative',
        eventInstructionReferences:
          'not-exposed-as-attached-behavior-name-reference-by-current-libgd-binding',
      },
    };
  };

  const add = (input: any): any => {
    const { object, objectScope, scene } = resolveObject(input);
    const behaviorType = requireString(input.behaviorType, 'behaviorType');
    const typeRecord = describeType(behaviorType);
    const behaviorName =
      typeof input.behaviorName === 'string' && input.behaviorName.trim()
        ? input.behaviorName.trim()
        : typeRecord.defaultName || typeRecord.name || behaviorType;
    const compatibility = getCompatibility(object, typeRecord);

    if (object.hasBehaviorNamed(behaviorName)) {
      const existing = object.getBehavior(behaviorName);
      if (existing.getTypeName() === behaviorType) {
        return {
          added: false,
          alreadyAttached: true,
          identityPreserved: true,
          compatibility,
          behavior: serializeAttachedBehavior({
            object,
            behaviorName,
            objectScope,
            scene,
            includeOperations: true,
          }),
        };
      }
      throw new AgentError({
        code: 'behavior_name_already_exists',
        field: 'behaviorName',
        details: {
          objectName: object.getName(),
          behaviorName,
          requestedBehaviorType: behaviorType,
          existingBehaviorType: existing.getTypeName(),
        },
      });
    }

    if (compatibility.capability) {
      const existingNames = compatibility.attachedNames;
      if (existingNames.length) {
        return {
          added: false,
          alreadyAttached: true,
          providedByObjectType: compatibility.providedByObjectType,
          behavior: serializeAttachedBehavior({
            object,
            behaviorName: existingNames[0],
            objectScope,
            scene,
            includeOperations: true,
          }),
          compatibility,
        };
      }
      if (!compatibility.providedByObjectType) {
        throw new AgentError({
          code: 'capability_managed_by_object_type',
          field: 'behaviorType',
          message:
            'Hidden capability behaviors may only be restored when the connected object-type metadata declares them as a default capability.',
          details: {
            behaviorType,
            objectType: object.getType(),
            defaultBehaviorTypes: compatibility.defaultBehaviorTypes,
            compatibility,
          },
          hint:
            'Choose an object type that provides this capability, or configure the corresponding custom-object capability setting when applicable.',
        });
      }
    }

    if (!compatibility.nativeCompatible || !compatibility.attachable) {
      throw new AgentError({
        code: 'behavior_incompatible_with_object',
        field: 'behaviorType',
        details: {
          behaviorType,
          objectType: object.getType(),
          compatibility,
        },
      });
    }

    gd.WholeProjectRefactorer.addBehaviorAndRequiredBehaviors(
      project,
      object,
      behaviorType,
      behaviorName
    );
    if (!object.hasBehaviorNamed(behaviorName)) {
      throw new AgentError({
        code: 'behavior_add_failed',
        details: {
          objectName: object.getName(),
          behaviorName,
          behaviorType,
        },
      });
    }
    notifyStructuralMutation({ objectScope, scene });

    return {
      added: true,
      alreadyAttached: false,
      compatibility,
      behavior: serializeAttachedBehavior({
        object,
        behaviorName,
        objectScope,
        scene,
        includeOperations: true,
      }),
    };
  };

  const update = async (input: any, requestContext?: any): Promise<any> => {
    const { object, objectScope, scene } = resolveObject(input);
    const behaviorName = requireString(input.behaviorName, 'behaviorName');
    if (!object.hasBehaviorNamed(behaviorName)) {
      throw new AgentError({
        code: 'behavior_not_found',
        field: 'behaviorName',
        details: { objectName: object.getName(), behaviorName },
      });
    }
    const changes = Array.isArray(input.changes) ? input.changes : [];
    if (!changes.length) {
      throw new AgentError({
        code: 'missing_behavior_property_changes',
        field: 'changes',
      });
    }
    const mutation = await objectPropertyService.set(
      {
        targetKind: 'behavior',
        objectName: object.getName(),
        objectScope,
        ...(scene ? { sceneName: scene.getName() } : {}),
        behaviorName,
        changes,
      },
      requestContext
    );
    return {
      updated: true,
      delegatedTo: 'objects.properties.set',
      mutation,
      behavior: serializeAttachedBehavior({
        object,
        behaviorName,
        objectScope,
        scene,
        includeOperations: false,
      }),
    };
  };

  const remove = (input: any): any => {
    const { object, objectScope, scene } = resolveObject(input);
    const behaviorName = requireString(input.behaviorName, 'behaviorName');
    if (!object.hasBehaviorNamed(behaviorName)) {
      throw new AgentError({
        code: 'behavior_not_found',
        field: 'behaviorName',
        details: { objectName: object.getName(), behaviorName },
      });
    }
    const behavior = object.getBehavior(behaviorName);
    const behaviorType = behavior.getTypeName();
    const dependentBehaviorNames = gd.WholeProjectRefactorer.findDependentBehaviorNames(
      project,
      object,
      behaviorName
    )
      .toJSArray()
      .map(String)
      .sort((left, right) => left.localeCompare(right));
    const removalNames = [behaviorName, ...dependentBehaviorNames];
    const instanceOverrides = getInstanceOverrides(
      object.getName(),
      removalNames,
      objectScope,
      scene
    );
    const diagnostics = [];

    const defaultBehavior =
      behavior.isDefaultBehavior() ||
      getDefaultBehaviorTypes(object.getType()).includes(behaviorType);
    if (defaultBehavior) {
      diagnostics.push({
        code: 'default_behavior_cannot_be_removed',
        behaviorName,
        behaviorType,
      });
    }
    if (dependentBehaviorNames.length && input.cascadeDependents !== true) {
      diagnostics.push({
        code: 'behavior_has_dependents',
        behaviorName,
        dependentBehaviorNames,
      });
    }
    if (instanceOverrides.length && input.removeInstanceOverrides !== true) {
      diagnostics.push({
        code: 'behavior_has_instance_overrides',
        behaviorName,
        instanceOverrides,
      });
    }

    const dryRun = input.dryRun !== false;
    const preflight = {
      dryRun,
      behaviorName,
      behaviorType,
      defaultBehavior,
      dependentBehaviorNames,
      instanceOverrides,
      diagnostics,
      removalNames,
      referenceCoverage: {
        requiredBehaviorDependencies: 'authoritative',
        initialInstanceOverrides: 'authoritative',
        eventInstructionReferences:
          'not-exposed-as-attached-behavior-name-reference-by-current-libgd-binding',
      },
      orderConstraints: {
        exposedByMetadata: false,
        diagnostics: [],
        note:
          'Connected behavior metadata exposes dependencies but no configurable behavior-order constraint contract.',
      },
    };

    if (dryRun) return { removed: false, preflight };
    if (diagnostics.length) {
      throw new AgentError({
        code: 'behavior_remove_blocked',
        details: preflight,
        hint:
          'Resolve the reported diagnostics or opt into cascadeDependents/removeInstanceOverrides where appropriate, then repeat dry-run.',
      });
    }

    if (input.removeInstanceOverrides === true && instanceOverrides.length) {
      instanceOverrides.forEach(reference => {
        const layout = project.getLayout(reference.sceneName);
        iterateInstances(layout.getInitialInstances(), instance => {
          if (instance.getPersistentUuid() !== reference.instanceId) return;
          if (instance.hasBehaviorOverridingNamed(reference.behaviorName)) {
            instance.removeBehaviorOverriding(reference.behaviorName);
          }
        });
      });
    }

    [...dependentBehaviorNames, behaviorName].forEach(name => {
      if (object.hasBehaviorNamed(name)) object.removeBehavior(name);
    });
    notifyStructuralMutation({ objectScope, scene });

    return {
      removed: true,
      removedBehaviorNames: removalNames,
      removedInstanceOverrides:
        input.removeInstanceOverrides === true ? instanceOverrides : [],
      preflight,
    };
  };

  return {
    list,
    available,
    describe,
    add,
    update,
    remove,
  };
};
