const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ASYNC_JOB_STEP_COMMANDS,
  createAsyncJobRegistry,
} = require('./McpAsyncJobs');

const makeIdentity = (
  agentId = 'agent-a',
  sessionId = 'session-a',
  taskId = 'task-a'
) => ({
  clientId: `${agentId}-client`,
  agentId,
  sessionId,
  ...(taskId ? { taskId } : {}),
  ownerKey: `${agentId}::${sessionId}`,
});

const context = identity => ({ identity });

const waitForTerminal = async (registry, jobId, requestContext) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const status = registry.status({ jobId, limit: 500 }, requestContext);
    if (
      ['succeeded', 'failed', 'cancelled', 'timed_out'].includes(
        status.job.status
      )
    ) {
      return status;
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('async_job_test_timeout');
};

const waitForAbort = signal =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
      return;
    }
    signal.addEventListener(
      'abort',
      () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      },
      { once: true }
    );
  });

test('runs a 5 viewport x 2 language QA matrix asynchronously with sequenced partial results', async () => {
  let nextId = 0;
  const registry = createAsyncJobRegistry({
    makeJobId: () => `job-${++nextId}`,
    makeServerSessionId: () => 'editor-session-test',
  });
  const requestContext = context(makeIdentity());
  const steps = [];
  const viewports = [
    [320, 568],
    [390, 844],
    [768, 1024],
    [1280, 720],
    [1920, 1080],
  ];
  for (const [width, height] of viewports) {
    for (const language of ['en', 'pt-BR']) {
      steps.push({
        stepId: `${width}x${height}-${language}`,
        phase: `viewport:${width}x${height}:language:${language}`,
        command: 'runtime.status',
        input: { width, height, language },
      });
    }
  }

  const started = registry.start({
    input: {
      label: 'coin-idle-matrix',
      policy: 'continue-on-error',
      jobTimeoutMs: 5000,
      steps,
    },
    requestContext,
    targeting: { windowId: '8', projectPath: 'C:/game/game.json' },
    traceId: 'trace-matrix',
    executeStep: async step => {
      await new Promise(resolve => setTimeout(resolve, 1));
      return {
        requestTimeoutMs: 10000,
        envelope: {
          contractVersion: 1,
          command: step.command,
          data: {
            viewport: {
              width: step.input.width,
              height: step.input.height,
            },
            language: step.input.language,
          },
          meta: { traceId: 'trace-matrix' },
        },
      };
    },
    cleanup: async () => ({ actions: [], diagnostics: [] }),
  });

  assert.equal(started.accepted, true);
  assert.equal(started.job.jobId, 'job-1');
  assert.equal(started.job.serverSessionId, 'editor-session-test');
  assert.equal(started.job.requestDetached, true);
  assert.equal(started.job.progress.total, 10);
  assert.equal(
    started.job.timeouts.commandRequestTimeoutsRemainIndependent,
    true
  );

  const reconnectContext = context(makeIdentity());
  const firstPoll = registry.status(
    { jobId: started.job.jobId, afterSequence: 0, limit: 2 },
    reconnectContext
  );
  assert.ok(firstPoll.events.length >= 1);
  assert.ok(firstPoll.events.length <= 2);
  assert.ok(firstPoll.cursor.nextSequence >= firstPoll.events[0].sequence);

  const terminal = await waitForTerminal(
    registry,
    started.job.jobId,
    reconnectContext
  );
  assert.equal(terminal.job.status, 'succeeded');
  assert.deepEqual(terminal.job.progress, {
    completed: 10,
    total: 10,
    phase: 'succeeded',
  });
  assert.deepEqual(terminal.job.counts, {
    succeeded: 10,
    failed: 0,
    skipped: 0,
  });
  assert.equal(terminal.job.owner.ownerKey, 'agent-a::session-a');
  assert.equal(terminal.job.owner.taskId, 'task-a');
  assert.equal(terminal.job.targeting.windowId, '8');

  const result = registry.result(
    { jobId: started.job.jobId, afterSequence: 0, limit: 500 },
    reconnectContext
  );
  assert.equal(result.complete, true);
  assert.equal(result.results.length, 10);
  assert.equal(result.diagnostics.length, 0);
  assert.ok(
    result.results.every(
      event =>
        event.ok === true &&
        event.result.envelope.contractVersion === 1 &&
        event.result.envelope.command === 'runtime.status'
    )
  );

  const sequences = terminal.events.map(event => event.sequence);
  assert.deepEqual(sequences, [...sequences].sort((a, b) => a - b));
  assert.equal(
    registry.capabilities().executionModel,
    'host-event-loop-no-unmanaged-processes'
  );
  assert.ok(
    ASYNC_JOB_STEP_COMMANDS.includes('desktop.window.capture') &&
      ASYNC_JOB_STEP_COMMANDS.includes('preview.capture.region') &&
      ASYNC_JOB_STEP_COMMANDS.includes('runtime.wait-for')
  );
  await registry.dispose();
});

