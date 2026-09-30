// @flow
import { AgentError } from '../core/AgentError';

const gd: libGDevelop = global.gd;

const requireString = (value: any, field: string): string => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AgentError({
      code: 'missing_object_group_field',
      field,
      details: { field },
    });
  }
  return value.trim();
};

const clampIndex = (value: any, count: number): number => {
  if (!Number.isInteger(value)) return count;
  return Math.max(0, Math.min(value, count));
};

const canonicalSelector = ({ scope, sceneName, groupName }: any): string =>
  scope === 'global'
    ? `object-group:global:${encodeURIComponent(groupName)}`
    : `object-group:scene:${encodeURIComponent(
        sceneName || ''
      )}:${encodeURIComponent(groupName)}`;

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const createObjectGroupService = ({
  project,
  eventTools,
  metadataDiscoveryService,
  triggerUnsavedChanges,
  forceUpdate,
  onObjectGroupsModifiedOutsideEditor,
}: {|
  project: gdProject,
  eventTools: any,
  metadataDiscoveryService: any,
  triggerUnsavedChanges: () => void,
  forceUpdate: () => void,
  onObjectGroupsModifiedOutsideEditor?: any,
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

  const getScope = ({
    scope,
    sceneName,
  }: {|
    scope: 'global' | 'scene',
    sceneName?: ?string,
  |}): any => {
    if (scope === 'global') {
      return {
        scope,
        scene: null,
        sceneName: null,
        objects: project.getObjects(),
        groups: project.getObjects().getObjectGroups(),
      };
    }
    const resolvedSceneName = requireString(sceneName, 'sceneName');
    const scene = requireScene(resolvedSceneName);
    return {
      scope,
      scene,
      sceneName: resolvedSceneName,
      objects: scene.getObjects(),
      groups: scene.getObjects().getObjectGroups(),
    };
  };

  const resolveGroup = (input: any): any => {
    const groupName = requireString(input && input.groupName, 'groupName');
    const requested =
      input && typeof input.groupScope === 'string' ? input.groupScope : 'auto';
    if (!['auto', 'global', 'scene'].includes(requested)) {
      throw new AgentError({
        code: 'invalid_object_group_scope',
        field: 'groupScope',
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
      const sceneScope = getScope({ scope: 'scene', sceneName });
      if (sceneScope.groups.has(groupName)) {
        return {
          ...sceneScope,
          groupName,
          group: sceneScope.groups.get(groupName),
        };
      }
      if (requested === 'scene') {
        throw new AgentError({
          code: 'object_group_not_found',
          field: 'groupName',
          details: { groupName, groupScope: 'scene', sceneName },
        });
      }
    } else if (requested === 'scene') {
      throw new AgentError({
        code: 'missing_object_group_field',
        field: 'sceneName',
        details: { field: 'sceneName', groupScope: 'scene' },
      });
    }

    const globalScope = getScope({ scope: 'global' });
    if (globalScope.groups.has(groupName)) {
      return {
        ...globalScope,
        groupName,
        group: globalScope.groups.get(groupName),
      };
    }

    throw new AgentError({
      code: 'object_group_not_found',
      field: 'groupName',
      details: {
        groupName,
        groupScope: requested,
        ...(sceneName ? { sceneName } : {}),
      },
    });
  };

  const resolveMember = (resolved: any, objectName: string): any => {
    if (
      resolved.scope === 'scene' &&
      resolved.scene &&
      resolved.scene.getObjects().hasObjectNamed(objectName)
    ) {
      const object = resolved.scene.getObjects().getObject(objectName);
      return {
        exists: true,
        objectName,
        objectType: object.getType(),
        objectScope: 'scene',
        sceneName: resolved.sceneName,
      };
    }
    if (project.getObjects().hasObjectNamed(objectName)) {
      const object = project.getObjects().getObject(objectName);
      return {
        exists: true,
        objectName,
        objectType: object.getType(),
        objectScope: 'global',
      };
    }
    return {
      exists: false,
      objectName,
      objectType: null,
      objectScope: null,
      diagnostic: {
        code: 'object_group_member_not_found',
        severity: 'error',
      },
    };
  };

  const serializeGroup = (resolved: any): any => {
    const names = resolved.group
      .getAllObjectsNames()
      .toJSArray()
      .map(String);
    const members = names.map((objectName, position) => ({
      position,
      ...resolveMember(resolved, objectName),
    }));
    const diagnostics = members
      .filter(member => !member.exists)
      .map(member => ({
        code: 'object_group_member_not_found',
        severity: 'error',
        objectName: member.objectName,
        position: member.position,
      }));
    return {
      identity: {
        kind: 'canonical-scope-name',
        selector: canonicalSelector({
          scope: resolved.scope,
          sceneName: resolved.sceneName,
          groupName: resolved.groupName,
        }),
        nativePersistentUuid: false,
        renameChangesSelector: true,
      },
      name: resolved.groupName,
      scope: resolved.scope,
      ...(resolved.sceneName ? { sceneName: resolved.sceneName } : {}),
      position: resolved.groups.getPosition(resolved.groupName),
      memberCount: members.length,
      members,
      diagnostics,
      referenceSemantics: {
        eventParameterEntityKind: 'object-or-object-group',
        renameRefactor:
          resolved.scope === 'global'
            ? 'gd.WholeProjectRefactorer.globalObjectOrGroupRenamed'
            : 'gd.WholeProjectRefactorer.objectOrGroupRenamedInScene',
        deletion: 'blocked-when-authoritative-event-references-remain',
      },
    };
  };

  const nameConflict = (
    scopeRecord: any,
    name: string,
    exceptGroupName?: ?string
  ): ?any => {
    const localGroupTaken =
      scopeRecord.groups.has(name) && name !== exceptGroupName;
    if (localGroupTaken) {
      return { kind: 'object-group', scope: scopeRecord.scope, name };
    }
    if (scopeRecord.objects.hasObjectNamed(name)) {
      return { kind: 'object', scope: scopeRecord.scope, name };
    }
    if (scopeRecord.scope === 'scene') {
      const globalGroups = project.getObjects().getObjectGroups();
      if (globalGroups.has(name)) {
        return { kind: 'object-group', scope: 'global', name };
      }
      if (project.getObjects().hasObjectNamed(name)) {
        return { kind: 'object', scope: 'global', name };
      }
    }
    return null;
  };

  const notifyMutation = (resolved: any) => {
    triggerUnsavedChanges();
    forceUpdate();
    if (onObjectGroupsModifiedOutsideEditor) {
      onObjectGroupsModifiedOutsideEditor({ scene: resolved.scene || null });
    }
  };

  const scopeRecordsForList = (input: any): Array<any> => {
    const requested =
      input && typeof input.groupScope === 'string' ? input.groupScope : 'all';
    if (!['all', 'global', 'scene'].includes(requested)) {
      throw new AgentError({
        code: 'invalid_object_group_scope',
        field: 'groupScope',
        details: {
          allowedValues: ['all', 'global', 'scene'],
          value: requested,
        },
      });
    }
    const records = [];
    if (requested !== 'scene') records.push(getScope({ scope: 'global' }));
    if (requested !== 'global') {
      if (input && input.sceneName) {
        records.push(getScope({ scope: 'scene', sceneName: input.sceneName }));
      } else {
        for (let index = 0; index < project.getLayoutsCount(); index++) {
          const scene = project.getLayoutAt(index);
          records.push(
            getScope({ scope: 'scene', sceneName: scene.getName() })
          );
        }
      }
    }
    return records;
  };

  const list = (input: any = {}): any => {
    const items = [];
    scopeRecordsForList(input).forEach(scopeRecord => {
      for (let index = 0; index < scopeRecord.groups.count(); index++) {
        const group = scopeRecord.groups.getAt(index);
        items.push(
          serializeGroup({
            ...scopeRecord,
            group,
            groupName: group.getName(),
          })
        );
      }
    });
    const query =
      input && typeof input.query === 'string'
        ? input.query.trim().toLowerCase()
        : '';
    const filtered = query
      ? items.filter(item => item.name.toLowerCase().includes(query))
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
      items: filtered.slice(offset, offset + limit),
      truncated: offset + limit < filtered.length,
      discovery: {
        get: 'objects.groups.get',
        reverseLookup: 'objects.groups.for-object',
        usages: 'objects.groups.usages',
      },
    };
  };

  const get = (input: any): any => ({
    group: serializeGroup(resolveGroup(input)),
  });

  const groupsForObject = (input: any): any => {
    const objectName = requireString(input && input.objectName, 'objectName');
    const items = [];
    scopeRecordsForList(input).forEach(scopeRecord => {
      for (let index = 0; index < scopeRecord.groups.count(); index++) {
        const group = scopeRecord.groups.getAt(index);
        if (!group.find(objectName)) continue;
        items.push(
          serializeGroup({
            ...scopeRecord,
            group,
            groupName: group.getName(),
          })
        );
      }
    });
    return { objectName, count: items.length, items };
  };

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
    if (!candidates.length) return null;
    const objectCandidate = candidates.find(
      parameter => parameter.valueType && parameter.valueType.object
    );
    return objectCandidate || candidates[0];
  };

  const flattenInstructionRecords = (events: Array<any>): Array<any> => {
    const output = [];
    const visitInstructions = (
      instructions,
      event,
      kind: 'condition' | 'action'
    ) => {
      (instructions || []).forEach(instruction => {
        output.push({
          instruction,
          event,
          kind,
        });
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
        authoritativeFor: scene.getName(),
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
        authoritativeFor: externalEvents.getAssociatedLayout() || null,
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
          authoritativeFor: null,
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

  const isAuthoritativeTargetForGroup = (
    resolved: any,
    targetRecord: any
  ): boolean => {
    if (targetRecord.namespace !== 'project-scene') return false;
    if (resolved.scope === 'global') return true;
    return targetRecord.authoritativeFor === resolved.sceneName;
  };

  const collectUsages = (resolved: any): any => {
    const references = [];
    const potentialReferences = [];
    const exactToken = new RegExp(
      `(^|[^A-Za-z0-9_])${escapeRegExp(resolved.groupName)}([^A-Za-z0-9_]|$)`
    );

    allEventTargets().forEach(targetRecord => {
      let state;
      try {
        state = eventTools.readEventsJson({ target: targetRecord.target });
      } catch (error) {
        return;
      }
      flattenInstructionRecords(state.events || []).forEach(record => {
        const params = record.instruction.parameters || [];
        params.forEach((value, parameterIndex) => {
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
          const authoritativeTarget = isAuthoritativeTargetForGroup(
            resolved,
            targetRecord
          );
          const base = {
            referenceKind: objectParameter
              ? 'object-or-object-group-parameter'
              : 'expression-or-text-potential-reference',
            groupEntityKind: 'object-group',
            groupName: resolved.groupName,
            target: targetRecord.target,
            eventHandle: record.event.handle,
            eventPath: record.event.path,
            instructionHandle: record.instruction.handle,
            instructionKind: record.kind,
            instructionType: record.instruction.type,
            parameterIndex,
            parameterValue: value,
            parameterMetadata: parameterMetadata
              ? {
                  name: parameterMetadata.name,
                  type: parameterMetadata.type,
                  valueType: parameterMetadata.valueType,
                  referenceSemantics: parameterMetadata.referenceSemantics,
                }
              : null,
            eventsRevision: state.eventsRevision,
            authoritative: authoritativeTarget && objectParameter,
          };
          if (objectParameter && value === resolved.groupName) {
            references.push(base);
          } else if (exactToken.test(value)) {
            potentialReferences.push({
              ...base,
              authoritative: false,
              diagnostic: {
                code: 'object_group_potential_dynamic_reference',
                severity: 'warning',
                message:
                  'The group name appears inside an expression/text parameter; the current metadata does not prove this is a rewritable object-group reference.',
              },
            });
          }
        });
      });
    });

    const authoritativeReferences = references.filter(
      reference => reference.authoritative
    );
    return {
      references,
      authoritativeReferences,
      potentialReferences,
      referenceCount: references.length,
      authoritativeReferenceCount: authoritativeReferences.length,
      potentialReferenceCount: potentialReferences.length,
      coverage: {
        sceneEvents: 'exact-object-typed-parameters-with-stable-event-handles',
        externalEvents:
          'exact-object-typed-parameters; authoritative when associated with the group scene, or for global groups',
        extensionFunctions:
          'scanned-but-independent-object-group-namespace; matches are reported non-authoritatively',
        expressions:
          'lexical-potential-only-when-parameter-metadata-does-not-prove-object-reference',
        rename:
          'native WholeProjectRefactorer remains authoritative for supported Event Sheet rewrites',
      },
    };
  };

  const usages = (input: any): any => {
    const resolved = resolveGroup(input);
    return {
      group: serializeGroup(resolved),
      usages: collectUsages(resolved),
    };
  };

  const create = (input: any): any => {
    const groupName = requireString(input && input.groupName, 'groupName');
    const scope = input && input.groupScope === 'global' ? 'global' : 'scene';
    const resolved = getScope({
      scope,
      sceneName: input && input.sceneName,
    });
    const conflict = nameConflict(resolved, groupName);
    if (conflict) {
      throw new AgentError({
        code: 'object_group_name_conflict',
        field: 'groupName',
        details: { groupName, conflict },
      });
    }
    const position = clampIndex(
      input && input.position,
      resolved.groups.count()
    );
    const group = resolved.groups.insertNew(groupName, position);
    const groupResolved = { ...resolved, group, groupName };
    notifyMutation(groupResolved);
    return {
      created: true,
      group: serializeGroup(groupResolved),
    };
  };

  const rename = (input: any): any => {
    const resolved = resolveGroup(input);
    const newGroupName = requireString(
      input && input.newGroupName,
      'newGroupName'
    );
    if (newGroupName === resolved.groupName) {
      return {
        renamed: false,
        nothingChanged: true,
        group: serializeGroup(resolved),
      };
    }
    const conflict = nameConflict(resolved, newGroupName, resolved.groupName);
    if (conflict) {
      throw new AgentError({
        code: 'object_group_name_conflict',
        field: 'newGroupName',
        details: {
          groupName: resolved.groupName,
          newGroupName,
          conflict,
        },
      });
    }

    const beforeUsages = collectUsages(resolved);
    if (resolved.scope === 'global') {
      gd.WholeProjectRefactorer.globalObjectOrGroupRenamed(
        project,
        resolved.groupName,
        newGroupName,
        true
      );
    } else {
      gd.WholeProjectRefactorer.objectOrGroupRenamedInScene(
        project,
        resolved.scene,
        resolved.groupName,
        newGroupName,
        true
      );
    }
    resolved.group.setName(newGroupName);
    resolved.groupName = newGroupName;
    notifyMutation(resolved);
    return {
      renamed: true,
      oldGroupName: input.groupName,
      newGroupName,
      rewrittenReferences: beforeUsages.authoritativeReferenceCount,
      group: serializeGroup(resolved),
      nativeRefactor: true,
    };
  };

  const remove = (input: any): any => {
    const resolved = resolveGroup(input);
    const usageState = collectUsages(resolved);
    const plan = {
      operation: 'delete-object-group',
      target: {
        selector: canonicalSelector({
          scope: resolved.scope,
          sceneName: resolved.sceneName,
          groupName: resolved.groupName,
        }),
        groupName: resolved.groupName,
        groupScope: resolved.scope,
        ...(resolved.sceneName ? { sceneName: resolved.sceneName } : {}),
      },
      group: serializeGroup(resolved),
      usages: usageState,
      blockers:
        usageState.authoritativeReferenceCount > 0
          ? [
              {
                code: 'object_group_in_use',
                referenceCount: usageState.authoritativeReferenceCount,
              },
            ]
          : [],
    };
    if (input.dryRun !== false) {
      return { deleted: false, plan };
    }
    if (plan.blockers.length) {
      throw new AgentError({
        code: 'object_group_delete_blocked',
        details: plan,
        hint:
          'Rename/refactor or remove the reported Event Sheet references before deleting the group.',
      });
    }
    resolved.groups.remove(resolved.groupName);
    notifyMutation(resolved);
    return {
      deleted: true,
      plan,
    };
  };

  const addMember = (input: any): any => {
    const resolved = resolveGroup(input);
    const objectName = requireString(input && input.objectName, 'objectName');
    const member = resolveMember(resolved, objectName);
    if (!member.exists) {
      throw new AgentError({
        code: 'object_group_member_not_found',
        field: 'objectName',
        details: {
          objectName,
          groupName: resolved.groupName,
          groupScope: resolved.scope,
        },
      });
    }
    if (resolved.group.find(objectName)) {
      throw new AgentError({
        code: 'object_group_member_already_exists',
        field: 'objectName',
        details: { objectName, groupName: resolved.groupName },
      });
    }
    resolved.group.addObject(objectName);
    notifyMutation(resolved);
    return {
      added: true,
      member,
      group: serializeGroup(resolved),
    };
  };

  const removeMember = (input: any): any => {
    const resolved = resolveGroup(input);
    const objectName = requireString(input && input.objectName, 'objectName');
    if (!resolved.group.find(objectName)) {
      throw new AgentError({
        code: 'object_group_member_not_found',
        field: 'objectName',
        details: { objectName, groupName: resolved.groupName },
      });
    }
    resolved.group.removeObject(objectName);
    notifyMutation(resolved);
    return {
      removed: true,
      objectName,
      group: serializeGroup(resolved),
    };
  };

  const moveMember = (input: any): any => {
    const resolved = resolveGroup(input);
    const names = resolved.group
      .getAllObjectsNames()
      .toJSArray()
      .map(String);
    if (!names.length) {
      throw new AgentError({
        code: 'object_group_member_not_found',
        details: { groupName: resolved.groupName, memberCount: 0 },
      });
    }
    let fromIndex = Number.isInteger(input && input.fromIndex)
      ? input.fromIndex
      : -1;
    if (
      fromIndex < 0 &&
      input &&
      typeof input.objectName === 'string' &&
      input.objectName
    ) {
      fromIndex = names.indexOf(input.objectName);
    }
    if (fromIndex < 0 || fromIndex >= names.length) {
      throw new AgentError({
        code: 'object_group_member_not_found',
        field: Number.isInteger(input && input.fromIndex)
          ? 'fromIndex'
          : 'objectName',
        details: { fromIndex, memberCount: names.length },
      });
    }
    if (
      !Number.isInteger(input && input.toIndex) ||
      input.toIndex < 0 ||
      input.toIndex >= names.length
    ) {
      throw new AgentError({
        code: 'invalid_object_group_member_index',
        field: 'toIndex',
        details: { toIndex: input && input.toIndex, memberCount: names.length },
      });
    }
    const [moved] = names.splice(fromIndex, 1);
    names.splice(input.toIndex, 0, moved);
    const currentNames = resolved.group.getAllObjectsNames().toJSArray();
    currentNames.forEach(name => resolved.group.removeObject(name));
    names.forEach(name => resolved.group.addObject(name));
    notifyMutation(resolved);
    return {
      moved: true,
      objectName: moved,
      fromIndex,
      toIndex: input.toIndex,
      group: serializeGroup(resolved),
    };
  };

  return {
    list,
    get,
    groupsForObject,
    usages,
    create,
    rename,
    remove,
    addMember,
    removeMember,
    moveMember,
  };
};
