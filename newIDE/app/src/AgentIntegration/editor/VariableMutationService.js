// @flow

const gd: libGDevelop = global.gd;

type OperationError = {|
  code: string,
  message: string,
  variablePath?: string,
  details?: Object,
|};

type MutationResult = {|
  output: {|
    success: boolean,
    message: string,
    operationErrors?: Array<OperationError>,
  |},
  didModifyProject: boolean,
|};

class VariableMutationError extends Error {
  code: string;
  details: Object;

  constructor(code: string, message: string, details: Object = {}) {
    super(message);
    this.name = 'VariableMutationError';
    this.code = code;
    this.details = details;
  }
}

const asString = value => (typeof value === 'string' ? value : null);
const asNumber = value => (typeof value === 'number' ? value : null);
const asBoolean = value => (typeof value === 'boolean' ? value : false);

const extractOperations = (args: any): Array<any> => {
  const values = Array.isArray(args && args.variables)
    ? args.variables
    : [args || {}];
  return values.map(value => ({
    variableNameOrPath: asString(value.variable_name_or_path),
    value: asString(value.value),
    variableType: asString(value.variable_type),
    deleteThisVariable: asBoolean(value.delete_this_variable),
    newVariableName: asString(value.new_variable_name),
    moveBeforeVariable: asString(value.move_before_variable),
    moveAfterVariable: asString(value.move_after_variable),
    moveToIndex: asNumber(value.move_to_index),
  }));
};

const operationHasRenameOrReorder = operation =>
  !!(
    (operation.newVariableName && operation.newVariableName.trim()) ||
    (operation.moveBeforeVariable && operation.moveBeforeVariable.trim()) ||
    (operation.moveAfterVariable && operation.moveAfterVariable.trim()) ||
    operation.moveToIndex !== null
  );

export const hasVariableRenameOrReorder = (args: any): boolean =>
  extractOperations(args).some(operationHasRenameOrReorder);

const parseVariablePath = (
  variablePath: string
): Array<{| type: 'property' | 'index', value: string |}> => {
  const segments = [];
  let currentSegment = '';
  let index = 0;
  while (index < variablePath.length) {
    const character = variablePath[index];
    if (character === '.') {
      if (currentSegment.trim()) {
        segments.push({ type: 'property', value: currentSegment.trim() });
        currentSegment = '';
      }
      index++;
      continue;
    }
    if (character === '[') {
      if (currentSegment.trim()) {
        segments.push({ type: 'property', value: currentSegment.trim() });
        currentSegment = '';
      }
      index++;
      let indexContent = '';
      while (index < variablePath.length && variablePath[index] !== ']') {
        indexContent += variablePath[index++];
      }
      if (index >= variablePath.length || variablePath[index] !== ']') {
        throw new VariableMutationError(
          'invalid_variable_path',
          'Improperly formatted array index.'
        );
      }
      const trimmed = indexContent.trim();
      if (!/^\\d+$/.test(trimmed)) {
        throw new VariableMutationError(
          'invalid_variable_path',
          `Array index "${trimmed}" must be a non-negative integer.`
        );
      }
      segments.push({ type: 'index', value: trimmed });
      index++;
      continue;
    }
    currentSegment += character;
    index++;
  }
  if (currentSegment.trim()) {
    segments.push({ type: 'property', value: currentSegment.trim() });
  }
  if (!segments.length || segments[0].type !== 'property') {
    throw new VariableMutationError(
      'invalid_variable_path',
      'Variable path must start with a property name.'
    );
  }
  return segments;
};

