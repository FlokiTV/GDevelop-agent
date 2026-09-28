// @flow
import { AgentError } from '../core/AgentError';

const gd: libGDevelop = global.gd;
const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

type Options = {|
  project: ?gdProject,
  triggerUnsavedChanges: () => void,
  forceUpdate: () => void,
  onInstancesModifiedOutsideEditor: any,
|};

const requireString = (value: any, field: string): string => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AgentError({
      code: 'invalid_layer_order_input',
      message: `${field} must be a non-empty string.`,
      field,
      details: { field, expected: 'non-empty string' },
    });
  }
  return value;
};

const iterateInstances = (
  container: gdInitialInstancesContainer,
  callback: (instance: gdInitialInstance, sourceIndex: number) => void
) => {
  let sourceIndex = 0;
  const functor = new gd.InitialInstanceJSFunctor();
  // $FlowFixMe[cannot-write]
  functor.invoke = instancePtr => {
    const instance: gdInitialInstance = gd.wrapPointer(
      // $FlowFixMe[incompatible-type]
      instancePtr,
      gd.InitialInstance
    );
    callback(instance, sourceIndex++);
  };
  // $FlowFixMe[incompatible-type]
  container.iterateOverInstances(functor);
  functor.delete();
};

const idMatches = (value: string, query: string): boolean =>
  value.toLowerCase().startsWith(query.toLowerCase());

