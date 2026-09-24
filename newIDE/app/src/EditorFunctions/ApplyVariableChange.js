// @flow

const gd: libGDevelop = global.gd;

export class VariableMutationError extends Error {
  code: string;
  details: Object;

  constructor(code: string, message: string, details: Object = {}) {
    super(message);
    this.name = 'VariableMutationError';
    this.code = code;
    this.details = details;
  }
}

const readOrInferVariableType = (
  specifiedType: string | null,
  value: string
): string => {
  if (specifiedType) {
    const lowercaseSpecifiedType = specifiedType.toLowerCase();
    if (lowercaseSpecifiedType === 'string') {
      return 'String';
    } else if (lowercaseSpecifiedType === 'number') {
      return 'Number';
    } else if (lowercaseSpecifiedType === 'boolean') {
      return 'Boolean';
    }
  }

  if (value.toLowerCase() === 'true' || value.toLowerCase() === 'false') {
    return 'Boolean';
  }

  // An empty value must stay a string: `Number('')` is 0, which would
  // silently turn it into a number.
  if (value.trim() !== '') {
    const numberValue = Number(value);
    if (!Number.isNaN(numberValue)) {
      return 'Number';
    }
  }

  return 'String';
};

// Parse variable path to handle both dot notation and array indexing
export const parseVariablePath = (
  variablePath: string
): Array<{| type: 'property' | 'index', value: string |}> => {
  const segments = [];
  let currentSegment = '';
  let i = 0;

  while (i < variablePath.length) {
    const char = variablePath[i];

    if (char === '.') {
      // End of property segment
      if (currentSegment.trim()) {
        segments.push({ type: 'property', value: currentSegment.trim() });
        currentSegment = '';
      }
      i++;
    } else if (char === '[') {
      // Start of array index
      if (currentSegment.trim()) {
        segments.push({ type: 'property', value: currentSegment.trim() });
        currentSegment = '';
      }

      // Find the closing bracket
      i++; // Skip opening bracket
      let indexContent = '';
      let foundClosingBracketWithProperIndex = false;
      while (i < variablePath.length && variablePath[i] !== ']') {
        indexContent += variablePath[i];
        i++;
      }

      if (i < variablePath.length && variablePath[i] === ']') {
        // Valid array index
        const indexValue = indexContent.trim();
        if (indexValue && !isNaN(parseInt(indexValue, 10))) {
          segments.push({ type: 'index', value: indexValue });
          foundClosingBracketWithProperIndex = true;
        } else {
          throw new Error(
            `Content of the index is invalid ("${indexValue}") - it should be a number.`
          );
        }
        i++; // Skip closing bracket
      }

      if (!foundClosingBracketWithProperIndex) {
        throw new Error(
          'Improperly formatted array index. Please check the variable path - it should be formatted like this: `myVar[1].prop`, `myVar`, `myVar.prop`, etc...'
        );
      }
    } else {
      currentSegment += char;
      i++;
    }
  }

  // Add remaining segment
  if (currentSegment.trim()) {
    segments.push({ type: 'property', value: currentSegment.trim() });
  }

  // $FlowFixMe[incompatible-type]
  return segments;
};

const parseValueAsObjectOrArray = (value: string): Array<any> | {} | null => {
  try {
    const parsedValue = JSON.parse(value);

    if (Array.isArray(parsedValue) || typeof parsedValue === 'object') {
      return parsedValue;
    }

    // Value is a primitive, not an object or array.
    return null;
  } catch (error) {
    // Not even a JSON string (probably a primitive or a string).
    return null;
  }
};

const convertJsObjectToVariable = (value: any, variable: gdVariable) => {
  if (value === null) {
    variable.setString('null');
  } else if (value === undefined) {
    variable.setString('undefined');
  } else if (typeof value === 'number') {
    variable.setValue(value || 0);
  } else if (typeof value === 'string') {
    variable.setString(value);
  } else if (typeof value === 'boolean') {
    variable.setBool(value);
  } else if (Array.isArray(value)) {
    variable.castTo('array');
    variable.clearChildren();
    for (const item of value) {
      convertJsObjectToVariable(item, variable.pushNew());
    }
  } else if (typeof value === 'object') {
    variable.castTo('structure');
    variable.clearChildren();
    for (const [key, item] of Object.entries(value)) {
      convertJsObjectToVariable(item, variable.getChild(key));
    }
  }
};