const getParentForPath = ({
  variablesContainer,
  pathSegments,
}: {|
  variablesContainer: gdVariablesContainer,
  pathSegments: Array<{| type: 'property' | 'index', value: string |}>,
|}) => {
  if (pathSegments.length === 1) {
    return { parent: null, finalSegment: pathSegments[0] };
  }
  const root = pathSegments[0].value;
  if (!variablesContainer.has(root)) {
    throw new VariableMutationError(
      'variable_not_found',
      `Variable "${root}" was not found.`,
      { variableName: root }
    );
  }
  let parent = variablesContainer.get(root);
  for (let index = 1; index < pathSegments.length - 1; index++) {
    const segment = pathSegments[index];
    if (segment.type === 'property') {
      if (
        parent.getType() !== gd.Variable.Structure ||
        !parent.hasChild(segment.value)
      ) {
        throw new VariableMutationError(
          'variable_path_not_found',
          `Variable path segment "${segment.value}" was not found.`
        );
      }
      parent = parent.getChild(segment.value);
    } else {
      const arrayIndex = parseInt(segment.value, 10);
      if (
        parent.getType() !== gd.Variable.Array ||
        arrayIndex >= parent.getChildrenCount()
      ) {
        throw new VariableMutationError(
          'variable_path_not_found',
          `Variable array index ${arrayIndex} was not found.`
        );
      }
      parent = parent.getAtIndex(arrayIndex);
    }
  }
  return {
    parent,
    finalSegment: pathSegments[pathSegments.length - 1],
  };
};

const validateNewName = (name: string, topLevel: boolean): string => {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new VariableMutationError(
      'invalid_variable_name',
      'The new variable name cannot be empty.'
    );
  }
  if (trimmed.includes('.') || trimmed.includes('[') || trimmed.includes(']')) {
    throw new VariableMutationError(
      'invalid_variable_name',
      'The new variable name cannot contain path separators (., [ or ]).',
      { requestedName: name }
    );
  }
  if (topLevel && gd.Project.getSafeName(trimmed) !== trimmed) {
    throw new VariableMutationError(
      'invalid_variable_name',
      `Top-level variable name "${trimmed}" is not a valid GDevelop identifier.`,
      { requestedName: trimmed }
    );
  }
  return trimmed;
};

const renameVariable = ({
  variablesContainer,
  variablePath,
  newVariableName,
}: {|
  variablesContainer: gdVariablesContainer,
  variablePath: string,
  newVariableName: string,
|}) => {
  const pathSegments = parseVariablePath(variablePath);
  const { parent, finalSegment } = getParentForPath({
    variablesContainer,
    pathSegments,
  });
  if (finalSegment.type === 'index') {
    throw new VariableMutationError(
      'variable_rename_array_index_unsupported',
      'Array indexes cannot be renamed; rename a property or the array variable instead.',
      { variablePath }
    );
  }
  const oldName = finalSegment.value;
  const nextName = validateNewName(newVariableName, !parent);
  if (oldName === nextName) {
    return { renamed: false, newPath: variablePath };
  }

  if (!parent) {
    if (!variablesContainer.has(oldName)) {
      throw new VariableMutationError(
        'variable_not_found',
        `Variable "${oldName}" was not found.`,
        { variablePath }
      );
    }
    if (variablesContainer.has(nextName)) {
      throw new VariableMutationError(
        'variable_name_conflict',
        `A variable named "${nextName}" already exists.`,
        { variablePath, newVariableName: nextName }
      );
    }
    if (!variablesContainer.rename(oldName, nextName)) {
      throw new VariableMutationError(
        'variable_rename_failed',
        `Could not rename variable "${oldName}" to "${nextName}".`
      );
    }
  } else {
    if (
      parent.getType() !== gd.Variable.Structure ||
      !parent.hasChild(oldName)
    ) {
      throw new VariableMutationError(
        'variable_not_found',
        `Variable "${variablePath}" was not found.`,
        { variablePath }
      );
    }
    if (parent.hasChild(nextName)) {
      throw new VariableMutationError(
        'variable_name_conflict',
        `A sibling variable named "${nextName}" already exists.`,
        { variablePath, newVariableName: nextName }
      );
    }
    parent.renameChild(oldName, nextName);
  }

  const prefix = pathSegments
    .slice(0, -1)
    .map((segment, index) =>
      segment.type === 'index'
        ? `[${segment.value}]`
        : `${index === 0 ? '' : '.'}${segment.value}`
    )
    .join('');
  return {
    renamed: true,
    newPath: prefix ? `${prefix}.${nextName}` : nextName,
  };
};

