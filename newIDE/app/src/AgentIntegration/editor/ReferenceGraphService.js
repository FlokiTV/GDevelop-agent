// @flow
import { AgentError } from '../core/AgentError';

export const REFERENCE_NODE_KINDS = [
  'project',
  'scene',
  'external-events',
  'object-definition',
  'scene-instance',
  'object-group',
  'variable',
  'resource',
  'behavior',
  'extension',
  'extension-function',
  'event',
  'event-condition',
  'event-action',
];

const encodePart = (value: any): string =>
  encodeURIComponent(value == null ? '' : String(value));

const hashString = (value: string): string => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

const clampInteger = (
  value: any,
  fallback: number,
  min: number,
  max: number
): number =>
  Number.isInteger(value) ? Math.max(min, Math.min(max, value)) : fallback;

const asArray = (value: any): Array<any> => (Array.isArray(value) ? value : []);

const nonEmptyString = (value: any): ?string =>
  typeof value === 'string' && value ? value : null;

const variableSelector = ({
  scope,
  sceneName,
  objectSelector,
  path,
}: any): string =>
  [
    'variable',
    encodePart(scope),
    encodePart(sceneName || ''),
    encodePart(objectSelector || ''),
    encodePart(path),
  ].join(':');

const functionSelector = ({
  extensionName,
  ownerKind,
  ownerName,
  functionName,
}: any): string =>
  [
    'extension-function',
    encodePart(extensionName),
    encodePart(ownerKind || 'extension'),
    encodePart(ownerName || ''),
    encodePart(functionName),
  ].join(':');

const makeError = (code: string, details?: any = {}) =>
  new AgentError({ code, details });

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^$()|[\]\\]/g, '\\$&');

const exactToken = (name: string): RegExp =>
  new RegExp('(^|[^A-Za-z0-9_])' + escapeRegExp(name) + '([^A-Za-z0-9_]|$)');

