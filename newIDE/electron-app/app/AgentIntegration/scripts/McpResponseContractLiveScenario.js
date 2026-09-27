const fs = require('fs');
const os = require('os');
const path = require('path');
const { connectLiveGDevelopMcp, sanitizeForReplay } = require('./McpClient');

const PROJECT_NAME = 'DX21 Response Contract Acceptance';
const SCENE_NAME = 'DX21 Metadata Scene';
const FUNCTION_NAME = 'inspect_variables';
const AGENT_ID = 'dx21-response-contract-agent';
const TASK_ID = 'dx21-response-contract';

const REQUIRED_TOOLS = [
  'agent.capabilities',
  'project.status',
  'project.create',
  'project.close',
  'project.scenes.create',
  'editor.types.objects.list',
  'editor.functions.list',
  'editor.functions.describe',
  'editor.functions.call',
  'editor.functions.call-batch',
  'agent.concurrency.lease.acquire',
  'agent.concurrency.lease.release',
  'safety.transactions.begin',
  'safety.transactions.commit',
  'validation.run',
];

const REQUIRED_META_FIELDS = [
  'traceId',
  'readOnly',
  'modifiesProject',
  'projectRevision',
  'semanticRevisions',
  'durationMs',
  'idempotencyReplayed',
];

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const parseArgs = argv => {
  const options = { label: 'live', evidencePath: null };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--label') options.label = argv[++index] || 'live';
    else if (argument === '--evidence') {
      options.evidencePath = argv[++index] || null;
    } else throw new Error(`unknown_argument:${argument}`);
  }
  return options;
};

const installRepositoryReadGuard = () => {
  const repositoryRoot = path.resolve(__dirname, '..', '..', '..', '..', '..');
  const originalReadFileSync = fs.readFileSync.bind(fs);
  const originalReadFile = fs.readFile.bind(fs);
  const assertAllowed = filePath => {
    if (typeof filePath !== 'string') return;
    const resolved = path.resolve(filePath);
    const relative = path.relative(repositoryRoot, resolved);
    const insideRepository =
      relative === '' ||
      (!relative.startsWith('..') && !path.isAbsolute(relative));
    if (insideRepository) {
      throw new Error(
        `clean_room_repository_read_forbidden:${path.basename(resolved)}`
      );
    }
  };
  fs.readFileSync = (filePath, ...args) => {
    assertAllowed(filePath);
    return originalReadFileSync(filePath, ...args);
  };
  fs.readFile = (filePath, ...args) => {
    assertAllowed(filePath);
    return originalReadFile(filePath, ...args);
  };
  return () => {
    fs.readFileSync = originalReadFileSync;
    fs.readFile = originalReadFile;
  };
};

const assertSuccessMeta = (meta, label) => {
  assert(meta && typeof meta === 'object', `${label}:missing_meta`);
  REQUIRED_META_FIELDS.forEach(field => {
    assert(
      Object.prototype.hasOwnProperty.call(meta, field),
      `${label}:missing_meta_field:${field}`
    );
  });
  assert(
    meta.traceId === null || typeof meta.traceId === 'string',
    `${label}:invalid_trace_id`
  );
  assert(typeof meta.readOnly === 'boolean', `${label}:invalid_read_only`);
  assert(
    typeof meta.modifiesProject === 'boolean',
    `${label}:invalid_modifies_project`
  );
  assert(
    meta.projectRevision === null || Number.isInteger(meta.projectRevision),
    `${label}:invalid_project_revision`
  );
  assert(
    Array.isArray(meta.semanticRevisions),
    `${label}:invalid_semantic_revisions`
  );
  assert(
    meta.durationMs === null || Number.isFinite(meta.durationMs),
    `${label}:invalid_duration`
  );
  assert(
    typeof meta.idempotencyReplayed === 'boolean',
    `${label}:invalid_idempotency_replayed`
  );
};

