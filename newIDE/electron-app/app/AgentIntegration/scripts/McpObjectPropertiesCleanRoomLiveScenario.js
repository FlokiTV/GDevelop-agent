const fs = require('fs');
const os = require('os');
const path = require('path');
const { connectLiveGDevelopMcp, sanitizeForReplay } = require('./McpClient');

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const getProjectRevision = result => {
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
  const tool = tools.find(candidate => candidate.name === name);
  assert(tool, 'missing_tool:' + name);
  return tool;
};

const extractError = result => {
  if (result && result.structuredContent && result.structuredContent.error) {
    return result.structuredContent.error;
  }
  if (result && result.data && result.data.error) return result.data.error;
  return null;
};

const chooseStringProperty = described => {
  const properties =
    described && described.data && Array.isArray(described.data.properties)
      ? described.data.properties
      : [];
  return (
    properties.find(
      property =>
        property &&
        property.writable === true &&
        property.valueType === 'string' &&
        property.descriptorType &&
        String(property.descriptorType)
          .toLowerCase()
          .includes('string') &&
        !(
          property.constraints &&
          Array.isArray(property.constraints.choices) &&
          property.constraints.choices.length
        )
    ) ||
    properties.find(
      property =>
        property &&
        property.writable === true &&
        property.valueType === 'string' &&
        !(
          property.constraints &&
          Array.isArray(property.constraints.choices) &&
          property.constraints.choices.length
        )
    ) ||
    null
  );
};