const reorderVariable = ({
  variablesContainer,
  variablePath,
  moveBeforeVariable,
  moveAfterVariable,
  moveToIndex,
}: {|
  variablesContainer: gdVariablesContainer,
  variablePath: string,
  moveBeforeVariable: ?string,
  moveAfterVariable: ?string,
  moveToIndex: ?number,
|}) => {
  const segments = parseVariablePath(variablePath);
  if (segments.length !== 1 || segments[0].type !== 'property') {
    throw new VariableMutationError(
      'variable_reorder_nested_unsupported',
      'Reordering is supported only for top-level variable declarations.',
      { variablePath }
    );
  }
  const variableName = segments[0].value;
  if (!variablesContainer.has(variableName)) {
    throw new VariableMutationError(
      'variable_not_found',
      `Variable "${variableName}" was not found.`,
      { variablePath }
    );
  }

  const before = moveBeforeVariable ? moveBeforeVariable.trim() : '';
  const after = moveAfterVariable ? moveAfterVariable.trim() : '';
  const modes = [!!before, !!after, moveToIndex !== null].filter(Boolean)
    .length;
  if (modes !== 1) {
    throw new VariableMutationError(
      'variable_reorder_position_conflict',
      'Specify exactly one of move_before_variable, move_after_variable or move_to_index.',
      { variablePath }
    );
  }

  const fromIndex = variablesContainer.getPosition(variableName);
  let toIndex = fromIndex;
  if (moveToIndex !== null) {
    if (
      !Number.isInteger(moveToIndex) ||
      moveToIndex < 0 ||
      moveToIndex >= variablesContainer.count()
    ) {
      throw new VariableMutationError(
        'variable_reorder_index_out_of_range',
        `move_to_index must be between 0 and ${Math.max(
          0,
          variablesContainer.count() - 1
        )}.`,
        { variablePath, moveToIndex, variableCount: variablesContainer.count() }
      );
    }
    toIndex = moveToIndex;
  } else {
    const targetName = before || after;
    if (!variablesContainer.has(targetName)) {
      throw new VariableMutationError(
        'variable_reorder_target_not_found',
        `Reorder target variable "${targetName}" was not found.`,
        { variablePath, targetName }
      );
    }
    if (targetName === variableName) {
      throw new VariableMutationError(
        'variable_reorder_self_target',
        'A variable cannot be moved before or after itself.',
        { variablePath, targetName }
      );
    }
    const targetIndex = variablesContainer.getPosition(targetName);
    toIndex =
      (targetIndex > fromIndex ? targetIndex - 1 : targetIndex) +
      (after ? 1 : 0);
  }

  if (fromIndex === toIndex) {
    return { moved: false, fromIndex, toIndex };
  }
  variablesContainer.move(fromIndex, toIndex);
  return { moved: true, fromIndex, toIndex };
};

const findInstances = ({
  layout,
  objectName,
  instanceId,
}: {|
  layout: gdLayout,
  objectName: ?string,
  instanceId: string,
|}): Array<gdInitialInstance> => {
  const matches = [];
  const functor = new gd.InitialInstanceJSFunctor();
  // $FlowFixMe[cannot-write]
  functor.invoke = instancePtr => {
    // $FlowFixMe[incompatible-type]
    const instance: gdInitialInstance = gd.wrapPointer(
      instancePtr,
      gd.InitialInstance
    );
    if (objectName && instance.getObjectName() !== objectName) return;
    if (
      !instance
        .getPersistentUuid()
        .toLowerCase()
        .startsWith(instanceId.toLowerCase())
    ) {
      return;
    }
    matches.push(instance);
  };
  layout.getInitialInstances().iterateOverInstances(functor);
  functor.delete();
  return matches;
};