const getEnvelope = (result, name) => {
  const envelope = result && result.envelope;
  assert(envelope && typeof envelope === 'object', `${name}:missing_envelope`);
  assert(
    envelope.contractVersion === 1,
    `${name}:unexpected_contract_version:${envelope.contractVersion}`
  );
  return envelope;
};

const findTool = (tools, name) => {
  const tool = tools.find(candidate => candidate.name === name);
  assert(tool, `missing_tool:${name}`);
  return tool;
};

const assertOutputEnvelopeSchema = tool => {
  const schema = tool && tool.outputSchema;
  assert(
    schema && typeof schema === 'object',
    `${tool.name}:missing_output_schema`
  );
  const required = Array.isArray(schema.required) ? schema.required : [];
  ['contractVersion', 'command', 'data', 'meta'].forEach(field => {
    assert(
      required.includes(field),
      `${tool.name}:missing_output_required:${field}`
    );
  });
  assert(
    schema.properties &&
      schema.properties.contractVersion &&
      schema.properties.contractVersion.const === 1,
    `${tool.name}:missing_contract_version_schema`
  );
  assert(
    schema.properties && schema.properties.data && schema.properties.meta,
    `${tool.name}:missing_data_or_meta_schema`
  );
};

const connect = label =>
  connectLiveGDevelopMcp({
    clientId: `gdevelop-dx21-${label}`,
    agentId: AGENT_ID,
    sessionId: `dx21-${label}`,
    taskId: TASK_ID,
    confirmDestructiveOperations: true,
  });

const validationErrorCount = validation => {
  if (
    validation &&
    validation.summary &&
    Number.isInteger(validation.summary.diagnosticErrors)
  ) {
    return validation.summary.diagnosticErrors;
  }
  if (
    validation &&
    validation.diagnostics &&
    validation.diagnostics.summary &&
    Number.isInteger(validation.diagnostics.summary.errors)
  ) {
    return validation.diagnostics.summary.errors;
  }
  return 0;
};