const getParentVariableForPath = ({
  pathSegments,
  variablesContainer,
}: {|
  pathSegments: Array<{| type: 'property' | 'index', value: string |}>,
  variablesContainer: gdVariablesContainer,
|}): {| parentVariable: gdVariable | null, finalSegment: any |} => {
  const firstSegment = pathSegments[0];
  if (!firstSegment || firstSegment.type !== 'property') {
    throw new VariableMutationError(
      'invalid_variable_path',
      'Variable path must start with a property name.'
    );
  }
  if (pathSegments.length === 1) {
    return { parentVariable: null, finalSegment: firstSegment };
  }
  if (!variablesContainer.has(firstSegment.value)) {
    throw new VariableMutationError(
      'variable_not_found',
      `Variable "${firstSegment.value}" was not found.`,
      { variableName: firstSegment.value }
    );
  }

  let parentVariable = variablesContainer.get(firstSegment.value);
  for (let index = 1; index < pathSegments.length - 1; index++) {
    const segment = pathSegments[index];
    if (segment.type === 'property') {
      if (
        parentVariable.getType() !== gd.Variable.Structure ||
        !parentVariable.hasChild(segment.value)
      ) {
        throw new VariableMutationError(
          'variable_path_not_found',
          `Variable path segment "${segment.value}" was not found.`,
          { segment: segment.value }
        );
      }
      parentVariable = parentVariable.getChild(segment.value);
    } else {
      const arrayIndex = parseInt(segment.value, 10);
      if (
        parentVariable.getType() !== gd.Variable.Array ||
        arrayIndex >= parentVariable.getChildrenCount()
      ) {
        throw new VariableMutationError(
          'variable_path_not_found',
          `Variable array index ${arrayIndex} was not found.`,
          { index: arrayIndex }
        );
      }
      parentVariable = parentVariable.getAtIndex(arrayIndex);
    }
  }
  return {
    parentVariable,
    finalSegment: pathSegments[pathSegments.length - 1],
  };
};

const assertValidVariableName = (
  name: string,
  { topLevel }: {| topLevel: boolean |}
) => {
  const trimmedName = name.trim();
  if (!trimmedName) {
    throw new VariableMutationError(
      'invalid_variable_name',
      'The new variable name cannot be empty.'
    );
  }
  if (
    trimmedName.includes('.') ||
    trimmedName.includes('[') ||
    trimmedName.includes(']')
  ) {
    throw new VariableMutationError(
      'invalid_variable_name',
      'The new variable name cannot contain path separators (., [ or ]).',
      { requestedName: name }
    );
  }
  if (topLevel && gd.Project.getSafeName(trimmedName) !== trimmedName) {
    throw new VariableMutationError(
      'invalid_variable_name',
      `Top-level variable name "${trimmedName}" is not a valid GDevelop identifier.`,
      { requestedName: trimmedName }
    );
  }
  return trimmedName;
};

