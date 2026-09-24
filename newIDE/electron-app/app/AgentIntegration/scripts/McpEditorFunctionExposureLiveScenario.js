const { connectLiveGDevelopMcp } = require('./McpClient');

const REQUIRED_REGRESSION_FUNCTIONS = [
  'create_extension',
  'create_custom_function',
  'add_or_edit_variable',
];

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const compactExposure = metadata => ({
  executableInEmbeddedApi: metadata.executableInEmbeddedApi,
  executionScope: metadata.executionScope,
  readOnly: metadata.readOnly,
  exposure: metadata.exposure,
  capabilities: metadata.capabilities,
});

const run = async ({ label = 'live' } = {}) => {
  const session = await connectLiveGDevelopMcp({
    clientId: `gdevelop-dx15-exposure-${label}`,
  });

  try {
    const tools = await session.listTools();
    const listed = await session.call('editor.functions.list', {
      executableOnly: false,
    });
    assert(!listed.isError, 'editor_functions_list_failed');
    const data = listed.data || {};
    const functions = Array.isArray(data.functions) ? data.functions : [];
    const stats = data.stats || {};
    assert(functions.length > 0, 'empty_editor_function_inventory');
    assert(
      functions.length === stats.count,
      'editor_function_inventory_stats_mismatch'
    );

    const byName = new Map(functions.map(item => [item.name, item]));
    REQUIRED_REGRESSION_FUNCTIONS.forEach(name => {
      assert(byName.has(name), `missing_regression_function:${name}`);
    });

    let expectedTypedToolCount = 0;
    functions.forEach(metadata => {
      assert(
        metadata.exposure &&
          metadata.exposure.discovery &&
          metadata.exposure.discovery.listed === true &&
          metadata.exposure.discovery.describable === true,
        `missing_discovery_exposure:${metadata.name}`
      );
      const typed = metadata.exposure.typedTool;
      assert(
        typed && typeof typed.available === 'boolean',
        `missing_typed_exposure:${metadata.name}`
      );
      if (typed.available) {
        expectedTypedToolCount += 1;
        assert(
          typeof typed.toolName === 'string' &&
            tools.some(tool => tool.name === typed.toolName),
          `missing_typed_tool:${metadata.name}`
        );
      } else if (typed.toolName) {
        throw new Error(
          `unavailable_function_has_typed_tool_name:${metadata.name}`
        );
      }
    });

    const typedToolCount = tools.filter(tool =>
      functions.some(
        metadata =>
          metadata.exposure.typedTool.available &&
          metadata.exposure.typedTool.toolName === tool.name
      )
    ).length;
    assert(
      typedToolCount === expectedTypedToolCount,
      'typed_tool_inventory_mismatch'
    );

    const createExtension = byName.get('create_extension');
    const createCustomFunction = byName.get('create_custom_function');
    for (const metadata of [createExtension, createCustomFunction]) {
      assert(
        metadata.exposure.genericCall.available === true &&
          metadata.exposure.typedTool.available === true &&
          metadata.exposure.runScript.available === true,
        `extension_authoring_not_fully_exposed:${metadata.name}`
      );
      assert(
        metadata.exposure.readOnlyRunScript.available === false &&
          metadata.exposure.readOnlyRunScript.hiddenReason ===
            'mutating-function-in-read-only-script',
        `extension_authoring_read_only_policy_drift:${metadata.name}`
      );
    }

    const variables = byName.get('add_or_edit_variable');
    assert(
      !variables.capabilities.includes('rename') &&
        !variables.capabilities.includes('move'),
      'variable_capability_drift_rename_move'
    );
    assert(
      /Create, update or delete/.test(variables.description),
      'variable_description_not_truthful'
    );

    const searchDocs = byName.get('search_docs');
    assert(searchDocs, 'missing_search_docs_metadata');
    assert(
      searchDocs.exposure.genericCall.available === false &&
        searchDocs.exposure.genericCall.hiddenReason ===
          'generation-service-only' &&
        searchDocs.exposure.typedTool.available === false,
      'generation_service_exposure_drift'
    );

    const runScript = byName.get('run_script');
    assert(runScript, 'missing_run_script_metadata');
    assert(
      runScript.exposure.runScript.available === false &&
        runScript.exposure.runScript.hiddenReason ===
          'recursive-script-execution-disabled',
      'run_script_recursion_policy_drift'
    );

    const initializeProject = byName.get('initialize_project');
    assert(initializeProject, 'missing_initialize_project_metadata');
    assert(
      initializeProject.exposure.genericCall.available === true &&
        initializeProject.exposure.runScript.available === false &&
        initializeProject.exposure.runScript.hiddenReason ===
          'project-bootstrap-outside-script',
      'initialize_project_exposure_drift'
    );

    const snapshot = {
      label,
      protocolVersion: session.protocolVersion,
      toolCount: tools.length,
      functionCount: functions.length,
      stats,
      typedToolCount,
      regressionFunctions: {
        create_extension: compactExposure(createExtension),
        create_custom_function: compactExposure(createCustomFunction),
        add_or_edit_variable: compactExposure(variables),
        search_docs: compactExposure(searchDocs),
        run_script: compactExposure(runScript),
        initialize_project: compactExposure(initializeProject),
      },
    };

    process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
    return snapshot;
  } finally {
    await session.close();
  }
};

if (require.main === module) {
  const labelIndex = process.argv.indexOf('--label');
  const label =
    labelIndex >= 0 && process.argv[labelIndex + 1]
      ? process.argv[labelIndex + 1]
      : 'live';
  run({ label }).catch(error => {
    console.error(error && error.stack ? error.stack : String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  REQUIRED_REGRESSION_FUNCTIONS,
  run,
};
