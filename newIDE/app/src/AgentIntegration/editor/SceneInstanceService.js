// @flow
import { AgentError } from '../core/AgentError';

const gd: libGDevelop = global.gd;

type Options = {|
  project: ?gdProject,
  layerOrderService: any,
  objectPropertyService: any,
  triggerUnsavedChanges: () => void,
  forceUpdate: () => void,
  onInstancesModifiedOutsideEditor: any,
|};

const RESERVED_UPDATE_PATHS = new Set([
  'instance.x',
  'instance.y',
  'instance.z',
  'instance.angle',
  'instance.rotationX',
  'instance.rotationY',
  'instance.layer',
  'instance.zOrder',
  'instance.hasCustomSize',
  'instance.hasCustomDepth',
  'instance.customWidth',
  'instance.customHeight',
  'instance.customDepth',
]);

const hashString = (value: string): string => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

const requireString = (value: any, field: string): string => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AgentError({
      code: 'invalid_scene_instance_input',
      field,
      details: { field, expected: 'non-empty string' },
    });
  }
  return value.trim();
};

const requireFiniteNumber = (value: any, field: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new AgentError({
      code: 'invalid_scene_instance_input',
      field,
      details: { field, expected: 'finite number', actualValue: value },
    });
  }
  return value;
};

