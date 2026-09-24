// @flow
import { editorFunctions, type EditorFunctionGenericOutput } from './index';
import { makeFakeLaunchFunctionOptionsWithProject } from './TestHelpers';

const gd: libGDevelop = global.gd;

describe('add_or_edit_variable', () => {
  let project: gdProject;

  beforeEach(() => {
    // $FlowFixMe[invalid-constructor]
    project = new gd.ProjectHelper.createNewGDJSProject();
    project.insertNewLayout('TestScene', 0);
  });

  afterEach(() => {
    project.delete();
  });

  const addVariableReferenceAction = ({
    scene,
    type,
    parameters,
  }: {|
    scene: gdLayout,
    type: string,
    parameters: Array<string>,
  |}) => {
    const event = new gd.StandardEvent();
    const action = new gd.Instruction();
    action.setType(type);
    action.setParametersCount(parameters.length);
    parameters.forEach((parameter, index) =>
      action.setParameter(index, parameter)
    );
    event.getActions().insert(action, 0);
    scene.getEvents().insertEvent(event, 0);
    action.delete();
    event.delete();
    return gd
      .asStandardEvent(scene.getEvents().getEventAt(0))
      .getActions()
      .get(0);
  };

  it('renames a global variable with references and reorders declarations without value/type loss', async () => {
    const variables = project.getVariables();
    variables.insertNew('PublicA', 0).setString('alpha');
    variables.insertNew('__Internal', 1).setValue(7);
    variables.insertNew('PublicB', 2).setBool(true);
    variables.ensurePersistentUuids();
    const uuid = variables.get('PublicA').getPersistentUuid();
    const action = addVariableReferenceAction({
      scene: project.getLayout('TestScene'),
      type: 'SetNumberVariable',
      parameters: ['PublicA', '=', '123'],
    });

    const rename: EditorFunctionGenericOutput = await editorFunctions.add_or_edit_variable.launchFunction(
      {
        ...makeFakeLaunchFunctionOptionsWithProject(project),
        args: {
          variable_scope: 'global',
          variables: [
            {
              variable_name_or_path: 'PublicA',
              new_variable_name: 'DisplayName',
            },
          ],
        },
      }
    );

    expect(rename.success).toBe(true);
    expect(rename.message).toContain('references updated');
    expect(action.getParameter(0).getPlainString()).toBe('DisplayName');
    const renamed = variables.get('DisplayName');
    expect(renamed.getPersistentUuid()).toBe(uuid);
    expect(renamed.getType()).toBe(gd.Variable.String);
    expect(renamed.getString()).toBe('alpha');

    const reorder: EditorFunctionGenericOutput = await editorFunctions.add_or_edit_variable.launchFunction(
      {
        ...makeFakeLaunchFunctionOptionsWithProject(project),
        args: {
          variable_scope: 'global',
          variables: [
            {
              variable_name_or_path: '__Internal',
              move_to_index: 2,
            },
          ],
        },
      }
    );

    expect(reorder.success).toBe(true);
    expect(
      Array.from({ length: variables.count() }, (_, index) =>
        variables.getNameAt(index)
      )
    ).toEqual(['DisplayName', 'PublicB', '__Internal']);
    expect(variables.get('__Internal').getValue()).toBe(7);
    expect(variables.get('PublicB').getBool()).toBe(true);
  });

  it('renames a scene variable and rewrites its event reference', async () => {
    const scene = project.getLayout('TestScene');
    scene
      .getVariables()
      .insertNew('Wave', 0)
      .setValue(2);
    const action = addVariableReferenceAction({
      scene,
      type: 'SetNumberVariable',
      parameters: ['Wave', '=', '3'],
    });

    const result: EditorFunctionGenericOutput = await editorFunctions.add_or_edit_variable.launchFunction(
      {
        ...makeFakeLaunchFunctionOptionsWithProject(project),
        args: {
          variable_scope: 'scene',
          scene_name: 'TestScene',
          variable_name_or_path: 'Wave',
          new_variable_name: 'WaveIndex',
        },
      }
    );

    expect(result.success).toBe(true);
    expect(scene.getVariables().has('Wave')).toBe(false);
    expect(
      scene
        .getVariables()
        .get('WaveIndex')
        .getValue()
    ).toBe(2);
    expect(action.getParameter(0).getPlainString()).toBe('WaveIndex');
  });

  it('renames an object variable, its instance override and object references', async () => {
    const scene = project.getLayout('TestScene');
    const object = scene
      .getObjects()
      .insertNewObject(project, 'Sprite', 'Enemy', 0);
    object
      .getVariables()
      .insertNew('Health', 0)
      .setValue(100);
    const instance = scene.getInitialInstances().insertNewInitialInstance();
    instance.setObjectName('Enemy');
    instance
      .getVariables()
      .insertNew('Health', 0)
      .setValue(35);
    const action = addVariableReferenceAction({
      scene,
      type: 'SetNumberObjectVariable',
      parameters: ['Enemy', 'Health', '=', 'Enemy.Health'],
    });

    const result: EditorFunctionGenericOutput = await editorFunctions.add_or_edit_variable.launchFunction(
      {
        ...makeFakeLaunchFunctionOptionsWithProject(project),
        args: {
          variable_scope: 'object',
          scene_name: 'TestScene',
          object_name: 'Enemy',
          variable_name_or_path: 'Health',
          new_variable_name: 'HitPoints',
        },
      }
    );

    expect(result.success).toBe(true);
    expect(
      object
        .getVariables()
        .get('HitPoints')
        .getValue()
    ).toBe(100);
    expect(
      instance
        .getVariables()
        .get('HitPoints')
        .getValue()
    ).toBe(35);
    expect(action.getParameter(1).getPlainString()).toBe('HitPoints');
    expect(action.getParameter(3).getPlainString()).toBe('Enemy.HitPoints');
  });

  it('returns structured duplicate-name and reorder conflicts', async () => {
    project
      .getVariables()
      .insertNew('First', 0)
      .setValue(1);
    project
      .getVariables()
      .insertNew('Second', 1)
      .setValue(2);

    const duplicate: EditorFunctionGenericOutput = await editorFunctions.add_or_edit_variable.launchFunction(
      {
        ...makeFakeLaunchFunctionOptionsWithProject(project),
        args: {
          variable_scope: 'global',
          variable_name_or_path: 'First',
          new_variable_name: 'Second',
        },
      }
    );
    expect(duplicate.success).toBe(false);
    expect(duplicate.operationErrors).toEqual([
      expect.objectContaining({
        code: 'variable_name_conflict',
        variablePath: 'First',
      }),
    ]);

    const reorder: EditorFunctionGenericOutput = await editorFunctions.add_or_edit_variable.launchFunction(
      {
        ...makeFakeLaunchFunctionOptionsWithProject(project),
        args: {
          variable_scope: 'global',
          variable_name_or_path: 'First',
          move_before_variable: 'Second',
          move_after_variable: 'Second',
        },
      }
    );
    expect(reorder.success).toBe(false);
    expect(reorder.operationErrors).toEqual([
      expect.objectContaining({
        code: 'variable_reorder_position_conflict',
        variablePath: 'First',
      }),
    ]);
  });

  it('forces a numeric-looking value to be stored as a string', async () => {
    const result: EditorFunctionGenericOutput = await editorFunctions.add_or_edit_variable.launchFunction(
      {
        ...makeFakeLaunchFunctionOptionsWithProject(project),
        args: {
          variable_name_or_path: 'code',
          variable_scope: 'global',
          value: '123',
          variable_type: 'string',
        },
      }
    );

    expect(result.success).toBe(true);
    expect(result.message).toBe('Added global variable "code" (String) = 123');
    const variable = project.getVariables().get('code');
    expect(variable.getType()).toBe(gd.Variable.String);
    expect(variable.getString()).toBe('123');
  });

  it('infers a boolean variable from a "true" value', async () => {
    const result: EditorFunctionGenericOutput = await editorFunctions.add_or_edit_variable.launchFunction(
      {
        ...makeFakeLaunchFunctionOptionsWithProject(project),
        args: {
          variable_name_or_path: 'isPaused',
          variable_scope: 'global',
          value: 'true',
        },
      }
    );

    expect(result.success).toBe(true);
    expect(result.message).toBe(
      'Added global variable "isPaused" (Boolean) = true'
    );
    const variable = project.getVariables().get('isPaused');
    expect(variable.getType()).toBe(gd.Variable.Boolean);
    expect(variable.getBool()).toBe(true);
  });

  // A malformed path used to throw out of the whole call, losing the report
  // of the variables already applied earlier in the batch.
  it('applies the valid items of a batch and warns about the malformed ones', async () => {
    const result: EditorFunctionGenericOutput = await editorFunctions.add_or_edit_variable.launchFunction(
      {
        ...makeFakeLaunchFunctionOptionsWithProject(project),
        args: {
          variable_scope: 'global',
          variables: [
            { variable_name_or_path: 'score', value: '100' },
            // Malformed array index: this item alone must fail.
            { variable_name_or_path: 'items[x]', value: '1' },
            { variable_name_or_path: 'playerName', value: 'Alex' },
          ],
        },
      }
    );

    expect(result.success).toBe(true);
    expect(result.message).toEqual(
      expect.stringContaining('Added global variable "score" (Number) = 100')
    );
    expect(result.message).toEqual(
      expect.stringContaining(
        'Added global variable "playerName" (String) = Alex'
      )
    );
    expect(result.message).toEqual(
      expect.stringContaining(
        'Could not change global variable "items[x]": Content of the index is invalid ("x") - it should be a number.'
      )
    );
    // Both valid items were really applied, the malformed one was not.
    expect(
      project
        .getVariables()
        .get('score')
        .getValue()
    ).toBe(100);
    expect(
      project
        .getVariables()
        .get('playerName')
        .getString()
    ).toBe('Alex');
    expect(project.getVariables().has('items')).toBe(false);
  });

  it('warns (and stores nothing) when a forced number has a non-numeric value', async () => {
    const result: EditorFunctionGenericOutput = await editorFunctions.add_or_edit_variable.launchFunction(
      {
        ...makeFakeLaunchFunctionOptionsWithProject(project),
        args: {
          variable_name_or_path: 'score',
          variable_scope: 'global',
          value: 'lots',
          variable_type: 'number',
        },
      }
    );

    expect(result.success).toBe(false);
    expect(result.message).toEqual(
      expect.stringContaining(
        'Could not change global variable "score": Value "lots" is not a valid number'
      )
    );
    // No NaN variable was created.
    expect(project.getVariables().has('score')).toBe(false);
  });

  it('fails on an invalid variable_scope', async () => {
    const result: EditorFunctionGenericOutput = await editorFunctions.add_or_edit_variable.launchFunction(
      {
        ...makeFakeLaunchFunctionOptionsWithProject(project),
        args: {
          variable_name_or_path: 'score',
          variable_scope: 'world',
          value: '1',
        },
      }
    );

    expect(result.success).toBe(false);
    expect(result.message).toBe(
      'Invalid "variable_scope": "world". Use `scene`, `object`, `group`, `instance` or `global`.'
    );
  });

  it('fails when scene_name is missing for a scene variable', async () => {
    const result: EditorFunctionGenericOutput = await editorFunctions.add_or_edit_variable.launchFunction(
      {
        ...makeFakeLaunchFunctionOptionsWithProject(project),
        args: {
          variable_name_or_path: 'lives',
          variable_scope: 'scene',
          value: '3',
        },
      }
    );

    expect(result.success).toBe(false);
    expect(result.message).toBe(
      'Missing "scene_name" (required for scene variable).'
    );
  });

  it('fails when object_name is missing for an object variable', async () => {
    const result: EditorFunctionGenericOutput = await editorFunctions.add_or_edit_variable.launchFunction(
      {
        ...makeFakeLaunchFunctionOptionsWithProject(project),
        args: {
          variable_name_or_path: 'health',
          variable_scope: 'object',
          scene_name: 'TestScene',
          value: '100',
        },
      }
    );

    expect(result.success).toBe(false);
    expect(result.message).toBe(
      'Missing "object_name" (required for an object or group variable).'
    );
  });

  it('fails when the object is not found in the scene', async () => {
    const result: EditorFunctionGenericOutput = await editorFunctions.add_or_edit_variable.launchFunction(
      {
        ...makeFakeLaunchFunctionOptionsWithProject(project),
        args: {
          variable_name_or_path: 'health',
          variable_scope: 'object',
          scene_name: 'TestScene',
          object_name: 'Ghost',
          value: '100',
        },
      }
    );

    expect(result.success).toBe(false);
    expect(result.message).toBe(
      'Object or group "Ghost" not in scene "TestScene". For a global object, omit scene_name.'
    );
  });

  it('fails when the object is not found globally (no scene_name)', async () => {
    const result: EditorFunctionGenericOutput = await editorFunctions.add_or_edit_variable.launchFunction(
      {
        ...makeFakeLaunchFunctionOptionsWithProject(project),
        args: {
          variable_name_or_path: 'health',
          variable_scope: 'object',
          object_name: 'Ghost',
          value: '100',
        },
      }
    );

    expect(result.success).toBe(false);
    expect(result.message).toBe(
      'Object or group "Ghost" not found globally. Did you forget to specify scene_name?'
    );
  });

  it('fails when the "variables" list is empty', async () => {
    const result: EditorFunctionGenericOutput = await editorFunctions.add_or_edit_variable.launchFunction(
      {
        ...makeFakeLaunchFunctionOptionsWithProject(project),
        args: {
          variable_scope: 'global',
          variables: [],
        },
      }
    );

    expect(result.success).toBe(false);
    expect(result.message).toBe(
      'No variable to change (the "variables" list is empty).'
    );
  });

  it('fails when every variable item is skipped (no value, not a deletion)', async () => {
    const result: EditorFunctionGenericOutput = await editorFunctions.add_or_edit_variable.launchFunction(
      {
        ...makeFakeLaunchFunctionOptionsWithProject(project),
        args: {
          variable_scope: 'global',
          variables: [{ variable_name_or_path: 'orphan' }],
        },
      }
    );

    expect(result.success).toBe(false);
    expect(result.message).toBe(
      'Variable "orphan" was skipped: no "value" provided and it was not marked for deletion.'
    );
    expect(project.getVariables().has('orphan')).toBe(false);
  });

  it('still succeeds when only some variable items are skipped', async () => {
    const result: EditorFunctionGenericOutput = await editorFunctions.add_or_edit_variable.launchFunction(
      {
        ...makeFakeLaunchFunctionOptionsWithProject(project),
        args: {
          variable_scope: 'global',
          variables: [
            { variable_name_or_path: 'score', value: '10' },
            { variable_name_or_path: 'orphan' },
          ],
        },
      }
    );

    expect(result.success).toBe(true);
    expect(result.message).toContain(
      'Added global variable "score" (Number) = 10'
    );
    expect(result.message).toContain(
      'Variable "orphan" was skipped: no "value" provided and it was not marked for deletion.'
    );
    expect(
      project
        .getVariables()
        .get('score')
        .getValue()
    ).toBe(10);
    expect(project.getVariables().has('orphan')).toBe(false);
  });
});