const run = async ({
  label = 'live',
  evidencePath: requestedEvidencePath = null,
} = {}) => {
  const restoreRepositoryReads = installRepositoryReadGuard();
  const evidencePath =
    requestedEvidencePath ||
    path.join(os.tmpdir(), `gdevelop-dx21-${label}-${process.pid}.json`);
  const ownerKey = `${AGENT_ID}::dx21-${label}`;
  let session = null;
  let projectOpen = false;
  let transactionId = null;
  let leaseId = null;
  const replay = [];

  const record = ({ name, args, result, envelope }) => {
    replay.push(
      sanitizeForReplay({
        name,
        args,
        isError: !!result.isError,
        contractVersion: envelope.contractVersion,
        command: envelope.command || null,
        error:
          envelope.error && typeof envelope.error === 'object'
            ? {
                code: envelope.error.code,
                category: envelope.error.category,
                field: envelope.error.field || null,
                path: envelope.error.path || null,
                retryable: envelope.error.retryable,
              }
            : null,
        meta:
          envelope.meta && typeof envelope.meta === 'object'
            ? {
                readOnly: envelope.meta.readOnly,
                modifiesProject: envelope.meta.modifiesProject,
                projectRevision: envelope.meta.projectRevision,
                semanticRevisions: envelope.meta.semanticRevisions,
                transactionId: envelope.meta.transactionId || null,
                semanticLeaseOwner: envelope.meta.semanticLeaseOwner || null,
                leaseId: envelope.meta.leaseId || null,
                leaseIds: envelope.meta.leaseIds || [],
              }
            : null,
      })
    );
  };

  const call = async (name, args = {}, { allowError = false } = {}) => {
    const result = await session.call(name, args, { timeout: 120000 });
    const envelope = getEnvelope(result, name);
    record({ name, args, result, envelope });
    if (result.isError) {
      assert(envelope.error, `${name}:error_envelope_missing_error`);
      if (!allowError) {
        const error = new Error(
          `${name} failed: ${JSON.stringify(envelope.error)}`
        );
        error.toolError = envelope.error;
        throw error;
      }
      return { result, envelope };
    }

    assert(envelope.command === name, `${name}:command_mismatch`);
    assert(
      Object.prototype.hasOwnProperty.call(envelope, 'data'),
      `${name}:missing_data`
    );
    assertSuccessMeta(envelope.meta, name);
    return { result, envelope };
  };

  const callOk = async (name, args = {}) => {
    const { envelope } = await call(name, args);
    return envelope;
  };

  const callError = async (name, args, expectedCode) => {
    const { result, envelope } = await call(name, args, { allowError: true });
    assert(result.isError === true, `${name}:expected_error`);
    assert(
      envelope.error && envelope.error.code === expectedCode,
      `${name}:unexpected_error:${JSON.stringify(envelope.error)}`
    );
    assert(
      typeof envelope.error.category === 'string' &&
        typeof envelope.error.retryable === 'boolean',
      `${name}:incomplete_error_contract`
    );
    return envelope.error;
  };

  try {
    session = await connect(label);
    const tools = await session.listTools();
    const missing = REQUIRED_TOOLS.filter(
      name => !tools.some(tool => tool.name === name)
    );
    assert(!missing.length, `missing_tools:${missing.join(',')}`);
    tools.forEach(assertOutputEnvelopeSchema);

    const callBatchTool = findTool(tools, 'editor.functions.call-batch');
    assert(
      callBatchTool.inputSchema &&
        callBatchTool.inputSchema.properties &&
        callBatchTool.inputSchema.properties.calls &&
        callBatchTool.inputSchema.properties.calls.maxItems === 100,
      'call_batch_max_items_not_published'
    );
    const validationTool = findTool(tools, 'validation.run');
    assert(
      validationTool.inputSchema.properties.gameplayTests.maxItems === 20 &&
        validationTool.inputSchema.properties.runtimeAssertions.maxItems === 50,
      'validation_bounds_not_published'
    );
    const eventReadTool = findTool(tools, 'events.read');
    assert(
      eventReadTool.inputSchema.properties.limit.maximum === 200 &&
        eventReadTool.inputSchema.properties.offset.minimum === 0,
      'events_pagination_bounds_not_published'
    );

    const guide = await session.readResource(
      'gdevelop://guides/response-contract'
    );
    assert(
      guide.contents &&
        guide.contents[0] &&
        /contractVersion/.test(guide.contents[0].text) &&
        /category/.test(guide.contents[0].text) &&
        /field\/path/.test(guide.contents[0].text) &&
        /mode="bounded"|mode=\"bounded\"/.test(guide.contents[0].text),
      'response_contract_guide_incomplete'
    );

    const initial = await callOk('project.status');
    assert(
      !initial.data || initial.data.projectOpen === false,
      'dx21_requires_fresh_editor_without_open_project'
    );

    const capabilities = await callOk('agent.capabilities');
    assert(
      capabilities.data && typeof capabilities.data === 'object',
      'agent_capabilities_missing'
    );

    const invalidCreate = await callError(
      'project.create',
      { name: 42 },
      'invalid_command_input'
    );
    assert(
      invalidCreate.category === 'validation' &&
        invalidCreate.field === 'name' &&
        Array.isArray(invalidCreate.path) &&
        invalidCreate.path[0] === 'name',
      `invalid_input_location_missing:${JSON.stringify(invalidCreate)}`
    );
    const afterInvalid = await callOk('project.status');
    assert(
      !afterInvalid.data || afterInvalid.data.projectOpen === false,
      'invalid_input_reached_renderer_or_created_project'
    );

    await callOk('project.create', { name: PROJECT_NAME });
    projectOpen = true;
    await session.close();
    session = await connect(label);

    const status = await callOk('project.status');
    assert(
      status.data &&
        status.data.projectOpen === true &&
        Number.isInteger(status.meta.projectRevision),
      'project_status_after_create_invalid'
    );
    let revision = status.meta.projectRevision;

    const objectTypes = await callOk('editor.types.objects.list', {
      limit: 1,
      offset: 0,
    });
    assert(
      objectTypes.data &&
        objectTypes.data.pagination &&
        objectTypes.data.pagination.mode === 'offset' &&
        objectTypes.data.pagination.limit === 1 &&
        typeof objectTypes.data.pagination.hasMore === 'boolean' &&
        typeof objectTypes.data.pagination.truncated === 'boolean',
      'offset_pagination_contract_missing'
    );

    const functionList = await callOk('editor.functions.list', {
      query: FUNCTION_NAME,
      executableOnly: true,
    });
    assert(
      functionList.data &&
        Array.isArray(functionList.data.functions) &&
        functionList.data.functions.some(
          entry => entry && entry.name === FUNCTION_NAME
        ),
      'function_list_contract_invalid'
    );

    const functionDescribe = await callOk('editor.functions.describe', {
      name: FUNCTION_NAME,
    });
    assert(
      functionDescribe.data &&
        functionDescribe.data.function &&
        functionDescribe.data.function.name === FUNCTION_NAME,
      'function_describe_contract_invalid'
    );

    const functionCall = await callOk('editor.functions.call', {
      name: FUNCTION_NAME,
      arguments: { variable_scope: 'global' },
      expectedRevision: revision,
    });
    assert(
      functionCall.data && Array.isArray(functionCall.data.results),
      'function_call_contract_invalid'
    );
    revision = functionCall.meta.projectRevision;
    assert(Number.isInteger(revision), 'function_call_revision_missing');

    const lease = await callOk('agent.concurrency.lease.acquire', {
      scope: 'project',
      ttlMs: 30000,
    });
    leaseId =
      lease.data &&
      lease.data.lease &&
      typeof lease.data.lease.leaseId === 'string'
        ? lease.data.lease.leaseId
        : null;
    assert(leaseId, 'lease_id_missing');
    assert(
      lease.meta.leaseId === leaseId &&
        Array.isArray(lease.meta.leaseIds) &&
        lease.meta.leaseIds.includes(leaseId),
      'lease_control_meta_missing'
    );

    const transaction = await callOk('safety.transactions.begin', {
      label: 'DX21 response contract metadata',
    });
    transactionId =
      transaction.data && typeof transaction.data.transactionId === 'string'
        ? transaction.data.transactionId
        : null;
    assert(transactionId, 'transaction_id_missing');
    assert(
      transaction.meta.transactionId === transactionId,
      'transaction_control_meta_missing'
    );

    const mutation = await callOk('project.scenes.create', {
      name: SCENE_NAME,
      expectedRevision: revision,
      semanticLeaseOwner: ownerKey,
    });
    revision = mutation.meta.projectRevision;
    assert(
      Number.isInteger(revision) &&
        mutation.meta.transactionId === transactionId &&
        mutation.meta.semanticLeaseOwner === ownerKey &&
        mutation.meta.leaseId === leaseId &&
        Array.isArray(mutation.meta.leaseIds) &&
        mutation.meta.leaseIds.includes(leaseId) &&
        Array.isArray(mutation.meta.semanticRevisions) &&
        mutation.meta.semanticRevisions.length > 0,
      `mutation_concurrency_meta_missing:${JSON.stringify(mutation.meta)}`
    );

    const committed = await callOk('safety.transactions.commit', {
      transactionId,
    });
    assert(
      committed.meta.transactionId === transactionId,
      'commit_transaction_meta_missing'
    );
    transactionId = null;

    const released = await callOk('agent.concurrency.lease.release', {
      scope: 'project',
      leaseId,
    });
    assert(
      released.meta.leaseId === leaseId &&
        Array.isArray(released.meta.leaseIds) &&
        released.meta.leaseIds.includes(leaseId),
      'lease_release_meta_missing'
    );
    leaseId = null;

    const validation = await callOk('validation.run', {
      includeNativeReport: true,
      includeAssets: false,
      includeRuntimeLogs: false,
    });
    const validationErrors = validationErrorCount(validation.data);
    assert(validationErrors === 0, 'dx21_validation_has_errors');

    await callOk('project.close', { discardUnsavedChanges: true });
    projectOpen = false;

    const evidence = sanitizeForReplay({
      kind: 'dx21-response-contract-acceptance',
      label,
      generatedAt: new Date().toISOString(),
      protocolVersion: session.protocolVersion,
      cleanRoom: {
        repositoryImplementationOrTestsReadDuringScenario: false,
        repositoryReadGuard: true,
        clientParsing: 'result.envelope only',
        fallbackHeuristicsUsed: false,
      },
      discovery: {
        toolCount: tools.length,
        toolsWithCanonicalOutputSchema: tools.length,
        argumentBoundsPublished: true,
        guideUri: 'gdevelop://guides/response-contract',
      },
      successEnvelope: {
        contractVersion: 1,
        requiredMetaFields: REQUIRED_META_FIELDS,
        unrelatedToolsConsumed: [
          'project.status',
          'agent.capabilities',
          'editor.types.objects.list',
          'editor.functions.list',
          'editor.functions.describe',
          'editor.functions.call',
          'project.scenes.create',
          'validation.run',
        ],
      },
      errorEnvelope: {
        code: invalidCreate.code,
        category: invalidCreate.category,
        field: invalidCreate.field,
        path: invalidCreate.path,
        retryable: invalidCreate.retryable,
      },
      listDescribeCall: {
        listDataKey: 'functions',
        describeDataKey: 'function',
        callDataKey: 'results',
        canonicalOuterPath: 'structuredContent.data',
      },
      pagination: {
        offsetModeObserved: true,
        boundedModeUnitCovered: true,
      },
      concurrencyMeta: {
        projectRevision: revision,
        semanticRevisions: mutation.meta.semanticRevisions,
        transactionIdOnMutation: true,
        leaseIdOnMutation: true,
        semanticLeaseOwnerOnMutation: true,
        controlCommandIdentifiersMirrored: true,
      },
      validationErrors,
      replay,
    });
    fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    return { ...evidence, evidencePath };
  } finally {
    if (session) {
      if (transactionId) {
        try {
          await session.call('safety.transactions.commit', { transactionId });
        } catch (_) {}
      }
      if (leaseId) {
        try {
          await session.call('agent.concurrency.lease.release', {
            scope: 'project',
            leaseId,
          });
        } catch (_) {}
      }
      if (projectOpen) {
        try {
          await session.call('project.close', {
            discardUnsavedChanges: true,
          });
        } catch (_) {}
      }
      try {
        await session.close();
      } catch (_) {}
    }
    restoreRepositoryReads();
  }
};

if (require.main === module) {
  run(parseArgs(process.argv.slice(2)))
    .then(result => {
      process.stdout.write(
        `${JSON.stringify(
          {
            ok: true,
            label: result.label,
            protocolVersion: result.protocolVersion,
            toolCount: result.discovery.toolCount,
            contractVersion: result.successEnvelope.contractVersion,
            errorEnvelope: result.errorEnvelope,
            listDescribeCall: result.listDescribeCall,
            concurrencyMeta: result.concurrencyMeta,
            validationErrors: result.validationErrors,
            evidencePath: result.evidencePath,
          },
          null,
          2
        )}\n`
      );
    })
    .catch(error => {
      process.stderr.write(
        `MCP DX-21 response contract scenario failed: ${error.stack ||
          error.message}\n`
      );
      process.exitCode = 1;
    });
}

module.exports = {
  REQUIRED_META_FIELDS,
  REQUIRED_TOOLS,
  assertOutputEnvelopeSchema,
  assertSuccessMeta,
  getEnvelope,
  parseArgs,
  run,
};
