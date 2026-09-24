const fs = require('fs');
const os = require('os');
const path = require('path');
const { connectLiveGDevelopMcp, sanitizeForReplay } = require('./McpClient');

const EXTENSION_NAME = 'Dx10Localization';
const DELETE_EXTENSION_NAME = 'Dx10DeleteMe';
const ROLLBACK_EXTENSION_NAME = 'Dx10RollbackProbe';
const SCENE_NAME = 'DX10Main';

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const clone = value => JSON.parse(JSON.stringify(value));

const callOk = async (session, name, args = {}, requestOptions = {}) => {
  const result = await session.call(name, args, requestOptions);
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

const run = async ({
  label = 'live',
  evidencePath = path.join(
    os.tmpdir(),
    `gdevelop-dx10-extension-authoring-${process.pid}.json`
  ),
} = {}) => {
  let session = await connectLiveGDevelopMcp({
    clientId: `gdevelop-dx10-extension-authoring-${label}`,
  });
  let transactionId = null;
  const replay = [];
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gdevelop-dx10-'));
  const savePath = path.join(tempDir, 'DX10Localization.json');

  const record = (name, args, result) => {
    replay.push(
      sanitizeForReplay({
        name,
        args,
        result: result.structuredContent || result.data || result.content,
      })
    );
  };
  const call = async (name, args = {}, requestOptions = {}) => {
    const result = await callOk(session, name, args, requestOptions);
    record(name, args, result);
    return result;
  };

  try {
    const toolsBeforeProject = await session.listTools();
    const requiredTools = [
      'project.create',
      'project.close',
      'project.status',
      'project.save-as',
      'editor.functions.create-scene',
      'editor.functions.create-extension',
      'editor.functions.change-extension-properties',
      'editor.functions.create-custom-function',
      'editor.functions.change-custom-function',
      'editor.functions.inspect-extension',
      'events.read',
      'events.insert',
      'events.nodes.describe',
      'events.instructions.search',
      'validation.run',
      'safety.transactions.begin',
      'safety.transactions.rollback',
    ];
    requiredTools.forEach(name => findTool(toolsBeforeProject, name));

    const createFunctionTool = findTool(
      toolsBeforeProject,
      'editor.functions.create-custom-function'
    );
    const createSchema = createFunctionTool.inputSchema;
    assert(
      createSchema &&
        createSchema.properties &&
        createSchema.properties.scope &&
        createSchema.properties.function_type &&
        Array.isArray(createSchema.properties.function_type.enum) &&
        createSchema.properties.function_type.enum.includes('Condition') &&
        createSchema.properties.function_type.enum.includes('Expression') &&
        createSchema.properties.expression_type.enum.includes('string') &&
        createSchema.properties.parameters.items.properties.type.enum.includes(
          'string'
        ),
      'typed_custom_function_schema_missing'
    );

    const before = await call('project.status');
    if (before.data && before.data.projectOpen) {
      assert(
        before.data.hasUnsavedChanges === false,
        'dx10_requires_clean_or_fresh_editor'
      );
      await call('project.close', {
        expectedRevision:
          before.meta && Number.isInteger(before.meta.projectRevision)
            ? before.meta.projectRevision
            : undefined,
        idempotencyKey: 'dx10-close-clean-auto-open-project',
      });
    }
    await call('project.create', {
      name: 'DX10 Extension Authoring Acceptance',
      idempotencyKey: 'dx10-create-project',
    });
    const createScene = await call('editor.functions.create-scene', {
      scene_name: SCENE_NAME,
      is_first_scene: true,
      idempotencyKey: 'dx10-create-scene',
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

    const tx = await call('safety.transactions.begin', {
      label: 'DX-10 transaction rollback probe',
    });
    transactionId = tx.data && tx.data.transactionId;
    assert(transactionId, 'missing_transaction_id');

    await mutate(
      'editor.functions.create-extension',
      {
        extension_name: ROLLBACK_EXTENSION_NAME,
        full_name: 'DX10 rollback probe',
      },
      'dx10-rollback-probe-extension'
    );
    await mutate(
      'editor.functions.create-custom-function',
      {
        scope: {
          type: 'extension',
          extension_name: ROLLBACK_EXTENSION_NAME,
        },
        function_name: 'Probe',
        function_type: 'Action',
        parameters: [],
      },
      'dx10-rollback-probe-function'
    );
    const rollbackProbeBefore = await call('events.instructions.search', {
      extension: ROLLBACK_EXTENSION_NAME,
      query: 'Probe',
      kind: 'action',
      includeHidden: true,
      deprecated: 'include',
      limit: 20,
    });
    assert(
      (rollbackProbeBefore.data.items || []).some(item =>
        String(item.id).includes('Probe')
      ),
      'transaction_probe_metadata_missing_before_rollback'
    );

    const rollback = await call(
      'safety.transactions.rollback',
      { transactionId },
      { timeout: 600000, maxTotalTimeout: 600000 }
    );
    transactionId = null;
    assert(
      rollback.data && rollback.data.rolledBack === true,
      'transaction_rollback_missing'
    );
    const rollbackProbeAfter = await call('events.instructions.search', {
      extension: ROLLBACK_EXTENSION_NAME,
      query: 'Probe',
      kind: 'action',
      includeHidden: true,
      deprecated: 'include',
      limit: 20,
    });
    assert(
      !rollbackProbeAfter.data.items ||
        !rollbackProbeAfter.data.items.some(item =>
          String(item.id).includes('Probe')
        ),
      'transaction_rollback_left_probe_metadata'
    );
    revision = getResponseRevision(await call('project.status'));

    const createArgs = {
      extension_name: EXTENSION_NAME,
      full_name: 'DX10 Localization',
      short_description: 'Localization-like project extension authored via MCP',
      description:
        'Temporary acceptance extension created through typed EditorFunction MCP tools.',
      category: 'Internal',
      tags: 'dx10,localization',
      author: 'GDevelop MCP acceptance',
    };
    const revisionBeforeCreate = revision;
    const createExtension = await mutate(
      'editor.functions.create-extension',
      createArgs,
      'dx10-create-extension'
    );
    const createExtensionOutput = editorOutput(createExtension);
    assert(
      createExtensionOutput.extensionName === EXTENSION_NAME,
      'extension_create_name_mismatch'
    );
    const revisionAfterCreate = revision;

    const replayCreate = await call('editor.functions.create-extension', {
      ...createArgs,
      expectedRevision: revisionBeforeCreate,
      idempotencyKey: 'dx10-create-extension',
    });
    assert(
      replayCreate.meta && replayCreate.meta.idempotencyReplayed === true,
      'extension_create_idempotency_not_replayed'
    );
    const revisionAfterReplay = getResponseRevision(replayCreate);
    assert(
      revisionAfterReplay === revisionAfterCreate,
      'idempotency_replay_changed_revision'
    );
    revision = revisionAfterReplay;

    await mutate(
      'editor.functions.change-extension-properties',
      {
        extension_name: EXTENSION_NAME,
        changed_properties: [
          {
            property_name: 'description',
            new_value:
              'Localization-like extension updated through typed MCP authoring.',
          },
        ],
      },
      'dx10-change-extension'
    );

    const scope = {
      type: 'extension',
      extension_name: EXTENSION_NAME,
    };
    const functions = [
      {
        function_name: 'Update',
        function_type: 'Action',
        full_name: 'Update localization',
        sentence: 'Update localization state',
        is_async: true,
        parameters: [],
      },
      {
        function_name: 'Has',
        function_type: 'Condition',
        full_name: 'Has translation',
        sentence: 'Translation exists for _PARAM0_',
        is_private: true,
        parameters: [{ name: 'Key', type: 'string', label: 'Key' }],
      },
      {
        function_name: 'Text',
        function_type: 'StringExpression',
        full_name: 'Localized text',
        parameters: [{ name: 'Key', type: 'string', label: 'Key' }],
      },
      {
        function_name: 'Count',
        function_type: 'Expression',
        expression_type: 'number',
        full_name: 'Translation count',
        parameters: [{ name: 'Key', type: 'string', label: 'Key' }],
      },
    ];

    const createOutputs = {};
    for (const spec of functions) {
      const created = await mutate(
        'editor.functions.create-custom-function',
        { scope, ...spec },
        `dx10-create-function-${spec.function_name}`
      );
      createOutputs[spec.function_name] = editorOutput(created);
    }

    await mutate(
      'editor.functions.create-custom-function',
      {
        scope,
        function_name: 'Obsolete',
        function_type: 'Action',
        parameters: [],
      },
      'dx10-create-obsolete'
    );
    await mutate(
      'editor.functions.change-custom-function',
      {
        scope,
        function_name: 'Obsolete',
        delete_this_function: true,
      },
      'dx10-delete-obsolete'
    );

    await mutate(
      'editor.functions.change-custom-function',
      {
        scope,
        function_name: 'Has',
        changed_settings: [
          { setting_name: 'isPrivate', new_value: false },
          {
            setting_name: 'description',
            new_value: 'Checks whether a translation key is available.',
          },
        ],
      },
      'dx10-change-has'
    );

    const commentDescription = await call('events.nodes.describe', {
      type: 'BuiltinCommonInstructions::Comment',
    });
    const commentExample =
      commentDescription.data &&
      commentDescription.data.item &&
      commentDescription.data.item.canonicalExample;
    assert(commentExample, 'comment_canonical_example_missing');

    for (const spec of functions) {
      const target = {
        kind: 'extension-function',
        extensionName: EXTENSION_NAME,
        functionName: spec.function_name,
      };
      const beforeEvents = await call('events.read', { target });
      const comment = clone(commentExample);
      comment.comment = `DX-10 authored ${spec.function_name} through MCP.`;
      await mutate(
        'events.insert',
        {
          target,
          expectedEventsRevision: beforeEvents.data.eventsRevision,
          eventsJson: [comment],
        },
        `dx10-events-${spec.function_name}`
      );
      const afterEvents = await call('events.read', { target });
      assert(
        afterEvents.data &&
          Array.isArray(afterEvents.data.eventsJson) &&
          afterEvents.data.eventsJson.some(
            event =>
              event.type === 'BuiltinCommonInstructions::Comment' &&
              event.comment === comment.comment
          ),
        `function_events_missing:${spec.function_name}`
      );
    }

    const inspection = editorOutput(
      await call('editor.functions.inspect-extension', {
        extension_name: EXTENSION_NAME,
      })
    );
    const inspectionText = JSON.stringify(inspection);
    for (const name of ['Update', 'Has', 'Text', 'Count']) {
      assert(inspectionText.includes(name), `inspect_missing_function:${name}`);
    }
    assert(
      !inspectionText.includes('Obsolete'),
      'deleted_function_still_inspected'
    );

    const actionMetadata = await call('events.instructions.search', {
      extension: EXTENSION_NAME,
      query: 'Update',
      kind: 'action',
      includeHidden: true,
      deprecated: 'include',
      limit: 50,
    });
    const conditionMetadata = await call('events.instructions.search', {
      extension: EXTENSION_NAME,
      query: 'Has',
      kind: 'condition',
      includeHidden: true,
      deprecated: 'include',
      limit: 50,
    });
    const expressionMetadata = await call('events.instructions.search', {
      extension: EXTENSION_NAME,
      query: 'Text',
      kind: 'expression',
      includeHidden: true,
      deprecated: 'include',
      limit: 50,
    });
    const numberMetadata = await call('events.instructions.search', {
      extension: EXTENSION_NAME,
      query: 'Count',
      kind: 'expression',
      includeHidden: true,
      deprecated: 'include',
      limit: 50,
    });

    const actionItem = (actionMetadata.data.items || []).find(item =>
      String(item.id).includes('Update')
    );
    const conditionItem = (conditionMetadata.data.items || []).find(item =>
      String(item.id).includes('Has')
    );
    const textItem = (expressionMetadata.data.items || []).find(item =>
      String(item.id).includes('Text')
    );
    const numberItem = (numberMetadata.data.items || []).find(item =>
      String(item.id).includes('Count')
    );
    assert(actionItem, 'generated_action_metadata_missing');
    assert(conditionItem, 'generated_condition_metadata_missing');
    assert(
      textItem && textItem.returnType === 'string',
      'string_expression_metadata_missing'
    );
    assert(
      numberItem && numberItem.returnType === 'number',
      'number_expression_metadata_missing'
    );
    assert(
      Array.isArray(textItem.parameters) &&
        textItem.parameters.some(
          parameter => parameter.type === 'string' && !parameter.codeOnly
        ),
      'string_expression_parameter_metadata_missing'
    );

    const callForms = [
      ...(createOutputs.Update.callForms || []),
      ...(createOutputs.Has.callForms || []),
      ...(createOutputs.Text.callForms || []),
      ...(createOutputs.Count.callForms || []),
    ];
    assert(
      callForms.some(form => form.includes(`${EXTENSION_NAME}::Text`)),
      'localization_text_call_form_missing'
    );
    assert(
      callForms.some(form => form.includes(`${EXTENSION_NAME}::Has`)),
      'localization_has_call_form_missing'
    );

    await mutate(
      'editor.functions.create-extension',
      {
        extension_name: DELETE_EXTENSION_NAME,
        full_name: 'Delete me',
      },
      'dx10-create-delete-extension'
    );
    await mutate(
      'editor.functions.change-extension-properties',
      {
        extension_name: DELETE_EXTENSION_NAME,
        delete_this_extension: true,
      },
      'dx10-delete-extension'
    );

    const validation = await call('validation.run', {
      includeNativeReport: true,
      includeAssets: true,
    });
    const validationErrors =
      validation.data &&
      validation.data.summary &&
      Number.isInteger(validation.data.summary.errors)
        ? validation.data.summary.errors
        : validation.data && Array.isArray(validation.data.errors)
        ? validation.data.errors.length
        : 0;
    assert(validationErrors === 0, 'dx10_validation_has_errors');

    await call('project.save-as', {
      filePath: savePath,
      name: 'DX10 Extension Authoring Acceptance',
    });
    assert(fs.existsSync(savePath), 'dx10_explicit_save_missing');

    const evidence = sanitizeForReplay({
      kind: 'dx10-project-extension-authoring',
      label,
      protocolVersion: session.protocolVersion,
      authoringSurface: {
        createExtension: 'editor.functions.create-extension',
        changeExtension: 'editor.functions.change-extension-properties',
        createFunction: 'editor.functions.create-custom-function',
        changeFunction: 'editor.functions.change-custom-function',
        functionEvents: 'events.insert target=extension-function',
        directProjectJsonEdit: false,
        externalImportBootstrap: false,
      },
      typedSchema: {
        functionTypes: createSchema.properties.function_type.enum,
        expressionTypes: createSchema.properties.expression_type.enum,
        parameterTypes:
          createSchema.properties.parameters.items.properties.type.enum,
      },
      functions: {
        callForms,
        actionId: actionItem.id,
        conditionId: conditionItem.id,
        stringExpressionId: textItem.id,
        stringReturnType: textItem.returnType,
        numberExpressionId: numberItem.id,
        numberReturnType: numberItem.returnType,
      },
      validationErrors,
      explicitSave: true,
      transactionRollback: true,
      idempotencyReplay: true,
      replay,
    });
    fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);

    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          label,
          protocolVersion: session.protocolVersion,
          extensionName: EXTENSION_NAME,
          functions: {
            action: actionItem.id,
            condition: conditionItem.id,
            stringExpression: {
              id: textItem.id,
              returnType: textItem.returnType,
            },
            numberExpression: {
              id: numberItem.id,
              returnType: numberItem.returnType,
            },
          },
          callForms,
          validationErrors,
          idempotencyReplay: true,
          transactionRollback: true,
          directProjectJsonEdit: false,
          externalImportBootstrap: false,
          evidencePath,
        },
        null,
        2
      )}\n`
    );
    return evidence;
  } finally {
    if (transactionId && session) {
      try {
        await session.call(
          'safety.transactions.rollback',
          { transactionId },
          { timeout: 600000, maxTotalTimeout: 600000 }
        );
      } catch (_) {}
    }
    if (session) {
      try {
        await session.close();
      } catch (_) {}
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
};

if (require.main === module) {
  const args = process.argv.slice(2);
  let label = 'live';
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--label') label = args[++index];
    else throw new Error(`unknown_argument:${args[index]}`);
  }
  run({ label }).catch(error => {
    console.error(error && error.stack ? error.stack : String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  DELETE_EXTENSION_NAME,
  EXTENSION_NAME,
  SCENE_NAME,
  run,
};
