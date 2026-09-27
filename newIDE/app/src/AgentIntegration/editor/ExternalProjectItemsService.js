// @flow
import { AgentError } from '../core/AgentError';
import {
  serializeToJSObject,
  unserializeFromJSObject,
} from '../../Utils/Serializer';
import { analyzeExternalEventsRenameImpact } from './ProjectStructureImpact';

const gd: libGDevelop = global.gd;

type Options = {|
  project: ?gdProject,
  triggerUnsavedChanges: () => void,
  forceUpdate: () => void,
|};

const INSTANCE_MUTABLE_FIELDS = [
  ['x', 'setX', 'number'],
  ['y', 'setY', 'number'],
  ['z', 'setZ', 'number'],
  ['angle', 'setAngle', 'number'],
  ['rotationX', 'setRotationX', 'number'],
  ['rotationY', 'setRotationY', 'number'],
  ['zOrder', 'setZOrder', 'number'],
  ['opacity', 'setOpacity', 'number'],
  ['layer', 'setLayer', 'string'],
  ['locked', 'setLocked', 'boolean'],
  ['sealed', 'setSealed', 'boolean'],
  ['hidden', 'setHidden', 'boolean'],
  ['flippedX', 'setFlippedX', 'boolean'],
  ['flippedY', 'setFlippedY', 'boolean'],
  ['flippedZ', 'setFlippedZ', 'boolean'],
  ['keepRatio', 'setShouldKeepRatio', 'boolean'],
  ['hasCustomSize', 'setHasCustomSize', 'boolean'],
  ['hasCustomDepth', 'setHasCustomDepth', 'boolean'],
  ['customWidth', 'setCustomWidth', 'number'],
  ['customHeight', 'setCustomHeight', 'number'],
  ['customDepth', 'setCustomDepth', 'number'],
];

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

const serializeInstance = (instance: gdInitialInstance) => ({
  ...serializeToJSObject(instance),
  id: instance.getPersistentUuid(),
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
});

