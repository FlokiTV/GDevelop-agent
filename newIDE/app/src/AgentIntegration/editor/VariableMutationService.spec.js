// @flow
import { runVariableRenameOrReorder } from './VariableMutationService';

const gd: libGDevelop = global.gd;

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

const names = (container: gdVariablesContainer): Array<string> =>
  Array.from({ length: container.count() }, (_, index) =>
    container.getNameAt(index)
  );

describe('VariableMutationService', () => {
  let project: gdProject;
  let scene: gdLayout;

  beforeEach(() => {
    // $FlowFixMe[invalid-constructor]
    project = new gd.ProjectHelper.createNewGDJSProject();
    scene = project.insertNewLayout('TestScene', 0);
  });

  afterEach(() => {
    project.delete();
  });

  it('renames a global declaration in place, rewrites references and supports public-first/internal-last ordering', () => {
    const variables = project.getVariables();
    variables.insertNew('PublicA', 0).setString('alpha');
    variables.insertNew('PublicB', 1).setBool(true);
    variables.insertNew('__Internal', 2).setValue(7);
    variables.ensurePersistentUuids();
    const uuid = variables.get('PublicA').getPersistentUuid();
    const action = addVariableReferenceAction({
      scene,
      type: 'SetNumberVariable',
      parameters: ['PublicA', '=', '123'],
    });

    const rename = runVariableRenameOrReorder({
      project,
      args: {
        variable_scope: 'global',
        variables: [
          {
            variable_name_or_path: 'PublicA',
            new_variable_name: 'DisplayName',
            move_before_variable: 'PublicB',
          },
          {
            variable_name_or_path: '__Internal',
            move_to_index: 2,
          },
        ],
      },
    });

    expect(rename.output.success).toBe(true);
    expect(rename.didModifyProject).toBe(true);
    expect(names(variables)).toEqual(['DisplayName', 'PublicB', '__Internal']);
    expect(action.getParameter(0).getPlainString()).toBe('DisplayName');
    expect(variables.get('DisplayName').getPersistentUuid()).toBe(uuid);
    expect(variables.get('DisplayName').getType()).toBe(gd.Variable.String);
    expect(variables.get('DisplayName').getString()).toBe('alpha');
    expect(variables.get('PublicB').getBool()).toBe(true);
    expect(variables.get('__Internal').getValue()).toBe(7);
  });

  it('renames a nested structure child without rebuilding siblings', () => {
    const config = project.getVariables().insertNew('Config', 0);
    config.castTo('structure');
    config.getChild('Speed').setValue(12);
    config.getChild('Label').setString('Fast');

    const result = runVariableRenameOrReorder({
      project,
      args: {
        variable_scope: 'global',
        variable_name_or_path: 'Config.Speed',
        new_variable_name: 'MoveSpeed',
      },
    });

    expect(result.output.success).toBe(true);
    const updatedConfig = project.getVariables().get('Config');
    expect(updatedConfig.hasChild('Speed')).toBe(false);
    expect(updatedConfig.getChild('MoveSpeed').getValue()).toBe(12);
    expect(updatedConfig.getChild('Label').getString()).toBe('Fast');
  });

  it('renames a scene declaration and rewrites its event reference', () => {
    scene
      .getVariables()
      .insertNew('Wave', 0)
      .setValue(2);
    const action = addVariableReferenceAction({
      scene,
      type: 'SetNumberVariable',
      parameters: ['Wave', '=', '3'],
    });

    const result = runVariableRenameOrReorder({
      project,
      args: {
        variable_scope: 'scene',
        scene_name: 'TestScene',
        variable_name_or_path: 'Wave',
        new_variable_name: 'WaveIndex',
      },
    });

    expect(result.output.success).toBe(true);
    expect(scene.getVariables().has('Wave')).toBe(false);
    expect(
      scene
        .getVariables()
        .get('WaveIndex')
        .getValue()
    ).toBe(2);
    expect(action.getParameter(0).getPlainString()).toBe('WaveIndex');
  });

  it('renames an object declaration, instance override and object references', () => {
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

    const result = runVariableRenameOrReorder({
      project,
      args: {
        variable_scope: 'object',
        scene_name: 'TestScene',
        object_name: 'Enemy',
        variable_name_or_path: 'Health',
        new_variable_name: 'HitPoints',
      },
    });

    expect(result.output.success).toBe(true);
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

  it('renames through instance scope by mutating its owning declaration and preserves the override', () => {
    const object = scene
      .getObjects()
      .insertNewObject(project, 'Sprite', 'Door', 0);
    object
      .getVariables()
      .insertNew('Access', 0)
      .setValue(1);
    const instance = scene.getInitialInstances().insertNewInitialInstance();
    instance.setObjectName('Door');
    instance
      .getVariables()
      .insertNew('Access', 0)
      .setValue(9);
    const action = addVariableReferenceAction({
      scene,
      type: 'SetNumberObjectVariable',
      parameters: ['Door', 'Access', '=', 'Door.Access'],
    });

    const result = runVariableRenameOrReorder({
      project,
      args: {
        variable_scope: 'instance',
        scene_name: 'TestScene',
        object_name: 'Door',
        instance_id: instance.getPersistentUuid().slice(0, 10),
        variable_name_or_path: 'Access',
        new_variable_name: 'AccessLevel',
      },
    });

    expect(result.output.success).toBe(true);
    expect(
      object
        .getVariables()
        .get('AccessLevel')
        .getValue()
    ).toBe(1);
    expect(
      instance
        .getVariables()
        .get('AccessLevel')
        .getValue()
    ).toBe(9);
    expect(action.getParameter(1).getPlainString()).toBe('AccessLevel');
    expect(action.getParameter(3).getPlainString()).toBe('Door.AccessLevel');
  });

  it('implements stable before/after/final-index semantics', () => {
    const variables = project.getVariables();
    variables.insertNew('A', 0).setValue(1);
    variables.insertNew('B', 1).setValue(2);
    variables.insertNew('C', 2).setValue(3);

    expect(
      runVariableRenameOrReorder({
        project,
        args: {
          variable_scope: 'global',
          variable_name_or_path: 'A',
          move_after_variable: 'C',
        },
      }).output.success
    ).toBe(true);
    expect(names(variables)).toEqual(['B', 'C', 'A']);

    expect(
      runVariableRenameOrReorder({
        project,
        args: {
          variable_scope: 'global',
          variable_name_or_path: 'A',
          move_to_index: 1,
        },
      }).output.success
    ).toBe(true);
    expect(names(variables)).toEqual(['B', 'A', 'C']);

    expect(
      runVariableRenameOrReorder({
        project,
        args: {
          variable_scope: 'global',
          variable_name_or_path: 'C',
          move_before_variable: 'B',
        },
      }).output.success
    ).toBe(true);
    expect(names(variables)).toEqual(['C', 'B', 'A']);
  });

  it('returns stable structured conflicts and rejects ambiguous group rename/reorder', () => {
    project
      .getVariables()
      .insertNew('First', 0)
      .setValue(1);
    project
      .getVariables()
      .insertNew('Second', 1)
      .setValue(2);

    const duplicate = runVariableRenameOrReorder({
      project,
      args: {
        variable_scope: 'global',
        variable_name_or_path: 'First',
        new_variable_name: 'Second',
      },
    });
    expect(duplicate.output.success).toBe(false);
    expect(duplicate.output.operationErrors).toEqual([
      expect.objectContaining({
        code: 'variable_name_conflict',
        variablePath: 'First',
      }),
    ]);

    const ambiguous = runVariableRenameOrReorder({
      project,
      args: {
        variable_scope: 'global',
        variable_name_or_path: 'First',
        move_before_variable: 'Second',
        move_after_variable: 'Second',
      },
    });
    expect(ambiguous.output.success).toBe(false);
    expect(ambiguous.output.operationErrors).toEqual([
      expect.objectContaining({
        code: 'variable_reorder_position_conflict',
        variablePath: 'First',
      }),
    ]);

    const group = runVariableRenameOrReorder({
      project,
      args: {
        variable_scope: 'group',
        scene_name: 'TestScene',
        object_name: 'Enemies',
        variable_name_or_path: 'Health',
        new_variable_name: 'HitPoints',
      },
    });
    expect(group.output.success).toBe(false);
    expect(group.output.operationErrors).toEqual([
      expect.objectContaining({
        code: 'group_variable_reorder_rename_unsupported',
      }),
    ]);
  });

  it('rejects mixing rename/reorder with value/type/delete fields so legacy changes stay native', () => {
    project
      .getVariables()
      .insertNew('Score', 0)
      .setValue(3);

    const result = runVariableRenameOrReorder({
      project,
      args: {
        variable_scope: 'global',
        variable_name_or_path: 'Score',
        new_variable_name: 'Points',
        value: '9',
      },
    });

    expect(result.output.success).toBe(false);
    expect(result.didModifyProject).toBe(false);
    expect(result.output.operationErrors).toEqual([
      expect.objectContaining({
        code: 'variable_mutation_mixed_mode_unsupported',
        variablePath: 'Score',
      }),
    ]);
    expect(project.getVariables().has('Score')).toBe(true);
    expect(project.getVariables().has('Points')).toBe(false);
  });
});