const resolveTarget = ({
  project,
  args,
}: {|
  project: gdProject,
  args: any,
|}) => {
  if (args && args.scope && args.scope.type && args.scope.type !== 'project') {
    throw new VariableMutationError(
      'variable_rename_reorder_scope_unsupported',
      'Rename/reorder currently supports project scene/object/instance declarations only.',
      { scope: args.scope.type }
    );
  }
  const variableScope = asString(args.variable_scope) || '';
  if (variableScope === 'global') {
    return {
      variablesContainer: project.getVariables(),
      layout: null,
      objectName: null,
      scopeLabel: 'global',
    };
  }
  const sceneName = (asString(args.scene_name) || '').trim();
  if (!sceneName || !project.hasLayoutNamed(sceneName)) {
    throw new VariableMutationError(
      'scene_not_found',
      `Scene "${sceneName}" was not found.`,
      { sceneName }
    );
  }
  const layout = project.getLayout(sceneName);
  if (variableScope === 'scene') {
    return {
      variablesContainer: layout.getVariables(),
      layout: null,
      objectName: null,
      scopeLabel: `scene "${sceneName}"`,
    };
  }
  if (variableScope === 'group') {
    throw new VariableMutationError(
      'group_variable_reorder_rename_unsupported',
      'Rename/reorder of group variables is not supported; use a concrete object declaration.',
      { objectName: asString(args.object_name) }
    );
  }

  if (variableScope === 'object') {
    const objectName = (asString(args.object_name) || '').trim();
    if (!objectName || !layout.getObjects().hasObjectNamed(objectName)) {
      throw new VariableMutationError(
        'object_variable_owner_not_found',
        `Concrete scene object "${objectName}" was not found in scene "${sceneName}".`,
        { sceneName, objectName }
      );
    }
    const object = layout.getObjects().getObject(objectName);
    return {
      variablesContainer: object.getVariables(),
      layout,
      objectName,
      scopeLabel: `scene "${sceneName}" object "${objectName}"`,
    };
  }

  if (variableScope === 'instance') {
    const instanceId = (asString(args.instance_id) || '').trim();
    if (!instanceId) {
      throw new VariableMutationError(
        'missing_instance_id',
        'instance_id is required for instance-scope rename/reorder.'
      );
    }
    const requestedObjectName = asString(args.object_name);
    const matches = findInstances({
      layout,
      objectName: requestedObjectName,
      instanceId,
    });
    if (matches.length !== 1) {
      throw new VariableMutationError(
        'instance_variable_owner_ambiguous',
        'instance_id must resolve to exactly one instance.',
        { instanceId, matchCount: matches.length }
      );
    }
    const objectName = matches[0].getObjectName();
    if (!layout.getObjects().hasObjectNamed(objectName)) {
      throw new VariableMutationError(
        'instance_variable_global_object_unsupported',
        'Rename/reorder through instance scope currently requires a scene-owned object.',
        { sceneName, objectName }
      );
    }
    const object = layout.getObjects().getObject(objectName);
    return {
      variablesContainer: object.getVariables(),
      layout,
      objectName,
      scopeLabel: `instance of "${objectName}" in scene "${sceneName}"`,
    };
  }

  throw new VariableMutationError(
    'invalid_variable_scope',
    `Invalid variable_scope "${variableScope}" for rename/reorder.`,
    { variableScope }
  );
};

const mutateWithRefactoring = ({
  project,
  variablesContainer,
  layout,
  objectName,
  mutation,
}: {|
  project: gdProject,
  variablesContainer: gdVariablesContainer,
  layout: ?gdLayout,
  objectName: ?string,
  mutation: () => any,
|}) => {
  variablesContainer.ensurePersistentUuids();
  const snapshot = new gd.SerializerElement();
  variablesContainer.serializeTo(snapshot);
  try {
    const result = mutation();
    const changed =
      result &&
      ((Object.prototype.hasOwnProperty.call(result, 'renamed') &&
        result.renamed) ||
        (Object.prototype.hasOwnProperty.call(result, 'moved') &&
          result.moved));
    if (!changed) return result;
    const changeset = gd.WholeProjectRefactorer.computeChangesetForVariablesContainer(
      snapshot,
      variablesContainer
    );
    if (layout && objectName) {
      gd.WholeProjectRefactorer.applyRefactoringForObjectVariablesContainer(
        project,
        variablesContainer,
        layout.getInitialInstances(),
        objectName,
        changeset,
        snapshot
      );
    } else {
      gd.WholeProjectRefactorer.applyRefactoringForVariablesContainer(
        project,
        variablesContainer,
        changeset,
        snapshot
      );
    }
    return result;
  } finally {
    snapshot.delete();
  }
};