test('implements deterministic fail-fast and continue-on-error policies', async () => {
  const owner = context(makeIdentity());

  const runPolicy = async policy => {
    const registry = createAsyncJobRegistry();
    const calls = [];
    const started = registry.start({
      input: {
        policy,
        steps: [
          { stepId: 'one', command: 'runtime.status' },
          { stepId: 'two', command: 'runtime.status' },
          { stepId: 'three', command: 'runtime.status' },
        ],
      },
      requestContext: owner,
      executeStep: async step => {
        calls.push(step.stepId);
        if (step.stepId === 'two') {
          const error = new Error('probe failed');
          error.code = 'runtime_probe_failed';
          error.details = { probe: 'coins' };
          throw error;
        }
        return {
          requestTimeoutMs: null,
          envelope: {
            contractVersion: 1,
            command: step.command,
            data: { stepId: step.stepId },
            meta: {},
          },
        };
      },
      cleanup: async () => ({ actions: [], diagnostics: [] }),
    });
    const terminal = await waitForTerminal(registry, started.job.jobId, owner);
    const result = registry.result(
      { jobId: started.job.jobId, limit: 500 },
      owner
    );
    await registry.dispose();
    return { calls, terminal, result };
  };

  const failFast = await runPolicy('fail-fast');
  assert.deepEqual(failFast.calls, ['one', 'two']);
  assert.equal(failFast.terminal.job.status, 'failed');
  assert.deepEqual(failFast.terminal.job.counts, {
    succeeded: 1,
    failed: 1,
    skipped: 1,
  });
  assert.equal(failFast.result.results.length, 2);
  assert.equal(
    failFast.result.diagnostics[0].diagnostic.code,
    'runtime_probe_failed'
  );

  const continueOnError = await runPolicy('continue-on-error');
  assert.deepEqual(continueOnError.calls, ['one', 'two', 'three']);
  assert.equal(continueOnError.terminal.job.status, 'failed');
  assert.deepEqual(continueOnError.terminal.job.counts, {
    succeeded: 2,
    failed: 1,
    skipped: 0,
  });
  assert.equal(continueOnError.result.results.length, 3);
});

test('preserves partial results across timeout/reconnect and separates job deadline from start request', async () => {
  const registry = createAsyncJobRegistry({
    makeServerSessionId: () => 'editor-session-reconnect',
  });
  const creator = context(makeIdentity('agent-a', 'session-a', 'task-timeout'));
  const started = registry.start({
    input: {
      jobTimeoutMs: 50,
      steps: [
        { stepId: 'partial', command: 'runtime.status' },
        { stepId: 'hang', command: 'runtime.wait-for' },
      ],
    },
    requestContext: creator,
    traceId: 'trace-timeout',
    executeStep: async (step, executionContext) => {
      if (step.stepId === 'partial') {
        return {
          requestTimeoutMs: 10000,
          envelope: {
            contractVersion: 1,
            command: step.command,
            data: { partial: true },
            meta: {},
          },
        };
      }
      return waitForAbort(executionContext.signal);
    },
    cleanup: async () => ({ actions: ['cleanup'], diagnostics: [] }),
  });

  const reconnect = context(
    makeIdentity('agent-a', 'session-a', 'task-timeout')
  );
  const terminal = await waitForTerminal(
    registry,
    started.job.jobId,
    reconnect
  );
  assert.equal(terminal.job.status, 'timed_out');
  assert.equal(terminal.job.serverSessionId, 'editor-session-reconnect');
  assert.equal(terminal.job.progress.completed, 1);
  assert.equal(terminal.job.cleanup.ok, true);
  assert.ok(terminal.job.timestamps.timeoutRequestedAt);

  const result = registry.result(
    { jobId: started.job.jobId, afterSequence: 0, limit: 500 },
    reconnect
  );
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].result.envelope.data.partial, true);
  assert.ok(
    result.diagnostics.some(
      event => event.diagnostic.code === 'async_job_timeout'
    )
  );
  await registry.dispose();
});