export const applyVariableRename = ({
  variablePath,
  newVariableName,
  variablesContainer,
}: {|
  variablePath: string,
  newVariableName: string,
  variablesContainer: gdVariablesContainer,
|}): {| renamed: boolean, oldPath: string, newPath: string |} => {
  const pathSegments = parseVariablePath(variablePath);
  if (pathSegments.length === 0) {
    throw new VariableMutationError(
      'invalid_variable_path',
      'Invalid variable path.'
    );
  }
  const { parentVariable, finalSegment } = getParentVariableForPath({
    pathSegments,
    variablesContainer,
  });
  if (finalSegment.type === 'index') {
    throw new VariableMutationError(
      'variable_rename_array_index_unsupported',
      'Array indexes cannot be renamed; rename a property or the array variable instead.',
      { variablePath }
    );
  }

  const oldName = finalSegment.value;
  const newName = assertValidVariableName(newVariableName, {
    topLevel: !parentVariable,
  });
  if (oldName === newName) {
    return { renamed: false, oldPath: variablePath, newPath: variablePath };
  }

  if (!parentVariable) {
    if (!variablesContainer.has(oldName)) {
      throw new VariableMutationError(
        'variable_not_found',
        `Variable "${oldName}" was not found.`,
        { variablePath }
      );
    }
    if (variablesContainer.has(newName)) {
      throw new VariableMutationError(
        'variable_name_conflict',
        `A variable named "${newName}" already exists.`,
        { variablePath, newVariableName: newName }
      );
    }
    if (!variablesContainer.rename(oldName, newName)) {
      throw new VariableMutationError(
        'variable_rename_failed',
        `Could not rename variable "${oldName}" to "${newName}".`,
        { variablePath, newVariableName: newName }
      );
    }
  } else {
    if (
      parentVariable.getType() !== gd.Variable.Structure ||
      !parentVariable.hasChild(oldName)
    ) {
      throw new VariableMutationError(
        'variable_not_found',
        `Variable "${variablePath}" was not found.`,
        { variablePath }
      );
    }
    if (parentVariable.hasChild(newName)) {
      throw new VariableMutationError(
        'variable_name_conflict',
        `A sibling variable named "${newName}" already exists.`,
        { variablePath, newVariableName: newName }
      );
    }
    parentVariable.renameChild(oldName, newName);
  }

  const prefixSegments = pathSegments.slice(0, -1);
  const prefix = prefixSegments
    .map((segment, index) =>
      segment.type === 'index'
        ? `[${segment.value}]`
        : `${index === 0 ? '' : '.'}${segment.value}`
    )
    .join('');
  const newPath = prefix ? `${prefix}.${newName}` : newName;
  return { renamed: true, oldPath: variablePath, newPath };
};

export const applyVariableReorder = ({
  variablePath,
  variablesContainer,
  moveBeforeVariable,
  moveAfterVariable,
  moveToIndex,
}: {|
  variablePath: string,
  variablesContainer: gdVariablesContainer,
  moveBeforeVariable?: string | null,
  moveAfterVariable?: string | null,
  moveToIndex?: number | null,
|}): {| moved: boolean, fromIndex: number, toIndex: number |} => {
  const pathSegments = parseVariablePath(variablePath);
  if (
    pathSegments.length !== 1 ||
    !pathSegments[0] ||
    pathSegments[0].type !== 'property'
  ) {
    throw new VariableMutationError(
      'variable_reorder_nested_unsupported',
      'Reordering is supported only for top-level variable declarations.',
      { variablePath }
    );
  }
  const variableName = pathSegments[0].value;
  if (!variablesContainer.has(variableName)) {
    throw new VariableMutationError(
      'variable_not_found',
      `Variable "${variableName}" was not found.`,
      { variablePath }
    );
  }

  const positioningModes = [
    !!moveBeforeVariable,
    !!moveAfterVariable,
    moveToIndex !== null && moveToIndex !== undefined,
  ].filter(Boolean).length;
  if (positioningModes !== 1) {
    throw new VariableMutationError(
      'variable_reorder_position_conflict',
      'Specify exactly one of move_before_variable, move_after_variable or move_to_index.',
      { variablePath }
    );
  }

  const fromIndex = variablesContainer.getPosition(variableName);
  let toIndex = fromIndex;
  if (moveToIndex !== null && moveToIndex !== undefined) {
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
    const targetName = (moveBeforeVariable || moveAfterVariable || '').trim();
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
      (moveAfterVariable ? 1 : 0);
  }

  if (fromIndex === toIndex) return { moved: false, fromIndex, toIndex };
  variablesContainer.move(fromIndex, toIndex);
  return { moved: true, fromIndex, toIndex };
};