const requireNonNegativeNumber = (value: any, field: string): number => {
  const numberValue = requireFiniteNumber(value, field);
  if (numberValue < 0) {
    throw new AgentError({
      code: 'invalid_scene_instance_input',
      field,
      details: { field, minimum: 0, actualValue: value },
    });
  }
  return numberValue;
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

const normalizeInstanceQuery = (value: any, field: string): string => {
  const raw = requireString(value, field);
  if (raw.startsWith('instance:')) {
    const id = raw.slice('instance:'.length);
    return requireString(id, field);
  }
  return raw;
};

const angleDistance = (left: number, right: number): number => {
  const normalized = ((((left - right + 180) % 360) + 360) % 360) - 180;
  return Math.abs(normalized);
};

const placementContract = {
  identity: {
    field: 'instanceId',
    selectorFormat: 'instance:<persistent-uuid>',
    persistence: 'project-persistent',
    stableAcross: [
      'property-edits',
      'position-edits',
      'angle-edits',
      'layer-moves',
      'z-order-edits',
    ],
  },
  mutationSemantics: {
    createCommand: 'scene.instances.create',
    updateCommand: 'scene.instances.update',
    transformCommand: 'scene.instances.transform',
    duplicateCommand: 'scene.instances.duplicate',
    deleteCommand: 'scene.instances.delete',
    updateMayCreate: false,
    brushOrPointUpsertSupported: false,
    coordinates: 'absolute-scene-coordinates',
    note:
      'Scene instance mutation is identity-addressed. No brush/point/upsert selector creates an instance when an update target is absent.',
  },
  transformCapabilities: {
    position: ['x', 'y', 'z'],
    rotation: ['angle', 'rotationX', 'rotationY'],
    genericScaleFactorsSupported: false,
    customSizeOverrideSupported: true,
    customSizePaths: [
      'instance.customWidth',
      'instance.customHeight',
      'instance.customDepth',
    ],
    note:
      'InitialInstance has no generic multiplicative scaleX/scaleY/scaleZ contract. Width/height/depth use the native custom-size override when requested.',
  },
  integrations: {
    typedProperties: 'DX-24 objects.properties.describe/set',
    layerAndZOrder: 'DX-26 scene.instances.move-layer/set-render-order',
    ownershipAndRevision: 'DX-19 AgentHost/MCP mutation preconditions',
    responseEnvelope: 'DX-21 canonical MCP response/error envelope',
  },
};

export const createSceneInstanceService = ({
  project,
  layerOrderService,
  objectPropertyService,
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
        field: 'sceneName',
        details: { sceneName: name },
      });
    }
    return currentProject.getLayout(name);
  };

  const resolveObject = (
    scene: gdLayout,
    objectName: string,
    required: boolean = true
  ): ?gdObject => {
    if (scene.getObjects().hasObjectNamed(objectName)) {
      return scene.getObjects().getObject(objectName);
    }
    const globals = requireProject().getObjects();
    if (globals.hasObjectNamed(objectName)) {
      return globals.getObject(objectName);
    }
    if (!required) return null;
    throw new AgentError({
      code: 'scene_instance_object_not_found',
      field: 'objectName',
      details: { sceneName: scene.getName(), objectName },
    });
  };

  const getTargetQuery = (input: any): string => {
    if (input && input.instanceId !== undefined) {
      return normalizeInstanceQuery(input.instanceId, 'instanceId');
    }
    if (input && input.selector !== undefined) {
      return normalizeInstanceQuery(input.selector, 'selector');
    }
    throw new AgentError({
      code: 'missing_scene_instance_target',
      field: 'instanceId',
      hint:
        'Use instanceId or selector returned by scene.instances.list/get. Updates never create a missing target.',
    });
  };

  const resolveInstance = (scene: gdLayout, input: any): gdInitialInstance => {
    const query = getTargetQuery(input);
    const matches = [];
    iterateInstances(scene.getInitialInstances(), instance => {
      const id = instance.getPersistentUuid();
      if (id === query || id.toLowerCase().startsWith(query.toLowerCase())) {
        matches.push(instance);
      }
    });

    if (!matches.length) {
      throw new AgentError({
        code: 'scene_instance_not_found',
        field:
          input && input.selector !== undefined ? 'selector' : 'instanceId',
        details: {
          sceneName: scene.getName(),
          instanceId: query,
          matchCount: 0,
        },
        hint:
          'Re-read scene.instances.list/get. scene.instances.update/transform never create a replacement target.',
      });
    }
    if (matches.length > 1) {
      throw new AgentError({
        code: 'scene_instance_multi_match_conflict',
        field:
          input && input.selector !== undefined ? 'selector' : 'instanceId',
        details: {
          sceneName: scene.getName(),
          instanceId: query,
          matchCount: matches.length,
          matchedInstanceIds: matches.map(instance =>
            instance.getPersistentUuid()
          ),
        },
        hint:
          'Use the full persistent UUID from scene.instances.list/get instead of an ambiguous prefix.',
      });
    }
    return matches[0];
  };

  const getCustomPropertyRevisionData = (
    scene: gdLayout,
    instance: gdInitialInstance
  ): Array<any> => {
    try {
      const properties = instance.getCustomProperties(
        requireProject().getObjects(),
        scene.getObjects()
      );
      return properties
        .keys()
        .toJSArray()
        .sort((left, right) => left.localeCompare(right))
        .map(name => [name, properties.get(name).getValue()]);
    } catch (error) {
      return [];
    }
  };

  const getDirectRevisionData = (
    scene: gdLayout,
    instance: gdInitialInstance
  ): any => ({
    instanceId: instance.getPersistentUuid(),
    objectName: instance.getObjectName(),
    x: instance.getX(),
    y: instance.getY(),
    z: instance.getZ(),
    angle: instance.getAngle(),
    rotationX: instance.getRotationX(),
    rotationY: instance.getRotationY(),
    zOrder: instance.getZOrder(),
    opacity: instance.getOpacity(),
    layer: instance.getLayer(),
    locked: instance.isLocked(),
    sealed: instance.isSealed(),
    hidden: instance.isHidden(),
    flippedX: instance.isFlippedX(),
    flippedY: instance.isFlippedY(),
    flippedZ: instance.isFlippedZ(),
    keepRatio: instance.shouldKeepRatio(),
    hasCustomSize: instance.hasCustomSize(),
    hasCustomDepth: instance.hasCustomDepth(),
    customWidth: instance.getCustomWidth(),
    customHeight: instance.getCustomHeight(),
    customDepth: instance.getCustomDepth(),
    customProperties: getCustomPropertyRevisionData(scene, instance),
  });

  const getInstanceRevision = (
    scene: gdLayout,
    instance: gdInitialInstance
  ): string =>
    `instance-rev-${hashString(
      JSON.stringify(getDirectRevisionData(scene, instance))
    )}`;

  const getOrderContext = (scene: gdLayout): any => {
    const order = layerOrderService.list({
      sceneName: scene.getName(),
      includeInstances: true,
    });
    return {
      layersByName: new Map(
        (order.layers || []).map(layer => [layer.name, layer])
      ),
      instancesById: new Map(
        (order.instances || []).map(instance => [instance.instanceId, instance])
      ),
    };
  };

  const snapshotInstance = (
    scene: gdLayout,
    instance: gdInitialInstance,
    orderContext: ?any = null
  ): any => {
    const context = orderContext || getOrderContext(scene);
    const instanceId = instance.getPersistentUuid();
    const order = context.instancesById.get(instanceId) || {};
    const layer = context.layersByName.get(instance.getLayer()) || null;
    const object = resolveObject(scene, instance.getObjectName(), false);
    const opacity = instance.getOpacity();
    const hidden = instance.isHidden();
    const layerVisibleAtStartup =
      layer && layer.state ? layer.state.visibleAtStartup : null;
    return {
      instanceId,
      selector: `instance:${instanceId}`,
      instanceRevision: getInstanceRevision(scene, instance),
      objectName: instance.getObjectName(),
      objectType: object ? object.getType() : null,
      missingObjectDefinition: !object,
      layer: {
        id: order.layerId || (layer ? layer.layerId : null),
        name: instance.getLayer(),
        index:
          order.layerIndex !== undefined
            ? order.layerIndex
            : layer
            ? layer.index
            : null,
        missing: !!order.missingLayer,
      },
      position: {
        x: instance.getX(),
        y: instance.getY(),
        z: instance.getZ(),
      },
      angle: instance.getAngle(),
      rotation: {
        x: instance.getRotationX(),
        y: instance.getRotationY(),
      },
      zOrder: instance.getZOrder(),
      renderOrder: {
        withinLayer:
          order.renderOrderWithinLayer !== undefined
            ? order.renderOrderWithinLayer
            : null,
        deterministic:
          order.renderOrderDeterministic !== undefined
            ? order.renderOrderDeterministic
            : false,
        zOrderTieCount:
          order.zOrderTieCount !== undefined ? order.zOrderTieCount : null,
        editorContainerIndex:
          order.editorContainerIndex !== undefined
            ? order.editorContainerIndex
            : null,
        authority: 'editor-project',
      },
      visibility: {
        hidden,
        opacity,
        layerVisibleAtStartup,
        effectivelyVisibleAtStartup:
          !hidden && opacity > 0 && layerVisibleAtStartup !== false,
        authority: 'editor-project-initial-state',
      },
      editorState: {
        locked: instance.isLocked(),
        sealed: instance.isSealed(),
      },
      sizeOverride: {
        hasCustomSize: instance.hasCustomSize(),
        hasCustomDepth: instance.hasCustomDepth(),
        width: instance.getCustomWidth(),
        height: instance.getCustomHeight(),
        depth: instance.getCustomDepth(),
      },
    };
  };

  const assertInstancePreconditions = (
    scene: gdLayout,
    instance: gdInitialInstance,
    input: any,
    snapshot: ?any = null
  ): any => {
    const current = snapshot || snapshotInstance(scene, instance);
    if (
      input &&
      input.expectedObjectName !== undefined &&
      input.expectedObjectName !== current.objectName
    ) {
      throw new AgentError({
        code: 'stale_scene_instance',
        retryable: true,
        field: 'expectedObjectName',
        details: {
          instanceId: current.instanceId,
          expectedObjectName: input.expectedObjectName,
          actualObjectName: current.objectName,
          actualInstanceRevision: current.instanceRevision,
        },
        hint:
          'Re-read scene.instances.get and retry against the current identity.',
      });
    }
    if (
      input &&
      input.expectedInstanceRevision !== undefined &&
      input.expectedInstanceRevision !== current.instanceRevision
    ) {
      throw new AgentError({
        code: 'stale_scene_instance',
        retryable: true,
        field: 'expectedInstanceRevision',
        details: {
          instanceId: current.instanceId,
          expectedInstanceRevision: input.expectedInstanceRevision,
          actualInstanceRevision: current.instanceRevision,
        },
        hint:
          'Re-read scene.instances.get and retry against the new instanceRevision.',
      });
    }
    return current;
  };

  const notifyMutation = (scene: gdLayout) => {
    triggerUnsavedChanges();
    forceUpdate();
    if (typeof onInstancesModifiedOutsideEditor === 'function') {
      onInstancesModifiedOutsideEditor({ scene });
    }
  };

  const assertNoPlacementPaths = (changes: any) => {
    if (!Array.isArray(changes) || !changes.length) {
      throw new AgentError({
        code: 'invalid_scene_instance_changes',
        field: 'changes',
        details: { expected: 'non-empty array' },
      });
    }
    const forbidden = changes
      .filter(change => change && RESERVED_UPDATE_PATHS.has(change.path))
      .map(change => change.path);
    if (forbidden.length) {
      throw new AgentError({
        code: 'unsupported_scene_instance_update_path',
        field: 'changes',
        details: {
          forbiddenPaths: forbidden,
          transformCommand: 'scene.instances.transform',
          layerCommand: 'scene.instances.move-layer',
          zOrderCommand: 'scene.instances.set-render-order',
        },
        hint:
          'Use scene.instances.transform for position/rotation/size, scene.instances.move-layer for layer, or scene.instances.set-render-order for Z-order.',
      });
    }
  };

  const validateChangesAgainstDescription = (changes: any, described: any) => {
    assertNoPlacementPaths(changes);
    const seen = new Set();
    const properties = Array.isArray(described.properties)
      ? described.properties
      : [];
    changes.forEach((change, index) => {
      const field = `changes[${index}]`;
      if (!change || typeof change !== 'object' || Array.isArray(change)) {
        throw new AgentError({
          code: 'invalid_scene_instance_changes',
          field,
        });
      }
      const path = requireString(change.path, `${field}.path`);
      if (seen.has(path)) {
        throw new AgentError({
          code: 'invalid_scene_instance_changes',
          field: `${field}.path`,
          path,
          details: { reason: 'duplicate-path' },
        });
      }
      seen.add(path);
      if (!Object.prototype.hasOwnProperty.call(change, 'value')) {
        throw new AgentError({
          code: 'invalid_scene_instance_changes',
          field: `${field}.value`,
          path,
          details: { reason: 'missing-value' },
        });
      }
      const property = properties.find(candidate => candidate.path === path);
      if (!property || !property.writable) {
        throw new AgentError({
          code: property
            ? 'unsupported_property_mutation'
            : 'unknown_property_path',
          field: `${field}.path`,
          path,
          details: {
            path,
            writable: !!(property && property.writable),
          },
        });
      }
      const value = change.value;
      const typeMatches =
        property.valueType === 'number'
          ? typeof value === 'number' && Number.isFinite(value)
          : typeof value === property.valueType;
      if (!typeMatches) {
        throw new AgentError({
          code: 'invalid_property_type',
          field: `${field}.value`,
          path,
          details: {
            expectedType: property.valueType,
            actualType: value === null ? 'null' : typeof value,
          },
        });
      }
      const constraints = property.constraints || {};
      if (
        typeof constraints.minimum === 'number' &&
        value < constraints.minimum
      ) {
        throw new AgentError({
          code: 'invalid_property_value',
          field: `${field}.value`,
          path,
          details: {
            minimum: constraints.minimum,
            actualValue: value,
          },
        });
      }
      if (
        typeof constraints.maximum === 'number' &&
        value > constraints.maximum
      ) {
        throw new AgentError({
          code: 'invalid_property_value',
          field: `${field}.value`,
          path,
          details: {
            maximum: constraints.maximum,
            actualValue: value,
          },
        });
      }
      if (
        Array.isArray(constraints.choices) &&
        constraints.choices.length &&
        !constraints.choices.some(choice => choice.value === value)
      ) {
        throw new AgentError({
          code: 'invalid_property_value',
          field: `${field}.value`,
          path,
          details: {
            allowedValues: constraints.choices.map(choice => choice.value),
            actualValue: value,
          },
        });
      }
    });
  };

  const normalizeSelection = (selection: any): any =>
    selection && typeof selection === 'object' && !Array.isArray(selection)
      ? selection
      : {};

  const hasExplicitSelection = (selection: any): boolean => {
    const normalized = normalizeSelection(selection);
    return (
      normalized.all === true ||
      (Array.isArray(normalized.instanceIds) &&
        normalized.instanceIds.length > 0) ||
      (Array.isArray(normalized.objectNames) &&
        normalized.objectNames.length > 0) ||
      (Array.isArray(normalized.objectTypes) &&
        normalized.objectTypes.length > 0) ||
      (Array.isArray(normalized.layerNames) &&
        normalized.layerNames.length > 0) ||
      typeof normalized.hidden === 'boolean' ||
      !!normalized.near
    );
  };

  const selectInstances = (
    scene: gdLayout,
    selection: any,
    requireExplicit: boolean = false
  ): any => {
    const normalized = normalizeSelection(selection);
    if (requireExplicit && !hasExplicitSelection(normalized)) {
      throw new AgentError({
        code: 'invalid_bulk_scene_instance_selection',
        field: 'selection',
        message:
          'Bulk mutations require explicit selection criteria or selection.all=true.',
        hint:
          'Run the bulk command with dryRun=true first and reuse expectedSelectionRevision to apply.',
      });
    }

    let allowedIds = null;
    if (
      Array.isArray(normalized.instanceIds) &&
      normalized.instanceIds.length
    ) {
      allowedIds = new Set();
      normalized.instanceIds.forEach((value, index) => {
        const instance = resolveInstance(scene, {
          instanceId: normalizeInstanceQuery(
            value,
            `selection.instanceIds[${index}]`
          ),
        });
        allowedIds.add(instance.getPersistentUuid());
      });
    }

    const orderContext = getOrderContext(scene);
    const selected = [];
    iterateInstances(scene.getInitialInstances(), instance => {
      const instanceId = instance.getPersistentUuid();
      if (allowedIds && !allowedIds.has(instanceId)) return;
      const snapshot = snapshotInstance(scene, instance, orderContext);
      if (
        Array.isArray(normalized.objectNames) &&
        normalized.objectNames.length &&
        !normalized.objectNames.includes(snapshot.objectName)
      ) {
        return;
      }
      if (
        Array.isArray(normalized.objectTypes) &&
        normalized.objectTypes.length &&
        !normalized.objectTypes.includes(snapshot.objectType)
      ) {
        return;
      }
      if (
        Array.isArray(normalized.layerNames) &&
        normalized.layerNames.length &&
        !normalized.layerNames.includes(snapshot.layer.name)
      ) {
        return;
      }
      if (
        typeof normalized.hidden === 'boolean' &&
        snapshot.visibility.hidden !== normalized.hidden
      ) {
        return;
      }
      if (normalized.near) {
        const x = requireFiniteNumber(normalized.near.x, 'selection.near.x');
        const y = requireFiniteNumber(normalized.near.y, 'selection.near.y');
        const radius = requireNonNegativeNumber(
          normalized.near.radius,
          'selection.near.radius'
        );
        const dx = snapshot.position.x - x;
        const dy = snapshot.position.y - y;
        if (Math.sqrt(dx * dx + dy * dy) > radius) return;
      }
      selected.push({ instance, snapshot });
    });

    selected.sort((left, right) =>
      left.snapshot.instanceId.localeCompare(right.snapshot.instanceId)
    );
    const selectionRevision = `selection-rev-${hashString(
      selected
        .map(
          entry =>
            `${entry.snapshot.instanceId}@${entry.snapshot.instanceRevision}`
        )
        .join('|')
    )}`;
    return { selected, selectionRevision };
  };

  const summarizeSelection = (selected: Array<any>): any => {
    const byObject = {};
    const byLayer = {};
    selected.forEach(({ snapshot }) => {
      byObject[snapshot.objectName] = (byObject[snapshot.objectName] || 0) + 1;
      const layerName = snapshot.layer.name;
      byLayer[layerName] = (byLayer[layerName] || 0) + 1;
    });
    return {
      count: selected.length,
      byObject,
      byLayer,
      targets: selected.map(({ snapshot }) => ({
        instanceId: snapshot.instanceId,
        selector: snapshot.selector,
        instanceRevision: snapshot.instanceRevision,
        objectName: snapshot.objectName,
        objectType: snapshot.objectType,
        layerName: snapshot.layer.name,
        position: snapshot.position,
      })),
    };
  };

  const assertSelectionRevision = (selectionRevision: string, input: any) => {
    if (
      !input ||
      typeof input.expectedSelectionRevision !== 'string' ||
      !input.expectedSelectionRevision
    ) {
      throw new AgentError({
        code: 'missing_selection_revision',
        field: 'expectedSelectionRevision',
        hint:
          'Run the same bulk command with dryRun=true, then pass its selectionRevision as expectedSelectionRevision.',
      });
    }
    if (input.expectedSelectionRevision !== selectionRevision) {
      throw new AgentError({
        code: 'stale_scene_instance_selection',
        retryable: true,
        field: 'expectedSelectionRevision',
        details: {
          expectedSelectionRevision: input.expectedSelectionRevision,
          actualSelectionRevision: selectionRevision,
        },
        hint:
          'The selected instances changed since dry-run. Re-run dry-run and review the new target set.',
      });
    }
  };

  const list = (input: any): any => {
    const scene = requireScene(input && input.sceneName);
    const { selected, selectionRevision } = selectInstances(
      scene,
      input && input.selection,
      false
    );
    const offset =
      input && Number.isInteger(input.offset) && input.offset >= 0
        ? input.offset
        : 0;
    const limit =
      input &&
      Number.isInteger(input.limit) &&
      input.limit >= 1 &&
      input.limit <= 1000
        ? input.limit
        : 200;
    const page = selected.slice(offset, offset + limit);
    return {
      authority: 'editor-project',
      scene: {
        sceneName: scene.getName(),
        sceneId:
          typeof scene.getPersistentUuid === 'function'
            ? scene.getPersistentUuid()
            : null,
      },
      contract: placementContract,
      items: page.map(entry => entry.snapshot),
      total: selected.length,
      offset,
      limit,
      hasMore: offset + page.length < selected.length,
      selectionRevision,
    };
  };

  const get = (input: any): any => {
    const scene = requireScene(input && input.sceneName);
    const instance = resolveInstance(scene, input || {});
    return {
      authority: 'editor-project',
      contract: placementContract,
      instance: snapshotInstance(scene, instance),
      typedProperties: {
        command: 'objects.properties.describe',
        arguments: {
          targetKind: 'scene-instance',
          sceneName: scene.getName(),
          instanceId: instance.getPersistentUuid(),
        },
      },
      layerMutation: {
        command: 'scene.instances.move-layer',
      },
      zOrderMutation: {
        command: 'scene.instances.set-render-order',
      },
    };
  };

  const create = (input: any): any => {
    const scene = requireScene(input && input.sceneName);
    const objectName = requireString(input && input.objectName, 'objectName');
    resolveObject(scene, objectName, true);
    const position = input && input.position;
    if (!position || typeof position !== 'object' || Array.isArray(position)) {
      throw new AgentError({
        code: 'invalid_scene_instance_input',
        field: 'position',
        details: { expected: '{x,y,z?}' },
      });
    }
    const x = requireFiniteNumber(position.x, 'position.x');
    const y = requireFiniteNumber(position.y, 'position.y');
    const z =
      position.z === undefined
        ? 0
        : requireFiniteNumber(position.z, 'position.z');
    const layerName =
      input && input.layerName !== undefined ? String(input.layerName) : '';
    if (layerName !== '' && !scene.getLayers().hasLayerNamed(layerName)) {
      throw new AgentError({
        code: 'scene_instance_layer_not_found',
        field: 'layerName',
        details: { sceneName: scene.getName(), layerName },
      });
    }

    let zOrder;
    if (input && input.zOrder !== undefined) {
      if (
        !Number.isInteger(input.zOrder) ||
        input.zOrder < -2147483648 ||
        input.zOrder > 2147483647
      ) {
        throw new AgentError({
          code: 'invalid_z_order',
          field: 'zOrder',
          details: { value: input.zOrder },
        });
      }
      zOrder = input.zOrder;
    } else {
      const finder = new gd.HighestZOrderFinder();
      finder.reset();
      scene.getInitialInstances().iterateOverInstances(finder);
      zOrder = finder.getHighestZOrder() + 1;
      finder.delete();
    }

    const container = scene.getInitialInstances();
    const beforeCount = container.getInstancesCount();
    const instance = container.insertNewInitialInstance();
    instance.setObjectName(objectName);
    instance.setX(x);
    instance.setY(y);
    instance.setZ(z);
    instance.setLayer(layerName);
    instance.setZOrder(zOrder);
    if (input && input.angle !== undefined) {
      instance.setAngle(requireFiniteNumber(input.angle, 'angle'));
    }
    if (input && input.hidden !== undefined) {
      if (typeof input.hidden !== 'boolean') {
        throw new AgentError({
          code: 'invalid_scene_instance_input',
          field: 'hidden',
        });
      }
      instance.setHidden(input.hidden);
    }
    if (input && input.opacity !== undefined) {
      const opacity = requireFiniteNumber(input.opacity, 'opacity');
      if (opacity < 0 || opacity > 255) {
        throw new AgentError({
          code: 'invalid_scene_instance_input',
          field: 'opacity',
          details: { minimum: 0, maximum: 255, actualValue: opacity },
        });
      }
      instance.setOpacity(opacity);
    }

    const afterCount = container.getInstancesCount();
    if (afterCount !== beforeCount + 1) {
      throw new AgentError({
        code: 'scene_instance_create_invariant_conflict',
        details: { beforeCount, afterCount },
      });
    }
    notifyMutation(scene);
    return {
      created: true,
      contract: placementContract,
      instance: snapshotInstance(scene, instance),
      instanceCount: { before: beforeCount, after: afterCount, delta: 1 },
    };
  };

  const update = async (input: any, requestContext: any = {}): Promise<any> => {
    const scene = requireScene(input && input.sceneName);
    const instance = resolveInstance(scene, input || {});
    const before = assertInstancePreconditions(scene, instance, input || {});
    assertNoPlacementPaths(input && input.changes);
    const container = scene.getInitialInstances();
    const beforeCount = container.getInstancesCount();
    const delegated = await objectPropertyService.set(
      {
        targetKind: 'scene-instance',
        sceneName: scene.getName(),
        instanceId: before.instanceId,
        changes: input.changes,
      },
      requestContext
    );
    const afterCount = container.getInstancesCount();
    if (afterCount !== beforeCount) {
      throw new AgentError({
        code: 'scene_instance_update_invariant_conflict',
        details: {
          instanceId: before.instanceId,
          beforeCount,
          afterCount,
          invariant: 'update-must-never-create-or-delete-an-instance',
        },
      });
    }
    const afterInstance = resolveInstance(scene, {
      instanceId: before.instanceId,
    });
    const after = snapshotInstance(scene, afterInstance);
    return {
      updated: true,
      created: false,
      identityPreserved: after.instanceId === before.instanceId,
      instanceCountUnchanged: true,
      before,
      after,
      delegatedMutation: delegated.mutation,
      applied: delegated.applied,
    };
  };

  const transform = async (
    input: any,
    requestContext: any = {}
  ): Promise<any> => {
    const scene = requireScene(input && input.sceneName);
    const instance = resolveInstance(scene, input || {});
    const before = assertInstancePreconditions(scene, instance, input || {});
    const changes = [];
    const position = input && input.position;
    if (position !== undefined) {
      if (
        !position ||
        typeof position !== 'object' ||
        Array.isArray(position)
      ) {
        throw new AgentError({
          code: 'invalid_scene_instance_transform',
          field: 'position',
        });
      }
      ['x', 'y', 'z'].forEach(axis => {
        if (position[axis] !== undefined) {
          changes.push({
            path: `instance.${axis}`,
            value: requireFiniteNumber(position[axis], `position.${axis}`),
          });
        }
      });
    }
    ['angle', 'rotationX', 'rotationY'].forEach(field => {
      if (input && input[field] !== undefined) {
        changes.push({
          path: `instance.${field}`,
          value: requireFiniteNumber(input[field], field),
        });
      }
    });
    const size = input && input.size;
    if (size !== undefined) {
      if (!size || typeof size !== 'object' || Array.isArray(size)) {
        throw new AgentError({
          code: 'invalid_scene_instance_transform',
          field: 'size',
        });
      }
      const has2dSize = size.width !== undefined || size.height !== undefined;
      if (has2dSize) {
        changes.push({ path: 'instance.hasCustomSize', value: true });
      }
      if (size.width !== undefined) {
        changes.push({
          path: 'instance.customWidth',
          value: requireNonNegativeNumber(size.width, 'size.width'),
        });
      }
      if (size.height !== undefined) {
        changes.push({
          path: 'instance.customHeight',
          value: requireNonNegativeNumber(size.height, 'size.height'),
        });
      }
      if (size.depth !== undefined) {
        changes.push({ path: 'instance.hasCustomDepth', value: true });
        changes.push({
          path: 'instance.customDepth',
          value: requireNonNegativeNumber(size.depth, 'size.depth'),
        });
      }
    }
    if (!changes.length) {
      throw new AgentError({
        code: 'invalid_scene_instance_transform',
        message:
          'Provide at least one absolute position, rotation, or custom size field.',
        field: 'position',
      });
    }

    const container = scene.getInitialInstances();
    const beforeCount = container.getInstancesCount();
    const delegated = await objectPropertyService.set(
      {
        targetKind: 'scene-instance',
        sceneName: scene.getName(),
        instanceId: before.instanceId,
        changes,
      },
      requestContext
    );
    const afterCount = container.getInstancesCount();
    if (afterCount !== beforeCount) {
      throw new AgentError({
        code: 'scene_instance_transform_invariant_conflict',
        details: {
          instanceId: before.instanceId,
          beforeCount,
          afterCount,
          invariant: 'transform-must-never-create-or-delete-an-instance',
        },
      });
    }
    const after = snapshotInstance(
      scene,
      resolveInstance(scene, { instanceId: before.instanceId })
    );
    return {
      transformed: true,
      created: false,
      identityPreserved: after.instanceId === before.instanceId,
      instanceCountUnchanged: true,
      coordinates: 'absolute-scene-coordinates',
      scaleSemantics: placementContract.transformCapabilities,
      before,
      after,
      applied: delegated.applied,
    };
  };

  const duplicate = (input: any): any => {
    const scene = requireScene(input && input.sceneName);
    const source = resolveInstance(scene, input || {});
    const sourceSnapshot = assertInstancePreconditions(
      scene,
      source,
      input || {}
    );
    const container = scene.getInitialInstances();
    const beforeCount = container.getInstancesCount();
    const clone = container.insertInitialInstance(source).resetPersistentUuid();

    const offset = (input && input.offset) || {};
    if (offset.x !== undefined) {
      clone.setX(clone.getX() + requireFiniteNumber(offset.x, 'offset.x'));
    }
    if (offset.y !== undefined) {
      clone.setY(clone.getY() + requireFiniteNumber(offset.y, 'offset.y'));
    }
    if (offset.z !== undefined) {
      clone.setZ(clone.getZ() + requireFiniteNumber(offset.z, 'offset.z'));
    }
    if (input && input.angleOffset !== undefined) {
      clone.setAngle(
        clone.getAngle() + requireFiniteNumber(input.angleOffset, 'angleOffset')
      );
    }

    const cloneId = clone.getPersistentUuid();
    if (!cloneId || cloneId === sourceSnapshot.instanceId) {
      throw new AgentError({
        code: 'scene_instance_duplicate_identity_conflict',
        details: {
          sourceInstanceId: sourceSnapshot.instanceId,
          duplicateInstanceId: cloneId || null,
        },
      });
    }
    const afterCount = container.getInstancesCount();
    if (afterCount !== beforeCount + 1) {
      throw new AgentError({
        code: 'scene_instance_duplicate_invariant_conflict',
        details: { beforeCount, afterCount },
      });
    }
    notifyMutation(scene);
    return {
      duplicated: true,
      source: sourceSnapshot,
      duplicate: snapshotInstance(scene, clone),
      newIdentity: true,
      instanceCount: { before: beforeCount, after: afterCount, delta: 1 },
    };
  };

  const remove = (input: any): any => {
    const scene = requireScene(input && input.sceneName);
    const instance = resolveInstance(scene, input || {});
    if (
      !input ||
      typeof input.expectedInstanceRevision !== 'string' ||
      !input.expectedInstanceRevision
    ) {
      throw new AgentError({
        code: 'missing_instance_revision',
        field: 'expectedInstanceRevision',
        hint:
          'Read scene.instances.get immediately before delete and pass its instanceRevision.',
      });
    }
    const deleted = assertInstancePreconditions(scene, instance, input || {});
    const container = scene.getInitialInstances();
    const beforeCount = container.getInstancesCount();
    container.removeInstance(instance);
    const afterCount = container.getInstancesCount();
    if (afterCount !== beforeCount - 1) {
      throw new AgentError({
        code: 'scene_instance_delete_invariant_conflict',
        details: { beforeCount, afterCount },
      });
    }
    notifyMutation(scene);
    return {
      deleted: true,
      instance: deleted,
      instanceCount: { before: beforeCount, after: afterCount, delta: -1 },
    };
  };

  const diagnoseDuplicates = (input: any): any => {
    const scene = requireScene(input && input.sceneName);
    const { selected } = selectInstances(
      scene,
      input && input.selection,
      false
    );
    const positionTolerance =
      input && input.positionTolerance !== undefined
        ? requireNonNegativeNumber(input.positionTolerance, 'positionTolerance')
        : 0.5;
    const zTolerance =
      input && input.zTolerance !== undefined
        ? requireNonNegativeNumber(input.zTolerance, 'zTolerance')
        : 0.01;
    const angleTolerance =
      input && input.angleTolerance !== undefined
        ? requireNonNegativeNumber(input.angleTolerance, 'angleTolerance')
        : 0.1;
    const snapshots = selected.map(entry => entry.snapshot);
    const adjacency = snapshots.map(() => new Set());

    let candidatePairsChecked = 0;
    for (let leftIndex = 0; leftIndex < snapshots.length; leftIndex++) {
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < snapshots.length;
        rightIndex++
      ) {
        candidatePairsChecked++;
        const left = snapshots[leftIndex];
        const right = snapshots[rightIndex];
        if (left.objectName !== right.objectName) continue;
        if (left.objectType !== right.objectType) continue;
        if (left.layer.name !== right.layer.name) continue;
        const dx = left.position.x - right.position.x;
        const dy = left.position.y - right.position.y;
        const planarDistance = Math.sqrt(dx * dx + dy * dy);
        if (planarDistance > positionTolerance) continue;
        if (Math.abs(left.position.z - right.position.z) > zTolerance) {
          continue;
        }
        if (angleDistance(left.angle, right.angle) > angleTolerance) {
          continue;
        }
        adjacency[leftIndex].add(rightIndex);
        adjacency[rightIndex].add(leftIndex);
      }
    }

    const visited = new Set();
    const groups = [];
    for (let start = 0; start < snapshots.length; start++) {
      if (visited.has(start) || adjacency[start].size === 0) continue;
      const stack = [start];
      const members = [];
      visited.add(start);
      while (stack.length) {
        const index = stack.pop();
        members.push(snapshots[index]);
        adjacency[index].forEach(neighbor => {
          if (visited.has(neighbor)) return;
          visited.add(neighbor);
          stack.push(neighbor);
        });
      }
      members.sort((left, right) =>
        left.instanceId.localeCompare(right.instanceId)
      );
      const canonical = members[0];
      const duplicateIds = members.slice(1).map(member => member.instanceId);
      groups.push({
        groupId: `likely-duplicate-${hashString(
          members.map(member => member.instanceId).join('|')
        )}`,
        confidenceBasis: {
          sameObjectName: true,
          sameObjectType: true,
          sameLayer: true,
          positionTolerance,
          zTolerance,
          angleTolerance,
        },
        objectName: canonical.objectName,
        objectType: canonical.objectType,
        layerName: canonical.layer.name,
        canonicalInstanceId: canonical.instanceId,
        duplicateInstanceIds: duplicateIds,
        members,
        deterministicCleanupSuggestion: {
          keepInstanceId: canonical.instanceId,
          deleteInstanceIds: duplicateIds,
          command: 'scene.instances.bulk-delete',
          requiresDryRun: true,
        },
      });
    }
    groups.sort((left, right) =>
      left.canonicalInstanceId.localeCompare(right.canonicalInstanceId)
    );

    return {
      authority: 'editor-project',
      autoDelete: false,
      diagnosticOnly: true,
      candidatePairsChecked,
      likelyDuplicateGroups: groups,
      groupCount: groups.length,
      duplicateInstanceCount: groups.reduce(
        (total, group) => total + group.duplicateInstanceIds.length,
        0
      ),
      contract:
        'Likely duplicates are diagnostic only. Cleanup must be an explicit scene.instances.bulk-delete dry-run followed by guarded apply.',
    };
  };

  const bulkDelete = (input: any): any => {
    const scene = requireScene(input && input.sceneName);
    const { selected, selectionRevision } = selectInstances(
      scene,
      input && input.selection,
      true
    );
    const summary = summarizeSelection(selected);
    const dryRun = !input || input.dryRun !== false;
    if (dryRun) {
      return {
        dryRun: true,
        operation: 'delete',
        selectionRevision,
        summary,
        wouldDelete: summary.count,
        autoApplied: false,
      };
    }
    assertSelectionRevision(selectionRevision, input);
    if (!selected.length) {
      throw new AgentError({
        code: 'scene_instance_not_found',
        details: { matchCount: 0, operation: 'bulk-delete' },
      });
    }

    const container = scene.getInitialInstances();
    const beforeCount = container.getInstancesCount();
    selected.forEach(({ instance }) => container.removeInstance(instance));
    const afterCount = container.getInstancesCount();
    if (afterCount !== beforeCount - selected.length) {
      throw new AgentError({
        code: 'scene_instance_bulk_delete_invariant_conflict',
        details: {
          beforeCount,
          afterCount,
          selectedCount: selected.length,
        },
      });
    }
    notifyMutation(scene);
    return {
      dryRun: false,
      operation: 'delete',
      applied: true,
      selectionRevision,
      deletedCount: selected.length,
      deleted: summary.targets,
      instanceCount: {
        before: beforeCount,
        after: afterCount,
        delta: -selected.length,
      },
    };
  };

  const bulkUpdate = async (
    input: any,
    requestContext: any = {}
  ): Promise<any> => {
    const scene = requireScene(input && input.sceneName);
    const { selected, selectionRevision } = selectInstances(
      scene,
      input && input.selection,
      true
    );
    assertNoPlacementPaths(input && input.changes);

    const preflight = selected.map(({ snapshot }) => {
      const described = objectPropertyService.describe({
        targetKind: 'scene-instance',
        sceneName: scene.getName(),
        instanceId: snapshot.instanceId,
      });
      validateChangesAgainstDescription(input.changes, described);
      return {
        instanceId: snapshot.instanceId,
        instanceRevision: snapshot.instanceRevision,
      };
    });

    const summary = summarizeSelection(selected);
    const dryRun = !input || input.dryRun !== false;
    if (dryRun) {
      return {
        dryRun: true,
        operation: 'update',
        selectionRevision,
        summary,
        changes: input.changes,
        preflight,
        autoApplied: false,
        atomic: false,
        safety:
          'All targets and values were preflighted. Apply is guarded by expectedSelectionRevision; use a safety transaction when rollback atomicity is required.',
      };
    }
    assertSelectionRevision(selectionRevision, input);
    if (!selected.length) {
      throw new AgentError({
        code: 'scene_instance_not_found',
        details: { matchCount: 0, operation: 'bulk-update' },
      });
    }

    const container = scene.getInitialInstances();
    const beforeCount = container.getInstancesCount();
    const results = [];
    for (const { snapshot } of selected) {
      const result = await objectPropertyService.set(
        {
          targetKind: 'scene-instance',
          sceneName: scene.getName(),
          instanceId: snapshot.instanceId,
          changes: input.changes,
        },
        requestContext
      );
      results.push({
        instanceId: snapshot.instanceId,
        applied: result.applied,
      });
    }
    const afterCount = container.getInstancesCount();
    if (afterCount !== beforeCount) {
      throw new AgentError({
        code: 'scene_instance_bulk_update_invariant_conflict',
        details: {
          beforeCount,
          afterCount,
          invariant: 'bulk-update-must-never-create-or-delete-an-instance',
        },
      });
    }
    const afterSelection = selectInstances(
      scene,
      {
        instanceIds: selected.map(entry => entry.snapshot.instanceId),
      },
      true
    );
    return {
      dryRun: false,
      operation: 'update',
      applied: true,
      atomic: false,
      selectionRevision,
      updatedCount: selected.length,
      instanceCountUnchanged: true,
      results,
      after: summarizeSelection(afterSelection.selected),
    };
  };

  return {
    list,
    get,
    create,
    update,
    transform,
    duplicate,
    remove,
    diagnoseDuplicates,
    bulkDelete,
    bulkUpdate,
  };
};

export const sceneInstanceInternals = {
  placementContract,
  RESERVED_UPDATE_PATHS,
  hashString,
};