test('enforces owner and task identity while allowing same-session reconnect', async () => {
  const registry = createAsyncJobRegistry();
  const creator = context(makeIdentity('agent-a', 'session-a', 'task-a'));
  const started = registry.start({
    input: { steps: [{ command: 'runtime.status' }] },
    requestContext: creator,
    executeStep: async step => ({
      requestTimeoutMs: null,
      envelope: {
        contractVersion: 1,
        command: step.command,
        data: {},
        meta: {},
      },
    }),
    cleanup: async () => ({ actions: [], diagnostics: [] }),
  });

  assert.doesNotThrow(() =>
    registry.status(
      { jobId: started.job.jobId },
      context(makeIdentity('agent-a', 'session-a', 'task-a'))
    )
  );
  assert.throws(
    () =>
      registry.status(
        { jobId: started.job.jobId },
        context(makeIdentity('agent-b', 'session-b', 'task-a'))
      ),
    error => error && error.code === 'async_job_owner_mismatch'
  );
  assert.throws(
    () =>
      registry.status(
        { jobId: started.job.jobId },
        context(makeIdentity('agent-a', 'session-a', 'task-b'))
      ),
    error => error && error.code === 'async_job_task_mismatch'
  );
  await waitForTerminal(registry, started.job.jobId, creator);
  await registry.dispose();
});

test('cancel is non-blocking and runs deterministic host cleanup before terminal state', async () => {
  const registry = createAsyncJobRegistry();
  const owner = context(makeIdentity());
  const cleanupCalls = [];
  const started = registry.start({
    input: {
      steps: [
        { stepId: 'wait', command: 'runtime.wait-for' },
        { stepId: 'never', command: 'runtime.status' },
      ],
    },
    requestContext: owner,
    executeStep: async (step, executionContext) => {
      if (step.stepId === 'wait') return waitForAbort(executionContext.signal);
      return {};
    },
    createResources: () => ({ token: 'resource-token' }),
    cleanup: async cleanupContext => {
      cleanupCalls.push({
        jobId: cleanupContext.jobId,
        token: cleanupContext.resources.token,
        terminalReason: cleanupContext.terminalReason,
      });
      return {
        actions: [
          { command: 'preview.input.reset', ok: true },
          { command: 'preview.viewport.set', ok: true },
          { command: 'preview.network.capture.stop', ok: true },
        ],
        diagnostics: [],
      };
    },
  });

  await new Promise(resolve => setTimeout(resolve, 10));
  const cancelled = registry.cancel({ jobId: started.job.jobId }, owner);
  assert.equal(cancelled.cancelRequested, true);
  assert.equal(cancelled.job.status, 'cancelling');

  const terminal = await waitForTerminal(registry, started.job.jobId, owner);
  assert.equal(terminal.job.status, 'cancelled');
  assert.equal(terminal.job.cleanup.completed, true);
  assert.equal(terminal.job.cleanup.ok, true);
  assert.equal(terminal.job.counts.skipped, 2);
  assert.equal(cleanupCalls.length, 1);
  assert.equal(cleanupCalls[0].token, 'resource-token');
  assert.equal(cleanupCalls[0].terminalReason, 'cancelled');

  const secondCancel = registry.cancel({ jobId: started.job.jobId }, owner);
  assert.equal(secondCancel.alreadyTerminal, true);
  assert.equal(secondCancel.cancelRequested, false);
  await registry.dispose();
});

test('rejects non-QA commands before scheduling any work', () => {
  const registry = createAsyncJobRegistry();
  assert.throws(
    () =>
      registry.start({
        input: {
          steps: [{ command: 'project.save' }],
        },
        requestContext: context(makeIdentity()),
        executeStep: async () => ({}),
      }),
    error => error && error.code === 'async_job_command_not_eligible'
  );
});

test('host dispose cancels queued work and waits for deterministic cleanup', async () => {
  const registry = createAsyncJobRegistry();
  const owner = context(makeIdentity());
  let cleanupCount = 0;
  const started = registry.start({
    input: {
      steps: [{ command: 'runtime.wait-for' }],
    },
    requestContext: owner,
    executeStep: async (step, executionContext) =>
      waitForAbort(executionContext.signal),
    cleanup: async () => {
      cleanupCount += 1;
      return {
        actions: [{ command: 'preview.input.reset', ok: true }],
        diagnostics: [],
      };
    },
  });

  await registry.dispose();

  const status = registry.status({ jobId: started.job.jobId }, owner);
  assert.equal(status.job.status, 'cancelled');
  assert.equal(status.job.cleanup.completed, true);
  assert.equal(status.job.cleanup.ok, true);
  assert.equal(cleanupCount, 1);
});