const toOperationError = (
  error: any,
  variablePath: ?string
): OperationError => ({
  code:
    error instanceof VariableMutationError
      ? error.code
      : 'variable_operation_failed',
  message: error && error.message ? error.message : String(error),
  ...(variablePath ? { variablePath } : {}),
  ...(error instanceof VariableMutationError && error.details
    ? { details: error.details }
    : {}),
});

export const runVariableRenameOrReorder = ({
  project,
  args,
}: {|
  project: gdProject,
  args: any,
|}): MutationResult => {
  const operations = extractOperations(args);
  const errors = [];
  const changes = [];
  let didModifyProject = false;

  if (!operations.length) {
    return {
      output: {
        success: false,
        message: 'No variable operation was provided.',
        operationErrors: [
          {
            code: 'variable_operation_missing',
            message: 'No variable operation was provided.',
          },
        ],
      },
      didModifyProject: false,
    };
  }

  for (const operation of operations) {
    const variablePath = operation.variableNameOrPath;
    if (!variablePath) {
      errors.push({
        code: 'missing_variable_path',
        message: 'variable_name_or_path is required.',
      });
      continue;
    }
    if (!operationHasRenameOrReorder(operation)) {
      errors.push({
        code: 'variable_mutation_batch_mixed_modes_unsupported',
        message:
          'A rename/reorder call cannot include create/update/delete-only operations; send those in a separate add_or_edit_variable call.',
        variablePath,
      });
      continue;
    }
    if (
      operation.value !== null ||
      operation.variableType !== null ||
      operation.deleteThisVariable
    ) {
      errors.push({
        code: 'variable_mutation_mixed_mode_unsupported',
        message:
          'Rename/reorder cannot be combined with value/type/delete fields in the same operation; apply the value update separately.',
        variablePath,
      });
      continue;
    }

    try {
      const target = resolveTarget({ project, args });
      let effectivePath = variablePath;
      const requestedRename =
        operation.newVariableName && operation.newVariableName.trim();
      if (requestedRename) {
        const result = mutateWithRefactoring({
          project,
          variablesContainer: target.variablesContainer,
          layout: target.layout,
          objectName: target.objectName,
          mutation: () =>
            renameVariable({
              variablesContainer: target.variablesContainer,
              variablePath: effectivePath,
              newVariableName: operation.newVariableName || '',
            }),
        });
        if (result.renamed) {
          changes.push(
            `Renamed ${target.scopeLabel} variable "${effectivePath}" to "${
              result.newPath
            }" (references updated).`
          );
          effectivePath = result.newPath;
          didModifyProject = true;
        } else {
          changes.push(
            `${
              target.scopeLabel
            } variable "${effectivePath}" already has the requested name.`
          );
        }
      }

      const hasReorder =
        !!(
          operation.moveBeforeVariable && operation.moveBeforeVariable.trim()
        ) ||
        !!(operation.moveAfterVariable && operation.moveAfterVariable.trim()) ||
        operation.moveToIndex !== null;
      if (hasReorder) {
        const result = reorderVariable({
          variablesContainer: target.variablesContainer,
          variablePath: effectivePath,
          moveBeforeVariable: operation.moveBeforeVariable,
          moveAfterVariable: operation.moveAfterVariable,
          moveToIndex: operation.moveToIndex,
        });
        if (result.moved) {
          changes.push(
            `Moved ${
              target.scopeLabel
            } variable "${effectivePath}" from index ${result.fromIndex} to ${
              result.toIndex
            }.`
          );
          didModifyProject = true;
        } else {
          changes.push(
            `${
              target.scopeLabel
            } variable "${effectivePath}" is already at index ${
              result.toIndex
            }.`
          );
        }
      }
    } catch (error) {
      errors.push(toOperationError(error, variablePath));
    }
  }

  const message = [
    ...changes,
    ...errors.map(error => `[${error.code}] ${error.message}`),
  ].join('\n');
  return {
    output: {
      success: changes.length > 0 && errors.length === 0,
      message: message || 'No variable was changed.',
      ...(errors.length ? { operationErrors: errors } : {}),
    },
    didModifyProject,
  };
};
