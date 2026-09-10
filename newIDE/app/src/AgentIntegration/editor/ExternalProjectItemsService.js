// @flow
import { AgentError } from '../core/AgentError';
import {
  serializeToJSObject,
  unserializeFromJSObject,
} from '../../Utils/Serializer';

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

  const requireExternalEvents = (name: any): gdExternalEvents => {
    const externalEventsName = requireNonEmptyName(
      name,
      'invalid_external_events_name'
    );
    const currentProject = requireProject();
    if (!currentProject.hasExternalEventsNamed(externalEventsName)) {
      throw new AgentError({
        code: 'external_events_not_found',
        details: { name: externalEventsName },
      });
    }
    return currentProject.getExternalEvents(externalEventsName);
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

  const summarizeExternalEvents = (externalEvents: gdExternalEvents) => ({
    name: externalEvents.getName(),
    associatedLayout: externalEvents.getAssociatedLayout(),
    eventCount: externalEvents.getEvents().getEventsCount(),
  });

  const summarizeExternalLayout = (externalLayout: gdExternalLayout) => ({
    name: externalLayout.getName(),
    associatedLayout: externalLayout.getAssociatedLayout(),
    instanceCount: externalLayout.getInitialInstances().getInstancesCount(),
  });

  const listExternalEvents = () => {
    const currentProject = requireProject();
    const items = Array.from(
      { length: currentProject.getExternalEventsCount() },
      (_, index) => summarizeExternalEvents(currentProject.getExternalEventsAt(index))
    );
    return { items, total: items.length };
  };

  const inspectExternalEvents = ({ name }: any) => ({
    externalEvents: summarizeExternalEvents(requireExternalEvents(name)),
  });

  const createExternalEvents = ({ name, associatedLayout = '' }: any) => {
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
    const externalEvents = currentProject.insertNewExternalEvents(
      externalEventsName,
      currentProject.getExternalEventsCount()
    );
    if (associatedLayout) externalEvents.setAssociatedLayout(associatedLayout);
    notifyMutation();
    return { created: true, externalEvents: summarizeExternalEvents(externalEvents) };
  };

  const updateExternalEvents = ({ name, associatedLayout }: any) => {
    const externalEvents = requireExternalEvents(name);
    if (associatedLayout !== undefined) {
      requireAssociatedLayout(associatedLayout);
      externalEvents.setAssociatedLayout(associatedLayout || '');
    }
    notifyMutation();
    return { updated: true, externalEvents: summarizeExternalEvents(externalEvents) };
  };

  const renameExternalEvents = ({ name, newName }: any) => {
    const currentProject = requireProject();
    const externalEvents = requireExternalEvents(name);
    const nextName = requireNonEmptyName(newName, 'invalid_external_events_name');
    if (nextName === name) {
      return {
        renamed: false,
        reason: 'same_name',
        externalEvents: summarizeExternalEvents(externalEvents),
      };
    }
    if (currentProject.hasExternalEventsNamed(nextName)) {
      throw new AgentError({
        code: 'external_events_name_taken',
        details: { name: nextName },
      });
    }
    externalEvents.setName(nextName);
    gd.WholeProjectRefactorer.renameExternalEvents(currentProject, name, nextName);
    notifyMutation();
    return {
      renamed: true,
      oldName: name,
      newName: nextName,
      externalEvents: summarizeExternalEvents(externalEvents),
    };
  };

  const deleteExternalEvents = ({ name, allowReferenced = false }: any) => {
    const currentProject = requireProject();
    requireExternalEvents(name);
    if (!allowReferenced) {
      throw new AgentError({
        code: 'external_events_delete_requires_reference_opt_in',
        message:
          'GDevelop exposes no authoritative project-wide External Events usage finder. Set allowReferenced=true only after checking call sites.',
        recovery:
          'Inspect project event links, create a checkpoint, then retry with allowReferenced=true.',
      });
    }
    currentProject.removeExternalEvents(name);
    notifyMutation();
    return { deleted: true, name, allowedReferenced: true };
  };

  const listExternalLayouts = () => {
    const currentProject = requireProject();
    const items = Array.from(
      { length: currentProject.getExternalLayoutsCount() },
      (_, index) => summarizeExternalLayout(currentProject.getExternalLayoutAt(index))
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
    return { created: true, externalLayout: summarizeExternalLayout(externalLayout) };
  };

  const updateExternalLayout = ({ name, associatedLayout }: any) => {
    const externalLayout = requireExternalLayout(name);
    if (associatedLayout !== undefined) {
      requireAssociatedLayout(associatedLayout);
      externalLayout.setAssociatedLayout(associatedLayout || '');
    }
    notifyMutation();
    return { updated: true, externalLayout: summarizeExternalLayout(externalLayout) };
  };

  const duplicateExternalLayout = ({ name, newName }: any) => {
    const currentProject = requireProject();
    const source = requireExternalLayout(name);
    const nextName = requireNonEmptyName(newName, 'invalid_external_layout_name');
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
    unserializeFromJSObject(copy, serialized, 'unserializeFrom', currentProject);
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
    const nextName = requireNonEmptyName(newName, 'invalid_external_layout_name');
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
    gd.WholeProjectRefactorer.renameExternalLayout(currentProject, name, nextName);
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
    if (globals.hasObjectNamed(objectName)) return globals.getObject(objectName);
    const associatedLayoutName = externalLayout.getAssociatedLayout();
    if (
      associatedLayoutName &&
      currentProject.hasLayoutNamed(associatedLayoutName)
    ) {
      const sceneObjects = currentProject.getLayout(associatedLayoutName).getObjects();
      if (sceneObjects.hasObjectNamed(objectName)) return sceneObjects.getObject(objectName);
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
        details: { externalLayoutName: externalLayout.getName(), instanceId: id },
      });
    }
    if (matches.length > 1) {
      throw new AgentError({
        code: 'ambiguous_instance_id',
        details: { externalLayoutName: externalLayout.getName(), instanceId: id },
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
      const objectName = requireNonEmptyName(patch.objectName, 'invalid_object_name');
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

  const createExternalLayoutInstance = ({ name, objectName, ...patch }: any) => {
    const externalLayout = requireExternalLayout(name);
    const targetObjectName = requireNonEmptyName(objectName, 'invalid_object_name');
    resolveExternalLayoutObject(externalLayout, targetObjectName);
    const instance = externalLayout.getInitialInstances().insertNewInitialInstance();
    instance.setObjectName(targetObjectName);
    applyInstancePatch(externalLayout, instance, patch);
    notifyMutation();
    return { created: true, instance: serializeInstance(instance) };
  };

  const updateExternalLayoutInstance = ({ name, instanceId, ...patch }: any) => {
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
    createExternalEvents,
    updateExternalEvents,
    renameExternalEvents,
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