const assertPropertyToolSchemas = tools => {
  const describe = findTool(tools, 'objects.properties.describe');
  const set = findTool(tools, 'objects.properties.set');
  const setProperties =
    set.inputSchema && set.inputSchema.properties
      ? set.inputSchema.properties
      : {};
  const changes = setProperties.changes;
  assert(
    changes && changes.type === 'array',
    'property_set_changes_schema_missing'
  );
  assert(
    changes.items &&
      changes.items.type === 'object' &&
      changes.items.properties &&
      changes.items.properties.path &&
      changes.items.properties.value,
    'property_set_change_item_schema_missing'
  );
  assert(
    !set.annotations || set.annotations.readOnlyHint !== true,
    'property_set_must_be_mutating'
  );
  assert(
    !describe.annotations || describe.annotations.readOnlyHint !== false,
    'property_describe_must_be_read_only'
  );
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
        'clean_room_repository_read_forbidden:' + path.basename(resolved)
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

const callOk = async (session, name, args = {}) => {
  const result = await session.call(name, args);
  if (result.isError) {
    const error = extractError(result);
    throw new Error(
      'tool_failed:' +
        name +
        ':' +
        (error && error.code ? error.code : 'unknown') +
        ':' +
        (error && error.message ? error.message : 'no_message')
    );
  }
  return result;
};

const findDiscoverableTextualType = async call => {
  const searched = await call('editor.types.objects.list', {
    query: 'text',
    deprecated: 'exclude',
    renderingMode: '2d',
    limit: 100,
  });
  const candidates =
    searched.data && Array.isArray(searched.data.items)
      ? searched.data.items.filter(
          item => item && item.kind === 'object' && item.renderingMode === '2d'
        )
      : [];
  assert(candidates.length > 0, 'clean_room_textual_object_candidates_missing');

  for (const candidate of candidates) {
    const described = await call('editor.types.objects.describe', {
      type: candidate.type,
      ...(candidate.extension && candidate.extension.name
        ? { extension: candidate.extension.name }
        : {}),
    });
    const properties =
      described.data &&
      described.data.item &&
      Array.isArray(described.data.item.properties)
        ? described.data.item.properties
        : [];
    const hasStringProperty = properties.some(property => {
      const descriptorType = String(
        (property && (property.type || property.descriptorType)) || ''
      ).toLowerCase();
      return descriptorType.includes('string');
    });
    if (hasStringProperty) return candidate;
  }
  throw new Error('clean_room_textual_object_type_not_found');
};

const findResizableObject = async ({ call, mutate, sceneName, suffix }) => {
  const searched = await call('editor.types.objects.list', {
    query: 'tiled',
    deprecated: 'exclude',
    renderingMode: '2d',
    limit: 100,
  });
  const candidates =
    searched.data && Array.isArray(searched.data.items)
      ? searched.data.items.filter(
          item => item && item.kind === 'object' && item.renderingMode === '2d'
        )
      : [];
  assert(candidates.length > 0, 'clean_room_resizable_candidates_missing');

  for (let index = 0; index < Math.min(candidates.length, 12); index++) {
    const candidate = candidates[index];
    const objectName = 'DX24Resizable' + suffix + index;
    await mutate(
      'editor.functions.create-object',
      {
        scene_name: sceneName,
        object_name: objectName,
        object_type: candidate.type,
      },
      'dx24-create-resizable-' + index
    );
    const described = await call('objects.properties.describe', {
      targetKind: 'object-definition',
      sceneName,
      objectName,
    });
    const runtimeProperties =
      described.data && Array.isArray(described.data.runtimeOnlyProperties)
        ? described.data.runtimeOnlyProperties
        : [];
    const width = runtimeProperties.find(
      property => property && property.name === 'width'
    );
    const height = runtimeProperties.find(
      property => property && property.name === 'height'
    );
    if (
      width &&
      height &&
      width.authoritativeMutation &&
      height.authoritativeMutation
    ) {
      return { candidate, objectName, described, width, height };
    }
  }
  throw new Error('clean_room_resizable_capability_not_discovered');
};

const run = async ({
  label = 'live',
  evidencePath = path.join(
    os.tmpdir(),
    'gdevelop-dx24-object-properties-' + process.pid + '.json'
  ),
} = {}) => {
  // The external acceptance actor must learn all authoring details through MCP.
  // Repository implementation/tests are unreadable from this point onward.
  const restoreRepositoryReads = installRepositoryReadGuard();
  let session = null;
  let transactionId = null;
  let createdProject = false;
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

  try {
    session = await connectLiveGDevelopMcp({
      clientId: 'gdevelop-dx24-properties-clean-room-' + label,
    });

    let tools = await session.listTools();
    [
      'project.status',
      'project.create',
      'editor.types.objects.list',
      'editor.types.objects.describe',
      'editor.functions.create-scene',
      'editor.functions.create-object',
      'objects.properties.describe',
      'objects.properties.set',
      'events.instructions.describe',
      'safety.transactions.begin',
      'safety.transactions.rollback',
      'validation.run',
    ].forEach(name => findTool(tools, name));
    assertPropertyToolSchemas(tools);

    const call = async (name, args = {}) => {
      const result = await callOk(session, name, args);
      record(name, args, result);
      return result;
    };

    let status = await call('project.status');
    if (!status.data || status.data.projectOpen !== true) {
      await call('project.create', {
        name: 'DX24 Property Clean Room Acceptance',
        idempotencyKey: 'dx24-clean-room-project',
      });
      createdProject = true;
      await session.close();
      session = await connectLiveGDevelopMcp({
        clientId: 'gdevelop-dx24-properties-clean-room-' + label,
      });
      tools = await session.listTools();
      assertPropertyToolSchemas(tools);
      status = await callOk(session, 'project.status', {});
      record('project.status', {}, status);
    }

    const transaction = await call('safety.transactions.begin', {
      label: 'DX-24 clean-room typed property acceptance',
    });
    transactionId = transaction.data && transaction.data.transactionId;
    assert(transactionId, 'clean_room_transaction_missing');

    let revision = getProjectRevision(status);
    const mutate = async (name, args, key) => {
      const result = await call(name, {
        ...args,
        expectedRevision: revision,
        idempotencyKey: key,
      });
      revision = getProjectRevision(result);
      assert(
        result.meta && result.meta.transactionId === transactionId,
        'mutation_transaction_metadata_missing:' + name
      );
      return result;
    };

    const suffix = Date.now().toString(36);
    const sceneName = 'DX24CleanRoom' + suffix;
    const objectName = 'DX24Textual' + suffix;

    await mutate(
      'editor.functions.create-scene',
      { scene_name: sceneName },
      'dx24-create-scene'
    );

    const textualType = await findDiscoverableTextualType(call);
    await mutate(
      'editor.functions.create-object',
      {
        scene_name: sceneName,
        object_name: objectName,
        object_type: textualType.type,
      },
      'dx24-create-textual-object'
    );

    let described = await call('objects.properties.describe', {
      targetKind: 'object-definition',
      sceneName,
      objectName,
    });
    const discoveredProperty = chooseStringProperty(described);
    assert(discoveredProperty, 'clean_room_writable_string_property_not_found');
    assert(
      discoveredProperty.mutation &&
        discoveredProperty.mutation.command === 'objects.properties.set',
      'clean_room_property_mutation_contract_missing'
    );

    const sentinel = 'DX24 clean-room ' + suffix;
    const changed = await mutate(
      'objects.properties.set',
      {
        targetKind: 'object-definition',
        sceneName,
        objectName,
        changes: [{ path: discoveredProperty.path, value: sentinel }],
      },
      'dx24-set-discovered-property'
    );
    assert(
      changed.data &&
        changed.data.applied &&
        changed.data.applied[0] &&
        changed.data.applied[0].path === discoveredProperty.path,
      'clean_room_property_set_not_applied'
    );

    described = await call('objects.properties.describe', {
      targetKind: 'object-definition',
      sceneName,
      objectName,
    });
    const afterProperty = (described.data.properties || []).find(
      property => property.path === discoveredProperty.path
    );
    assert(
      afterProperty && afterProperty.currentValue === sentinel,
      'clean_room_property_value_not_persisted'
    );

    const invalidType = await session.call('objects.properties.set', {
      targetKind: 'object-definition',
      sceneName,
      objectName,
      changes: [{ path: discoveredProperty.path, value: 24 }],
      expectedRevision: revision,
      idempotencyKey: 'dx24-invalid-type',
    });
    record(
      'objects.properties.set:invalid-type',
      { path: discoveredProperty.path, value: 24 },
      invalidType
    );
    assert(invalidType.isError === true, 'invalid_type_should_fail');
    const invalidTypeError = extractError(invalidType);
    assert(
      invalidTypeError &&
        invalidTypeError.code === 'invalid_property_type' &&
        invalidTypeError.field === 'changes[0].value' &&
        invalidTypeError.path === discoveredProperty.path,
      'invalid_type_field_diagnostics_missing'
    );

    const unknownPath = 'configuration.__dx24_clean_room_unknown__';
    const invalidName = await session.call('objects.properties.set', {
      targetKind: 'object-definition',
      sceneName,
      objectName,
      changes: [{ path: unknownPath, value: 'x' }],
      expectedRevision: revision,
      idempotencyKey: 'dx24-invalid-path',
    });
    record(
      'objects.properties.set:invalid-path',
      { path: unknownPath, value: 'x' },
      invalidName
    );
    assert(invalidName.isError === true, 'invalid_path_should_fail');
    const invalidNameError = extractError(invalidName);
    assert(
      invalidNameError &&
        invalidNameError.code === 'unknown_property_path' &&
        invalidNameError.field === 'changes[0].path' &&
        invalidNameError.path === unknownPath,
      'invalid_path_field_diagnostics_missing'
    );

    const resizable = await findResizableObject({
      call,
      mutate,
      sceneName,
      suffix,
    });
    for (const property of [resizable.width, resizable.height]) {
      assert(
        property.layer === 'runtime-only' &&
          property.writable === false &&
          property.readOnlyReason === 'runtime-capability-backed',
        'resizable_runtime_layer_invalid:' + property.name
      );
      const authoritative = property.authoritativeMutation;
      assert(
        authoritative &&
          authoritative.kind === 'behavior-capability-action' &&
          authoritative.action &&
          authoritative.action.id &&
          authoritative.action.discovery &&
          authoritative.action.discovery.command ===
            'events.instructions.describe' &&
          authoritative.action.authoring &&
          authoritative.action.authoring.command === 'events.patch',
        'resizable_authoritative_path_missing:' + property.name
      );
      const actionDescription = await call(
        authoritative.action.discovery.command,
        authoritative.action.discovery.arguments
      );
      assert(
        actionDescription.data &&
          actionDescription.data.item &&
          actionDescription.data.item.id === authoritative.action.id,
        'resizable_authoritative_action_not_resolvable:' + property.name
      );

      const genericAttempt = await session.call('objects.properties.set', {
        targetKind: 'object-definition',
        sceneName,
        objectName: resizable.objectName,
        changes: [{ path: property.path, value: 320 }],
        expectedRevision: revision,
        idempotencyKey: 'dx24-no-trial-' + property.name,
      });
      record(
        'objects.properties.set:runtime-' + property.name,
        { path: property.path, value: 320 },
        genericAttempt
      );
      assert(
        genericAttempt.isError === true,
        'generic_runtime_property_mutation_should_fail:' + property.name
      );
      const capabilityError = extractError(genericAttempt);
      assert(
        capabilityError &&
          capabilityError.code === 'unsupported_property_mutation' &&
          capabilityError.field === 'changes[0].path' &&
          capabilityError.path === property.path &&
          capabilityError.details &&
          capabilityError.details.authoritativeMutation &&
          capabilityError.details.authoritativeMutation.action &&
          capabilityError.details.authoritativeMutation.action.id ===
            authoritative.action.id,
        'resizable_error_did_not_return_authoritative_path:' + property.name
      );
    }

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
    assert(validationErrors === 0, 'clean_room_validation_has_errors');

    const evidence = sanitizeForReplay({
      kind: 'dx24-object-properties-clean-room',
      generatedAt: new Date().toISOString(),
      cleanRoom: {
        repositoryImplementationOrTestsReadDuringScenario: false,
        repositoryReadGuard: true,
        authoringInputSource: 'live raw MCP responses',
      },
      protocolVersion: session.protocolVersion,
      discovery: {
        textualObjectType: textualType.type,
        propertyPath: discoveredProperty.path,
        propertyValueType: discoveredProperty.valueType,
        resizableObjectType: resizable.candidate.type,
        widthActionId: resizable.width.authoritativeMutation.action.id,
        heightActionId: resizable.height.authoritativeMutation.action.id,
      },
      mutation: {
        sentinel,
        projectRevision: revision,
        transactionId,
      },
      diagnostics: {
        invalidType: {
          code: invalidTypeError.code,
          field: invalidTypeError.field,
          path: invalidTypeError.path,
        },
        invalidPath: {
          code: invalidNameError.code,
          field: invalidNameError.field,
          path: invalidNameError.path,
        },
      },
      validationErrors,
      replay,
    });
    fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));

    await call('safety.transactions.rollback', { transactionId });
    transactionId = null;

    return {
      ok: true,
      createdProject,
      protocolVersion: session.protocolVersion,
      propertyPath: discoveredProperty.path,
      widthActionId: evidence.discovery.widthActionId,
      heightActionId: evidence.discovery.heightActionId,
      invalidType: evidence.diagnostics.invalidType,
      invalidPath: evidence.diagnostics.invalidPath,
      transactionRollback: true,
      validationErrors,
      evidencePath,
    };
  } finally {
    if (session && transactionId) {
      try {
        await session.call('safety.transactions.rollback', { transactionId });
      } catch (_) {}
    }
    if (session) await session.close();
    restoreRepositoryReads();
  }
};

if (require.main === module) {
  let label = 'live';
  let evidencePath;
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--label') label = args[++index];
    else if (args[index] === '--evidence') evidencePath = args[++index];
    else throw new Error('unknown_argument:' + args[index]);
  }
  run({ label, ...(evidencePath ? { evidencePath } : {}) })
    .then(result => {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    })
    .catch(error => {
      process.stderr.write(
        'MCP DX-24 clean-room scenario failed: ' +
          (error && error.stack ? error.stack : String(error)) +
          '\n'
      );
      process.exitCode = 1;
    });
}

module.exports = {
  assertPropertyToolSchemas,
  chooseStringProperty,
  extractError,
  installRepositoryReadGuard,
  run,
};