export const applyVariableChange = ({
  variablePath,
  forcedVariableType,
  variablesContainer,
  value,
}: {|
  variablePath: string,
  forcedVariableType: string | null,
  variablesContainer: gd.VariablesContainer,
  value: string,
|}): {
  addedNewVariable: boolean,
  variable: null | gdVariable,
  variableType: string,
} => {
  const pathSegments = parseVariablePath(variablePath);

  if (pathSegments.length === 0) {
    throw new Error('Invalid variable path');
  }

  // Analyze the value upfront, so that an invalid one is rejected before any
  // variable (or intermediate parent) is created.
  // An explicitly requested primitive type wins over JSON parsing: without
  // this, a JSON-looking value could never be stored as a literal string.
  const lowercaseForcedType = forcedVariableType
    ? forcedVariableType.toLowerCase()
    : null;
  const isForcedPrimitiveType =
    lowercaseForcedType === 'string' ||
    lowercaseForcedType === 'number' ||
    lowercaseForcedType === 'boolean';
  const arrayOrObjectValue = isForcedPrimitiveType
    ? null
    : parseValueAsObjectOrArray(value);
  let primitiveVariableType = null;
  let numberValue = 0;
  if (!arrayOrObjectValue) {
    primitiveVariableType = readOrInferVariableType(forcedVariableType, value);
    if (primitiveVariableType === 'Number') {
      // `Number` (not `parseFloat`) so the stored value always matches the
      // type inference, and garbage is caught instead of storing NaN.
      numberValue = value.trim() === '' ? NaN : Number(value);
      if (Number.isNaN(numberValue)) {
        throw new Error(
          `Value "${value}" is not a valid number for variable path "${variablePath}". Use a numeric value, or set \`variable_type\` to "string".`
        );
      }
    }
  }

  let addedNewVariable = false;
  const firstSegment = pathSegments[0];

  if (firstSegment.type !== 'property') {
    throw new Error('Variable path must start with a property name');
  }

  const firstVariableName = firstSegment.value;
  let variable = null;
  if (!variablesContainer.has(firstVariableName)) {
    variable = variablesContainer.insertNew(firstVariableName, 0);
    addedNewVariable = true;
  } else {
    variable = variablesContainer.get(firstVariableName);
  }

  for (let i = 1; i < pathSegments.length; i++) {
    const segment = pathSegments[i];

    if (segment.type === 'property') {
      // Navigate to structure property. Only cast if not already a Structure:
      // castTo always clears children, even when the type already matches.
      // $FlowFixMe[incompatible-use]
      if (variable.getType() !== gd.Variable.Structure) {
        // $FlowFixMe[incompatible-use]
        variable.castTo('structure');
      }
      // $FlowFixMe[incompatible-use]
      if (!variable.hasChild(segment.value)) {
        addedNewVariable = true;
      }
      // $FlowFixMe[incompatible-use]
      variable = variable.getChild(segment.value);
    } else if (segment.type === 'index') {
      // Navigate to array element. Only cast if not already an Array:
      // castTo always clears children, even when the type already matches.
      const index = parseInt(segment.value, 10);
      // $FlowFixMe[incompatible-use]
      if (variable.getType() !== gd.Variable.Array) {
        // $FlowFixMe[incompatible-use]
        variable.castTo('array');
      }

      // Ensure array has enough elements
      // $FlowFixMe[incompatible-use]
      while (variable.getChildrenCount() <= index) {
        // $FlowFixMe[incompatible-use]
        variable.pushNew();
        addedNewVariable = true;
      }

      // $FlowFixMe[incompatible-use]
      variable = variable.getAtIndex(index);
    }
  }

  if (arrayOrObjectValue) {
    // Value is an object or array.
    // $FlowFixMe[incompatible-type]
    convertJsObjectToVariable(arrayOrObjectValue, variable);

    return {
      variable,
      variableType:
        // $FlowFixMe[incompatible-use]
        variable.getType() === gd.Variable.Array ? 'Array' : 'Structure',
      addedNewVariable,
    };
  } else {
    // Value is a primitive, or not a valid Object/Array in JSON:

    const variableType =
      primitiveVariableType ||
      readOrInferVariableType(forcedVariableType, value);

    if (variableType === 'String') {
      // $FlowFixMe[incompatible-use]
      variable.setString(value);
    } else if (variableType === 'Number') {
      // $FlowFixMe[incompatible-use]
      variable.setValue(numberValue);
    } else if (variableType === 'Boolean') {
      // $FlowFixMe[incompatible-use]
      variable.setBool(value.toLowerCase() === 'true');
    }

    return {
      variable,
      variableType,
      addedNewVariable,
    };
  }
};

