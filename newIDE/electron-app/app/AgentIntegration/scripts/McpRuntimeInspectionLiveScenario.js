const fs = require('fs');
const os = require('os');
const path = require('path');
const { connectLiveGDevelopMcp, sanitizeForReplay } = require('./McpClient');

const SCENE_NAME = 'DX12RuntimeInspection';
const TEXT_OBJECT_NAME = 'RuleText';

const wait = milliseconds =>
  new Promise(resolve => setTimeout(resolve, milliseconds));

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const getRevision = result => {
  const revision =
    result && result.meta && Number.isInteger(result.meta.projectRevision)
      ? result.meta.projectRevision
      : result &&
        result.structuredContent &&
        result.structuredContent.meta &&
        Number.isInteger(result.structuredContent.meta.projectRevision)
      ? result.structuredContent.meta.projectRevision
      : null;
  assert(Number.isInteger(revision), 'dx12_missing_project_revision');
  return revision;
};

const run = async ({
  label = 'live',
  evidencePath = path.join(
    os.tmpdir(),
    `gdevelop-dx12-runtime-inspection-${process.pid}.json`
  ),
} = {}) => {
  const session = await connectLiveGDevelopMcp({
    clientId: `gdevelop-dx12-runtime-inspection-${label}`,
  });
  let transactionId = null;
  let previewStarted = false;
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
    const result = await session.call(name, args);
    record(name, args, result);
    if (result.isError) {
      throw new Error(
        `${name} failed: ${JSON.stringify(
          result.structuredContent || result.content || result.data
        )}`
      );
    }
    return result;
  };

  try {
    const tools = await session.listTools();
    const required = [
      'project.create',
      'project.close',
      'project.status',
      'scene.open',
      'editor.functions.create-scene',
      'editor.functions.create-object',
      'editor.functions.change-object-property',
      'editor.functions.put-2d-instances',
      'editor.functions.add-or-edit-variable',
      'preview.status',
      'preview.start',
      'preview.close-all',
      'runtime.inspect',
      'runtime.assert',
      'runtime.wait-for',
      'validation.run',
      'safety.transactions.begin',
      'safety.transactions.rollback',
    ];
    for (const name of required) {
      assert(
        tools.some(tool => tool.name === name),
        `dx12_missing_tool:${name}`
      );
    }

    const inspectTool = tools.find(tool => tool.name === 'runtime.inspect');
    assert(
      inspectTool &&
        inspectTool.inputSchema &&
        inspectTool.inputSchema.properties &&
        inspectTool.inputSchema.properties.selector,
      'dx12_runtime_inspect_schema_missing'
    );

    const before = await call('project.status');
    if (before.data && before.data.projectOpen) {
      assert(
        before.data.hasUnsavedChanges === false,
        'dx12_requires_clean_or_fresh_editor'
      );
      await call('project.close', {
        expectedRevision:
          before.meta && Number.isInteger(before.meta.projectRevision)
            ? before.meta.projectRevision
            : undefined,
        idempotencyKey: 'dx12-close-clean-auto-open-project',
      });
    }

    await call('project.create', {
      name: 'DX12 Runtime Inspection Acceptance',
      idempotencyKey: 'dx12-create-project',
    });
    const tx = await call('safety.transactions.begin', {
      label: 'DX-12 runtime inspection acceptance',
    });
    transactionId = tx.data && tx.data.transactionId;
    assert(transactionId, 'dx12_transaction_missing');

    const sceneResult = await call('editor.functions.create-scene', {
      scene_name: SCENE_NAME,
      idempotencyKey: 'dx12-create-scene',
    });
    let revision = getRevision(sceneResult);
    const mutate = async (name, args, key) => {
      const result = await call(name, {
        ...args,
        expectedRevision: revision,
        idempotencyKey: key,
      });
      revision = getRevision(result);
      return result;
    };

    await call('scene.open', { sceneName: SCENE_NAME, mode: 'scene' });
    await wait(250);

    await mutate(
      'editor.functions.create-object',
      {
        scene_name: SCENE_NAME,
        object_name: TEXT_OBJECT_NAME,
        object_type: 'TextObject::Text',
        description: 'DX-12 localized runtime text fixture',
      },
      'dx12-create-rule-text'
    );
    await mutate(
      'editor.functions.change-object-property',
      {
        scene_name: SCENE_NAME,
        object_name: TEXT_OBJECT_NAME,
        changed_properties: [
          { property_name: 'text', new_value: 'Cara ou coroa' },
        ],
      },
      'dx12-set-rule-text'
    );
    await mutate(
      'editor.functions.put-2d-instances',
      {
        scene_name: SCENE_NAME,
        layer_name: '',
        brush_kind: 'point',
        brush_position: '320,240',
        object_name: TEXT_OBJECT_NAME,
        new_instances_count: 1,
      },
      'dx12-place-rule-text'
    );
    await mutate(
      'editor.functions.add-or-edit-variable',
      {
        variable_scope: 'global',
        variable_name_or_path: 'Money',
        value: '123',
        variable_type: 'number',
      },
      'dx12-create-money'
    );
    await mutate(
      'editor.functions.add-or-edit-variable',
      {
        variable_scope: 'scene',
        scene_name: SCENE_NAME,
        variable_name_or_path: 'CurrentLanguage',
        value: 'pt-BR',
        variable_type: 'string',
      },
      'dx12-create-language'
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
    assert(validationErrors === 0, 'dx12_validation_has_errors');

    const previewBefore = await call('preview.status');
    if (previewBefore.data && previewBefore.data.running) {
      await call('preview.close-all');
      await wait(300);
    }
    await call('preview.start', { numberOfWindows: 1 });
    previewStarted = true;

    let runtimeReady = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      await wait(attempt === 0 ? 1200 : 350);
      try {
        const ready = await call('runtime.inspect', {
          selector: {
            kind: 'object-count',
            objectName: TEXT_OBJECT_NAME,
          },
        });
        if (ready.data && ready.data.value === 1) {
          runtimeReady = true;
          break;
        }
      } catch (_) {}
    }
    assert(runtimeReady, 'dx12_runtime_preview_not_ready');

    const statusBeforeReadOnly = await call('project.status');
    const revisionBeforeReadOnly = statusBeforeReadOnly.data.projectRevision;

    const money = await call('runtime.inspect', {
      selector: { kind: 'global-variable', path: 'Money' },
    });
    const language = await call('runtime.inspect', {
      selector: { kind: 'scene-variable', path: 'CurrentLanguage' },
    });
    const ruleText = await call('runtime.inspect', {
      selector: {
        kind: 'object-property',
        objectName: TEXT_OBJECT_NAME,
        property: 'text',
      },
    });
    const textAssertion = await call('runtime.assert', {
      condition: {
        selector: {
          kind: 'object-property',
          objectName: TEXT_OBJECT_NAME,
          property: 'text',
        },
        operator: 'contains',
        value: 'coroa',
      },
    });
    const moneyAssertion = await call('runtime.assert', {
      condition: {
        selector: { kind: 'global-variable', path: 'Money' },
        operator: 'equals',
        value: 123,
      },
    });
    const languageWait = await call('runtime.wait-for', {
      condition: {
        selector: { kind: 'scene-variable', path: 'CurrentLanguage' },
        operator: 'equals',
        value: 'pt-BR',
      },
      timeoutMs: 3000,
      intervalMs: 150,
    });

    assert(money.data && money.data.value === 123, 'dx12_money_mismatch');
    assert(
      language.data && language.data.value === 'pt-BR',
      'dx12_language_mismatch'
    );
    assert(
      ruleText.data && ruleText.data.value === 'Cara ou coroa',
      'dx12_rule_text_mismatch'
    );
    assert(
      textAssertion.data && textAssertion.data.passed === true,
      'dx12_text_assertion_failed'
    );
    assert(
      moneyAssertion.data && moneyAssertion.data.passed === true,
      'dx12_money_assertion_failed'
    );
    assert(
      languageWait.data &&
        languageWait.data.passed === true &&
        languageWait.data.timedOut === false,
      'dx12_language_wait_failed'
    );

    const statusAfterReadOnly = await call('project.status');
    const revisionAfterReadOnly = statusAfterReadOnly.data.projectRevision;
    assert(
      revisionAfterReadOnly === revisionBeforeReadOnly,
      `dx12_read_only_revision_changed:${revisionBeforeReadOnly}->${revisionAfterReadOnly}`
    );

    const moneyAfter = await call('runtime.inspect', {
      selector: { kind: 'global-variable', path: 'Money' },
    });
    assert(
      moneyAfter.data && moneyAfter.data.value === 123,
      'dx12_economy_state_changed'
    );

    const evidence = sanitizeForReplay({
      kind: 'dx12-runtime-inspection-acceptance',
      label,
      protocolVersion: session.protocolVersion,
      localization: {
        language: language.data.value,
        ruleText: ruleText.data.value,
        qaJsCodeInstrumentation: false,
        documentTitleInstrumentation: false,
      },
      economy: {
        moneyBefore: money.data.value,
        moneyAfter: moneyAfter.data.value,
        preserved: money.data.value === moneyAfter.data.value,
      },
      selectors: [
        'global-variable',
        'scene-variable',
        'object-count',
        'object-property',
      ],
      assertions: {
        text: textAssertion.data.passed,
        money: moneyAssertion.data.passed,
        waitForLanguage: languageWait.data.passed,
      },
      readOnlyProjectRevision: {
        before: revisionBeforeReadOnly,
        after: revisionAfterReadOnly,
        unchanged: revisionBeforeReadOnly === revisionAfterReadOnly,
      },
      validationErrors,
      replay,
    });
    fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));

    if (previewStarted) {
      await call('preview.close-all');
      previewStarted = false;
    }
    await call('safety.transactions.rollback', { transactionId });
    transactionId = null;

    console.log(
      JSON.stringify(
        {
          ok: true,
          label,
          protocolVersion: session.protocolVersion,
          localization: evidence.localization,
          economy: evidence.economy,
          assertions: evidence.assertions,
          readOnlyProjectRevision: evidence.readOnlyProjectRevision,
          validationErrors,
          evidencePath,
        },
        null,
        2
      )
    );
  } finally {
    if (previewStarted) {
      try {
        await session.call('preview.close-all', {});
      } catch (_) {}
    }
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

module.exports = { run, SCENE_NAME, TEXT_OBJECT_NAME };