export const createLayerOrderService = ({
  project,
  triggerUnsavedChanges,
  forceUpdate,
  onInstancesModifiedOutsideEditor,
}: Options) => {
  const fallbackLayerIdsByScene = new Map();
  let nextFallbackLayerId = 1;

  const getFallbackRegistry = (scene: gdLayout): Map<string, string> => {
    const sceneKey =
      typeof scene.getPersistentUuid === 'function'
        ? scene.getPersistentUuid()
        : scene.getName();
    let registry = fallbackLayerIdsByScene.get(sceneKey);
    if (!registry) {
      registry = new Map();
      fallbackLayerIdsByScene.set(sceneKey, registry);
    }
    return registry;
  };

  const getLayerIdentity = (scene: gdLayout, layer: gdLayer): any => {
    if (typeof layer.getPersistentUuid === 'function') {
      const id = layer.getPersistentUuid();
      if (id) return { id, persistence: 'project-persistent' };
    }
    const registry = getFallbackRegistry(scene);
    const name = layer.getName();
    let id = registry.get(name);
    if (!id) {
      id = `session-layer-${nextFallbackLayerId++}`;
      registry.set(name, id);
    }
    return { id, persistence: 'session-fallback' };
  };

  const renameFallbackLayerIdentity = (
    scene: gdLayout,
    oldName: string,
    newName: string
  ) => {
    const registry = getFallbackRegistry(scene);
    const id = registry.get(oldName);
    if (id) {
      registry.delete(oldName);
      registry.set(newName, id);
    }
  };

  const removeFallbackLayerIdentity = (scene: gdLayout, name: string) => {
    getFallbackRegistry(scene).delete(name);
  };

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
        details: { sceneName: name },
      });
    }
    return currentProject.getLayout(name);
  };

  const serializeLayer = (
    scene: gdLayout,
    layer: gdLayer,
    index: number
  ): any => {
    const identity = getLayerIdentity(scene, layer);
    return {
      layerId: identity.id,
      layerIdPersistence: identity.persistence,
      selector: `layer:${identity.id}`,
      name: layer.getName(),
      index,
      renderOrder: {
        authority: 'editor-project',
        direction: 'back-to-front',
        lowerIndexRendersBelow: true,
      },
      state: {
        visibleAtStartup: layer.getVisibility(),
        lockedInEditor: layer.isLocked(),
        lightingLayer: layer.isLightingLayer(),
        followsBaseLayerCamera: layer.isFollowingBaseLayerCamera(),
        renderingType: layer.getRenderingType(),
        cameraType: layer.getCameraType(),
        defaultCameraBehavior: layer.getDefaultCameraBehavior(),
        cameraCount: layer.getCameraCount(),
      },
      instanceCount: scene
        .getInitialInstances()
        .getLayerInstancesCount(layer.getName()),
      isBaseLayer: layer.getName() === '',
    };
  };

  const allLayers = (scene: gdLayout): Array<any> => {
    const layers = scene.getLayers();
    const result = [];
    for (let index = 0; index < layers.getLayersCount(); index++) {
      result.push(serializeLayer(scene, layers.getLayerAt(index), index));
    }
    return result;
  };

  const resolveLayer = (scene: gdLayout, target: any): any => {
    const layers = scene.getLayers();
    const layerId =
      target && typeof target.layerId === 'string' && target.layerId.trim()
        ? target.layerId.trim()
        : null;
    const hasName =
      target &&
      Object.prototype.hasOwnProperty.call(target, 'layerName') &&
      typeof target.layerName === 'string';
    if (!layerId && !hasName) {
      throw new AgentError({
        code: 'missing_layer_target',
        field: 'layerId',
        hint: 'Use layerId from scene.layers.list, or layerName.',
      });
    }
    const matches = [];
    for (let index = 0; index < layers.getLayersCount(); index++) {
      const layer = layers.getLayerAt(index);
      const identity = getLayerIdentity(scene, layer);
      if (layerId && !idMatches(identity.id, layerId)) continue;
      if (hasName && layer.getName() !== target.layerName) continue;
      matches.push({ layer, index });
    }
    if (!matches.length) {
      throw new AgentError({
        code: 'layer_not_found',
        message: 'The requested layer no longer exists.',
        details: { layerId, layerName: hasName ? target.layerName : null },
      });
    }
    if (matches.length > 1) {
      throw new AgentError({
        code: 'layer_id_ambiguous',
        message: 'The supplied layer UUID prefix matches multiple layers.',
        details: { layerId, matchCount: matches.length },
      });
    }
    return matches[0];
  };

  const resolveInstance = (
    scene: gdLayout,
    instanceId: any
  ): gdInitialInstance => {
    const query = requireString(instanceId, 'instanceId');
    const matches = [];
    iterateInstances(scene.getInitialInstances(), instance => {
      if (idMatches(instance.getPersistentUuid(), query))
        matches.push(instance);
    });
    if (!matches.length) {
      throw new AgentError({
        code: 'instance_not_found',
        message: 'The requested scene instance no longer exists.',
        details: { instanceId: query },
      });
    }
    if (matches.length > 1) {
      throw new AgentError({
        code: 'instance_id_ambiguous',
        details: { instanceId: query, matchCount: matches.length },
      });
    }
    return matches[0];
  };

  const assertLayerPreconditions = (
    scene: gdLayout,
    resolved: any,
    input: any
  ) => {
    if (
      input &&
      input.expectedIndex !== undefined &&
      input.expectedIndex !== resolved.index
    ) {
      throw new AgentError({
        code: 'layer_order_conflict',
        message: 'The layer moved since it was inspected.',
        retryable: true,
        details: {
          layerId: getLayerIdentity(scene, resolved.layer).id,
          expectedIndex: input.expectedIndex,
          actualIndex: resolved.index,
        },
      });
    }
    if (
      input &&
      input.expectedName !== undefined &&
      input.expectedName !== resolved.layer.getName()
    ) {
      throw new AgentError({
        code: 'layer_name_conflict',
        message: 'The layer was renamed since it was inspected.',
        retryable: true,
        details: {
          layerId: getLayerIdentity(scene, resolved.layer).id,
          expectedName: input.expectedName,
          actualName: resolved.layer.getName(),
        },
      });
    }
  };

  const layerInfoForInstance = (
    scene: gdLayout,
    instance: gdInitialInstance
  ) => {
    const layerName = instance.getLayer();
    const layers = scene.getLayers();
    if (!layers.hasLayerNamed(layerName)) {
      return {
        layerId: null,
        layerName,
        layerIndex: null,
        missingLayer: true,
      };
    }
    const index = layers.getLayerPosition(layerName);
    const layer = layers.getLayer(layerName);
    return {
      layerId: getLayerIdentity(scene, layer).id,
      layerName,
      layerIndex: index,
      missingLayer: false,
    };
  };

  const collectInstances = (scene: gdLayout): Array<any> => {
    const raw = [];
    iterateInstances(scene.getInitialInstances(), (instance, sourceIndex) => {
      raw.push({
        instance,
        sourceIndex,
        zOrder: instance.getZOrder(),
        layer: layerInfoForInstance(scene, instance),
      });
    });

    const countsByLayerAndZ = new Map();
    raw.forEach(entry => {
      const key = `${entry.layer.layerId || entry.layer.layerName}\u0000${
        entry.zOrder
      }`;
      countsByLayerAndZ.set(key, (countsByLayerAndZ.get(key) || 0) + 1);
    });

    const sorted = raw.slice().sort((a, b) => {
      const aLayer =
        a.layer.layerIndex == null
          ? Number.MAX_SAFE_INTEGER
          : a.layer.layerIndex;
      const bLayer =
        b.layer.layerIndex == null
          ? Number.MAX_SAFE_INTEGER
          : b.layer.layerIndex;
      if (aLayer !== bLayer) return aLayer - bLayer;
      if (a.zOrder !== b.zOrder) return a.zOrder - b.zOrder;
      return a.sourceIndex - b.sourceIndex;
    });

    const layerRanks = new Map();
    return sorted.map(entry => {
      const layerKey = entry.layer.layerId || entry.layer.layerName;
      const rank = layerRanks.get(layerKey) || 0;
      layerRanks.set(layerKey, rank + 1);
      const tieKey = `${layerKey}\u0000${entry.zOrder}`;
      const tieCount = countsByLayerAndZ.get(tieKey) || 1;
      return {
        instanceId: entry.instance.getPersistentUuid(),
        selector: `instance:${entry.instance.getPersistentUuid()}`,
        objectName: entry.instance.getObjectName(),
        ...entry.layer,
        zOrder: entry.zOrder,
        renderOrderWithinLayer: tieCount === 1 ? rank : null,
        renderOrderDeterministic: tieCount === 1,
        zOrderTieCount: tieCount,
        editorContainerIndex: entry.sourceIndex,
        authority: 'editor-project',
      };
    });
  };

  const compareSnapshots = (a: any, b: any): any => {
    if (a.instanceId === b.instanceId) {
      return {
        determinable: true,
        relation: 'same',
        reason: 'same-instance',
      };
    }
    if (a.missingLayer || b.missingLayer) {
      return {
        determinable: false,
        relation: 'indeterminate',
        reason: 'missing-layer',
      };
    }
    if (a.layerIndex !== b.layerIndex) {
      return a.layerIndex > b.layerIndex
        ? { determinable: true, relation: 'above', reason: 'layer-order' }
        : { determinable: true, relation: 'below', reason: 'layer-order' };
    }
    if (a.zOrder !== b.zOrder) {
      return a.zOrder > b.zOrder
        ? { determinable: true, relation: 'above', reason: 'z-order' }
        : { determinable: true, relation: 'below', reason: 'z-order' };
    }
    return {
      determinable: false,
      relation: 'indeterminate',
      reason: 'equal-z-order-has-no-authoritative-editor-tiebreak',
    };
  };

  const snapshotInstance = (
    scene: gdLayout,
    instance: gdInitialInstance
  ): any => {
    const all = collectInstances(scene);
    const id = instance.getPersistentUuid();
    return all.find(item => item.instanceId === id);
  };

  const markChanged = (scene: gdLayout, instancesModified: boolean = false) => {
    triggerUnsavedChanges();
    forceUpdate();
    if (
      instancesModified &&
      typeof onInstancesModifiedOutsideEditor === 'function'
    ) {
      onInstancesModifiedOutsideEditor({ scene });
    }
  };

  const list = (input: any): any => {
    const scene = requireScene(input && input.sceneName);
    const includeInstances = !input || input.includeInstances !== false;
    return {
      authority: 'editor-project',
      runtimeDynamicStateIncluded: false,
      scene: {
        sceneName: scene.getName(),
        sceneId: scene.getPersistentUuid(),
      },
      orderSemantics: {
        layers: 'ascending-index-is-back-to-front',
        instances: 'within-layer-higher-zOrder-renders-above',
        equalZOrder: 'indeterminate',
      },
      layers: allLayers(scene),
      ...(includeInstances ? { instances: collectInstances(scene) } : {}),
    };
  };

  const compare = (input: any): any => {
    const scene = requireScene(input && input.sceneName);
    const a = snapshotInstance(
      scene,
      resolveInstance(scene, input && input.aInstanceId)
    );
    const b = snapshotInstance(
      scene,
      resolveInstance(scene, input && input.bInstanceId)
    );
    return {
      authority: 'editor-project',
      sceneName: scene.getName(),
      a,
      b,
      result: compareSnapshots(a, b),
      runtimeNote:
        'Runtime events may change layer/Z-order. Use preview.layout.inspect for live runtime renderStack relations.',
    };
  };

  const create = (input: any): any => {
    const scene = requireScene(input && input.sceneName);
    const name = requireString(input && input.name, 'name');
    const layers = scene.getLayers();
    if (layers.hasLayerNamed(name)) {
      throw new AgentError({
        code: 'layer_already_exists',
        details: { layerName: name },
      });
    }
    const count = layers.getLayersCount();
    const position =
      input && input.position !== undefined ? input.position : count;
    if (!Number.isInteger(position) || position < 0 || position > count) {
      throw new AgentError({
        code: 'invalid_layer_position',
        field: 'position',
        details: { position, minimum: 0, maximum: count },
      });
    }
    layers.insertNewLayer(name, position);
    const created = resolveLayer(scene, { layerName: name });
    markChanged(scene);
    return {
      authority: 'editor-project',
      created: serializeLayer(scene, created.layer, created.index),
    };
  };

  const rename = (input: any): any => {
    const scene = requireScene(input && input.sceneName);
    const resolved = resolveLayer(scene, input || {});
    assertLayerPreconditions(scene, resolved, input || {});
    const oldName = resolved.layer.getName();
    if (oldName === '') {
      throw new AgentError({
        code: 'base_layer_mutation_forbidden',
        message: 'The base layer cannot be renamed.',
      });
    }
    const newName = requireString(input && input.newName, 'newName');
    if (newName === oldName) {
      return {
        authority: 'editor-project',
        renamed: false,
        layer: serializeLayer(scene, resolved.layer, resolved.index),
      };
    }
    if (scene.getLayers().hasLayerNamed(newName)) {
      throw new AgentError({
        code: 'layer_already_exists',
        details: { layerName: newName },
      });
    }
    gd.WholeProjectRefactorer.renameLayerInScene(
      requireProject(),
      scene,
      oldName,
      newName
    );
    resolved.layer.setName(newName);
    renameFallbackLayerIdentity(scene, oldName, newName);
    markChanged(scene, true);
    return {
      authority: 'editor-project',
      renamed: true,
      oldName,
      layer: serializeLayer(scene, resolved.layer, resolved.index),
    };
  };

  const reorder = (input: any): any => {
    const scene = requireScene(input && input.sceneName);
    const resolved = resolveLayer(scene, input || {});
    assertLayerPreconditions(scene, resolved, input || {});
    const layers = scene.getLayers();
    const position = input && input.position;
    const max = Math.max(0, layers.getLayersCount() - 1);
    if (!Number.isInteger(position) || position < 0 || position > max) {
      throw new AgentError({
        code: 'invalid_layer_position',
        field: 'position',
        details: { position, minimum: 0, maximum: max },
      });
    }
    const before = serializeLayer(scene, resolved.layer, resolved.index);
    if (position !== resolved.index) layers.moveLayer(resolved.index, position);
    const afterResolved = resolveLayer(scene, { layerId: before.layerId });
    markChanged(scene);
    return {
      authority: 'editor-project',
      before,
      after: serializeLayer(scene, afterResolved.layer, afterResolved.index),
      unrelatedPropertiesPreserved: true,
    };
  };

  const remove = (input: any): any => {
    const scene = requireScene(input && input.sceneName);
    const resolved = resolveLayer(scene, input || {});
    assertLayerPreconditions(scene, resolved, input || {});
    const oldName = resolved.layer.getName();
    if (oldName === '') {
      throw new AgentError({
        code: 'base_layer_mutation_forbidden',
        message: 'The base layer cannot be deleted.',
      });
    }
    const replacement = resolveLayer(scene, {
      layerId: input && input.replacementLayerId,
      ...(input &&
      Object.prototype.hasOwnProperty.call(input, 'replacementLayerName')
        ? { layerName: input.replacementLayerName }
        : {}),
    });
    if (
      getLayerIdentity(scene, replacement.layer).id ===
      getLayerIdentity(scene, resolved.layer).id
    ) {
      throw new AgentError({
        code: 'invalid_layer_replacement',
        details: { reason: 'replacement-is-layer-being-deleted' },
      });
    }
    if (replacement.layer.getName() === '') {
      throw new AgentError({
        code: 'base_layer_replacement_unsupported',
        message:
          'A named layer cannot be safely deleted into the base layer because the native refactorer cannot rewrite named layer references to the empty base-layer name.',
        hint:
          'Choose a named replacement layer so references and instances can be rewritten atomically.',
        details: { layerId: getLayerIdentity(scene, resolved.layer).id },
      });
    }
    const before = serializeLayer(scene, resolved.layer, resolved.index);
    const replacementName = replacement.layer.getName();
    const replacementId = getLayerIdentity(scene, replacement.layer).id;
    gd.WholeProjectRefactorer.renameLayerInScene(
      requireProject(),
      scene,
      oldName,
      replacementName
    );
    scene.getLayers().removeLayer(oldName);
    removeFallbackLayerIdentity(scene, oldName);
    const replacementAfterDelete = resolveLayer(scene, {
      layerId: replacementId,
      layerName: replacementName,
    });
    markChanged(scene, true);
    return {
      authority: 'editor-project',
      deleted: before,
      replacement: serializeLayer(
        scene,
        replacementAfterDelete.layer,
        replacementAfterDelete.index
      ),
      instancesAndReferencesMoved: true,
    };
  };

  const assertInstancePreconditions = (
    scene: gdLayout,
    instance: gdInitialInstance,
    input: any
  ) => {
    const info = layerInfoForInstance(scene, instance);
    if (
      input &&
      input.expectedLayerId !== undefined &&
      (!info.layerId || !idMatches(info.layerId, input.expectedLayerId))
    ) {
      throw new AgentError({
        code: 'instance_layer_conflict',
        retryable: true,
        details: {
          instanceId: instance.getPersistentUuid(),
          expectedLayerId: input.expectedLayerId,
          actualLayerId: info.layerId,
          actualLayerName: info.layerName,
        },
      });
    }
    if (
      input &&
      input.expectedLayerName !== undefined &&
      input.expectedLayerName !== info.layerName
    ) {
      throw new AgentError({
        code: 'instance_layer_conflict',
        retryable: true,
        details: {
          instanceId: instance.getPersistentUuid(),
          expectedLayerName: input.expectedLayerName,
          actualLayerName: info.layerName,
        },
      });
    }
    if (
      input &&
      input.expectedZOrder !== undefined &&
      input.expectedZOrder !== instance.getZOrder()
    ) {
      throw new AgentError({
        code: 'instance_z_order_conflict',
        retryable: true,
        details: {
          instanceId: instance.getPersistentUuid(),
          expectedZOrder: input.expectedZOrder,
          actualZOrder: instance.getZOrder(),
        },
      });
    }
  };

  const moveInstanceToLayer = (input: any): any => {
    const scene = requireScene(input && input.sceneName);
    const instance = resolveInstance(scene, input && input.instanceId);
    assertInstancePreconditions(scene, instance, input || {});
    const target = resolveLayer(scene, {
      layerId: input && input.targetLayerId,
      ...(input &&
      Object.prototype.hasOwnProperty.call(input, 'targetLayerName')
        ? { layerName: input.targetLayerName }
        : {}),
    });
    const before = snapshotInstance(scene, instance);
    instance.setLayer(target.layer.getName());
    markChanged(scene, true);
    return {
      authority: 'editor-project',
      before,
      after: snapshotInstance(scene, instance),
      instanceRecreated: false,
      unrelatedPropertiesPreserved: true,
    };
  };

  const setInstanceRenderOrder = (input: any): any => {
    const scene = requireScene(input && input.sceneName);
    const instance = resolveInstance(scene, input && input.instanceId);
    assertInstancePreconditions(scene, instance, input || {});
    const directives = [
      input && input.zOrder !== undefined ? 'zOrder' : null,
      input && input.beforeInstanceId ? 'beforeInstanceId' : null,
      input && input.afterInstanceId ? 'afterInstanceId' : null,
    ].filter(Boolean);
    if (directives.length !== 1) {
      throw new AgentError({
        code: 'invalid_render_order_mutation',
        message:
          'Provide exactly one of zOrder, beforeInstanceId or afterInstanceId.',
        details: { directives },
      });
    }

    let nextZOrder;
    let relativeTo = null;
    if (directives[0] === 'zOrder') {
      nextZOrder = input.zOrder;
    } else {
      const referenceId =
        directives[0] === 'beforeInstanceId'
          ? input.beforeInstanceId
          : input.afterInstanceId;
      const reference = resolveInstance(scene, referenceId);
      if (reference.getPersistentUuid() === instance.getPersistentUuid()) {
        throw new AgentError({
          code: 'invalid_render_order_reference',
          details: { reason: 'self-reference' },
        });
      }
      if (reference.getLayer() !== instance.getLayer()) {
        throw new AgentError({
          code: 'render_order_cross_layer_conflict',
          message:
            'before/after is only supported within the same layer; move the instance first.',
          details: {
            instanceLayer: instance.getLayer(),
            referenceLayer: reference.getLayer(),
          },
        });
      }
      nextZOrder =
        reference.getZOrder() + (directives[0] === 'beforeInstanceId' ? -1 : 1);
      relativeTo = snapshotInstance(scene, reference);
    }

    if (
      !Number.isInteger(nextZOrder) ||
      nextZOrder < INT32_MIN ||
      nextZOrder > INT32_MAX
    ) {
      throw new AgentError({
        code: 'invalid_z_order',
        field: 'zOrder',
        details: { value: nextZOrder, minimum: INT32_MIN, maximum: INT32_MAX },
      });
    }
    const before = snapshotInstance(scene, instance);
    instance.setZOrder(nextZOrder);
    markChanged(scene, true);
    const after = snapshotInstance(scene, instance);
    return {
      authority: 'editor-project',
      before,
      after,
      relativeTo,
      result: relativeTo == null ? null : compareSnapshots(after, relativeTo),
      unrelatedPropertiesPreserved: true,
    };
  };

  return {
    list,
    compare,
    create,
    rename,
    reorder,
    remove,
    moveInstanceToLayer,
    setInstanceRenderOrder,
  };
};