export const applyVariableDeletion = ({
  variablePath,
  variablesContainer,
}: {|
  variablePath: string,
  variablesContainer: gd.VariablesContainer,
|}): {| removed: boolean |} => {
  const pathSegments = parseVariablePath(variablePath);

  if (pathSegments.length === 0) {
    throw new Error('Invalid variable path');
  }

  const firstSegment = pathSegments[0];
  if (firstSegment.type !== 'property') {
    throw new Error('Variable path must start with a property name');
  }

  // Top-level variable: remove it from the container.
  if (pathSegments.length === 1) {
    if (!variablesContainer.has(firstSegment.value)) {
      return { removed: false };
    }
    variablesContainer.remove(firstSegment.value);
    return { removed: true };
  }

  // Nested variable: navigate to its direct parent, then remove the last segment.
  if (!variablesContainer.has(firstSegment.value)) {
    return { removed: false };
  }
  let parentVariable = variablesContainer.get(firstSegment.value);

  for (let i = 1; i < pathSegments.length - 1; i++) {
    const segment = pathSegments[i];
    if (segment.type === 'property') {
      if (
        parentVariable.getType() !== gd.Variable.Structure ||
        !parentVariable.hasChild(segment.value)
      ) {
        return { removed: false };
      }
      parentVariable = parentVariable.getChild(segment.value);
    } else {
      const index = parseInt(segment.value, 10);
      if (
        parentVariable.getType() !== gd.Variable.Array ||
        index >= parentVariable.getChildrenCount()
      ) {
        return { removed: false };
      }
      parentVariable = parentVariable.getAtIndex(index);
    }
  }

  const lastSegment = pathSegments[pathSegments.length - 1];
  if (lastSegment.type === 'index') {
    const index = parseInt(lastSegment.value, 10);
    if (
      parentVariable.getType() !== gd.Variable.Array ||
      index >= parentVariable.getChildrenCount()
    ) {
      return { removed: false };
    }
    parentVariable.removeAtIndex(index);
    return { removed: true };
  }

  if (
    parentVariable.getType() !== gd.Variable.Structure ||
    !parentVariable.hasChild(lastSegment.value)
  ) {
    return { removed: false };
  }
  parentVariable.removeChild(lastSegment.value);
  return { removed: true };
};

export const getVariableAtPath = ({
  variablePath,
  variablesContainer,
}: {|
  variablePath: string,
  variablesContainer: gd.VariablesContainer,
|}): gdVariable | null => {
  const pathSegments = parseVariablePath(variablePath);

  if (pathSegments.length === 0) {
    throw new Error('Invalid variable path');
  }

  const firstSegment = pathSegments[0];
  if (firstSegment.type !== 'property') {
    throw new Error('Variable path must start with a property name');
  }

  if (!variablesContainer.has(firstSegment.value)) {
    return null;
  }
  let variable = variablesContainer.get(firstSegment.value);

  for (let i = 1; i < pathSegments.length; i++) {
    const segment = pathSegments[i];
    if (segment.type === 'property') {
      if (
        variable.getType() !== gd.Variable.Structure ||
        !variable.hasChild(segment.value)
      ) {
        return null;
      }
      variable = variable.getChild(segment.value);
    } else {
      const index = parseInt(segment.value, 10);
      if (
        variable.getType() !== gd.Variable.Array ||
        index >= variable.getChildrenCount()
      ) {
        return null;
      }
      variable = variable.getAtIndex(index);
    }
  }

  return variable;
};
