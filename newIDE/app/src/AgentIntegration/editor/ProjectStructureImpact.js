// @flow
import {
  serializeToJSObject,
  unserializeFromJSObject,
} from '../../Utils/Serializer';

const gd: libGDevelop = global.gd;

type Change = {|
  path: string,
  before: any,
  after: any,
  kind: string,
|};

const pathToString = (segments: Array<string | number>): string =>
  segments.reduce(
    (path, segment) =>
      typeof segment === 'number'
        ? `${path}[${segment}]`
        : path
        ? `${path}.${segment}`
        : String(segment),
    ''
  );

const classifyReference = (path: string): string => {
  if (path === 'firstLayout') return 'project-first-scene';
  if (/previewLayout/i.test(path)) return 'project-preview-scene';
  if (/externalEvents\[\d+\]\.associatedLayout$/.test(path)) {
    return 'external-events-associated-scene';
  }
  if (/externalLayouts\[\d+\]\.associatedLayout$/.test(path)) {
    return 'external-layout-associated-scene';
  }
  if (/\.events(?:\[|\.)/.test(path)) return 'event-reference';
  return 'project-reference';
};

const collectDiff = (
  before: any,
  after: any,
  segments: Array<string | number> = [],
  changes: Array<Change> = []
): Array<Change> => {
  if (before === after) return changes;
  const beforeObject = before && typeof before === 'object';
  const afterObject = after && typeof after === 'object';
  if (!beforeObject || !afterObject) {
    const path = pathToString(segments);
    changes.push({
      path,
      before,
      after,
      kind: classifyReference(path),
    });
    return changes;
  }

  if (Array.isArray(before) || Array.isArray(after)) {
    const beforeArray = Array.isArray(before) ? before : [];
    const afterArray = Array.isArray(after) ? after : [];
    const count = Math.max(beforeArray.length, afterArray.length);
    for (let index = 0; index < count; index++) {
      collectDiff(
        beforeArray[index],
        afterArray[index],
        [...segments, index],
        changes
      );
    }
    return changes;
  }

  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  keys.forEach(key =>
    collectDiff(before[key], after[key], [...segments, key], changes)
  );
  return changes;
};

const makeSentinel = (
  project: gdProject,
  base: string,
  hasName: string => boolean
): string => {
  let suffix = 0;
  let candidate = base;
  while (hasName(candidate)) {
    suffix++;
    candidate = `${base}_${suffix}`;
  }
  return candidate;
};

const cloneProject = (
  project: gdProject
): {| clone: gdProject, serialized: any |} => {
  const serialized = serializeToJSObject(project);
  // $FlowFixMe[invalid-constructor]
  const clone = new gd.ProjectHelper.createNewGDJSProject();
  unserializeFromJSObject(clone, serialized);
  return { clone, serialized };
};

const onlyRefactorChanges = (
  changes: Array<Change>,
  oldName: string,
  newName: string,
  definitionMatcher: string => boolean
): Array<Change> =>
  changes.filter(change => {
    if (definitionMatcher(change.path)) return false;
    return change.before === oldName && change.after === newName;
  });

export const analyzeSceneRenameImpact = (
  project: gdProject,
  sceneName: string
): {| references: Array<Change>, total: number |} => {
  const { clone, serialized } = cloneProject(project);
  try {
    if (!clone.hasLayoutNamed(sceneName)) {
      return { references: [], total: 0 };
    }
    const sentinel = makeSentinel(clone, '__GDevelopAgentSceneTarget__', name =>
      clone.hasLayoutNamed(name)
    );
    const wasFirstLayout = clone.getFirstLayout() === sceneName;
    const wasPreviewLayout = clone.getPreviewLayout() === sceneName;
    clone.getLayout(sceneName).setName(sentinel);
    gd.WholeProjectRefactorer.renameLayout(clone, sceneName, sentinel);
    if (wasFirstLayout) clone.setFirstLayout(sentinel);
    if (wasPreviewLayout) clone.setPreviewLayout(sentinel);
    const after = serializeToJSObject(clone);
    const references = onlyRefactorChanges(
      collectDiff(serialized, after),
      sceneName,
      sentinel,
      path => /^layouts\[\d+\]\.name$/.test(path)
    );
    return { references, total: references.length };
  } finally {
    clone.delete();
  }
};

export const analyzeExternalEventsRenameImpact = (
  project: gdProject,
  externalEventsName: string
): {| references: Array<Change>, total: number |} => {
  const { clone, serialized } = cloneProject(project);
  try {
    if (!clone.hasExternalEventsNamed(externalEventsName)) {
      return { references: [], total: 0 };
    }
    const sentinel = makeSentinel(
      clone,
      '__GDevelopAgentExternalEventsTarget__',
      name => clone.hasExternalEventsNamed(name)
    );
    clone.getExternalEvents(externalEventsName).setName(sentinel);
    gd.WholeProjectRefactorer.renameExternalEvents(
      clone,
      externalEventsName,
      sentinel
    );
    const after = serializeToJSObject(clone);
    const references = onlyRefactorChanges(
      collectDiff(serialized, after),
      externalEventsName,
      sentinel,
      path => /^externalEvents\[\d+\]\.name$/.test(path)
    );
    return { references, total: references.length };
  } finally {
    clone.delete();
  }
};

export { collectDiff, pathToString };
