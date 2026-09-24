const fs = require('fs');
const os = require('os');
const path = require('path');
const { connectLiveGDevelopMcp, sanitizeForReplay } = require('./McpClient');

const SCENE_NAME = 'DX11Variables';
const OBJECT_NAME = 'DX11Actor';

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const callOk = async (session, name, args = {}) => {
  const result = await session.call(name, args);
  if (result.isError) {
    throw new Error(
      `${name} failed: ${JSON.stringify(
        result.structuredContent || result.content || result.data
      )}`
    );
  }
  return result;
};

const editorOutput = result => {
  const results =
    result && result.data && Array.isArray(result.data.results)
      ? result.data.results
      : [];
  const failed = results.find(item => item && item.success === false);
  if (failed) {
    throw new Error(
      `editor_function_failed:${JSON.stringify(failed.output || failed)}`
    );
  }
  const first = results[0];
  assert(first && first.success === true, 'missing_editor_function_result');
  return first.output || {};
};

const getResponseRevision = result => {
  const revision =
    result && result.meta && Number.isInteger(result.meta.projectRevision)
      ? result.meta.projectRevision
      : result &&
        result.structuredContent &&
        result.structuredContent.meta &&
        Number.isInteger(result.structuredContent.meta.projectRevision)
      ? result.structuredContent.meta.projectRevision
      : null;
  assert(Number.isInteger(revision), 'missing_project_revision');
  return revision;
};

const findTool = (tools, name) => {
  const tool = tools.find(item => item.name === name);
  assert(tool, `missing_tool:${name}`);
  return tool;
};

const variableMap = variables =>
  Object.fromEntries(
    (variables || []).map(variable => [variable.variableName, variable])
  );

