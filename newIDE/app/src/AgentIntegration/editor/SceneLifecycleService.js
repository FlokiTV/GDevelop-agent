// @flow
import { AgentError } from '../core/AgentError';
import {
  serializeToJSObject,
  unserializeFromJSObject,
} from '../../Utils/Serializer';
import { renameLayoutInProject } from '../../Utils/Layout';
import { analyzeSceneRenameImpact } from './ProjectStructureImpact';

type Options = {|
  project: ?gdProject,
  triggerUnsavedChanges: () => void,
  forceUpdate: () => void,
  onWillDeleteScene: (changes: any) => Promise<void>,
|};

const normalizeSelectorId = (selector: any, prefix: string): ?string => {
  if (typeof selector !== 'string' || !selector) return null;
  return selector.startsWith(prefix) ? selector.slice(prefix.length) : selector;
};

export const createSceneLifecycleService = ({
  project,
  triggerUnsavedChanges,
  forceUpdate,
  onWillDeleteScene,
}: Options): any => {
  const requireProject = (): gdProject => {
    if (!project) throw new AgentError({ code: 'no_project_open' });
    return project;
  };

  const notifyMutation = () => {
    triggerUnsavedChanges();
    forceUpdate();
  };

  const requireName = (name: any, code: string = 'invalid_scene_name') => {
    if (typeof name !== 'string' || !name.trim()) {
      throw new AgentError({ code });
    }
    return name;
  };

  const getSceneId = (scene: gdLayout): string => {
    if (typeof scene.getPersistentUuid !== 'function') {
      throw new AgentError({
        code: 'scene_identity_unavailable',
        hint:
          'This build does not expose persistent scene UUIDs. Rebuild libGD.js with the DX-33 native model changes.',
      });
    }
    const id = scene.getPersistentUuid();
    if (!id) {
      throw new AgentError({ code: 'scene_identity_missing' });
    }
    return id;
  };

  const summarizeScene = (
    scene: gdLayout,
    index: number,
    currentProject: gdProject
  ) => {
    const id = getSceneId(scene);
    const name = scene.getName();
    return {
      id,
      sceneId: id,
      selector: `scene:${id}`,
      name,
      displayName: name,
      order: index,
      firstScene: currentProject.getFirstLayout() === name,
      eventCount: scene.getEvents().getEventsCount(),
      objectCount: scene.getObjects().getObjectsCount(),
      instanceCount: scene.getInitialInstances().getInstancesCount(),
      layerCount: scene.getLayers().getLayersCount(),
    };
  };

  const list = () => {
    const currentProject = requireProject();
    const items = Array.from(
      { length: currentProject.getLayoutsCount() },
      (_, index) =>
        summarizeScene(currentProject.getLayoutAt(index), index, currentProject)
    );
    return { items, total: items.length };
  };

  const findById = (id: string): ?gdLayout => {
    const currentProject = requireProject();
    for (let index = 0; index < currentProject.getLayoutsCount(); index++) {
      const scene = currentProject.getLayoutAt(index);
      if (getSceneId(scene) === id) return scene;
    }
    return null;
  };

  const resolveScene = (input: any = {}): gdLayout => {
    const currentProject = requireProject();
    const explicitId =
      normalizeSelectorId(input.sceneId, 'scene:') ||
      normalizeSelectorId(input.selector, 'scene:');
    const explicitName =
      typeof input.name === 'string' && input.name
        ? input.name
        : typeof input.sceneName === 'string' && input.sceneName
        ? input.sceneName
        : null;

    if (!explicitId && !explicitName) {
      throw new AgentError({
        code: 'missing_scene_target',
        hint:
          'Pass sceneId/selector from project.scenes.list, or a scene name.',
      });
    }

    const byId = explicitId ? findById(explicitId) : null;
    const byName =
      explicitName && currentProject.hasLayoutNamed(explicitName)
        ? currentProject.getLayout(explicitName)
        : null;

    if (explicitId && !byId) {
      throw new AgentError({
        code: 'scene_not_found',
        details: { sceneId: explicitId },
      });
    }
    if (explicitName && !byName) {
      throw new AgentError({
        code: 'scene_not_found',
        details: { name: explicitName },
      });
    }
    if (byId && byName && getSceneId(byId) !== getSceneId(byName)) {
      throw new AgentError({
        code: 'stale_scene_target',
        retryable: true,
        details: {
          expectedSceneId: getSceneId(byId),
          name: explicitName,
          actualSceneIdForName: getSceneId(byName),
        },
        hint:
          'The scene name now resolves to a different persistent identity. Re-read project.scenes.list/get and retry.',
      });
    }
    return byId || byName;
  };

  const get = (input: any) => {
    const currentProject = requireProject();
    const scene = resolveScene(input);
    return {
      scene: summarizeScene(
        scene,
        currentProject.getLayoutPosition(scene.getName()),
        currentProject
      ),
    };
  };

  const usages = (input: any) => {
    const currentProject = requireProject();
    const scene = resolveScene(input);
    const impact = analyzeSceneRenameImpact(currentProject, scene.getName());
    return {
      scene: summarizeScene(
        scene,
        currentProject.getLayoutPosition(scene.getName()),
        currentProject
      ),
      references: impact.references,
      total: impact.total,
    };
  };

  const create = ({ name, position }: any) => {
    const currentProject = requireProject();
    const sceneName = requireName(name);
    if (currentProject.hasLayoutNamed(sceneName)) {
      throw new AgentError({
        code: 'scene_name_taken',
        details: { name: sceneName },
      });
    }
    const count = currentProject.getLayoutsCount();
    const targetPosition = position == null ? count : Number(position);
    if (
      !Number.isInteger(targetPosition) ||
      targetPosition < 0 ||
      targetPosition > count
    ) {
      throw new AgentError({
        code: 'invalid_scene_order',
        details: { position, count },
      });
    }
    const scene = currentProject.insertNewLayout(sceneName, targetPosition);
    notifyMutation();
    return {
      created: true,
      scene: summarizeScene(
        scene,
        currentProject.getLayoutPosition(sceneName),
        currentProject
      ),
    };
  };

  const duplicate = ({
    name,
    sceneName,
    sceneId,
    selector,
    newName,
    position,
  }: any) => {
    const currentProject = requireProject();
    const source = resolveScene({ name: name || sceneName, sceneId, selector });
    const nextName = requireName(newName);
    if (currentProject.hasLayoutNamed(nextName)) {
      throw new AgentError({
        code: 'scene_name_taken',
        details: { name: nextName },
      });
    }

    const sourceIndex = currentProject.getLayoutPosition(source.getName());
    const count = currentProject.getLayoutsCount();
    const targetPosition =
      position == null ? Math.min(sourceIndex + 1, count) : Number(position);
    if (
      !Number.isInteger(targetPosition) ||
      targetPosition < 0 ||
      targetPosition > count
    ) {
      throw new AgentError({
        code: 'invalid_scene_order',
        details: { position, count },
      });
    }

    const serialized = serializeToJSObject(source);
    const copy = currentProject.insertNewLayout(nextName, targetPosition);
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
      source: summarizeScene(source, sourceIndex, currentProject),
      scene: summarizeScene(
        copy,
        currentProject.getLayoutPosition(nextName),
        currentProject
      ),
    };
  };

  const rename = ({ name, sceneName, sceneId, selector, newName }: any) => {
    const currentProject = requireProject();
    const scene = resolveScene({ name: name || sceneName, sceneId, selector });
    const oldName = scene.getName();
    const nextName = requireName(newName);
    const id = getSceneId(scene);
    if (nextName === oldName) {
      return {
        renamed: false,
        reason: 'same_name',
        scene: summarizeScene(
          scene,
          currentProject.getLayoutPosition(oldName),
          currentProject
        ),
      };
    }
    if (currentProject.hasLayoutNamed(nextName)) {
      throw new AgentError({
        code: 'scene_name_taken',
        details: { name: nextName },
      });
    }
    const impact = analyzeSceneRenameImpact(currentProject, oldName);
    renameLayoutInProject(currentProject, oldName, nextName);
    if (getSceneId(scene) !== id) {
      throw new AgentError({ code: 'scene_identity_changed_during_rename' });
    }
    notifyMutation();
    return {
      renamed: true,
      oldName,
      newName: nextName,
      preservedSceneId: id,
      referencesUpdated: impact.total,
      references: impact.references,
      scene: summarizeScene(
        scene,
        currentProject.getLayoutPosition(nextName),
        currentProject
      ),
    };
  };

  const reorder = ({ name, sceneName, sceneId, selector, position }: any) => {
    const currentProject = requireProject();
    const scene = resolveScene({ name: name || sceneName, sceneId, selector });
    const oldIndex = currentProject.getLayoutPosition(scene.getName());
    const newIndex = Number(position);
    const count = currentProject.getLayoutsCount();
    if (!Number.isInteger(newIndex) || newIndex < 0 || newIndex >= count) {
      throw new AgentError({
        code: 'invalid_scene_order',
        details: { position, count },
      });
    }
    if (oldIndex === newIndex) {
      return {
        reordered: false,
        reason: 'same_position',
        scene: summarizeScene(scene, oldIndex, currentProject),
      };
    }
    currentProject.moveLayout(oldIndex, newIndex);
    notifyMutation();
    return {
      reordered: true,
      oldIndex,
      newIndex,
      scene: summarizeScene(scene, newIndex, currentProject),
    };
  };

  const remove = async ({
    name,
    sceneName,
    sceneId,
    selector,
    dryRun = false,
    allowReferenced = false,
  }: any) => {
    const currentProject = requireProject();
    const scene = resolveScene({ name: name || sceneName, sceneId, selector });
    const summary = summarizeScene(
      scene,
      currentProject.getLayoutPosition(scene.getName()),
      currentProject
    );
    const impact = analyzeSceneRenameImpact(currentProject, scene.getName());
    const result = {
      dryRun: !!dryRun,
      wouldDelete: true,
      scene: summary,
      blockers: impact.references,
      blockerCount: impact.total,
    };
    if (dryRun) return result;
    if (impact.total > 0 && !allowReferenced) {
      throw new AgentError({
        code: 'scene_delete_blocked',
        retryable: true,
        details: result,
        hint:
          'Inspect project.scenes.usages. Delete or refactor the references first, or set allowReferenced=true only when broken references are intentional.',
      });
    }

    await onWillDeleteScene({ scene });
    const sceneNameToDelete = scene.getName();
    if (currentProject.getFirstLayout() === sceneNameToDelete) {
      currentProject.setFirstLayout('');
    }
    currentProject.removeLayout(sceneNameToDelete);
    notifyMutation();
    return {
      deleted: true,
      scene: summary,
      removedReferencedTarget: impact.total > 0,
      referencesAtDeletion: impact.references,
    };
  };

  return {
    list,
    get,
    usages,
    create,
    duplicate,
    rename,
    reorder,
    delete: remove,
    resolveScene,
  };
};