export const createReferenceGraphService = ({
  project,
  eventTools,
  metadataDiscoveryService,
  objectDefinitionService,
  objectGroupService,
  sceneInstanceService,
  assetTools,
  sceneLifecycleService,
  externalProjectItemsService,
}: {|
  project: gdProject,
  eventTools: any,
  metadataDiscoveryService: any,
  objectDefinitionService: any,
  objectGroupService: any,
  sceneInstanceService: any,
  assetTools: any,
  sceneLifecycleService?: any,
  externalProjectItemsService?: any,
|}) => {
  const instructionMetadataCache = new Map();

  const getInstructionMetadata = (
    instruction: any,
    kind: 'condition' | 'action'
  ): ?any => {
    const type = instruction && instruction.type;
    if (!type || !metadataDiscoveryService) return null;
    const key = kind + ':' + type;
    if (!instructionMetadataCache.has(key)) {
      let item = null;
      try {
        const result = metadataDiscoveryService.searchInstructions({
          kind,
          query: type,
          deprecated: 'include',
          includeHidden: true,
          limit: 100,
          offset: 0,
        });
        item = (result.items || []).find(candidate => candidate.id === type);
      } catch (error) {
        item = null;
      }
      instructionMetadataCache.set(key, item);
    }
    return instructionMetadataCache.get(key) || null;
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

  const buildGraph = (): any => {
    const nodes = new Map();
    const edgesByKey = new Map();
    const warnings = [];
    const coverage = {
      projectStructure: 'native-project-containers',
      instances: 'DX-27 stable initial-instance UUIDs',
      objects: 'DX-34 persistent object-definition UUIDs',
      groups: 'DX-31 canonical scope/name selectors',
      resources:
        'DX-28 native resource exposure and typed visual-resource paths where available',
      eventSheets:
        'DX-3/DX-20 stable event/instruction handles over scene/external/function targets',
      variables:
        'declarations indexed; typed variable parameters resolved when scope is authoritative',
      functions:
        'DX-10 project extension/functions indexed; call edges are exact for project-owned instruction types',
      dynamicReferences:
        'lexical candidates are warnings only and never promoted to hard safety claims',
    };

    const addNode = (node: any): ?any => {
      if (!node || !node.selector || !node.kind) return null;
      const existing = nodes.get(node.selector);
      nodes.set(
        node.selector,
        existing
          ? {
              ...existing,
              ...node,
              metadata: {
                ...(existing.metadata || {}),
                ...(node.metadata || {}),
              },
            }
          : node
      );
      return nodes.get(node.selector);
    };

    const summarizeNode = (node: any): any =>
      node
        ? {
            selector: node.selector,
            kind: node.kind,
            name: node.name || null,
            path: node.path || null,
            scope: node.scope || null,
            sceneName: node.sceneName || null,
            externalEventsName: node.externalEventsName || null,
            extensionName: node.extensionName || null,
            resourceKind: node.resourceKind || null,
          }
        : null;

    const strengthRank = { dynamic: 0, soft: 1, hard: 2 };

    const addEdge = ({
      source,
      target,
      referenceKind,
      strength = 'hard',
      scope = null,
      location = null,
      autoRefactorable = false,
      blockerOnDelete = strength === 'hard',
      metadata = null,
    }: any): ?any => {
      const sourceNode =
        typeof source === 'string' ? nodes.get(source) : addNode(source);
      const targetNode =
        typeof target === 'string' ? nodes.get(target) : addNode(target);
      if (!sourceNode || !targetNode || !referenceKind) return null;
      const key = [
        sourceNode.selector,
        targetNode.selector,
        referenceKind,
        location ? JSON.stringify(location) : '',
      ].join('|');
      const candidate = {
        id: 'reference-edge:' + hashString(key),
        source: summarizeNode(sourceNode),
        target: summarizeNode(targetNode),
        referenceKind,
        strength,
        hard: strength === 'hard',
        soft: strength === 'soft',
        dynamic: strength === 'dynamic',
        scope,
        location,
        autoRefactorable: !!autoRefactorable,
        blockerOnDelete: !!blockerOnDelete,
        metadata,
      };
      const existing = edgesByKey.get(key);
      if (
        !existing ||
        strengthRank[candidate.strength] > strengthRank[existing.strength] ||
        (candidate.autoRefactorable && !existing.autoRefactorable)
      ) {
        edgesByKey.set(key, candidate);
      }
      return edgesByKey.get(key);
    };

    const projectUuid =
      project.getProjectUuid && project.getProjectUuid()
        ? project.getProjectUuid()
        : project.getName();
    const projectSelector = 'project:' + encodePart(projectUuid);
    addNode({
      selector: projectSelector,
      kind: 'project',
      name: project.getName(),
      identity: {
        kind: project.getProjectUuid
          ? 'persistent-project-uuid'
          : 'project-name',
        id: projectUuid,
      },
    });

    const sceneNodesByName = new Map();
    const externalNodesByName = new Map();
    const objectNodesByScopeName = new Map();
    const groupNodesByScopeName = new Map();
    const resourceNodesByName = new Map();
    const variableNodesByScopeName = new Map();
    const functionNodesByInstructionType = new Map();
    const behaviorNodesByName = new Map();

    const rememberNamed = (map, key, node) => {
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(node);
    };

    const addVariableDeclarations = ({
      container,
      scope,
      sceneName = null,
      objectSelector = null,
      ownerSelector,
    }: any) => {
      if (!container || typeof container.count !== 'function') return;
      for (let index = 0; index < container.count(); index++) {
        const name = container.getNameAt(index);
        const selector = variableSelector({
          scope,
          sceneName,
          objectSelector,
          path: name,
        });
        const node = addNode({
          selector,
          kind: 'variable',
          name,
          path: name,
          scope,
          ...(sceneName ? { sceneName } : {}),
          ...(objectSelector ? { objectSelector } : {}),
          position: index,
          identity: {
            kind: 'canonical-scope-path',
            renameChangesSelector: true,
          },
        });
        rememberNamed(
          variableNodesByScopeName,
          scope + ':' + (sceneName || '') + ':' + name,
          node
        );
        addEdge({
          source: ownerSelector,
          target: selector,
          referenceKind: 'declares-variable',
          strength: 'hard',
          blockerOnDelete: false,
          scope,
        });
      }
    };

    for (let index = 0; index < project.getLayoutsCount(); index++) {
      const scene = project.getLayoutAt(index);
      const sceneId = scene.getPersistentUuid();
      const selector = 'scene:' + sceneId;
      const node = addNode({
        selector,
        kind: 'scene',
        name: scene.getName(),
        sceneName: scene.getName(),
        scope: 'project',
        position: index,
        identity: {
          kind: 'persistent-uuid',
          id: sceneId,
          stableAcrossRename: true,
        },
      });
      sceneNodesByName.set(scene.getName(), node);
      addEdge({
        source: projectSelector,
        target: selector,
        referenceKind: 'contains-scene',
        strength: 'hard',
        blockerOnDelete: false,
        scope: 'project',
      });
      addVariableDeclarations({
        container: scene.getVariables(),
        scope: 'scene',
        sceneName: scene.getName(),
        ownerSelector: selector,
      });
    }

    addVariableDeclarations({
      container: project.getVariables(),
      scope: 'global',
      ownerSelector: projectSelector,
    });

    for (let index = 0; index < project.getExternalEventsCount(); index++) {
      const externalEvents = project.getExternalEventsAt(index);
      const externalEventsId = externalEvents.getPersistentUuid();
      const selector = 'external-events:' + externalEventsId;
      const node = addNode({
        selector,
        kind: 'external-events',
        name: externalEvents.getName(),
        externalEventsName: externalEvents.getName(),
        scope: 'project',
        associatedSceneName: externalEvents.getAssociatedLayout() || null,
        position: index,
        identity: {
          kind: 'persistent-uuid',
          id: externalEventsId,
          stableAcrossRename: true,
        },
      });
      externalNodesByName.set(externalEvents.getName(), node);
      addEdge({
        source: projectSelector,
        target: selector,
        referenceKind: 'contains-external-events',
        strength: 'hard',
        blockerOnDelete: false,
        scope: 'project',
      });
    }

    for (
      let extensionIndex = 0;
      extensionIndex < project.getEventsFunctionsExtensionsCount();
      extensionIndex++
    ) {
      const extension = project.getEventsFunctionsExtensionAt(extensionIndex);
      const extensionName = extension.getName();
      const extensionSelector = 'extension:' + encodePart(extensionName);
      addNode({
        selector: extensionSelector,
        kind: 'extension',
        name: extensionName,
        extensionName,
        scope: 'project',
        identity: {
          kind: 'project-extension-name',
          renameChangesSelector: true,
        },
      });
      addEdge({
        source: projectSelector,
        target: extensionSelector,
        referenceKind: 'contains-extension',
        strength: 'hard',
        blockerOnDelete: false,
      });

      const addFunctions = (ownerKind, ownerName, container) => {
        for (
          let functionIndex = 0;
          functionIndex < container.getEventsFunctionsCount();
          functionIndex++
        ) {
          const eventsFunction = container.getEventsFunctionAt(functionIndex);
          const functionName = eventsFunction.getName();
          const selector = functionSelector({
            extensionName,
            ownerKind,
            ownerName,
            functionName,
          });
          const node = addNode({
            selector,
            kind: 'extension-function',
            name: functionName,
            extensionName,
            ownerKind,
            ownerName: ownerName || null,
            scope: 'extension-function',
            position: functionIndex,
            identity: {
              kind: 'extension-owner-function-name',
              renameChangesSelector: true,
            },
          });
          addEdge({
            source: extensionSelector,
            target: selector,
            referenceKind: 'declares-function',
            strength: 'hard',
            blockerOnDelete: false,
          });
          rememberNamed(
            functionNodesByInstructionType,
            extensionName + '::' + functionName,
            node
          );
        }
      };

      addFunctions('extension', null, extension.getEventsFunctions());
      const behaviors = extension.getEventsBasedBehaviors();
      for (let index = 0; index < behaviors.getCount(); index++) {
        const behavior = behaviors.getAt(index);
        addFunctions(
          'behavior',
          behavior.getName(),
          behavior.getEventsFunctions()
        );
      }
      const objects = extension.getEventsBasedObjects();
      for (let index = 0; index < objects.getCount(); index++) {
        const object = objects.getAt(index);
        addFunctions('object', object.getName(), object.getEventsFunctions());
      }
    }

    const listAllObjects = input => {
      const items = [];
      let offset = 0;
      for (let pageIndex = 0; pageIndex < 100; pageIndex++) {
        const page = objectDefinitionService.list({
          ...input,
          offset,
          limit: 100,
        });
        const pageItems = page.items || [];
        items.push(...pageItems);
        offset += pageItems.length;
        if (!page.truncated || !pageItems.length) break;
      }
      return items;
    };

    const addObject = item => {
      const selector = item.identity.selector;
      const node = addNode({
        selector,
        kind: 'object-definition',
        name: item.name,
        scope: item.scope,
        ...(item.sceneName ? { sceneName: item.sceneName } : {}),
        objectType: item.type,
        identity: item.identity,
      });
      objectNodesByScopeName.set(
        item.scope + ':' + (item.sceneName || '') + ':' + item.name,
        node
      );
      const ownerNode =
        item.scope === 'scene'
          ? sceneNodesByName.get(item.sceneName)
          : nodes.get(projectSelector);
      addEdge({
        source: ownerNode && ownerNode.selector,
        target: selector,
        referenceKind: 'declares-object',
        strength: 'hard',
        blockerOnDelete: false,
        scope: item.scope,
      });

      const detailed = objectDefinitionService.get({
        objectId: item.identity.objectId,
      }).object;
      asArray(detailed.behaviors).forEach((behavior, position) => {
        const behaviorSelector = [
          'behavior',
          encodePart(selector),
          encodePart(behavior.name),
        ].join(':');
        const behaviorNode = addNode({
          selector: behaviorSelector,
          kind: 'behavior',
          name: behavior.name,
          behaviorType: behavior.type,
          scope: item.scope,
          ...(item.sceneName ? { sceneName: item.sceneName } : {}),
          objectSelector: selector,
          position,
          identity: {
            kind: 'object-behavior-name',
            renameChangesSelector: true,
          },
        });
        rememberNamed(behaviorNodesByName, behavior.name, behaviorNode);
        addEdge({
          source: selector,
          target: behaviorSelector,
          referenceKind: 'has-behavior',
          strength: 'hard',
          blockerOnDelete: false,
          scope: item.scope,
        });
      });

      asArray(detailed.resources).forEach(resource => {
        const resourceName = resource.resourceName;
        const resourceSelector = 'resource:' + encodePart(resourceName);
        const resourceNode =
          resourceNodesByName.get(resourceName) ||
          addNode({
            selector: resourceSelector,
            kind: 'resource',
            name: resourceName,
            scope: 'project',
            identity: {
              kind: 'resource-name',
              renameChangesSelector: true,
            },
          });
        resourceNodesByName.set(resourceName, resourceNode);
        addEdge({
          source: selector,
          target: resourceSelector,
          referenceKind: 'object-resource',
          strength: 'hard',
          autoRefactorable: true,
          blockerOnDelete: true,
          scope: item.scope,
          metadata: {
            discovery: resource.discovery || null,
          },
        });
      });

      const nativeObjects =
        item.scope === 'global'
          ? project.getObjects()
          : project.getLayout(item.sceneName).getObjects();
      if (nativeObjects.hasObjectNamed(item.name)) {
        addVariableDeclarations({
          container: nativeObjects.getObject(item.name).getVariables(),
          scope: 'object',
          sceneName: item.sceneName || null,
          objectSelector: selector,
          ownerSelector: selector,
        });
      }
      return node;
    };

    listAllObjects({ objectScope: 'global' }).forEach(addObject);
    for (let index = 0; index < project.getLayoutsCount(); index++) {
      const sceneName = project.getLayoutAt(index).getName();
      listAllObjects({
        objectScope: 'scene',
        sceneName,
      }).forEach(addObject);
    }

    const resolveObjectNode = (name, sceneName) =>
      objectNodesByScopeName.get('scene:' + (sceneName || '') + ':' + name) ||
      objectNodesByScopeName.get('global::' + name) ||
      null;

    const listGroups = input => {
      try {
        return asArray(objectGroupService.list(input).items);
      } catch (error) {
        return [];
      }
    };

    const addGroup = group => {
      const selector =
        group.identity && group.identity.selector
          ? group.identity.selector
          : [
              'object-group',
              encodePart(group.scope),
              encodePart(group.sceneName || ''),
              encodePart(group.name),
            ].join(':');
      const node = addNode({
        selector,
        kind: 'object-group',
        name: group.name,
        scope: group.scope,
        ...(group.sceneName ? { sceneName: group.sceneName } : {}),
        identity: group.identity || {
          kind: 'canonical-scope-name',
          renameChangesSelector: true,
        },
      });
      groupNodesByScopeName.set(
        group.scope + ':' + (group.sceneName || '') + ':' + group.name,
        node
      );
      const ownerNode =
        group.scope === 'scene'
          ? sceneNodesByName.get(group.sceneName)
          : nodes.get(projectSelector);
      addEdge({
        source: ownerNode && ownerNode.selector,
        target: selector,
        referenceKind: 'declares-object-group',
        strength: 'hard',
        blockerOnDelete: false,
        scope: group.scope,
      });
      asArray(group.members).forEach(member => {
        const objectNode = resolveObjectNode(
          member.objectName,
          group.sceneName || null
        );
        if (!objectNode) {
          warnings.push({
            code: 'reference_graph_unresolved_group_member',
            severity: 'warning',
            groupSelector: selector,
            objectName: member.objectName,
          });
          return;
        }
        addEdge({
          source: selector,
          target: objectNode.selector,
          referenceKind: 'group-member',
          strength: 'hard',
          autoRefactorable: true,
          blockerOnDelete: true,
          scope: group.scope,
          location: {
            groupName: group.name,
            memberPosition: member.position,
            sceneName: group.sceneName || null,
          },
        });
      });
      return node;
    };

    listGroups({ groupScope: 'global' }).forEach(addGroup);
    for (let index = 0; index < project.getLayoutsCount(); index++) {
      const sceneName = project.getLayoutAt(index).getName();
      listGroups({ groupScope: 'scene', sceneName }).forEach(addGroup);
    }

    const resolveGroupNode = (name, sceneName) =>
      groupNodesByScopeName.get('scene:' + (sceneName || '') + ':' + name) ||
      groupNodesByScopeName.get('global::' + name) ||
      null;

    for (let index = 0; index < project.getLayoutsCount(); index++) {
      const sceneName = project.getLayoutAt(index).getName();
      let page = { items: [] };
      try {
        page = sceneInstanceService.list({ sceneName });
      } catch (error) {}
      asArray(page.items).forEach(instance => {
        const selector =
          instance.selector || 'instance:' + encodePart(instance.instanceId);
        addNode({
          selector,
          kind: 'scene-instance',
          name: instance.objectName,
          scope: 'scene',
          sceneName,
          instanceId: instance.instanceId,
          objectName: instance.objectName,
          identity: {
            kind: 'persistent-uuid',
            id: instance.instanceId,
          },
          metadata: {
            position: instance.position || null,
            layer: instance.layer || null,
          },
        });
        const sceneNode = sceneNodesByName.get(sceneName);
        addEdge({
          source: sceneNode && sceneNode.selector,
          target: selector,
          referenceKind: 'contains-instance',
          strength: 'hard',
          blockerOnDelete: false,
          scope: 'scene',
        });
        const objectNode = resolveObjectNode(instance.objectName, sceneName);
        if (objectNode) {
          addEdge({
            source: selector,
            target: objectNode.selector,
            referenceKind: 'instance-of-object',
            strength: 'hard',
            autoRefactorable: true,
            blockerOnDelete: true,
            scope: 'scene',
            location: {
              sceneName,
              instanceId: instance.instanceId,
            },
          });
        } else {
          warnings.push({
            code: 'reference_graph_unresolved_instance_object',
            severity: 'warning',
            sceneName,
            instanceId: instance.instanceId,
            objectName: instance.objectName,
          });
        }
      });
    }

    let resources = [];
    try {
      resources = asArray(assetTools.listResources().resources);
    } catch (error) {}
    resources.forEach(resource => {
      const selector = 'resource:' + encodePart(resource.name);
      const node = addNode({
        selector,
        kind: 'resource',
        name: resource.name,
        scope: 'project',
        resourceKind: resource.kind || null,
        identity: {
          kind: 'resource-name',
          renameChangesSelector: true,
        },
        metadata: {
          orphaned: !!resource.orphaned,
          usedInProject: !!resource.usedInProject,
        },
      });
      resourceNodesByName.set(resource.name, node);
      addEdge({
        source: projectSelector,
        target: selector,
        referenceKind: 'declares-resource',
        strength: 'hard',
        blockerOnDelete: false,
      });

      try {
        const visual = assetTools.inspectVisualResource({
          resourceName: resource.name,
        });
        asArray(visual && visual.usages && visual.usages.objectUsages).forEach(
          usage => {
            const objectNode = resolveObjectNode(
              usage.objectName,
              usage.sceneName || null
            );
            if (!objectNode) return;
            asArray(usage.paths).forEach(pathEntry => {
              addEdge({
                source: objectNode.selector,
                target: selector,
                referenceKind: 'object-resource',
                strength: 'hard',
                autoRefactorable: true,
                blockerOnDelete: true,
                scope: usage.scope || objectNode.scope,
                location: {
                  sceneName: usage.sceneName || null,
                  objectName: usage.objectName,
                  objectType: usage.objectType || null,
                  resourcePath: pathEntry,
                },
              });
            });
          }
        );
      } catch (error) {
        // Non-visual resources remain represented through native exposure.
      }
    });

    const resolveVariableNode = (name, targetRecord) => {
      const rootName = String(name || '')
        .split(/[.[\]]/)[0]
        .trim();
      if (!rootName) return null;
      if (targetRecord && targetRecord.sceneName) {
        const sceneMatches = variableNodesByScopeName.get(
          'scene:' + targetRecord.sceneName + ':' + rootName
        );
        if (sceneMatches && sceneMatches.length) return sceneMatches[0];
      }
      const globalMatches = variableNodesByScopeName.get('global::' + rootName);
      return globalMatches && globalMatches.length ? globalMatches[0] : null;
    };

    const resolveTargetRootNode = targetRecord => {
      const target = targetRecord.target;
      if (target.kind === 'scene') {
        return sceneNodesByName.get(target.sceneName) || null;
      }
      if (target.kind === 'external-events') {
        return externalNodesByName.get(target.externalEventsName) || null;
      }
      if (target.kind === 'extension-function') {
        return (
          nodes.get(
            functionSelector({
              extensionName: target.extensionName,
              ownerKind: target.ownerKind,
              ownerName: target.ownerName,
              functionName: target.functionName,
            })
          ) || null
        );
      }
      return null;
    };

    const addDynamicLexicalEdges = ({
      instructionNode,
      value,
      parameterIndex,
      location,
      typedTargetSelector,
    }) => {
      if (typeof value !== 'string' || !value) return;
      const candidates = [];
      nodes.forEach(node => {
        if (
          ![
            'object-definition',
            'object-group',
            'scene',
            'external-events',
            'resource',
          ].includes(node.kind) ||
          !node.name ||
          node.selector === typedTargetSelector
        ) {
          return;
        }
        if (exactToken(node.name).test(value)) {
          candidates.push(node);
        }
      });
      candidates.slice(0, 50).forEach(candidate => {
        addEdge({
          source: instructionNode.selector,
          target: candidate.selector,
          referenceKind: 'expression-or-text-potential-reference',
          strength: 'dynamic',
          autoRefactorable: false,
          blockerOnDelete: false,
          scope: instructionNode.scope,
          location: {
            ...location,
            parameterIndex,
            parameterValue: value,
          },
          metadata: {
            warningCode: 'reference_graph_dynamic_reference',
          },
        });
      });
      if (candidates.length) {
        warnings.push({
          code: 'reference_graph_dynamic_reference',
          severity: 'warning',
          instructionHandle: instructionNode.selector,
          parameterIndex,
          candidateCount: candidates.length,
          message:
            'A name appears lexically inside an expression/text parameter. This is dynamic evidence and is not claimed to be safely rewritable.',
        });
      }
    };

    allEventTargets().forEach(targetRecord => {
      let state;
      try {
        state = eventTools.readEventsJson({ target: targetRecord.target });
      } catch (error) {
        warnings.push({
          code: 'reference_graph_event_target_unreadable',
          severity: 'warning',
          target: targetRecord.target,
        });
        return;
      }
      const rootNode = resolveTargetRootNode(targetRecord);
      if (!rootNode) return;

      const visitInstruction = ({
        instruction,
        eventNode,
        parentInstructionNode,
        kind,
      }) => {
        const nodeKind = kind === 'action' ? 'event-action' : 'event-condition';
        const selector = instruction.handle;
        if (!selector) return;
        const instructionNode = addNode({
          selector,
          kind: nodeKind,
          name: instruction.type || selector,
          scope: targetRecord.namespace,
          sceneName: targetRecord.sceneName || null,
          extensionName:
            targetRecord.target.kind === 'extension-function'
              ? targetRecord.target.extensionName
              : null,
          identity: {
            kind: 'stable-event-instruction-handle',
            handle: selector,
          },
          metadata: {
            instructionType: instruction.type || null,
            instructionPath: instruction.path || null,
            target: targetRecord.target,
            eventsRevision: state.eventsRevision,
          },
        });
        addEdge({
          source: parentInstructionNode
            ? parentInstructionNode.selector
            : eventNode.selector,
          target: selector,
          referenceKind: 'contains-event-instruction',
          strength: 'hard',
          blockerOnDelete: false,
          scope: targetRecord.namespace,
        });

        const instructionType = instruction.type || '';
        const functionCandidates =
          functionNodesByInstructionType.get(instructionType) || [];
        functionCandidates.forEach(functionNode => {
          addEdge({
            source: selector,
            target: functionNode.selector,
            referenceKind: 'calls-extension-function',
            strength: 'hard',
            autoRefactorable: true,
            blockerOnDelete: true,
            scope: targetRecord.namespace,
            location: {
              target: targetRecord.target,
              eventHandle: eventNode.selector,
              instructionHandle: selector,
              eventsRevision: state.eventsRevision,
            },
          });
        });

        const metadata = getInstructionMetadata(instruction, kind);
        asArray(instruction.parameters).forEach((value, parameterIndex) => {
          if (typeof value !== 'string') return;
          const parameterMetadata =
            metadata &&
            Array.isArray(metadata.parameters) &&
            metadata.parameters[parameterIndex]
              ? metadata.parameters[parameterIndex]
              : null;
          const valueType =
            (parameterMetadata && parameterMetadata.valueType) || {};
          const typeName = String(
            (parameterMetadata && parameterMetadata.type) || ''
          ).toLowerCase();
          const location = {
            target: targetRecord.target,
            eventHandle: eventNode.selector,
            eventPath: eventNode.metadata.eventPath || null,
            instructionHandle: selector,
            instructionKind: kind,
            instructionType,
            parameterIndex,
            parameterValue: value,
            eventsRevision: state.eventsRevision,
          };

          let typedTarget = null;
          let referenceKind = null;
          let strength = 'hard';
          let autoRefactorable = true;

          if (valueType.object) {
            if (targetRecord.namespace === 'project-scene') {
              typedTarget =
                resolveObjectNode(value, targetRecord.sceneName) ||
                resolveGroupNode(value, targetRecord.sceneName);
            }
            referenceKind = typedTarget
              ? typedTarget.kind === 'object-group'
                ? 'event-parameter-object-group'
                : 'event-parameter-object'
              : 'event-parameter-object-or-group-unresolved';
            if (!typedTarget) {
              strength = 'dynamic';
              autoRefactorable = false;
            }
          } else if (valueType.resource) {
            typedTarget = resourceNodesByName.get(value) || null;
            referenceKind = 'event-parameter-resource';
            if (!typedTarget) {
              strength = 'dynamic';
              autoRefactorable = false;
            }
          } else if (valueType.variable) {
            typedTarget = resolveVariableNode(value, targetRecord);
            referenceKind = 'event-parameter-variable';
            if (!typedTarget) {
              strength = 'dynamic';
              autoRefactorable = false;
            }
          } else if (valueType.behavior) {
            const matches = behaviorNodesByName.get(value) || [];
            typedTarget = matches.length === 1 ? matches[0] : null;
            referenceKind = 'event-parameter-behavior';
            strength = typedTarget ? 'soft' : 'dynamic';
            autoRefactorable = false;
          } else if (typeName.includes('scene')) {
            typedTarget = sceneNodesByName.get(value) || null;
            referenceKind = 'event-parameter-scene';
            if (!typedTarget) {
              strength = 'dynamic';
              autoRefactorable = false;
            }
          } else if (typeName.includes('external')) {
            typedTarget = externalNodesByName.get(value) || null;
            referenceKind = 'event-parameter-external-events';
            if (!typedTarget) {
              strength = 'dynamic';
              autoRefactorable = false;
            }
          }

          if (typedTarget) {
            addEdge({
              source: selector,
              target: typedTarget.selector,
              referenceKind,
              strength,
              autoRefactorable,
              blockerOnDelete: strength === 'hard',
              scope: targetRecord.namespace,
              location,
              metadata: {
                parameterMetadata: parameterMetadata
                  ? {
                      name: parameterMetadata.name,
                      type: parameterMetadata.type,
                      valueType,
                      referenceSemantics:
                        parameterMetadata.referenceSemantics || null,
                    }
                  : null,
              },
            });
          } else if (referenceKind) {
            warnings.push({
              code: 'reference_graph_unresolved_typed_reference',
              severity: 'warning',
              referenceKind,
              value,
              location,
            });
          }

          addDynamicLexicalEdges({
            instructionNode,
            value,
            parameterIndex,
            location,
            typedTargetSelector: typedTarget && typedTarget.selector,
          });
        });

        asArray(instruction.children).forEach(child => {
          visitInstruction({
            instruction: child,
            eventNode,
            parentInstructionNode: instructionNode,
            kind,
          });
        });
      };

      const visitEvents = (events, parentEventNode = null) => {
        asArray(events).forEach(event => {
          if (!event || !event.handle) return;
          const eventNode = addNode({
            selector: event.handle,
            kind: 'event',
            name: event.type || event.handle,
            scope: targetRecord.namespace,
            sceneName: targetRecord.sceneName || null,
            extensionName:
              targetRecord.target.kind === 'extension-function'
                ? targetRecord.target.extensionName
                : null,
            identity: {
              kind: 'stable-event-handle',
              handle: event.handle,
            },
            metadata: {
              eventType: event.type || null,
              eventPath: event.path || null,
              target: targetRecord.target,
              eventsRevision: state.eventsRevision,
            },
          });
          addEdge({
            source: parentEventNode
              ? parentEventNode.selector
              : rootNode.selector,
            target: eventNode.selector,
            referenceKind: parentEventNode
              ? 'contains-subevent'
              : 'contains-event',
            strength: 'hard',
            blockerOnDelete: false,
            scope: targetRecord.namespace,
          });

          asArray(event.conditions).forEach(instruction =>
            visitInstruction({
              instruction,
              eventNode,
              parentInstructionNode: null,
              kind: 'condition',
            })
          );
          asArray(event.whileConditions).forEach(instruction =>
            visitInstruction({
              instruction,
              eventNode,
              parentInstructionNode: null,
              kind: 'condition',
            })
          );
          asArray(event.actions).forEach(instruction =>
            visitInstruction({
              instruction,
              eventNode,
              parentInstructionNode: null,
              kind: 'action',
            })
          );
          visitEvents(event.children || [], eventNode);
        });
      };

      visitEvents(state.events || []);
    });

    if (
      sceneLifecycleService &&
      typeof sceneLifecycleService.usages === 'function'
    ) {
      sceneNodesByName.forEach((sceneNode, sceneName) => {
        try {
          const usage = sceneLifecycleService.usages({ sceneName });
          asArray(usage.references).forEach(reference => {
            addEdge({
              source: projectSelector,
              target: sceneNode.selector,
              referenceKind: 'native-scene-refactor-reference',
              strength: 'hard',
              autoRefactorable: true,
              blockerOnDelete: true,
              scope: 'project',
              location: reference,
              metadata: {
                source: 'project.scenes.usages',
              },
            });
          });
        } catch (error) {}
      });
    }

    if (
      externalProjectItemsService &&
      typeof externalProjectItemsService.externalEventsUsages === 'function'
    ) {
      externalNodesByName.forEach((externalNode, externalEventsName) => {
        try {
          const usage = externalProjectItemsService.externalEventsUsages({
            externalEventsName,
          });
          asArray(usage.references).forEach(reference => {
            addEdge({
              source: projectSelector,
              target: externalNode.selector,
              referenceKind: 'native-external-events-refactor-reference',
              strength: 'hard',
              autoRefactorable: true,
              blockerOnDelete: true,
              scope: 'project',
              location: reference,
              metadata: {
                source: 'external-events.usages',
              },
            });
          });
        } catch (error) {}
      });
    }

    const edges = Array.from(edgesByKey.values()).sort((left, right) =>
      [left.source.selector, left.target.selector, left.referenceKind, left.id]
        .join('|')
        .localeCompare(
          [
            right.source.selector,
            right.target.selector,
            right.referenceKind,
            right.id,
          ].join('|')
        )
    );
    const nodeList = Array.from(nodes.values()).sort((left, right) =>
      left.selector.localeCompare(right.selector)
    );
    const graphRevision =
      'reference-graph:' +
      hashString(
        JSON.stringify({
          nodes: nodeList.map(node => node.selector),
          edges: edges.map(edge => edge.id),
        })
      );

    return {
      graphRevision,
      projectSelector,
      nodes: nodeList,
      nodeMap: nodes,
      edges,
      warnings,
      coverage,
    };
  };

  const resolveNode = (graph: any, input: any): any => {
    const selector = nonEmptyString(input && input.selector);
    if (selector) {
      const node = graph.nodeMap.get(selector);
      if (!node) {
        throw makeError('reference_graph_node_not_found', { selector });
      }
      return node;
    }

    const name = nonEmptyString(input && input.name);
    const path = nonEmptyString(input && input.path);
    const kind = nonEmptyString(input && input.kind);
    const matches = graph.nodes.filter(node => {
      if (kind && node.kind !== kind) return false;
      if (name && node.name !== name) return false;
      if (path && node.path !== path) return false;
      return !!(name || path || kind);
    });
    if (!matches.length) {
      throw makeError('reference_graph_node_not_found', {
        name,
        path,
        kind,
      });
    }
    if (matches.length > 1) {
      throw makeError('reference_graph_node_ambiguous', {
        name,
        path,
        kind,
        matches: matches.slice(0, 50).map(node => ({
          selector: node.selector,
          kind: node.kind,
          scope: node.scope || null,
          sceneName: node.sceneName || null,
          extensionName: node.extensionName || null,
        })),
      });
    }
    return matches[0];
  };

  const edgeMatchesFilters = (edge: any, input: any): boolean => {
    if (
      input &&
      Array.isArray(input.referenceKinds) &&
      input.referenceKinds.length &&
      !input.referenceKinds.includes(edge.referenceKind)
    ) {
      return false;
    }
    if (
      input &&
      Array.isArray(input.strengths) &&
      input.strengths.length &&
      !input.strengths.includes(edge.strength)
    ) {
      return false;
    }
    if (
      input &&
      typeof input.sceneName === 'string' &&
      input.sceneName &&
      ![
        edge.source.sceneName,
        edge.target.sceneName,
        edge.location && edge.location.sceneName,
        edge.location && edge.location.target && edge.location.target.sceneName,
      ].includes(input.sceneName)
    ) {
      return false;
    }
    if (
      input &&
      typeof input.externalEventsName === 'string' &&
      input.externalEventsName &&
      ![
        edge.source.externalEventsName,
        edge.target.externalEventsName,
        edge.location &&
          edge.location.target &&
          edge.location.target.externalEventsName,
      ].includes(input.externalEventsName)
    ) {
      return false;
    }
    if (
      input &&
      typeof input.extensionName === 'string' &&
      input.extensionName &&
      ![edge.source.extensionName, edge.target.extensionName].includes(
        input.extensionName
      )
    ) {
      return false;
    }
    if (
      input &&
      typeof input.resourceKind === 'string' &&
      input.resourceKind &&
      !(
        (edge.source.kind === 'resource' &&
          edge.source.resourceKind === input.resourceKind) ||
        (edge.target.kind === 'resource' &&
          edge.target.resourceKind === input.resourceKind)
      )
    ) {
      return false;
    }
    return true;
  };

  const query = (input: any = {}): any => {
    const graph = buildGraph();
    const root = resolveNode(graph, input);
    const direction = ['inbound', 'outbound', 'both'].includes(input.direction)
      ? input.direction
      : 'both';
    const maxDepth = clampInteger(input.maxDepth, 1, 0, 12);
    const maxVisitedNodes = clampInteger(input.maxVisitedNodes, 1000, 1, 10000);

    const queue = [{ selector: root.selector, depth: 0 }];
    const bestDepth = new Map([[root.selector, 0]]);
    const traversedEdges = new Map();
    const cycles = [];

    while (queue.length) {
      const current = queue.shift();
      if (!current || current.depth >= maxDepth) continue;

      graph.edges
        .filter(edge => {
          if (!edgeMatchesFilters(edge, input)) return false;
          const inbound =
            (direction === 'inbound' || direction === 'both') &&
            edge.target.selector === current.selector;
          const outbound =
            (direction === 'outbound' || direction === 'both') &&
            edge.source.selector === current.selector;
          return inbound || outbound;
        })
        .forEach(edge => {
          const traversalDirection =
            edge.target.selector === current.selector ? 'inbound' : 'outbound';
          const nextSelector =
            traversalDirection === 'inbound'
              ? edge.source.selector
              : edge.target.selector;
          const nextDepth = current.depth + 1;

          const previous = traversedEdges.get(edge.id);
          if (!previous || nextDepth < previous.traversalDepth) {
            traversedEdges.set(edge.id, {
              ...edge,
              traversalDepth: nextDepth,
              traversalDirection,
            });
          }

          const previousDepth = bestDepth.get(nextSelector);
          if (previousDepth == null) {
            if (bestDepth.size >= maxVisitedNodes) return;
            bestDepth.set(nextSelector, nextDepth);
            queue.push({ selector: nextSelector, depth: nextDepth });
          } else if (previousDepth <= nextDepth) {
            cycles.push({
              from: current.selector,
              to: nextSelector,
              viaEdge: edge.id,
              detectedAtDepth: nextDepth,
            });
          }
        });
    }

    const allEdges = Array.from(traversedEdges.values()).sort(
      (left, right) =>
        left.traversalDepth - right.traversalDepth ||
        left.id.localeCompare(right.id)
    );
    const offset = clampInteger(
      input.offset,
      0,
      0,
      Math.max(0, allEdges.length)
    );
    const limit = clampInteger(input.limit, 200, 1, 2000);
    const edges = allEdges.slice(offset, offset + limit);
    const selectors = new Set([root.selector]);
    edges.forEach(edge => {
      selectors.add(edge.source.selector);
      selectors.add(edge.target.selector);
    });

    return {
      graphRevision: graph.graphRevision,
      root,
      direction,
      maxDepth,
      totalEdges: allEdges.length,
      offset,
      limit,
      truncated: offset + limit < allEdges.length,
      edges,
      nodes: Array.from(selectors)
        .map(selector => graph.nodeMap.get(selector))
        .filter(Boolean),
      traversal: {
        visitedNodeCount: bestDepth.size,
        maxVisitedNodes,
        maxVisitedNodesReached: bestDepth.size >= maxVisitedNodes,
        cyclesDetected: cycles.length,
        cycles: cycles.slice(0, 100),
      },
      warnings: graph.warnings,
      coverage: graph.coverage,
      projectModified: false,
    };
  };

  const usages = (input: any = {}): any =>
    query({
      ...input,
      direction: 'inbound',
      maxDepth:
        Number.isInteger(input.maxDepth) && input.maxDepth >= 0
          ? input.maxDepth
          : 1,
    });

  const impact = (input: any = {}): any => {
    const operation = ['rename', 'move', 'delete'].includes(input.operation)
      ? input.operation
      : 'delete';
    const result = usages({
      ...input,
      maxDepth:
        Number.isInteger(input.maxDepth) && input.maxDepth >= 0
          ? input.maxDepth
          : 2,
      offset: 0,
      limit: 2000,
    });
    const affectedReferences = result.edges;
    const hardReferences = affectedReferences.filter(
      edge => edge.strength === 'hard'
    );
    const softReferences = affectedReferences.filter(
      edge => edge.strength === 'soft'
    );
    const dynamicReferences = affectedReferences.filter(
      edge => edge.strength === 'dynamic'
    );
    const safelyRewritable = hardReferences.filter(
      edge => edge.autoRefactorable
    );
    const isStructuralOwnershipEdge = edge =>
      typeof edge.referenceKind === 'string' &&
      (edge.referenceKind.startsWith('declares-') ||
        edge.referenceKind.startsWith('contains-'));
    const blockers =
      operation === 'delete'
        ? hardReferences.filter(edge => edge.blockerOnDelete)
        : hardReferences.filter(
            edge =>
              edge.traversalDepth === 1 &&
              !edge.autoRefactorable &&
              !isStructuralOwnershipEdge(edge)
          );
    const unresolvedWarnings = [
      ...dynamicReferences.map(edge => ({
        code: 'reference_graph_dynamic_reference',
        severity: 'warning',
        edgeId: edge.id,
        source: edge.source,
        location: edge.location,
      })),
      ...softReferences.map(edge => ({
        code: 'reference_graph_soft_reference',
        severity: 'warning',
        edgeId: edge.id,
        source: edge.source,
        location: edge.location,
      })),
      ...result.warnings,
    ];

    return {
      graphRevision: result.graphRevision,
      operation,
      target: result.root,
      affectedReferenceCount: affectedReferences.length,
      affectedReferences,
      hardReferenceCount: hardReferences.length,
      softReferenceCount: softReferences.length,
      dynamicReferenceCount: dynamicReferences.length,
      safelyRewritableCount: safelyRewritable.length,
      safelyRewritable,
      blockerCount: blockers.length,
      blockers,
      unresolvedWarnings,
      safeToApply: blockers.length === 0 && unresolvedWarnings.length === 0,
      safety: {
        hard:
          'Exact typed/native references. Rename may be auto-refactorable; delete remains blocked while hard inbound references exist.',
        soft:
          'A typed relationship exists but target resolution or native rewrite coverage is incomplete.',
        dynamic:
          'Lexical/expression evidence only. It is never treated as proof that automatic refactoring is safe.',
      },
      recommendedAction:
        blockers.length || unresolvedWarnings.length
          ? 'Review blockers and unresolved warnings before mutation. Re-query after cleanup/refactor and require a fresh graphRevision.'
          : 'No known blocking or unresolved inbound references were found at this graph revision.',
      coverage: result.coverage,
      projectModified: false,
    };
  };

  const capabilities = (): any => ({
    nodeKinds: REFERENCE_NODE_KINDS.map(kind => ({
      kind,
      stableIdentity: [
        'scene',
        'external-events',
        'object-definition',
        'scene-instance',
      ].includes(kind)
        ? 'native-persistent-uuid'
        : ['event', 'event-condition', 'event-action'].includes(kind)
        ? 'stable-event-handle'
        : 'canonical-name-or-path',
    })),
    edgeStrengths: ['hard', 'soft', 'dynamic'],
    directions: ['inbound', 'outbound', 'both'],
    operations: ['rename', 'move', 'delete'],
    traversal: {
      boundedDepth: true,
      maxDepth: 12,
      cycleHandling: 'visited-node-set-with-cycle-report',
      stablePagination: true,
      maxPageSize: 2000,
    },
    integrations: {
      variables: 'DX-11',
      resources: 'DX-28',
      groups: 'DX-31',
      scenesAndExternalEvents: 'DX-33',
      objectDefinitions: 'DX-34',
      extensionFunctions: 'DX-10',
      eventHandles: 'DX-3/DX-20',
      revisionsAndOwnership: 'DX-19 canonical command envelope',
      errors: 'DX-21 AgentError/canonical MCP error envelope',
    },
    projectModified: false,
  });

  return {
    capabilities,
    query,
    usages,
    impact,
  };
};