describe('add_or_edit_variable (instance scope)', () => {
  let project: gdProject;
  let testScene: gdLayout;
  let doorInstance1: gdInitialInstance;
  let doorInstance2: gdInitialInstance;
  let playerInstance: gdInitialInstance;

  const getIdOf = (instance: gdInitialInstance): string =>
    instance.getPersistentUuid().slice(0, 10);

  beforeEach(() => {
    // $FlowFixMe[invalid-constructor]
    project = new gd.ProjectHelper.createNewGDJSProject();
    testScene = project.insertNewLayout('TestScene', 0);
    testScene.getObjects().insertNewObject(project, 'Sprite', 'Door', 0);
    testScene.getObjects().insertNewObject(project, 'Sprite', 'Player', 0);

    doorInstance1 = testScene.getInitialInstances().insertNewInitialInstance();
    doorInstance1.setObjectName('Door');
    doorInstance2 = testScene.getInitialInstances().insertNewInitialInstance();
    doorInstance2.setObjectName('Door');
    playerInstance = testScene.getInitialInstances().insertNewInitialInstance();
    playerInstance.setObjectName('Player');
  });

  afterEach(() => {
    project.delete();
  });

  const addOrEditVariable = async (args: any) =>
    editorFunctions.add_or_edit_variable.launchFunction({
      ...makeFakeLaunchFunctionOptionsWithProject(project),
      args,
    });

  it('sets a variable on a single instance and declares it on the object, leaving the other instances untouched', async () => {
    const result = await addOrEditVariable({
      variable_scope: 'instance',
      scene_name: 'TestScene',
      instance_id: getIdOf(doorInstance1),
      variable_name_or_path: 'LevelNumber',
      value: '3',
    });

    expect(result.success).toBe(true);
    expect(result.message).toContain('Added instance');
    expect(result.message).toContain(`"${getIdOf(doorInstance1)}" (Door)`);
    expect(result.message).toContain('variable "LevelNumber" (Number) = 3');
    expect(result.message).toContain(
      'Declared "LevelNumber" (Number) on object "Door" too'
    );
    expect(result.message).toContain('events read it with `Door.LevelNumber`');

    expect(doorInstance1.getVariables().has('LevelNumber')).toBe(true);
    expect(
      doorInstance1
        .getVariables()
        .get('LevelNumber')
        .getValue()
    ).toBe(3);
    // The object declares the variable (with the default value of its type):
    // an instance can only hold its own value of a variable of its object.
    const doorVariables = testScene
      .getObjects()
      .getObject('Door')
      .getVariables();
    expect(doorVariables.has('LevelNumber')).toBe(true);
    expect(doorVariables.get('LevelNumber').getType()).toBe(gd.Variable.Number);
    expect(doorVariables.get('LevelNumber').getValue()).toBe(0);
    // The other instances (and other objects) are untouched.
    expect(doorInstance2.getVariables().has('LevelNumber')).toBe(false);
    expect(playerInstance.getVariables().has('LevelNumber')).toBe(false);
    expect(
      testScene
        .getObjects()
        .getObject('Player')
        .getVariables()
        .has('LevelNumber')
    ).toBe(false);
  });

  it('renames an instance variable through its object declaration and preserves references', async () => {
    const doorObject = testScene.getObjects().getObject('Door');
    doorObject
      .getVariables()
      .insertNew('Locked', 0)
      .setValue(1);
    doorInstance1
      .getVariables()
      .insertNew('Locked', 0)
      .setValue(5);

    const event = new gd.StandardEvent();
    const action = new gd.Instruction();
    action.setType('SetNumberObjectVariable');
    action.setParametersCount(4);
    action.setParameter(0, 'Door');
    action.setParameter(1, 'Locked');
    action.setParameter(2, '=');
    action.setParameter(3, 'Door.Locked');
    event.getActions().insert(action, 0);
    testScene.getEvents().insertEvent(event, 0);
    action.delete();
    event.delete();
    const storedAction = gd
      .asStandardEvent(testScene.getEvents().getEventAt(0))
      .getActions()
      .get(0);

    const result = await addOrEditVariable({
      variable_scope: 'instance',
      scene_name: 'TestScene',
      instance_id: getIdOf(doorInstance1),
      variable_name_or_path: 'Locked',
      new_variable_name: 'AccessLevel',
    });

    expect(result.success).toBe(true);
    expect(
      doorObject
        .getVariables()
        .get('AccessLevel')
        .getValue()
    ).toBe(1);
    expect(
      doorInstance1
        .getVariables()
        .get('AccessLevel')
        .getValue()
    ).toBe(5);
    expect(storedAction.getParameter(1).getPlainString()).toBe('AccessLevel');
    expect(storedAction.getParameter(3).getPlainString()).toBe(
      'Door.AccessLevel'
    );
  });

  it('leaves the object alone when it already declares the variable', async () => {
    const doorObject = testScene.getObjects().getObject('Door');
    doorObject
      .getVariables()
      .insertNew('Locked', 0)
      .setBool(true);

    const result = await addOrEditVariable({
      variable_scope: 'instance',
      scene_name: 'TestScene',
      instance_id: getIdOf(doorInstance1),
      variable_name_or_path: 'Locked',
      value: 'false',
    });

    expect(result.success).toBe(true);
    expect(result.message).not.toContain('Declared');
    expect(
      doorObject
        .getVariables()
        .get('Locked')
        .getBool()
    ).toBe(true);
    expect(
      doorInstance1
        .getVariables()
        .get('Locked')
        .getBool()
    ).toBe(false);
  });

  it('declares the root of a nested path on the object, as an empty structure', async () => {
    const result = await addOrEditVariable({
      variable_scope: 'instance',
      scene_name: 'TestScene',
      instance_id: getIdOf(doorInstance1),
      variables: [
        { variable_name_or_path: 'Stats.Health', value: '10' },
        { variable_name_or_path: 'Greeting', value: 'Hello' },
      ],
    });

    expect(result.success).toBe(true);
    expect(result.message).toContain(
      'Declared "Stats" (Structure) on object "Door" too'
    );
    expect(result.message).toContain(
      'Declared "Greeting" (String) on object "Door" too'
    );

    const doorVariables = testScene
      .getObjects()
      .getObject('Door')
      .getVariables();
    expect(doorVariables.get('Stats').getType()).toBe(gd.Variable.Structure);
    expect(doorVariables.get('Stats').getChildrenCount()).toBe(0);
    expect(doorVariables.get('Greeting').getType()).toBe(gd.Variable.String);
    expect(doorVariables.get('Greeting').getString()).toBe('');
    expect(
      doorInstance1
        .getVariables()
        .get('Stats')
        .getChild('Health')
        .getValue()
    ).toBe(10);
  });

  it('sets several variables (including nested paths) on one instance', async () => {
    const result = await addOrEditVariable({
      variable_scope: 'instance',
      scene_name: 'TestScene',
      instance_id: getIdOf(doorInstance1),
      variables: [
        { variable_name_or_path: 'IsOpen', value: 'false' },
        { variable_name_or_path: 'Config.Speed', value: '12' },
      ],
    });

    expect(result.success).toBe(true);
    expect(
      doorInstance1
        .getVariables()
        .get('IsOpen')
        .getBool()
    ).toBe(false);
    // Nested paths work, backed by the same ApplyVariableChange helpers.
    expect(
      doorInstance1
        .getVariables()
        .get('Config')
        .getChild('Speed')
        .getValue()
    ).toBe(12);
    // The other instances are untouched: one call changes one instance.
    expect(doorInstance2.getVariables().has('IsOpen')).toBe(false);
    expect(playerInstance.getVariables().has('IsOpen')).toBe(false);
  });

  it('deletes an instance variable', async () => {
    doorInstance1
      .getVariables()
      .insertNew('Obsolete', 0)
      .setValue(1);

    const result = await addOrEditVariable({
      variable_scope: 'instance',
      scene_name: 'TestScene',
      instance_id: getIdOf(doorInstance1),
      variables: [
        { variable_name_or_path: 'Obsolete', delete_this_variable: true },
      ],
    });

    expect(result.success).toBe(true);
    expect(result.message).toContain('Deleted instance');
    expect(doorInstance1.getVariables().has('Obsolete')).toBe(false);
  });

  it('fails without scene_name', async () => {
    const result = await addOrEditVariable({
      variable_scope: 'instance',
      instance_id: getIdOf(doorInstance1),
      variable_name_or_path: 'LevelNumber',
      value: '3',
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('Missing "scene_name"');
  });

  it('fails without instance_id', async () => {
    const result = await addOrEditVariable({
      variable_scope: 'instance',
      scene_name: 'TestScene',
      variable_name_or_path: 'LevelNumber',
      value: '3',
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('Missing "instance_id"');
    expect(result.message).toContain('describe_instances');
  });

  it('fails (and changes nothing) when the id is unknown', async () => {
    const result = await addOrEditVariable({
      variable_scope: 'instance',
      scene_name: 'TestScene',
      instance_id: 'ffffffffff',
      variable_name_or_path: 'LevelNumber',
      value: '3',
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('ffffffffff');
    expect(result.message).toContain('describe_instances');
    expect(doorInstance1.getVariables().has('LevelNumber')).toBe(false);
  });

  it('fails when an id belongs to another object than object_name', async () => {
    const result = await addOrEditVariable({
      variable_scope: 'instance',
      scene_name: 'TestScene',
      object_name: 'Door',
      instance_id: getIdOf(playerInstance),
      variable_name_or_path: 'LevelNumber',
      value: '3',
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('not an instance of object "Door"');
    expect(result.message).toContain('(instance of "Player")');
    expect(playerInstance.getVariables().has('LevelNumber')).toBe(false);
  });

  it('inspect_variables works with the instance scope', async () => {
    doorInstance1
      .getVariables()
      .insertNew('LevelNumber', 0)
      .setValue(7);

    const result = await editorFunctions.inspect_variables.launchFunction({
      ...makeFakeLaunchFunctionOptionsWithProject(project),
      args: {
        variable_scope: 'instance',
        scene_name: 'TestScene',
        instance_id: getIdOf(doorInstance1),
      },
    });

    expect(result.success).toBe(true);
    expect(JSON.stringify(result.variables)).toContain('LevelNumber');
  });
});

describe('add_or_edit_variable (instance scope, in a variant of a custom object)', () => {
  let project: gdProject;
  let eventsBasedObject: gdEventsBasedObject;
  let defaultBackInstance: gdInitialInstance;
  let darkBackInstance: gdInitialInstance;

  const getIdOf = (instance: gdInitialInstance): string =>
    instance.getPersistentUuid().slice(0, 10);
  const getBackVariables = (variantName: string): gdVariablesContainer =>
    (variantName === ''
      ? eventsBasedObject.getDefaultVariant()
      : eventsBasedObject.getVariants().getVariant(variantName)
    )
      .getObjects()
      .getObject('Back')
      .getVariables();

  beforeEach(() => {
    // $FlowFixMe[invalid-constructor]
    project = new gd.ProjectHelper.createNewGDJSProject();
    const extension = project.insertNewEventsFunctionsExtension('UI', 0);
    eventsBasedObject = extension
      .getEventsBasedObjects()
      .insertNew('Dialog', 0);
    const defaultVariant = eventsBasedObject.getDefaultVariant();
    defaultVariant.getObjects().insertNewObject(project, 'Sprite', 'Back', 0);
    const darkVariant = eventsBasedObject
      .getVariants()
      .insertNewVariant('Dark', 0);
    gd.EventsBasedObjectVariantHelper.complyVariantsToEventsBasedObject(
      project,
      eventsBasedObject
    );
    defaultBackInstance = defaultVariant
      .getInitialInstances()
      .insertNewInitialInstance();
    defaultBackInstance.setObjectName('Back');
    darkBackInstance = darkVariant
      .getInitialInstances()
      .insertNewInitialInstance();
    darkBackInstance.setObjectName('Back');
  });

  afterEach(() => {
    project.delete();
  });

  const addOrEditVariable = async (args: any) =>
    editorFunctions.add_or_edit_variable.launchFunction({
      ...makeFakeLaunchFunctionOptionsWithProject(project),
      args,
    });

  it('declares the variable on the child object of the default variant, followed by the named variants', async () => {
    const result = await addOrEditVariable({
      scope: {
        type: 'custom_object_variant',
        extension_name: 'UI',
        custom_object_name: 'Dialog',
        variant_name: '',
      },
      variable_scope: 'instance',
      instance_id: getIdOf(defaultBackInstance),
      variable_name_or_path: 'Glow',
      value: 'true',
    });

    expect(result.success).toBe(true);
    expect(result.message).toContain(
      'Declared "Glow" (Boolean) on object "Back" too'
    );
    expect(
      defaultBackInstance
        .getVariables()
        .get('Glow')
        .getBool()
    ).toBe(true);
    expect(getBackVariables('').has('Glow')).toBe(true);
    expect(
      getBackVariables('')
        .get('Glow')
        .getBool()
    ).toBe(false);
    // The named variant complied with the new structure.
    expect(getBackVariables('Dark').has('Glow')).toBe(true);
  });

  it('declares the variable on the default variant when the instance is in a named variant', async () => {
    const result = await addOrEditVariable({
      scope: {
        type: 'custom_object_variant',
        extension_name: 'UI',
        custom_object_name: 'Dialog',
        variant_name: 'Dark',
      },
      variable_scope: 'instance',
      instance_id: getIdOf(darkBackInstance),
      variable_name_or_path: 'Depth',
      value: '2',
    });

    expect(result.success).toBe(true);
    expect(result.message).toContain(
      'Declared "Depth" (Number) on object "Back" too'
    );
    expect(
      darkBackInstance
        .getVariables()
        .get('Depth')
        .getValue()
    ).toBe(2);
    expect(getBackVariables('').has('Depth')).toBe(true);
    expect(getBackVariables('Dark').has('Depth')).toBe(true);
  });
});