const run = async ({
  label = 'live',
  evidencePath = path.join(
    os.tmpdir(),
    `gdevelop-dx11-variable-mutation-${process.pid}.json`
  ),
} = {}) => {
  const session = await connectLiveGDevelopMcp({
    clientId: `gdevelop-dx11-variable-mutation-${label}`,
  });
  let transactionId = null;
  const replay = [];

  const record = (name, args, result) => {
    replay.push(
      sanitizeForReplay({
        name,
        args,
        result: result.structuredContent || result.data || result.content,
      })
    );
  };
  const call = async (name, args = {}) => {
    const result = await callOk(session, name, args);
    record(name, args, result);
    return result;
  };

  try {
    const tools = await session.listTools();
    [
      'project.create',
      'project.close',
      'project.status',
      'editor.functions.create-scene',
      'editor.functions.create-object',
      'editor.functions.put-2d-instances',
      'editor.functions.describe-instances',
      'editor.functions.add-or-edit-variable',
      'editor.functions.inspect-variables',
      'safety.transactions.begin',
      'safety.transactions.rollback',
      'validation.run',
    ].forEach(name => findTool(tools, name));

    const mutationTool = findTool(
      tools,
      'editor.functions.add-or-edit-variable'
    );
    const variablesSchema =
      mutationTool.inputSchema &&
      mutationTool.inputSchema.properties &&
      mutationTool.inputSchema.properties.variables;
    const itemProperties =
      variablesSchema &&
      variablesSchema.items &&
      variablesSchema.items.properties;
    assert(itemProperties, 'dx11_variable_operation_schema_missing');
    [
      'new_variable_name',
      'move_before_variable',
      'move_after_variable',
      'move_to_index',
    ].forEach(name =>
      assert(itemProperties[name], `dx11_schema_missing:${name}`)
    );

    const before = await call('project.status');
    if (before.data && before.data.projectOpen) {
      assert(
        before.data.hasUnsavedChanges === false,
        'dx11_requires_clean_or_fresh_editor'
      );
      await call('project.close', {
        expectedRevision:
          before.meta && Number.isInteger(before.meta.projectRevision)
            ? before.meta.projectRevision
            : undefined,
        idempotencyKey: 'dx11-close-clean-auto-open-project',
      });
    }

    await call('project.create', {
      name: 'DX11 Variable Mutation Acceptance',
      idempotencyKey: 'dx11-create-project',
    });

    const tx = await call('safety.transactions.begin', {
      label: 'DX-11 variable rename/reorder acceptance',
    });
    transactionId = tx.data && tx.data.transactionId;
    assert(transactionId, 'dx11_transaction_missing');

    const createScene = await call('editor.functions.create-scene', {
      scene_name: SCENE_NAME,
      idempotencyKey: 'dx11-create-scene',
    });
    let revision = getResponseRevision(createScene);

    const mutate = async (name, args, key) => {
      const result = await call(name, {
        ...args,
        expectedRevision: revision,
        idempotencyKey: key,
      });
      revision = getResponseRevision(result);
      return result;
    };

    await mutate(
      'editor.functions.create-object',
      {
        scene_name: SCENE_NAME,
        object_name: OBJECT_NAME,
        object_type: 'Sprite',
      },
      'dx11-create-object'
    );
    await mutate(
      'editor.functions.put-2d-instances',
      {
        scene_name: SCENE_NAME,
        layer_name: '',
        brush_kind: 'point',
        brush_position: '320,240',
        object_name: OBJECT_NAME,
        new_instances_count: 1,
      },
      'dx11-create-instance'
    );

    const instances = editorOutput(
      await call('editor.functions.describe-instances', {
        scene_name: SCENE_NAME,
        filter_by_object_name: OBJECT_NAME,
      })
    ).instances;
    assert(
      Array.isArray(instances) && instances.length === 1,
      'dx11_instance_missing'
    );
    const instanceId = instances[0].id;
    assert(instanceId, 'dx11_instance_id_missing');

    await mutate(
      'editor.functions.add-or-edit-variable',
      {
        variable_scope: 'global',
        variables: [
          {
            variable_name_or_path: 'PublicA',
            value: 'alpha',
            variable_type: 'string',
          },
          {
            variable_name_or_path: 'PublicB',
            value: 'true',
            variable_type: 'boolean',
          },
          {
            variable_name_or_path: '__Internal',
            value: '7',
            variable_type: 'number',
          },
        ],
      },
      'dx11-create-globals'
    );

    await mutate(
      'editor.functions.add-or-edit-variable',
      {
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
      'dx11-rename-reorder-globals'
    );

    const globals = editorOutput(
      await call('editor.functions.inspect-variables', {
        variable_scope: 'global',
      })
    ).variables;
    assert(
      globals.map(variable => variable.variableName).join('|') ===
        'DisplayName|PublicB|__Internal',
      `dx11_global_order_mismatch:${JSON.stringify(globals)}`
    );
    const globalsByName = variableMap(globals);
    assert(
      globalsByName.DisplayName.type === 'String' &&
        globalsByName.DisplayName.value === 'alpha',
      'dx11_global_rename_lost_value_or_type'
    );
    assert(
      globalsByName.PublicB.type === 'Boolean' &&
        globalsByName.PublicB.value === 'True',
      'dx11_public_b_lost_value_or_type'
    );
    assert(
      globalsByName.__Internal.type === 'Number' &&
        globalsByName.__Internal.value === '7',
      'dx11_internal_lost_value_or_type'
    );

    await mutate(
      'editor.functions.add-or-edit-variable',
      {
        variable_scope: 'scene',
        scene_name: SCENE_NAME,
        variables: [
          {
            variable_name_or_path: 'Wave',
            value: '2',
            variable_type: 'number',
          },
          {
            variable_name_or_path: 'Wave',
            new_variable_name: 'WaveIndex',
          },
        ],
      },
      'dx11-scene-rename'
    );
    const sceneVariables = editorOutput(
      await call('editor.functions.inspect-variables', {
        variable_scope: 'scene',
        scene_name: SCENE_NAME,
      })
    ).variables;
    const sceneByName = variableMap(sceneVariables);
    assert(
      sceneByName.WaveIndex &&
        sceneByName.WaveIndex.type === 'Number' &&
        sceneByName.WaveIndex.value === '2' &&
        !sceneByName.Wave,
      'dx11_scene_rename_failed'
    );

    await mutate(
      'editor.functions.add-or-edit-variable',
      {
        variable_scope: 'object',
        scene_name: SCENE_NAME,
        object_name: OBJECT_NAME,
        variables: [
          {
            variable_name_or_path: 'Health',
            value: '100',
            variable_type: 'number',
          },
          {
            variable_name_or_path: 'Health',
            new_variable_name: 'HitPoints',
          },
          {
            variable_name_or_path: 'Access',
            value: '1',
            variable_type: 'number',
          },
        ],
      },
      'dx11-object-rename'
    );

    await mutate(
      'editor.functions.add-or-edit-variable',
      {
        variable_scope: 'instance',
        scene_name: SCENE_NAME,
        object_name: OBJECT_NAME,
        instance_id: instanceId,
        variable_name_or_path: 'Access',
        value: '9',
        variable_type: 'number',
      },
      'dx11-instance-override'
    );
    await mutate(
      'editor.functions.add-or-edit-variable',
      {
        variable_scope: 'instance',
        scene_name: SCENE_NAME,
        object_name: OBJECT_NAME,
        instance_id: instanceId,
        variable_name_or_path: 'Access',
        new_variable_name: 'AccessLevel',
      },
      'dx11-instance-scope-rename'
    );

    const objectVariables = editorOutput(
      await call('editor.functions.inspect-variables', {
        variable_scope: 'object',
        scene_name: SCENE_NAME,
        object_name: OBJECT_NAME,
      })
    ).variables;
    const objectByName = variableMap(objectVariables);
    assert(
      objectByName.HitPoints &&
        objectByName.HitPoints.type === 'Number' &&
        objectByName.HitPoints.value === '100' &&
        !objectByName.Health,
      'dx11_object_rename_failed'
    );
    assert(
      objectByName.AccessLevel &&
        objectByName.AccessLevel.type === 'Number' &&
        objectByName.AccessLevel.value === '1' &&
        !objectByName.Access,
      'dx11_instance_owner_rename_failed'
    );

    const instanceVariables = editorOutput(
      await call('editor.functions.inspect-variables', {
        variable_scope: 'instance',
        scene_name: SCENE_NAME,
        object_name: OBJECT_NAME,
        instance_id: instanceId,
      })
    ).variables;
    const instanceByName = variableMap(instanceVariables);
    assert(
      instanceByName.AccessLevel &&
        instanceByName.AccessLevel.type === 'Number' &&
        instanceByName.AccessLevel.value === '9' &&
        !instanceByName.Access,
      'dx11_instance_override_rename_failed'
    );

    const validation = await call('validation.run', {
      includeNativeReport: false,
      includeAssets: false,
    });
    const validationErrors =
      validation.data &&
      validation.data.summary &&
      Number.isInteger(validation.data.summary.errors)
        ? validation.data.summary.errors
        : validation.data && Array.isArray(validation.data.errors)
        ? validation.data.errors.length
        : 0;
    assert(validationErrors === 0, 'dx11_validation_has_errors');

    const evidence = sanitizeForReplay({
      kind: 'dx11-variable-rename-reorder',
      label,
      protocolVersion: session.protocolVersion,
      globalOrder: globals.map(variable => variable.variableName),
      preserved: {
        DisplayName: globalsByName.DisplayName,
        PublicB: globalsByName.PublicB,
        __Internal: globalsByName.__Internal,
        WaveIndex: sceneByName.WaveIndex,
        HitPoints: objectByName.HitPoints,
        AccessLevelDeclaration: objectByName.AccessLevel,
        AccessLevelInstance: instanceByName.AccessLevel,
      },
      scopes: ['global', 'scene', 'object', 'instance'],
      deleteRecreateWorkaroundUsed: false,
      validationErrors,
      replay,
    });
    fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));

    await call('safety.transactions.rollback', {
      transactionId,
    });
    transactionId = null;

    const afterRollbackGlobals = editorOutput(
      await call('editor.functions.inspect-variables', {
        variable_scope: 'global',
      })
    ).variables;
    assert(
      !afterRollbackGlobals.some(variable =>
        ['DisplayName', 'PublicB', '__Internal'].includes(variable.variableName)
      ),
      'dx11_transaction_rollback_failed'
    );

    console.log(
      JSON.stringify(
        {
          ok: true,
          label,
          protocolVersion: session.protocolVersion,
          globalOrder: evidence.globalOrder,
          scopes: evidence.scopes,
          validationErrors,
          deleteRecreateWorkaroundUsed: false,
          transactionRollback: true,
          evidencePath,
        },
        null,
        2
      )
    );
  } finally {
    if (transactionId) {
      try {
        await session.call('safety.transactions.rollback', { transactionId });
      } catch (_) {}
    }
    await session.close();
  }
};

if (require.main === module) {
  let label = 'live';
  let evidencePath;
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--label') label = args[++index];
    else if (args[index] === '--evidence') evidencePath = args[++index];
    else throw new Error(`unknown_argument:${args[index]}`);
  }
  run({ label, ...(evidencePath ? { evidencePath } : {}) }).catch(error => {
    console.error(error && error.stack ? error.stack : String(error));
    process.exitCode = 1;
  });
}

module.exports = { OBJECT_NAME, SCENE_NAME, run };
