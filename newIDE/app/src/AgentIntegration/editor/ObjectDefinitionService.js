// @flow
import { AgentError } from '../core/AgentError';

const gd: libGDevelop = global.gd;

const requireString = (value: any, field: string): string => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AgentError({
      code: 'missing_object_definition_field',
      field,
      details: { field },
    });
  }
  return value.trim();
};

const canonicalSelector = (object: gdObject): string =>
  `object-definition:${object.getPersistentUuid()}`;

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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

const findObjectFolderNode = (
  node: gdObjectFolderOrObject,
  objectName: string
): ?gdObjectFolderOrObject => {
  if (!node.isFolder()) {
    return node.getObject().getName() === objectName ? node : null;
  }
  for (let index = 0; index < node.getChildrenCount(); index++) {
    const found = findObjectFolderNode(node.getChildAt(index), objectName);
    if (found) return found;
  }
  return null;
};

const clampIndex = (value: any, count: number): number =>
  Number.isInteger(value) ? Math.max(0, Math.min(value, count)) : count;

export const createObjectDefinitionService = ({
  project,
  eventTools,
  metadataDiscoveryService,
  objectPropertyService,
  objectGroupService,
  assetTools,
  triggerUnsavedChanges,
  forceUpdate,
  onObjectsModifiedOutsideEditor,
}: {|
  project: gdProject,
  eventTools: any,
  metadataDiscoveryService: any,
  objectPropertyService: any,
  objectGroupService: any,
  assetTools: any,
  triggerUnsavedChanges: () => void,
  forceUpdate: () => void,
  onObjectsModifiedOutsideEditor?: any,
|}) => {
  const requireScene = (sceneName: string): gdLayout => {
    if (!project.hasLayoutNamed(sceneName)) {
      throw new AgentError({
        code: 'scene_not_found',
        field: 'sceneName',
        details: { sceneName },
      });
    }
    return project.getLayout(sceneName);
  };

  const getScopeRecord = (scope: 'global' | 'scene', sceneName?: ?string) => {
    if (scope === 'global') {
      return {
        scope,
        scene: null,
        sceneName: null,
        objects: project.getObjects(),
      };
    }
    const resolvedSceneName = requireString(sceneName, 'sceneName');
    const scene = requireScene(resolvedSceneName);
    return {
      scope,
      scene,
      sceneName: resolvedSceneName,
      objects: scene.getObjects(),
    };
  };

  const scopeRecords = (input: any = {}): Array<any> => {
    const requested =
      input && typeof input.objectScope === 'string'
        ? input.objectScope
        : 'all';
    if (!['all', 'global', 'scene'].includes(requested)) {
      throw new AgentError({
        code: 'invalid_object_definition_scope',
        field: 'objectScope',
        details: {
          allowedValues: ['all', 'global', 'scene'],
          value: requested,
        },
      });
    }
    const records = [];
    if (requested !== 'scene') records.push(getScopeRecord('global'));
    if (requested !== 'global') {
      if (input && input.sceneName) {
        records.push(getScopeRecord('scene', input.sceneName));
      } else {
        for (let index = 0; index < project.getLayoutsCount(); index++) {
          const scene = project.getLayoutAt(index);
          records.push(getScopeRecord('scene', scene.getName()));
        }
      }
    }
    return records;
  };

  const findById = (objectId: string): ?any => {
    for (const record of scopeRecords({ objectScope: 'all' })) {
      for (let index = 0; index < record.objects.getObjectsCount(); index++) {
        const object = record.objects.getObjectAt(index);
        if (object.getPersistentUuid() === objectId) {
          return { ...record, object, objectName: object.getName() };
        }
      }
    }
    return null;
  };

  const resolveObject = (input: any): any => {
    const objectId =
      input && typeof input.objectId === 'string' && input.objectId.trim()
        ? input.objectId.trim()
        : null;
    if (objectId) {
      const byId = findById(objectId);
      if (!byId) {
        throw new AgentError({
          code: 'object_definition_not_found',
          field: 'objectId',
          details: { objectId },
        });
      }
      if (
        input &&
        typeof input.objectName === 'string' &&
        input.objectName &&
        input.objectName !== byId.objectName
      ) {
        throw new AgentError({
          code: 'stale_object_definition_target',
          field: 'objectName',
          details: {
            objectId,
            requestedObjectName: input.objectName,
            currentObjectName: byId.objectName,
          },
        });
      }
      return byId;
    }

    const objectName = requireString(input && input.objectName, 'objectName');
    const requested =
      input && typeof input.objectScope === 'string'
        ? input.objectScope
        : 'auto';
    if (!['auto', 'global', 'scene'].includes(requested)) {
      throw new AgentError({
        code: 'invalid_object_definition_scope',
        field: 'objectScope',
        details: {
          allowedValues: ['auto', 'global', 'scene'],
          value: requested,
        },
      });
    }
    const sceneName =
      input && typeof input.sceneName === 'string' && input.sceneName
        ? input.sceneName
        : null;

    if (requested !== 'global' && sceneName) {
      const local = getScopeRecord('scene', sceneName);
      if (local.objects.hasObjectNamed(objectName)) {
        return {
          ...local,
          object: local.objects.getObject(objectName),
          objectName,
        };
      }
      if (requested === 'scene') {
        throw new AgentError({
          code: 'object_definition_not_found',
          field: 'objectName',
          details: { objectName, objectScope: 'scene', sceneName },
        });
      }
    } else if (requested === 'scene') {
      throw new AgentError({
        code: 'missing_object_definition_field',
        field: 'sceneName',
        details: { field: 'sceneName', objectScope: 'scene' },
      });
    }

    const global = getScopeRecord('global');
    if (global.objects.hasObjectNamed(objectName)) {
      return {
        ...global,
        object: global.objects.getObject(objectName),
        objectName,
      };
    }

    throw new AgentError({
      code: 'object_definition_not_found',
      field: 'objectName',
      details: {
        objectName,
        objectScope: requested,
        ...(sceneName ? { sceneName } : {}),
      },
    });
  };

  const validateName = (name: string, field: string): string => {
    const safeName = gd.Project.getSafeName(requireString(name, field));
    if (safeName !== name) {
      throw new AgentError({
        code: 'invalid_object_definition_name',
        field,
        details: { value: name, safeName },
      });
    }
    return name;
  };

  const visibleNameConflict = (
    scope: 'global' | 'scene',
    sceneName: ?string,
    name: string,
    ignoreObjectId?: ?string
  ): ?any => {
    const inspect = (record, includeGroups = true) => {
      if (record.objects.hasObjectNamed(name)) {
        const object = record.objects.getObject(name);
        if (!ignoreObjectId || object.getPersistentUuid() !== ignoreObjectId) {
          return {
            kind: 'object-definition',
            objectId: object.getPersistentUuid(),
            scope: record.scope,
            ...(record.sceneName ? { sceneName: record.sceneName } : {}),
          };
        }
      }
      if (includeGroups && record.objects.getObjectGroups().has(name)) {
        return {
          kind: 'object-group',
          scope: record.scope,
          ...(record.sceneName ? { sceneName: record.sceneName } : {}),
        };
      }
      return null;
    };

    if (scope === 'scene') {
      const local = getScopeRecord('scene', sceneName);
      return inspect(local) || inspect(getScopeRecord('global'));
    }

    const globalConflict = inspect(getScopeRecord('global'));
    if (globalConflict) return globalConflict;
    for (let index = 0; index < project.getLayoutsCount(); index++) {
      const scene = project.getLayoutAt(index);
      const local = inspect(getScopeRecord('scene', scene.getName()));
      if (local) return local;
    }
    return null;
  };

  const notifyMutation = (
    record: any,
    { isNewObjectTypeUsed = false }: {| isNewObjectTypeUsed?: boolean |} = {}
  ) => {
    if (record.scope === 'scene' && record.scene) {
      record.scene.updateBehaviorsSharedData(project);
    } else {
      gd.WholeProjectRefactorer.updateBehaviorsSharedData(project);
    }
    triggerUnsavedChanges();
    forceUpdate();
    if (onObjectsModifiedOutsideEditor) {
      onObjectsModifiedOutsideEditor({
        scene: record.scene || null,
        isNewObjectTypeUsed,
      });
    }
  };

  const collectBehaviors = (object: gdObject): Array<any> =>
    object
      .getAllBehaviorNames()
      .toJSArray()
      .map(String)
      .sort((left, right) => left.localeCompare(right))
      .map(name => {
        const behavior = object.getBehavior(name);
        return {
          name,
          type: behavior.getTypeName(),
          defaultBehavior: behavior.isDefaultBehavior(),
        };
      });

  const collectResources = (object: gdObject): Array<any> => {
    const helper = new gd.ResourcesInUseHelper(project.getResourcesManager());
    try {
      object.getConfiguration().exposeResources(helper);
      return helper
        .getAllResources()
        .toJSArray()
        .map(String)
        .filter(Boolean)
        .sort((left, right) => left.localeCompare(right))
        .map(resourceName => {
          let visual = null;
          if (assetTools && assetTools.inspectVisualResource) {
            try {
              visual = assetTools.inspectVisualResource({ resourceName });
            } catch (error) {
              visual = null;
            }
          }
          return {
            resourceName,
            ...(visual
              ? {
                  visual: {
                    kind: visual.kind || null,
                    path: visual.path || visual.filePath || null,
                    dimensions: visual.dimensions || null,
                    sha256: visual.sha256 || null,
                  },
                }
              : {}),
            discovery: {
              command: 'resources.visual.inspect',
              arguments: { resourceName },
            },
          };
        });
    } finally {
      helper.delete();
    }
  };

  const serializeObject = (resolved: any, { detailed = true } = {}): any => {
    const object = resolved.object;
    const typeMetadata = metadataDiscoveryService.describeObjectType({
      type: object.getType(),
    }).item;
    return {
      identity: {
        kind: 'persistent-uuid',
        objectId: object.getPersistentUuid(),
        selector: canonicalSelector(object),
        stableAcrossRename: true,
        stableAcrossSupportedScopeMove: true,
      },
      name: object.getName(),
      type: object.getType(),
      scope: resolved.scope,
      ...(resolved.sceneName ? { sceneName: resolved.sceneName } : {}),
      position: resolved.objects.getObjectPosition(object.getName()),
      typeMetadata: {
        fullName: typeMetadata.fullName,
        category: typeMetadata.category,
        renderingMode: typeMetadata.renderingMode,
        extension: typeMetadata.extension,
        defaultBehaviors: typeMetadata.defaultBehaviors || [],
      },
      scopeTransitions: {
        promoteToGlobal: resolved.scope === 'scene',
        demoteToScene: false,
        demoteReason:
          resolved.scope === 'global'
            ? 'The native editor does not support moving a global object definition into one scene because other scenes may depend on it.'
            : null,
      },
      ...(detailed
        ? {
            behaviors: collectBehaviors(object),
            resources: collectResources(object),
            discovery: {
              properties: {
                command: 'objects.properties.describe',
                arguments: {
                  targetKind: 'object-definition',
                  objectName: object.getName(),
                  objectScope: resolved.scope,
                  ...(resolved.sceneName
                    ? { sceneName: resolved.sceneName }
                    : {}),
                },
              },
              behaviors: {
                command: 'objects.behaviors.list',
                arguments: {
                  objectName: object.getName(),
                  objectScope: resolved.scope,
                  ...(resolved.sceneName
                    ? { sceneName: resolved.sceneName }
                    : {}),
                },
              },
              groups: {
                command: 'objects.groups.for-object',
                arguments: {
                  objectName: object.getName(),
                  groupScope: 'all',
                  ...(resolved.sceneName
                    ? { sceneName: resolved.sceneName }
                    : {}),
                },
              },
              usages: {
                command: 'objects.definitions.usages',
                arguments: { objectId: object.getPersistentUuid() },
              },
            },
          }
        : {}),
    };
  };

  const list = (input: any = {}): any => {
    const items = [];
    scopeRecords(input).forEach(record => {
      for (let index = 0; index < record.objects.getObjectsCount(); index++) {
        items.push(
          serializeObject(
            {
              ...record,
              object: record.objects.getObjectAt(index),
            },
            { detailed: false }
          )
        );
      }
    });
    const query =
      input && typeof input.query === 'string'
        ? input.query.trim().toLowerCase()
        : '';
    const filtered = query
      ? items.filter(item =>
          [item.name, item.type, item.typeMetadata.fullName]
            .filter(Boolean)
            .some(value =>
              String(value)
                .toLowerCase()
                .includes(query)
            )
        )
      : items;
    const offset =
      Number.isInteger(input.offset) && input.offset >= 0 ? input.offset : 0;
    const limit =
      Number.isInteger(input.limit) && input.limit > 0
        ? Math.min(input.limit, 100)
        : 50;
    return {
      total: filtered.length,
      offset,
      limit,
      truncated: offset + limit < filtered.length,
      items: filtered.slice(offset, offset + limit),
      discovery: {
        get: 'objects.definitions.get',
        usages: 'objects.definitions.usages',
        objectTypes: 'editor.types.objects.list',
      },
    };
  };

  const get = (input: any): any => ({
    object: serializeObject(resolveObject(input)),
  });

  const instructionMetadataCache = new Map();
  const getParameterMetadata = (
    instruction: any,
    kind: 'condition' | 'action',
    index: number
  ): ?any => {
    const type = instruction && instruction.type;
    if (!type) return null;
    const cacheKey = `${kind}:${type}`;
    if (!instructionMetadataCache.has(cacheKey)) {
      let items = [];
      try {
        const result = metadataDiscoveryService.searchInstructions({
          kind,
          query: type,
          deprecated: 'include',
          includeHidden: true,
          limit: 100,
          offset: 0,
        });
        items = (result.items || []).filter(item => item.id === type);
      } catch (error) {
        items = [];
      }
      instructionMetadataCache.set(cacheKey, items);
    }
    const records = instructionMetadataCache.get(cacheKey) || [];
    const candidates = records
      .map(record =>
        Array.isArray(record.parameters) ? record.parameters[index] : null
      )
      .filter(Boolean);
    return (
      candidates.find(
        parameter => parameter.valueType && parameter.valueType.object
      ) ||
      candidates[0] ||
      null
    );
  };

  const flattenInstructionRecords = (events: Array<any>): Array<any> => {
    const output = [];
    const visitInstructions = (
      instructions,
      event,
      kind: 'condition' | 'action'
    ) => {
      (instructions || []).forEach(instruction => {
        output.push({ instruction, event, kind });
        visitInstructions(instruction.children || [], event, kind);
      });
    };
    const visitEvents = nodes => {
      (nodes || []).forEach(event => {
        visitInstructions(event.conditions || [], event, 'condition');
        visitInstructions(event.whileConditions || [], event, 'condition');
        visitInstructions(event.actions || [], event, 'action');
        visitEvents(event.children || []);
      });
    };
    visitEvents(events || []);
    return output;
  };

  const allEventTargets = (): Array<any> => {
    const targets = [];
    for (let index = 0; index < project.getLayoutsCount(); index++) {
      const scene = project.getLayoutAt(index);
      targets.push({
        target: { kind: 'scene', sceneName: scene.getName() },
        sceneName: scene.getName(),
        namespace: 'project-scene',
      });
    }
    for (let index = 0; index < project.getExternalEventsCount(); index++) {
      const externalEvents = project.getExternalEventsAt(index);
      targets.push({
        target: {
          kind: 'external-events',
          externalEventsName: externalEvents.getName(),
        },
        sceneName: externalEvents.getAssociatedLayout() || null,
        namespace: 'project-scene',
      });
    }

    const addFunctions = (extensionName, ownerKind, ownerName, container) => {
      for (
        let functionIndex = 0;
        functionIndex < container.getEventsFunctionsCount();
        functionIndex++
      ) {
        const eventsFunction = container.getEventsFunctionAt(functionIndex);
        targets.push({
          target: {
            kind: 'extension-function',
            extensionName,
            ownerKind,
            ...(ownerName ? { ownerName } : {}),
            functionName: eventsFunction.getName(),
          },
          sceneName: null,
          namespace: 'extension-function',
        });
      }
    };
    for (
      let extensionIndex = 0;
      extensionIndex < project.getEventsFunctionsExtensionsCount();
      extensionIndex++
    ) {
      const extension = project.getEventsFunctionsExtensionAt(extensionIndex);
      const extensionName = extension.getName();
      addFunctions(
        extensionName,
        'extension',
        null,
        extension.getEventsFunctions()
      );
      const behaviors = extension.getEventsBasedBehaviors();
      for (let index = 0; index < behaviors.getCount(); index++) {
        const behavior = behaviors.getAt(index);
        addFunctions(
          extensionName,
          'behavior',
          behavior.getName(),
          behavior.getEventsFunctions()
        );
      }
      const objects = extension.getEventsBasedObjects();
      for (let index = 0; index < objects.getCount(); index++) {
        const object = objects.getAt(index);
        addFunctions(
          extensionName,
          'object',
          object.getName(),
          object.getEventsFunctions()
        );
      }
    }
    return targets;
  };

  const targetAuthoritativelyResolvesObject = (
    resolved: any,
    targetRecord: any
  ): boolean => {
    if (targetRecord.namespace !== 'project-scene') return false;
    if (resolved.scope === 'scene') {
      return targetRecord.sceneName === resolved.sceneName;
    }
    if (!targetRecord.sceneName) return false;
    if (!project.hasLayoutNamed(targetRecord.sceneName)) return false;
    return !project
      .getLayout(targetRecord.sceneName)
      .getObjects()
      .hasObjectNamed(resolved.objectName);
  };

  const collectEventUsages = (resolved: any): any => {
    const authoritativeReferences = [];
    const potentialReferences = [];
    const exactToken = new RegExp(
      `(^|[^A-Za-z0-9_])${escapeRegExp(resolved.objectName)}([^A-Za-z0-9_]|$)`
    );

    allEventTargets().forEach(targetRecord => {
      let state;
      try {
        state = eventTools.readEventsJson({ target: targetRecord.target });
      } catch (error) {
        return;
      }
      flattenInstructionRecords(state.events || []).forEach(record => {
        (record.instruction.parameters || []).forEach(
          (value, parameterIndex) => {
            if (typeof value !== 'string') return;
            const parameterMetadata = getParameterMetadata(
              record.instruction,
              record.kind,
              parameterIndex
            );
            const objectParameter = !!(
              parameterMetadata &&
              parameterMetadata.valueType &&
              parameterMetadata.valueType.object
            );
            const exactName = value === resolved.objectName;
            if (!exactName && !exactToken.test(value)) return;
            const base = {
              objectName: resolved.objectName,
              target: targetRecord.target,
              eventHandle: record.event.handle,
              eventPath: record.event.path,
              instructionHandle: record.instruction.handle,
              instructionKind: record.kind,
              instructionType: record.instruction.type,
              parameterIndex,
              parameterValue: value,
              eventsRevision: state.eventsRevision,
              parameterMetadata: parameterMetadata
                ? {
                    name: parameterMetadata.name,
                    type: parameterMetadata.type,
                    valueType: parameterMetadata.valueType,
                    referenceSemantics: parameterMetadata.referenceSemantics,
                  }
                : null,
            };
            if (
              objectParameter &&
              exactName &&
              targetAuthoritativelyResolvesObject(resolved, targetRecord)
            ) {
              authoritativeReferences.push({
                ...base,
                referenceKind: 'object-typed-parameter',
                authoritative: true,
              });
            } else {
              potentialReferences.push({
                ...base,
                referenceKind: objectParameter
                  ? 'non-authoritative-object-typed-parameter'
                  : 'expression-or-text-potential-reference',
                authoritative: false,
                diagnostic: {
                  code: 'object_definition_potential_dynamic_reference',
                  severity: 'warning',
                },
              });
            }
          }
        );
      });
    });
    return { authoritativeReferences, potentialReferences };
  };

  const collectInstances = (resolved: any): Array<any> => {
    const results = [];
    const inspectScene = scene => {
      if (
        resolved.scope === 'global' &&
        scene.getObjects().hasObjectNamed(resolved.objectName)
      ) {
        return;
      }
      iterateInstances(scene.getInitialInstances(), instance => {
        if (instance.getObjectName() !== resolved.objectName) return;
        results.push({
          sceneName: scene.getName(),
          instanceId: instance.getPersistentUuid(),
          selector: `instance:${instance.getPersistentUuid()}`,
        });
      });
    };
    if (resolved.scope === 'scene' && resolved.scene) {
      inspectScene(resolved.scene);
    } else {
      for (let index = 0; index < project.getLayoutsCount(); index++) {
        inspectScene(project.getLayoutAt(index));
      }
    }
    return results.sort((left, right) =>
      [left.sceneName, left.instanceId]
        .join('|')
        .localeCompare([right.sceneName, right.instanceId].join('|'))
    );
  };

  const collectGroups = (resolved: any): Array<any> => {
    const result = objectGroupService.groupsForObject({
      objectName: resolved.objectName,
      groupScope: 'all',
      ...(resolved.scope === 'scene' ? { sceneName: resolved.sceneName } : {}),
    });
    return (result.items || [])
      .filter(group => {
        const member = (group.members || []).find(
          candidate => candidate.objectName === resolved.objectName
        );
        if (!member || member.objectScope !== resolved.scope) return false;
        return (
          resolved.scope !== 'scene' || member.sceneName === resolved.sceneName
        );
      })
      .map(group => ({
        name: group.name,
        scope: group.scope,
        ...(group.sceneName ? { sceneName: group.sceneName } : {}),
        selector: group.identity && group.identity.selector,
      }));
  };

  const collectUsages = (resolved: any): any => {
    const events = collectEventUsages(resolved);
    const instances = collectInstances(resolved);
    const groups = collectGroups(resolved);
    const behaviors = collectBehaviors(resolved.object);
    const resources = collectResources(resolved.object);
    return {
      object: serializeObject(resolved, { detailed: false }),
      instances,
      groups,
      events,
      intrinsic: { behaviors, resources },
      counts: {
        instances: instances.length,
        groups: groups.length,
        authoritativeEventReferences: events.authoritativeReferences.length,
        potentialEventReferences: events.potentialReferences.length,
        behaviors: behaviors.length,
        resources: resources.length,
      },
      coverage: {
        instances: 'authoritative-initial-instance-uuid',
        groups: 'authoritative-membership-with-scope-resolution',
        eventInstructions:
          'authoritative-for-exact-object-typed-parameters-in-project-scene-namespace',
        extensionFunctions:
          'scanned-but-independent-parameter-object-namespace; reported-as-potential',
        expressions:
          'lexical-potential-only-when-metadata-does-not-prove-object-reference',
        resources:
          'native-ObjectConfiguration.exposeResources-linked-to-DX28-inspection',
      },
    };
  };

  const usages = (input: any): any => collectUsages(resolveObject(input));

  const create = async (input: any, requestContext?: any): Promise<any> => {
    const objectName = validateName(
      requireString(input && input.objectName, 'objectName'),
      'objectName'
    );
    const objectType = requireString(input && input.objectType, 'objectType');
    const scope = input && input.objectScope === 'global' ? 'global' : 'scene';
    const record = getScopeRecord(scope, input && input.sceneName);
    const conflict = visibleNameConflict(scope, record.sceneName, objectName);
    if (conflict) {
      throw new AgentError({
        code: 'object_definition_name_conflict',
        field: 'objectName',
        details: { objectName, conflict },
      });
    }
    let typeMetadata;
    try {
      typeMetadata = metadataDiscoveryService.describeObjectType({
        type: objectType,
      }).item;
    } catch (error) {
      throw new AgentError({
        code: 'object_definition_unknown_type',
        field: 'objectType',
        details: { objectType },
      });
    }

    const wasTypeUsed = gd.UsedObjectTypeFinder.scanProject(
      project,
      objectType
    );
    const position = clampIndex(
      input && input.position,
      record.objects.getObjectsCount()
    );
    const object = record.objects.insertNewObject(
      project,
      objectType,
      objectName,
      position
    );
    try {
      const changes =
        input && Array.isArray(input.initialProperties)
          ? input.initialProperties
          : [];
      if (changes.length) {
        await objectPropertyService.set(
          {
            targetKind: 'object-definition',
            objectName,
            objectScope: scope,
            ...(record.sceneName ? { sceneName: record.sceneName } : {}),
            changes,
          },
          requestContext
        );
      }
      notifyMutation(record, { isNewObjectTypeUsed: !wasTypeUsed });
      return {
        created: true,
        creationSchema: typeMetadata.creationSchema || null,
        object: serializeObject({ ...record, object, objectName }),
      };
    } catch (error) {
      record.objects.removeObject(objectName);
      throw error;
    }
  };

  const duplicate = (input: any): any => {
    const source = resolveObject(input);
    const newObjectName = validateName(
      requireString(input && input.newObjectName, 'newObjectName'),
      'newObjectName'
    );
    const targetScope =
      input && input.targetScope ? input.targetScope : source.scope;
    if (!['global', 'scene'].includes(targetScope)) {
      throw new AgentError({
        code: 'invalid_object_definition_scope',
        field: 'targetScope',
        details: { allowedValues: ['global', 'scene'], value: targetScope },
      });
    }
    const targetSceneName =
      targetScope === 'scene'
        ? input && input.targetSceneName
          ? input.targetSceneName
          : source.sceneName
        : null;
    const target = getScopeRecord(targetScope, targetSceneName);
    const conflict = visibleNameConflict(
      targetScope,
      target.sceneName,
      newObjectName
    );
    if (conflict) {
      throw new AgentError({
        code: 'object_definition_name_conflict',
        field: 'newObjectName',
        details: { newObjectName, conflict },
      });
    }

    const cloned = source.object.clone().release();
    try {
      cloned.setName(newObjectName);
      cloned.resetPersistentUuid();
      const position = clampIndex(
        input && input.position,
        target.objects.getObjectsCount()
      );
      const inserted = target.objects.insertObject(cloned, position);
      notifyMutation(target, { isNewObjectTypeUsed: false });
      return {
        duplicated: true,
        sourceObjectId: source.object.getPersistentUuid(),
        object: serializeObject({
          ...target,
          object: inserted,
          objectName: newObjectName,
        }),
      };
    } finally {
      cloned.delete();
    }
  };

  const rename = (input: any): any => {
    const resolved = resolveObject(input);
    const newObjectName = validateName(
      requireString(input && input.newObjectName, 'newObjectName'),
      'newObjectName'
    );
    if (newObjectName === resolved.objectName) {
      return {
        renamed: false,
        nothingChanged: true,
        object: serializeObject(resolved),
      };
    }
    const conflict = visibleNameConflict(
      resolved.scope,
      resolved.sceneName,
      newObjectName,
      resolved.object.getPersistentUuid()
    );
    if (conflict) {
      throw new AgentError({
        code: 'object_definition_name_conflict',
        field: 'newObjectName',
        details: { newObjectName, conflict },
      });
    }
    const before = collectUsages(resolved);
    const plan = {
      operation: 'rename-object-definition',
      target: {
        objectId: resolved.object.getPersistentUuid(),
        objectName: resolved.objectName,
        objectScope: resolved.scope,
        ...(resolved.sceneName ? { sceneName: resolved.sceneName } : {}),
      },
      before: {
        objectId: resolved.object.getPersistentUuid(),
        objectName: resolved.objectName,
        objectScope: resolved.scope,
        ...(resolved.sceneName ? { sceneName: resolved.sceneName } : {}),
      },
      after: {
        objectId: resolved.object.getPersistentUuid(),
        objectName: newObjectName,
        objectScope: resolved.scope,
        ...(resolved.sceneName ? { sceneName: resolved.sceneName } : {}),
      },
      rewrittenReferences: {
        instances: before.counts.instances,
        groups: before.counts.groups,
        eventInstructions: before.counts.authoritativeEventReferences,
      },
      usages: before,
      blockers: [],
      warnings:
        before.counts.potentialEventReferences > 0
          ? [
              {
                code: 'object_definition_has_potential_dynamic_references',
                count: before.counts.potentialEventReferences,
              },
            ]
          : [],
    };
    if (input && input.dryRun === true) {
      return {
        renamed: false,
        dryRun: true,
        plan,
        object: serializeObject(resolved),
      };
    }
    if (resolved.scope === 'global') {
      gd.WholeProjectRefactorer.globalObjectOrGroupRenamed(
        project,
        resolved.objectName,
        newObjectName,
        false
      );
    } else {
      gd.WholeProjectRefactorer.objectOrGroupRenamedInScene(
        project,
        resolved.scene,
        resolved.objectName,
        newObjectName,
        false
      );
    }
    resolved.object.setName(newObjectName);
    const oldObjectName = resolved.objectName;
    resolved.objectName = newObjectName;
    notifyMutation(resolved, { isNewObjectTypeUsed: false });
    return {
      renamed: true,
      oldObjectName,
      newObjectName,
      objectId: resolved.object.getPersistentUuid(),
      rewrittenReferences: plan.rewrittenReferences,
      plan,
      nativeRefactor: true,
      object: serializeObject(resolved),
    };
  };

  const remove = (input: any): any => {
    const resolved = resolveObject(input);
    const usageState = collectUsages(resolved);
    const blockers = [];
    if (usageState.counts.instances) {
      blockers.push({
        code: 'object_definition_has_instances',
        count: usageState.counts.instances,
      });
    }
    if (usageState.counts.groups) {
      blockers.push({
        code: 'object_definition_in_groups',
        count: usageState.counts.groups,
      });
    }
    if (usageState.counts.authoritativeEventReferences) {
      blockers.push({
        code: 'object_definition_referenced_by_events',
        count: usageState.counts.authoritativeEventReferences,
      });
    }
    if (
      usageState.counts.potentialEventReferences &&
      input.acknowledgePotentialReferences !== true
    ) {
      blockers.push({
        code: 'object_definition_has_potential_dynamic_references',
        count: usageState.counts.potentialEventReferences,
      });
    }

    const plan = {
      operation: 'delete-object-definition',
      target: {
        objectId: resolved.object.getPersistentUuid(),
        objectName: resolved.objectName,
        objectScope: resolved.scope,
        ...(resolved.sceneName ? { sceneName: resolved.sceneName } : {}),
      },
      usages: usageState,
      blockers,
    };
    if (input.dryRun !== false) return { deleted: false, plan };
    if (blockers.length) {
      throw new AgentError({
        code: 'object_definition_delete_blocked',
        details: plan,
        hint:
          'Remove or refactor the reported instances/groups/Event Sheet references, then repeat dry-run. Potential dynamic references require explicit acknowledgement.',
      });
    }

    if (resolved.scope === 'global') {
      gd.WholeProjectRefactorer.globalObjectRemoved(
        project,
        resolved.objectName
      );
    } else {
      gd.WholeProjectRefactorer.objectRemovedInScene(
        project,
        resolved.scene,
        resolved.objectName
      );
    }
    resolved.objects.removeObject(resolved.objectName);
    notifyMutation(resolved, { isNewObjectTypeUsed: false });
    return { deleted: true, plan };
  };

  const moveScope = (input: any): any => {
    const resolved = resolveObject(input);
    const targetScope = requireString(
      input && input.targetScope,
      'targetScope'
    );
    if (!['global', 'scene'].includes(targetScope)) {
      throw new AgentError({
        code: 'invalid_object_definition_scope',
        field: 'targetScope',
        details: { allowedValues: ['global', 'scene'], value: targetScope },
      });
    }
    if (targetScope === resolved.scope) {
      return {
        moved: false,
        nothingChanged: true,
        object: serializeObject(resolved),
      };
    }
    if (resolved.scope === 'global' && targetScope === 'scene') {
      throw new AgentError({
        code: 'object_scope_transition_unsupported',
        field: 'targetScope',
        details: {
          from: 'global',
          to: 'scene',
          reason:
            'The native editor does not support demoting a global object into one scene because other scenes may depend on it.',
        },
      });
    }

    const target = getScopeRecord('global');
    const conflict = visibleNameConflict(
      'global',
      null,
      resolved.objectName,
      resolved.object.getPersistentUuid()
    );
    if (conflict) {
      throw new AgentError({
        code: 'object_definition_scope_conflict',
        field: 'targetScope',
        details: { objectName: resolved.objectName, conflict },
      });
    }

    const eventMatchesOutsideSource = [];
    const exactToken = resolved.objectName;
    allEventTargets().forEach(targetRecord => {
      if (
        targetRecord.namespace !== 'project-scene' ||
        targetRecord.sceneName === resolved.sceneName
      ) {
        return;
      }
      let state;
      try {
        state = eventTools.readEventsJson({ target: targetRecord.target });
      } catch (error) {
        return;
      }
      flattenInstructionRecords(state.events || []).forEach(record => {
        (record.instruction.parameters || []).forEach(
          (value, parameterIndex) => {
            if (value !== exactToken) return;
            const metadata = getParameterMetadata(
              record.instruction,
              record.kind,
              parameterIndex
            );
            if (
              !(metadata && metadata.valueType && metadata.valueType.object)
            ) {
              return;
            }
            eventMatchesOutsideSource.push({
              target: targetRecord.target,
              eventHandle: record.event.handle,
              instructionHandle: record.instruction.handle,
              parameterIndex,
            });
          }
        );
      });
    });

    const plan = {
      operation: 'promote-object-definition',
      objectId: resolved.object.getPersistentUuid(),
      objectName: resolved.objectName,
      from: { scope: 'scene', sceneName: resolved.sceneName },
      to: { scope: 'global' },
      identityPreserved: true,
      potentialNewGlobalBindings: eventMatchesOutsideSource,
      blockers:
        eventMatchesOutsideSource.length &&
        input.acknowledgeNewGlobalBindings !== true
          ? [
              {
                code: 'object_scope_promotion_would_capture_references',
                count: eventMatchesOutsideSource.length,
              },
            ]
          : [],
    };
    if (input.dryRun !== false) return { moved: false, plan };
    if (plan.blockers.length) {
      throw new AgentError({
        code: 'object_definition_scope_move_blocked',
        details: plan,
      });
    }

    const node = findObjectFolderNode(
      resolved.objects.getRootFolder(),
      resolved.objectName
    );
    if (!node) {
      throw new AgentError({
        code: 'object_definition_folder_node_not_found',
        details: { objectName: resolved.objectName },
      });
    }
    resolved.objects.moveObjectFolderOrObjectToAnotherContainerInFolder(
      node,
      target.objects,
      target.objects.getRootFolder(),
      target.objects.getObjectsCount()
    );
    gd.WholeProjectRefactorer.updateBehaviorsSharedData(project);
    triggerUnsavedChanges();
    forceUpdate();
    if (onObjectsModifiedOutsideEditor) {
      onObjectsModifiedOutsideEditor({
        scene: resolved.scene,
        isNewObjectTypeUsed: false,
      });
      onObjectsModifiedOutsideEditor({
        scene: null,
        isNewObjectTypeUsed: false,
      });
    }
    const movedObject = target.objects.getObject(resolved.objectName);
    return {
      moved: true,
      plan,
      object: serializeObject({
        ...target,
        object: movedObject,
        objectName: movedObject.getName(),
      }),
    };
  };

  return {
    list,
    get,
    usages,
    create,
    duplicate,
    rename,
    remove,
    moveScope,
  };
};
