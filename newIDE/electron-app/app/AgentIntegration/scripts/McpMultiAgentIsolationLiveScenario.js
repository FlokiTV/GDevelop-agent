const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  Client,
  StreamableHTTPClientTransport,
} = require('@modelcontextprotocol/client');
const {
  getDefaultDiscoveryPath,
  getToolData,
  loadRuntimeConfig,
  makeRequestHeaders,
  sanitizeForReplay,
} = require('./McpClient');

const REQUIRED_TOOLS = [
  'project.status',
  'project.create',
  'project.save-as',
  'project.close',
  'editor.functions.create-scene',
  'agent.concurrency.capabilities',
  'agent.concurrency.status',
  'agent.concurrency.lease.acquire',
  'agent.concurrency.lease.renew',
  'agent.concurrency.lease.release',
  'agent.workspace.temp.capabilities',
  'agent.workspace.temp.create',
  'agent.workspace.temp.status',
  'agent.workspace.temp.write',
  'agent.workspace.temp.read',
  'agent.workspace.temp.list',
  'agent.workspace.temp.release',
  'safety.transactions.status',
  'safety.transactions.begin',
  'safety.transactions.commit',
  'safety.transactions.rollback',
  'validation.run',
];

const IDENTITIES = Object.freeze({
  a: Object.freeze({
    clientId: 'dx19-client-a',
    agentId: 'dx19-agent-a',
    sessionId: 'dx19-session-a',
    taskId: 'dx19-task-a',
    ownerKey: 'dx19-agent-a::dx19-session-a',
  }),
  b: Object.freeze({
    clientId: 'dx19-client-b',
    agentId: 'dx19-agent-b',
    sessionId: 'dx19-session-b',
    taskId: 'dx19-task-b',
    ownerKey: 'dx19-agent-b::dx19-session-b',
  }),
});

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const errorOf = response => {
  const data = getToolData(response);
  return data && data.error && typeof data.error === 'object'
    ? data.error
    : null;
};

const createClient = async ({ runtime, identity }) => {
  const client = new Client(
    { name: identity.clientId, version: '1.0.0' },
    {
      capabilities: { elicitation: { form: {} } },
      versionNegotiation: { mode: { pin: runtime.protocolVersion } },
    }
  );
  client.setRequestHandler('elicitation/create', async request => ({
    action: /rollback|discard|close/i.test(
      String((request.params && request.params.message) || '')
    )
      ? 'accept'
      : 'decline',
    content: { confirm: true },
  }));
  const transport = new StreamableHTTPClientTransport(
    new URL(runtime.endpoint),
    {
      requestInit: {
        headers: makeRequestHeaders({
          token: runtime.token,
          clientId: identity.clientId,
          agentId: identity.agentId,
          sessionId: identity.sessionId,
          taskId: identity.taskId,
        }),
      },
    }
  );
  await client.connect(transport);
  return client;
};