export const createExternalProjectItemsService = ({
  project,
  triggerUnsavedChanges,
  forceUpdate,
}: Options) => {
  const requireProject = (): gdProject => {
    if (!project) throw new AgentError({ code: 'no_project_open' });
    return project;
  };

  const notifyMutation = () => {
    triggerUnsavedChanges();
    forceUpdate();
  };

  const requireNonEmptyName = (name: any, code: string): string => {
    if (typeof name !== 'string' || !name.trim()) {
      throw new AgentError({ code });
    }
    return name;
  };

  const requireAssociatedLayout = (name: any): ?gdLayout => {
    if (name == null || name === '') return null;
    const associatedLayout = requireNonEmptyName(
      name,
      'invalid_associated_layout'
    );
    const currentProject = requireProject();
    if (!currentProject.hasLayoutNamed(associatedLayout)) {
      throw new AgentError({
        code: 'associated_scene_not_found',
        details: { associatedLayout },
      });
    }
    return currentProject.getLayout(associatedLayout);
  };

  const getExternalEventsId = (externalEvents: gdExternalEvents): string => {
    if (typeof externalEvents.getPersistentUuid !== 'function') {
      throw new AgentError({
        code: 'external_events_identity_unavailable',
        hint:
          'This build does not expose persistent External Events UUIDs. Rebuild libGD.js with the DX-33 native model changes.',
      });
    }
    const id = externalEvents.getPersistentUuid();
    if (!id) throw new AgentError({ code: 'external_events_identity_missing' });
    return id;
  };

  const findExternalEventsById = (id: string): ?gdExternalEvents => {
    const currentProject = requireProject();
    for (
      let index = 0;
      index < currentProject.getExternalEventsCount();
      index++
    ) {
      const externalEvents = currentProject.getExternalEventsAt(index);
      if (getExternalEventsId(externalEvents) === id) return externalEvents;
    }
    return null;
  };

  const requireExternalEvents = (target: any): gdExternalEvents => {
    const input = typeof target === 'string' ? { name: target } : target || {};
    const rawId =
      typeof input.externalEventsId === 'string'
        ? input.externalEventsId
        : typeof input.id === 'string'
        ? input.id
        : typeof input.selector === 'string' &&
          input.selector.startsWith('external-events:')
        ? input.selector.slice('external-events:'.length)
        : null;
    const externalEventsName =
      typeof input.name === 'string' && input.name
        ? input.name
        : typeof input.externalEventsName === 'string' &&
          input.externalEventsName
        ? input.externalEventsName
        : null;

    if (!rawId && !externalEventsName) {
      throw new AgentError({
        code: 'missing_external_events_target',
        hint:
          'Pass externalEventsId/selector from external-events.list, or a sheet name.',
      });
    }

    const currentProject = requireProject();
    const byId = rawId ? findExternalEventsById(rawId) : null;
    const byName =
      externalEventsName &&
      currentProject.hasExternalEventsNamed(externalEventsName)
        ? currentProject.getExternalEvents(externalEventsName)
        : null;

    if (rawId && !byId) {
      throw new AgentError({
        code: 'external_events_not_found',
        details: { externalEventsId: rawId },
      });
    }
    if (externalEventsName && !byName) {
      throw new AgentError({
        code: 'external_events_not_found',
        details: { name: externalEventsName },
      });
    }
    if (
      byId &&
      byName &&
      getExternalEventsId(byId) !== getExternalEventsId(byName)
    ) {
      throw new AgentError({
        code: 'stale_external_events_target',
        retryable: true,
        details: {
          expectedExternalEventsId: getExternalEventsId(byId),
          name: externalEventsName,
          actualExternalEventsIdForName: getExternalEventsId(byName),
        },
        hint:
          'The External Events name now resolves to a different persistent identity. Re-read external-events.list/get and retry.',
      });
    }
    return byId || byName;
  };

  const requireExternalLayout = (name: any): gdExternalLayout => {
    const externalLayoutName = requireNonEmptyName(
      name,
      'invalid_external_layout_name'
    );
    const currentProject = requireProject();
    if (!currentProject.hasExternalLayoutNamed(externalLayoutName)) {
      throw new AgentError({
        code: 'external_layout_not_found',
        details: { name: externalLayoutName },
      });
    }
    return currentProject.getExternalLayout(externalLayoutName);
  };

  const summarizeExternalEvents = (
    externalEvents: gdExternalEvents,
    index: ?number = null
  ) => {
    const id = getExternalEventsId(externalEvents);
    return {
      id,
      externalEventsId: id,
      selector: `external-events:${id}`,
      name: externalEvents.getName(),
      displayName: externalEvents.getName(),
      order: index,
      associatedLayout: externalEvents.getAssociatedLayout(),
      eventCount: externalEvents.getEvents().getEventsCount(),
    };
  };

  const summarizeExternalLayout = (externalLayout: gdExternalLayout) => ({
    name: externalLayout.getName(),
    associatedLayout: externalLayout.getAssociatedLayout(),
    instanceCount: externalLayout.getInitialInstances().getInstancesCount(),
  });

  const listExternalEvents = () => {
    const currentProject = requireProject();
    const items = Array.from(
      { length: currentProject.getExternalEventsCount() },
      (_, index) =>
        summarizeExternalEvents(
          currentProject.getExternalEventsAt(index),
          index
        )
    );
    return { items, total: items.length };
  };

  const inspectExternalEvents = (input: any) => {
    const currentProject = requireProject();
    const externalEvents = requireExternalEvents(input);
    return {
      externalEvents: summarizeExternalEvents(
        externalEvents,
        currentProject.getExternalEventsPosition(externalEvents.getName())
      ),
    };
  };

  const externalEventsUsages = (input: any) => {
    const currentProject = requireProject();
    const externalEvents = requireExternalEvents(input);
    const impact = analyzeExternalEventsRenameImpact(
      currentProject,
      externalEvents.getName()
    );
    return {
      externalEvents: summarizeExternalEvents(
        externalEvents,
        currentProject.getExternalEventsPosition(externalEvents.getName())
      ),
      references: impact.references,
      total: impact.total,
    };
  };

  const createExternalEvents = ({
    name,
    associatedLayout = '',
    position,
  }: any) => {
    const currentProject = requireProject();
    const externalEventsName = requireNonEmptyName(
      name,
      'invalid_external_events_name'
    );
    if (currentProject.hasExternalEventsNamed(externalEventsName)) {
      throw new AgentError({
        code: 'external_events_name_taken',
        details: { name: externalEventsName },
      });
    }
    requireAssociatedLayout(associatedLayout);
    const count = currentProject.getExternalEventsCount();
    const targetPosition = position == null ? count : Number(position);
    if (
      !Number.isInteger(targetPosition) ||
      targetPosition < 0 ||
      targetPosition > count
    ) {
      throw new AgentError({
        code: 'invalid_external_events_order',
        details: { position, count },
      });
    }
    const externalEvents = currentProject.insertNewExternalEvents(
      externalEventsName,
      targetPosition
    );
    if (associatedLayout) externalEvents.setAssociatedLayout(associatedLayout);
    notifyMutation();
    return {
      created: true,
      externalEvents: summarizeExternalEvents(
        externalEvents,
        currentProject.getExternalEventsPosition(externalEventsName)
      ),
    };
  };

  const updateExternalEvents = (input: any) => {
    const currentProject = requireProject();
    const externalEvents = requireExternalEvents(input);
    if (input.associatedLayout !== undefined) {
      requireAssociatedLayout(input.associatedLayout);
      externalEvents.setAssociatedLayout(input.associatedLayout || '');
    }
    notifyMutation();
    return {
      updated: true,
      externalEvents: summarizeExternalEvents(
        externalEvents,
        currentProject.getExternalEventsPosition(externalEvents.getName())
      ),
    };
  };

  const duplicateExternalEvents = ({
    name,
    externalEventsName,
    externalEventsId,
    id,
    selector,
    newName,
    position,
  }: any) => {
    const currentProject = requireProject();
    const source = requireExternalEvents({
      name: name || externalEventsName,
      externalEventsId: externalEventsId || id,
      selector,
    });
    const nextName = requireNonEmptyName(
      newName,
      'invalid_external_events_name'
    );
    if (currentProject.hasExternalEventsNamed(nextName)) {
      throw new AgentError({
        code: 'external_events_name_taken',
        details: { name: nextName },
      });
    }
    const sourceIndex = currentProject.getExternalEventsPosition(
      source.getName()
    );
    const count = currentProject.getExternalEventsCount();
    const targetPosition =
      position == null ? Math.min(sourceIndex + 1, count) : Number(position);
    if (
      !Number.isInteger(targetPosition) ||
      targetPosition < 0 ||
      targetPosition > count
    ) {
      throw new AgentError({
        code: 'invalid_external_events_order',
        details: { position, count },
      });
    }
    const serialized = serializeToJSObject(source);
    const copy = currentProject.insertNewExternalEvents(
      nextName,
      targetPosition
    );
    unserializeFromJSObject(
      copy,
      serialized,
      'unserializeFrom',
      currentProject
    );
    copy.setName(nextName);
    if (typeof copy.resetPersistentUuid === 'function') {
      copy.resetPersistentUuid();
    }
    notifyMutation();
    return {
      duplicated: true,
      source: summarizeExternalEvents(source, sourceIndex),
      externalEvents: summarizeExternalEvents(
        copy,
        currentProject.getExternalEventsPosition(nextName)
      ),
    };
  };

  const renameExternalEvents = (input: any) => {
    const currentProject = requireProject();
    const externalEvents = requireExternalEvents(input);
    const oldName = externalEvents.getName();
    const nextName = requireNonEmptyName(
      input.newName,
      'invalid_external_events_name'
    );
    const id = getExternalEventsId(externalEvents);
    if (nextName === oldName) {
      return {
        renamed: false,
        reason: 'same_name',
        externalEvents: summarizeExternalEvents(
          externalEvents,
          currentProject.getExternalEventsPosition(oldName)
        ),
      };
    }
    if (currentProject.hasExternalEventsNamed(nextName)) {
      throw new AgentError({
        code: 'external_events_name_taken',
        details: { name: nextName },
      });
    }
    const impact = analyzeExternalEventsRenameImpact(currentProject, oldName);
    externalEvents.setName(nextName);
    gd.WholeProjectRefactorer.renameExternalEvents(
      currentProject,
      oldName,
      nextName
    );
    if (getExternalEventsId(externalEvents) !== id) {
      throw new AgentError({
        code: 'external_events_identity_changed_during_rename',
      });
    }
    notifyMutation();
    return {
      renamed: true,
      oldName,
      newName: nextName,
      preservedExternalEventsId: id,
      referencesUpdated: impact.total,
      references: impact.references,
      externalEvents: summarizeExternalEvents(
        externalEvents,
        currentProject.getExternalEventsPosition(nextName)
      ),
    };
  };

  const reorderExternalEvents = ({ position, ...target }: any) => {
    const currentProject = requireProject();
    const externalEvents = requireExternalEvents(target);
    const oldIndex = currentProject.getExternalEventsPosition(
      externalEvents.getName()
    );
    const newIndex = Number(position);
    const count = currentProject.getExternalEventsCount();
    if (!Number.isInteger(newIndex) || newIndex < 0 || newIndex >= count) {
      throw new AgentError({
        code: 'invalid_external_events_order',
        details: { position, count },
      });
    }
    if (oldIndex === newIndex) {
      return {
        reordered: false,
        reason: 'same_position',
        externalEvents: summarizeExternalEvents(externalEvents, oldIndex),
      };
    }
    currentProject.moveExternalEvents(oldIndex, newIndex);
    notifyMutation();
    return {
      reordered: true,
      oldIndex,
      newIndex,
      externalEvents: summarizeExternalEvents(externalEvents, newIndex),
    };
  };

  const deleteExternalEvents = ({
    dryRun = false,
    allowReferenced = false,
    ...target
  }: any) => {
    const currentProject = requireProject();
    const externalEvents = requireExternalEvents(target);
    const summary = summarizeExternalEvents(
      externalEvents,
      currentProject.getExternalEventsPosition(externalEvents.getName())
    );
    const impact = analyzeExternalEventsRenameImpact(
      currentProject,
      externalEvents.getName()
    );
    const result = {
      dryRun: !!dryRun,
      wouldDelete: true,
      externalEvents: summary,
      blockers: impact.references,
      blockerCount: impact.total,
    };
    if (dryRun) return result;
    if (impact.total > 0 && !allowReferenced) {
      throw new AgentError({
        code: 'external_events_delete_blocked',
        retryable: true,
        details: result,
        hint:
          'Inspect external-events.usages. Delete or refactor the links first, or set allowReferenced=true only when broken references are intentional.',
      });
    }
    currentProject.removeExternalEvents(externalEvents.getName());
    notifyMutation();
    return {
      deleted: true,
      externalEvents: summary,
      removedReferencedTarget: impact.total > 0,
      referencesAtDeletion: impact.references,
    };
  };

  const listExternalLayouts = () => {
    const currentProject = requireProject();
    const items = Array.from(
      { length: currentProject.getExternalLayoutsCount() },
      (_, index) =>
        summarizeExternalLayout(currentProject.getExternalLayoutAt(index))
    );
    return { items, total: items.length };
  };

  const inspectExternalLayout = ({ name }: any) => ({
    externalLayout: summarizeExternalLayout(requireExternalLayout(name)),
  });

  const createExternalLayout = ({ name, associatedLayout = '' }: any) => {
    const currentProject = requireProject();
    const externalLayoutName = requireNonEmptyName(
      name,
      'invalid_external_layout_name'
    );
    if (currentProject.hasExternalLayoutNamed(externalLayoutName)) {
      throw new AgentError({
        code: 'external_layout_name_taken',
        details: { name: externalLayoutName },
      });
    }
    requireAssociatedLayout(associatedLayout);
    const externalLayout = currentProject.insertNewExternalLayout(
      externalLayoutName,
      currentProject.getExternalLayoutsCount()
    );
    if (associatedLayout) externalLayout.setAssociatedLayout(associatedLayout);
    notifyMutation();
    return {
      created: true,
      externalLayout: summarizeExternalLayout(externalLayout),
    };
  };

  const updateExternalLayout = ({ name, associatedLayout }: any) => {
    const externalLayout = requireExternalLayout(name);
    if (associatedLayout !== undefined) {
      requireAssociatedLayout(associatedLayout);
      externalLayout.setAssociatedLayout(associatedLayout || '');
    }
    notifyMutation();
    return {
      updated: true,
      externalLayout: summarizeExternalLayout(externalLayout),
    };
  };

  const duplicateExternalLayout = ({ name, newName }: any) => {
    const currentProject = requireProject();
    const source = requireExternalLayout(name);
    const nextName = requireNonEmptyName(
      newName,
      'invalid_external_layout_name'
    );
    if (currentProject.hasExternalLayoutNamed(nextName)) {
      throw new AgentError({
        code: 'external_layout_name_taken',
        details: { name: nextName },
      });
    }
    const serialized = serializeToJSObject(source);
    const copy = currentProject.insertNewExternalLayout(
      nextName,
      currentProject.getExternalLayoutPosition(name) + 1
    );
    unserializeFromJSObject(
      copy,
      serialized,
      'unserializeFrom',
      currentProject
    );
    copy.setName(nextName);
    notifyMutation();
    return {
      duplicated: true,
      sourceName: name,
      externalLayout: summarizeExternalLayout(copy),
    };
  };

  const renameExternalLayout = ({ name, newName }: any) => {
    const currentProject = requireProject();
    const externalLayout = requireExternalLayout(name);
    const nextName = requireNonEmptyName(
      newName,
      'invalid_external_layout_name'
    );
    if (nextName === name) {
      return {
        renamed: false,
        reason: 'same_name',
        externalLayout: summarizeExternalLayout(externalLayout),
      };
    }
    if (currentProject.hasExternalLayoutNamed(nextName)) {
      throw new AgentError({
        code: 'external_layout_name_taken',
        details: { name: nextName },
      });
    }
    externalLayout.setName(nextName);
    gd.WholeProjectRefactorer.renameExternalLayout(
      currentProject,
      name,
      nextName
    );
    notifyMutation();
    return {
      renamed: true,
      oldName: name,
      newName: nextName,
      externalLayout: summarizeExternalLayout(externalLayout),
    };
  };

  const deleteExternalLayout = ({ name, allowReferenced = false }: any) => {
    const currentProject = requireProject();
    requireExternalLayout(name);
    if (!allowReferenced) {
      throw new AgentError({
        code: 'external_layout_delete_requires_reference_opt_in',
        message:
          'GDevelop exposes no authoritative project-wide External Layout usage finder. Set allowReferenced=true only after checking call sites.',
        recovery:
          'Inspect project events and associated External Events, create a checkpoint, then retry with allowReferenced=true.',
      });
    }
    currentProject.removeExternalLayout(name);
    notifyMutation();
    return { deleted: true, name, allowedReferenced: true };
  };

  const resolveExternalLayoutObject = (
    externalLayout: gdExternalLayout,
    objectName: string
  ): gdObject => {
    const currentProject = requireProject();
    const globals = currentProject.getObjects();
    if (globals.hasObjectNamed(objectName))
      return globals.getObject(objectName);
    const associatedLayoutName = externalLayout.getAssociatedLayout();
    if (
      associatedLayoutName &&
      currentProject.hasLayoutNamed(associatedLayoutName)
    ) {
      const sceneObjects = currentProject
        .getLayout(associatedLayoutName)
        .getObjects();
      if (sceneObjects.hasObjectNamed(objectName))
        return sceneObjects.getObject(objectName);
    }
    throw new AgentError({
      code: 'external_layout_object_not_found',
      details: {
        externalLayoutName: externalLayout.getName(),
        associatedLayout: associatedLayoutName || null,
        objectName,
      },
    });
  };

  const listExternalLayoutInstances = ({ name, objectName }: any) => {
    const externalLayout = requireExternalLayout(name);
    const instances = [];
    iterateInstances(externalLayout.getInitialInstances(), instance => {
      if (objectName && instance.getObjectName() !== objectName) return;
      instances.push(serializeInstance(instance));
    });
    return { items: instances, total: instances.length };
  };

  const requireInstance = (
    externalLayout: gdExternalLayout,
    instanceId: any
  ): gdInitialInstance => {
    const id = requireNonEmptyName(instanceId, 'invalid_instance_id');
    const matches = [];
    iterateInstances(externalLayout.getInitialInstances(), instance => {
      const persistentUuid = instance.getPersistentUuid();
      if (persistentUuid === id || persistentUuid.startsWith(id)) {
        matches.push(instance);
      }
    });
    if (matches.length === 0) {
      throw new AgentError({
        code: 'external_layout_instance_not_found',
        details: {
          externalLayoutName: externalLayout.getName(),
          instanceId: id,
        },
      });
    }
    if (matches.length > 1) {
      throw new AgentError({
        code: 'ambiguous_instance_id',
        details: {
          externalLayoutName: externalLayout.getName(),
          instanceId: id,
        },
      });
    }
    return matches[0];
  };

  const applyInstancePatch = (
    externalLayout: gdExternalLayout,
    instance: gdInitialInstance,
    patch: any
  ) => {
    if (patch.objectName !== undefined) {
      const objectName = requireNonEmptyName(
        patch.objectName,
        'invalid_object_name'
      );
      resolveExternalLayoutObject(externalLayout, objectName);
      instance.setObjectName(objectName);
    }
    INSTANCE_MUTABLE_FIELDS.forEach(([property, setter, expectedType]) => {
      if (patch[property] === undefined) return;
      if (typeof patch[property] !== expectedType) {
        throw new AgentError({
          code: 'invalid_external_layout_instance_property',
          details: { property, expectedType },
        });
      }
      instance[setter](patch[property]);
    });
  };

  const createExternalLayoutInstance = ({
    name,
    objectName,
    ...patch
  }: any) => {
    const externalLayout = requireExternalLayout(name);
    const targetObjectName = requireNonEmptyName(
      objectName,
      'invalid_object_name'
    );
    resolveExternalLayoutObject(externalLayout, targetObjectName);
    const instance = externalLayout
      .getInitialInstances()
      .insertNewInitialInstance();
    instance.setObjectName(targetObjectName);
    applyInstancePatch(externalLayout, instance, patch);
    notifyMutation();
    return { created: true, instance: serializeInstance(instance) };
  };

  const updateExternalLayoutInstance = ({
    name,
    instanceId,
    ...patch
  }: any) => {
    const externalLayout = requireExternalLayout(name);
    const instance = requireInstance(externalLayout, instanceId);
    applyInstancePatch(externalLayout, instance, patch);
    notifyMutation();
    return { updated: true, instance: serializeInstance(instance) };
  };

  const deleteExternalLayoutInstance = ({ name, instanceId }: any) => {
    const externalLayout = requireExternalLayout(name);
    const container = externalLayout.getInitialInstances();
    const instance = requireInstance(externalLayout, instanceId);
    const deletedInstance = serializeInstance(instance);
    container.removeInstance(instance);
    notifyMutation();
    return { deleted: true, instance: deletedInstance };
  };

  return {
    listExternalEvents,
    inspectExternalEvents,
    externalEventsUsages,
    createExternalEvents,
    updateExternalEvents,
    duplicateExternalEvents,
    renameExternalEvents,
    reorderExternalEvents,
    deleteExternalEvents,
    listExternalLayouts,
    inspectExternalLayout,
    createExternalLayout,
    updateExternalLayout,
    duplicateExternalLayout,
    renameExternalLayout,
    deleteExternalLayout,
    listExternalLayoutInstances,
    createExternalLayoutInstance,
    updateExternalLayoutInstance,
    deleteExternalLayoutInstance,
  };
};