const runMultiAgentIsolationLiveScenario = async ({
  label = 'live',
  env = process.env,
  evidencePath = path.join(
    os.tmpdir(),
    `gdevelop-dx19-multi-agent-${process.pid}.json`
  ),
} = {}) => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gdevelop-dx19-'));
  const runtime = loadRuntimeConfig(getDefaultDiscoveryPath(env));
  const clientA = await createClient({ runtime, identity: IDENTITIES.a });
  const clientB = await createClient({ runtime, identity: IDENTITIES.b });
  let projectOpen = false;
  let transactionId = null;
  const namespaceIds = new Map();
  const replay = [];

  const call = async (clientName, client, name, args = {}, allowError = false) => {
    const response = await client.callTool(
      { name, arguments: args },
      { timeout: 120000 }
    );
    const data = getToolData(response);
    const error = errorOf(response);
    replay.push(
      sanitizeForReplay({
        client: clientName,
        name,
        args,
        ok: !response.isError,
        data:
          data && typeof data === 'object'
            ? {
                ...(data.error ? { error: data.error } : {}),
                ...(data.projectRevision != null
                  ? { projectRevision: data.projectRevision }
                  : {}),
                ...(data.transactionId
                  ? { transactionId: data.transactionId }
                  : {}),
                ...(data.namespaceId ? { namespaceId: data.namespaceId } : {}),
              }
            : null,
        identity:
          response &&
          response._meta &&
          response._meta['gdevelop/identity']
            ? response._meta['gdevelop/identity']
            : null,
      })
    );
    if (response.isError && !allowError) {
      const failure = new Error(
        `tool_failed:${clientName}:${name}:${
          error && error.code ? error.code : 'unknown'
        }`
      );
      failure.toolError = error;
      throw failure;
    }
    return { response, data, error };
  };

  const callA = (name, args, allowError) =>
    call('a', clientA, name, args, allowError);
  const callB = (name, args, allowError) =>
    call('b', clientB, name, args, allowError);

  const revision = async () => {
    const { data } = await callA('project.status');
    assert(
      data && Number.isInteger(data.projectRevision),
      'dx19_missing_project_revision'
    );
    return data.projectRevision;
  };

  const expectError = async (clientCall, expectedCodes, labelValue) => {
    const result = await clientCall;
    assert(result.response.isError === true, `${labelValue}:expected_error`);
    assert(
      result.error && expectedCodes.includes(result.error.code),
      `${labelValue}:unexpected_error:${JSON.stringify(result.error)}`
    );
    return result.error;
  };

  try {
    const toolsA = await clientA.listTools();
    const names = new Set(toolsA.tools.map(tool => tool.name));
    const missing = REQUIRED_TOOLS.filter(name => !names.has(name));
    assert(!missing.length, `dx19_missing_tools:${missing.join(',')}`);

    const initial = await callA('project.status');
    assert(
      !initial.data || initial.data.projectOpen !== true,
      'dx19_requires_fresh_editor'
    );

    await callA('project.create', { name: 'DX19 Multi Agent Acceptance' });
    projectOpen = true;
    await callA('project.save-as', {
      filePath: path.join(projectRoot, 'game.json'),
    });

    const concurrencyCapabilities = (
      await callA('agent.concurrency.capabilities')
    ).data;
    assert(
      concurrencyCapabilities &&
        concurrencyCapabilities.callerIdentity.supported === true &&
        concurrencyCapabilities.semanticLeases.ownerBoundToCallerIdentity ===
          true &&
        concurrencyCapabilities.semanticLeases.explicitRenew === true,
      'dx19_concurrency_capabilities_invalid'
    );
    const tempCapabilities = (
      await callA('agent.workspace.temp.capabilities')
    ).data;
    assert(
      tempCapabilities &&
        tempCapabilities.ownerBoundToCallerIdentity === true &&
        tempCapabilities.crossAgentAccessRejected === true &&
        tempCapabilities.cleanup.ttlExpiry === true,
      'dx19_temp_capabilities_invalid'
    );

    const concurrencyA = (
      await callA('agent.concurrency.status', { scopes: ['project'] })
    ).data;
    assert(
      concurrencyA &&
        concurrencyA.identity &&
        concurrencyA.identity.ownerKey === IDENTITIES.a.ownerKey,
      'dx19_caller_identity_not_propagated'
    );

    const namespaceA = (
      await callA('agent.workspace.temp.create', {
        purpose: 'agent-a helper scripts',
        ttlMs: 30000,
      })
    ).data.namespace;
    const namespaceB = (
      await callB('agent.workspace.temp.create', {
        purpose: 'agent-b helper scripts',
        ttlMs: 30000,
      })
    ).data.namespace;
    namespaceIds.set('a', namespaceA.namespaceId);
    namespaceIds.set('b', namespaceB.namespaceId);
    assert(
      namespaceA.ownerKey === IDENTITIES.a.ownerKey &&
        namespaceA.taskId === IDENTITIES.a.taskId &&
        namespaceB.ownerKey === IDENTITIES.b.ownerKey &&
        namespaceB.taskId === IDENTITIES.b.taskId,
      'dx19_temp_namespace_identity_invalid'
    );

    const relativePath = 'scripts/helper.js';
    await callA('agent.workspace.temp.write', {
      namespaceId: namespaceA.namespaceId,
      relativePath,
      content: 'module.exports = "agent-a";\n',
    });
    await callB('agent.workspace.temp.write', {
      namespaceId: namespaceB.namespaceId,
      relativePath,
      content: 'module.exports = "agent-b";\n',
    });
    const aContent = (
      await callA('agent.workspace.temp.read', {
        namespaceId: namespaceA.namespaceId,
        relativePath,
      })
    ).data.content;
    const bContent = (
      await callB('agent.workspace.temp.read', {
        namespaceId: namespaceB.namespaceId,
        relativePath,
      })
    ).data.content;
    assert(
      aContent !== bContent &&
        /agent-a/.test(aContent) &&
        /agent-b/.test(bContent),
      'dx19_temp_namespaces_clobbered'
    );
    const crossNamespaceError = await expectError(
      callB(
        'agent.workspace.temp.read',
        {
          namespaceId: namespaceA.namespaceId,
          relativePath,
        },
        true
      ),
      ['managed_temp_namespace_owner_mismatch'],
      'dx19_cross_agent_temp_access'
    );
    const overwriteError = await expectError(
      callA(
        'agent.workspace.temp.write',
        {
          namespaceId: namespaceA.namespaceId,
          relativePath,
          content: 'module.exports = "unexpected";\n',
        },
        true
      ),
      ['managed_temp_artifact_exists'],
      'dx19_implicit_overwrite'
    );

    const startRevision = await revision();
    const begun = (
      await callA('safety.transactions.begin', {
        label: 'DX19 owner-bound transaction',
      })
    ).data;
    transactionId = begun.transactionId;
    const transactionStatusB = (
      await callB('safety.transactions.status')
    ).data;
    assert(
      transactionStatusB.active === true &&
        transactionStatusB.owner &&
        transactionStatusB.owner.ownerKey === IDENTITIES.a.ownerKey &&
        transactionStatusB.purpose === 'DX19 owner-bound transaction' &&
        Number.isFinite(transactionStatusB.startedAt),
      'dx19_transaction_ownership_not_visible'
    );

    const foreignCommitError = await expectError(
      callB(
        'safety.transactions.commit',
        { transactionId },
        true
      ),
      ['transaction_owner_mismatch'],
      'dx19_foreign_commit'
    );
    const foreignMutationError = await expectError(
      callB(
        'editor.functions.create-scene',
        {
          scene_name: 'ForeignDuringTransaction',
          expectedRevision: startRevision,
        },
        true
      ),
      ['transaction_scope_locked'],
      'dx19_foreign_transaction_mutation'
    );
    const foreignRollbackError = await expectError(
      callB(
        'safety.transactions.rollback',
        { transactionId },
        true
      ),
      ['transaction_scope_locked', 'transaction_owner_mismatch'],
      'dx19_foreign_rollback'
    );
    await callA('safety.transactions.rollback', { transactionId });
    transactionId = null;

    const leaseStartRevision = await revision();
    const acquired = (
      await callA('agent.concurrency.lease.acquire', {
        scope: 'scene:AgentA',
        ttlMs: 30000,
      })
    ).data.lease;
    assert(
      acquired.owner === IDENTITIES.a.ownerKey &&
        acquired.identity &&
        acquired.identity.taskId === IDENTITIES.a.taskId &&
        Number.isFinite(acquired.acquiredAt) &&
        Number.isFinite(acquired.heartbeatAt) &&
        acquired.expiresAt > acquired.heartbeatAt,
      'dx19_lease_metadata_invalid'
    );
    const renewed = (
      await callA('agent.concurrency.lease.renew', {
        scope: 'scene:AgentA',
        leaseId: acquired.leaseId,
        ttlMs: 60000,
      })
    ).data.lease;
    assert(
      renewed.leaseId === acquired.leaseId &&
        renewed.expiresAt >= acquired.expiresAt,
      'dx19_lease_renew_failed'
    );

    const foreignLeaseMutationError = await expectError(
      callB(
        'editor.functions.create-scene',
        {
          scene_name: 'AgentA',
          expectedRevision: leaseStartRevision,
        },
        true
      ),
      ['semantic_scope_locked'],
      'dx19_foreign_lease_mutation'
    );

    await callA('editor.functions.create-scene', {
      scene_name: 'AgentA',
      expectedRevision: leaseStartRevision,
      idempotencyKey: 'dx19-create-agent-a',
    });
    const afterARevision = await revision();

    await callB('editor.functions.create-scene', {
      scene_name: 'AgentB',
      expectedRevision: afterARevision,
      idempotencyKey: 'dx19-create-agent-b',
    });
    const afterBRevision = await revision();

    const staleWriterError = await expectError(
      callA(
        'editor.functions.create-scene',
        {
          scene_name: 'StaleWriterShouldNotExist',
          expectedRevision: afterARevision,
          idempotencyKey: 'dx19-stale-a',
        },
        true
      ),
      ['revision_conflict'],
      'dx19_stale_writer'
    );
    assert(
      staleWriterError.details &&
        staleWriterError.details.conflictScope === 'project' &&
        staleWriterError.details.expectedRevision === afterARevision &&
        staleWriterError.details.actualRevision === afterBRevision &&
        staleWriterError.details.lastChange &&
        staleWriterError.details.lastChange.identity &&
        staleWriterError.details.lastChange.identity.ownerKey ===
          IDENTITIES.b.ownerKey,
      `dx19_stale_conflict_context_invalid:${JSON.stringify(
        staleWriterError
      )}`
    );

    await callA('editor.functions.create-scene', {
      scene_name: 'AgentAReconciled',
      expectedRevision: afterBRevision,
      idempotencyKey: 'dx19-reconciled-a',
    });
    const finalProject = (await callA('project.status')).data;
    assert(
      finalProject.sceneNames.includes('AgentA') &&
        finalProject.sceneNames.includes('AgentB') &&
        finalProject.sceneNames.includes('AgentAReconciled') &&
        !finalProject.sceneNames.includes('StaleWriterShouldNotExist'),
      'dx19_project_reconciliation_corrupted'
    );

    await callA('agent.concurrency.lease.release', {
      scope: 'scene:AgentA',
      leaseId: acquired.leaseId,
    });
    const leasesAfterRelease = (
      await callA('agent.concurrency.status', {
        scopes: ['project', 'scene:AgentA', 'scene:AgentB'],
      })
    ).data;
    assert(
      Array.isArray(leasesAfterRelease.leases) &&
        leasesAfterRelease.leases.length === 0,
      'dx19_lease_not_released'
    );

    const validation = (
      await callA('validation.run', {
        includeNativeReport: false,
        includeAssets: true,
      })
    ).data;
    assert(validation && validation.ok === true, 'dx19_validation_failed');

    await callA('agent.workspace.temp.release', {
      namespaceId: namespaceA.namespaceId,
    });
    namespaceIds.delete('a');
    await callB('agent.workspace.temp.release', {
      namespaceId: namespaceB.namespaceId,
    });
    namespaceIds.delete('b');
    const tempStatusA = (await callA('agent.workspace.temp.status')).data;
    const tempStatusB = (await callB('agent.workspace.temp.status')).data;
    assert(
      tempStatusA.namespaces.length === 0 && tempStatusB.namespaces.length === 0,
      'dx19_temp_cleanup_incomplete'
    );

    await callA('project.close', { discardUnsavedChanges: true });
    projectOpen = false;

    const result = {
      ok: true,
      label,
      protocolVersion: clientA.getNegotiatedProtocolVersion(),
      identity: {
        a: IDENTITIES.a,
        b: IDENTITIES.b,
      },
      tempIsolation: {
        sameRelativePath: relativePath,
        contentsIndependent: true,
        crossAgentAccessError: crossNamespaceError.code,
        implicitOverwriteError: overwriteError.code,
        cleanupVerified: true,
      },
      transactionIsolation: {
        ownerVisible: true,
        foreignCommitError: foreignCommitError.code,
        foreignMutationError: foreignMutationError.code,
        foreignRollbackError: foreignRollbackError.code,
        ownerRollbackSucceeded: true,
      },
      leaseIsolation: {
        owner: acquired.owner,
        renewed: true,
        foreignMutationError: foreignLeaseMutationError.code,
        released: true,
      },
      staleWriter: {
        expectedRevision: afterARevision,
        actualRevision: afterBRevision,
        error: staleWriterError.code,
        conflictScope: staleWriterError.details.conflictScope,
        lastChangeOwner: staleWriterError.details.lastChange.identity.ownerKey,
        retrySucceeded: true,
      },
      finalScenes: finalProject.sceneNames,
      validationErrors:
        validation.summary &&
        Number.isInteger(validation.summary.diagnosticErrors)
          ? validation.summary.diagnosticErrors
          : validation.diagnostics &&
            validation.diagnostics.summary &&
            Number.isInteger(validation.diagnostics.summary.errors)
          ? validation.diagnostics.summary.errors
          : 0,
      replay,
    };
    fs.writeFileSync(evidencePath, JSON.stringify(result, null, 2));
    return { ...result, evidencePath };
  } finally {
    if (transactionId) {
      try {
        await callA('safety.transactions.rollback', { transactionId });
      } catch (_) {}
    }
    for (const [owner, namespaceId] of Array.from(namespaceIds.entries())) {
      try {
        if (owner === 'a') {
          await callA('agent.workspace.temp.release', { namespaceId });
        } else {
          await callB('agent.workspace.temp.release', { namespaceId });
        }
      } catch (_) {}
    }
    if (projectOpen) {
      try {
        await callA('project.close', { discardUnsavedChanges: true });
      } catch (_) {}
    }
    try {
      await clientA.close();
    } catch (_) {}
    try {
      await clientB.close();
    } catch (_) {}
    fs.rmSync(projectRoot, { recursive: true, force: true });
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
  runMultiAgentIsolationLiveScenario({
    label,
    ...(evidencePath ? { evidencePath } : {}),
  })
    .then(result => {
      process.stdout.write(
        `${JSON.stringify(
          {
            ok: result.ok,
            label: result.label,
            protocolVersion: result.protocolVersion,
            tempIsolation: result.tempIsolation,
            transactionIsolation: result.transactionIsolation,
            leaseIsolation: result.leaseIsolation,
            staleWriter: result.staleWriter,
            finalScenes: result.finalScenes,
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
        `MCP DX-19 multi-agent scenario failed: ${error.stack || error.message}\n`
      );
      process.exitCode = 1;
    });
}

module.exports = {
  IDENTITIES,
  REQUIRED_TOOLS,
  errorOf,
  runMultiAgentIsolationLiveScenario,
};
