const crypto = require('crypto');
const { normalizeError } = require('./McpResponseContract');

const DEFAULT_JOB_TIMEOUT_MS = 120000;
const MIN_JOB_TIMEOUT_MS = 50;
const MAX_JOB_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_POLL_LIMIT = 100;
const MAX_POLL_LIMIT = 500;
const MAX_JOB_STEPS = 200;
const DEFAULT_MAX_JOBS = 64;
const DEFAULT_MAX_EVENTS_PER_JOB = 2000;

const TERMINAL_STATUSES = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
]);

const ASYNC_JOB_STEP_COMMANDS = Object.freeze([
  'desktop.windows.list',
  'desktop.window.capture',
  'diagnostics.inspect',
  'validation.run',
  'preview.qa.capabilities',
  'preview.viewport.status',
  'preview.viewport.set',
  'preview.layout.capabilities',
  'preview.layout.inspect',
  'preview.layout.assert',
  'preview.capture.region',
  'preview.input.inspect',
  'preview.input.interact',
  'preview.input.send',
  'preview.input.sequence',
  'preview.input.reset',
  'preview.input.runtime-status',
  'preview.input.runtime-reset',
  'preview.input.record.start',
  'preview.input.record.send',
  'preview.input.record.stop',
  'preview.input.replay',
  'preview.visual.baseline.compare',
  'preview.multiplayer.clients.list',
  'preview.multiplayer.runtime-status',
  'preview.network.capabilities',
  'preview.network.capture.start',
  'preview.network.capture.status',
  'preview.network.capture.read',
  'preview.network.capture.stop',
  'runtime.status',
  'runtime.snapshot',
  'runtime.inspect',
  'runtime.logs',
  'runtime.assert',
  'runtime.wait-for',
]);

const ASYNC_JOB_STEP_COMMAND_SET = new Set(ASYNC_JOB_STEP_COMMANDS);

const makeError = (code, details, options = {}) => {
  const error = new Error(options.message || code);
  error.code = code;
  error.retryable = !!options.retryable;
  if (options.hint) error.hint = options.hint;
  if (details !== undefined) error.details = details;
  return error;
};

const metadata = ({
  readOnly = false,
  idempotent = false,
  longRunning = false,
} = {}) => ({
  readOnly,
  modifiesProject: false,
  destructive: false,
  idempotent,
  requiresProject: false,
  longRunning,
});

const POLL_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['jobId'],
  properties: {
    jobId: { type: 'string', minLength: 1, maxLength: 200 },
    afterSequence: {
      type: 'integer',
      minimum: 0,
      description:
        'Return only events after this monotonically increasing sequence.',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_POLL_LIMIT,
    },
  },
};

const ASYNC_JOB_DESCRIPTORS = Object.freeze([
  {
    name: 'agent.jobs.capabilities',
    description:
      'Describe finite host-managed async QA jobs, supported step commands, limits, ownership and cleanup semantics.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    outputSchema: { type: 'object', additionalProperties: true },
    metadata: metadata({ readOnly: true, idempotent: true }),
  },
  {
    name: 'agent.jobs.start',
    description:
      'Schedule a finite ordered QA job and return immediately with a stable jobId. The job continues independently of the initiating MCP request until completion, cancellation or job timeout.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['steps'],
      properties: {
        label: { type: 'string', minLength: 1, maxLength: 160 },
        policy: {
          type: 'string',
          enum: ['fail-fast', 'continue-on-error'],
        },
        jobTimeoutMs: {
          type: 'integer',
          minimum: MIN_JOB_TIMEOUT_MS,
          maximum: MAX_JOB_TIMEOUT_MS,
          description:
            'Aggregate job deadline, independent from the transport/request timeout of agent.jobs.start and from each command request timeout.',
        },
        steps: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_JOB_STEPS,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['command'],
            properties: {
              stepId: { type: 'string', minLength: 1, maxLength: 160 },
              phase: { type: 'string', minLength: 1, maxLength: 160 },
              command: { type: 'string', minLength: 1, maxLength: 160 },
              input: { type: 'object', additionalProperties: true },
            },
          },
        },
      },
    },
    outputSchema: { type: 'object', additionalProperties: true },
    metadata: metadata(),
  },
  {
    name: 'agent.jobs.status',
    description:
      'Read async job lifecycle/progress and incrementally poll sequenced events after a cursor.',
    inputSchema: POLL_INPUT_SCHEMA,
    outputSchema: { type: 'object', additionalProperties: true },
    metadata: metadata({ readOnly: true, idempotent: true }),
  },
  {
    name: 'agent.jobs.result',
    description:
      'Read structured partial/final step results and diagnostics incrementally by sequence cursor without parsing logs.',
    inputSchema: POLL_INPUT_SCHEMA,
    outputSchema: { type: 'object', additionalProperties: true },
    metadata: metadata({ readOnly: true, idempotent: true }),
  },
  {
    name: 'agent.jobs.cancel',
    description:
      'Request cooperative cancellation of an owned async job. Cleanup continues in the host and status/result remain pollable.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['jobId'],
      properties: {
        jobId: { type: 'string', minLength: 1, maxLength: 200 },
      },
    },
    outputSchema: { type: 'object', additionalProperties: true },
    metadata: metadata({ idempotent: true }),
  },
]);

const isAsyncJobStepCommandAllowed = command =>
  typeof command === 'string' && ASYNC_JOB_STEP_COMMAND_SET.has(command);

const isAbortError = error =>
  !!error &&
  (error.name === 'AbortError' ||
    error.code === 'ABORT_ERR' ||
    error.code === 'renderer_request_cancelled' ||
    error.code === 'request_cancelled' ||
    error.code === 'async_job_cancelled');

const normalizeIdentity = requestContext => {
  const identity =
    requestContext &&
    requestContext.identity &&
    typeof requestContext.identity === 'object'
      ? requestContext.identity
      : null;
  if (
    !identity ||
    typeof identity.ownerKey !== 'string' ||
    !identity.ownerKey ||
    typeof identity.agentId !== 'string' ||
    !identity.agentId ||
    typeof identity.sessionId !== 'string' ||
    !identity.sessionId
  ) {
    throw makeError('async_job_identity_required');
  }
  return {
    clientId:
      typeof identity.clientId === 'string' && identity.clientId
        ? identity.clientId
        : identity.agentId,
    agentId: identity.agentId,
    sessionId: identity.sessionId,
    ...(typeof identity.taskId === 'string' && identity.taskId
      ? { taskId: identity.taskId }
      : {}),
    ownerKey: identity.ownerKey,
  };
};

const normalizePollInput = input => ({
  afterSequence:
    input && Number.isInteger(input.afterSequence) && input.afterSequence >= 0
      ? input.afterSequence
      : 0,
  limit:
    input && Number.isInteger(input.limit)
      ? Math.min(MAX_POLL_LIMIT, Math.max(1, input.limit))
      : DEFAULT_POLL_LIMIT,
});

const normalizeJobTimeout = value => {
  if (value == null) return DEFAULT_JOB_TIMEOUT_MS;
  if (
    !Number.isInteger(value) ||
    value < MIN_JOB_TIMEOUT_MS ||
    value > MAX_JOB_TIMEOUT_MS
  ) {
    throw makeError('invalid_async_job_timeout', {
      value,
      minimum: MIN_JOB_TIMEOUT_MS,
      maximum: MAX_JOB_TIMEOUT_MS,
    });
  }
  return value;
};

const cloneStepMetadata = (step, index) => ({
  index,
  stepId:
    typeof step.stepId === 'string' && step.stepId
      ? step.stepId
      : `step-${index + 1}`,
  phase:
    typeof step.phase === 'string' && step.phase ? step.phase : step.command,
  command: step.command,
});

const createAsyncJobRegistry = ({
  maxJobs = DEFAULT_MAX_JOBS,
  maxEventsPerJob = DEFAULT_MAX_EVENTS_PER_JOB,
  now = () => Date.now(),
  makeJobId = () => `job-${crypto.randomUUID()}`,
  makeServerSessionId = () => `editor-session-${crypto.randomUUID()}`,
  schedule = callback => setImmediate(callback),
} = {}) => {
  const jobs = new Map();
  const serverSessionId = makeServerSessionId();
  let disposed = false;

  const appendEvent = (job, type, payload = {}) => {
    const event = {
      sequence: ++job.lastSequence,
      type,
      at: now(),
      ...payload,
    };
    job.events.push(event);
    if (job.events.length > maxEventsPerJob) {
      job.events.splice(0, job.events.length - maxEventsPerJob);
      job.eventsTruncated = true;
    }
    job.updatedAt = event.at;
    return event;
  };

  const publicOwner = job => ({
    agentId: job.identity.agentId,
    sessionId: job.identity.sessionId,
    ...(job.identity.taskId ? { taskId: job.identity.taskId } : {}),
    ownerKey: job.identity.ownerKey,
  });

  const publicSummary = job => ({
    jobId: job.jobId,
    serverSessionId,
    kind: 'qa-batch',
    ...(job.label ? { label: job.label } : {}),
    status: job.status,
    policy: job.policy,
    owner: publicOwner(job),
    targeting: { ...job.targeting },
    requestDetached: true,
    timeouts: {
      jobTimeoutMs: job.jobTimeoutMs,
      commandRequestTimeoutsRemainIndependent: true,
    },
    progress: {
      completed: job.completedSteps,
      total: job.steps.length,
      phase: job.phase,
    },
    counts: {
      succeeded: job.succeededSteps,
      failed: job.failedSteps,
      skipped: job.skippedSteps,
    },
    timestamps: {
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      updatedAt: job.updatedAt,
      completedAt: job.completedAt,
      cancelRequestedAt: job.cancelRequestedAt,
      timeoutRequestedAt: job.timeoutRequestedAt,
      deadlineAt: job.deadlineAt,
    },
    cleanup: { ...job.cleanupStatus },
    lastSequence: job.lastSequence,
    earliestSequence:
      job.events.length > 0 ? job.events[0].sequence : job.lastSequence,
    eventsTruncated: job.eventsTruncated,
  });

  const assertOwnedJob = (jobId, requestContext) => {
    const identity = normalizeIdentity(requestContext);
    const job = jobs.get(jobId);
    if (!job) {
      throw makeError('async_job_not_found', { jobId });
    }
    if (job.identity.ownerKey !== identity.ownerKey) {
      throw makeError(
        'async_job_owner_mismatch',
        {
          jobId,
          owner: publicOwner(job),
          caller: {
            agentId: identity.agentId,
            sessionId: identity.sessionId,
            ...(identity.taskId ? { taskId: identity.taskId } : {}),
            ownerKey: identity.ownerKey,
          },
        },
        {
          hint:
            'Reconnect using the same GDevelop agentId/sessionId that created the job.',
        }
      );
    }
    if (
      job.identity.taskId &&
      (!identity.taskId || identity.taskId !== job.identity.taskId)
    ) {
      throw makeError(
        'async_job_task_mismatch',
        {
          jobId,
          expectedTaskId: job.identity.taskId,
          callerTaskId: identity.taskId || null,
        },
        {
          hint:
            'Reconnect with the same X-GDevelop-Task-Id used when the job was started.',
        }
      );
    }
    return job;
  };

  const pollEvents = (job, input) => {
    const { afterSequence, limit } = normalizePollInput(input);
    const candidates = job.events.filter(
      event => event.sequence > afterSequence
    );
    const events = candidates.slice(0, limit);
    const nextSequence =
      events.length > 0 ? events[events.length - 1].sequence : afterSequence;
    return {
      events,
      cursor: {
        afterSequence,
        nextSequence,
        latestSequence: job.lastSequence,
        hasMore: candidates.length > events.length,
      },
    };
  };

  const makeCancellationError = (job, step = null) =>
    makeError(
      job.timeoutRequestedAt ? 'async_job_timeout' : 'async_job_cancelled',
      {
        jobId: job.jobId,
        ...(step ? { step: cloneStepMetadata(step, step.index) } : {}),
        jobTimeoutMs: job.jobTimeoutMs,
      },
      {
        retryable: false,
        message: job.timeoutRequestedAt
          ? 'The async job exceeded its jobTimeoutMs deadline.'
          : 'The async job was cancelled.',
      }
    );

  const runCleanup = async job => {
    job.phase = 'cleanup';
    appendEvent(job, 'progress', {
      progress: {
        completed: job.completedSteps,
        total: job.steps.length,
        phase: job.phase,
      },
    });
    job.cleanupStatus = {
      attempted: true,
      completed: false,
      ok: false,
      actions: [],
      diagnostics: [],
    };
    try {
      const cleanupResult =
        typeof job.cleanup === 'function'
          ? await job.cleanup({
              jobId: job.jobId,
              identity: { ...job.identity },
              targeting: { ...job.targeting },
              resources: job.resources,
              terminalReason: job.pendingTerminalStatus,
            })
          : { actions: [], diagnostics: [] };
      const actions =
        cleanupResult && Array.isArray(cleanupResult.actions)
          ? cleanupResult.actions
          : [];
      const diagnostics =
        cleanupResult && Array.isArray(cleanupResult.diagnostics)
          ? cleanupResult.diagnostics
          : [];
      job.cleanupStatus = {
        attempted: true,
        completed: true,
        ok: diagnostics.length === 0,
        actions,
        diagnostics,
      };
      diagnostics.forEach(diagnostic => {
        appendEvent(job, 'diagnostic', {
          scope: 'cleanup',
          diagnostic,
        });
      });
      if (diagnostics.length > 0 && job.pendingTerminalStatus === 'succeeded') {
        job.pendingTerminalStatus = 'failed';
      }
    } catch (error) {
      const diagnostic = normalizeError(error, job.traceId);
      job.cleanupStatus = {
        attempted: true,
        completed: true,
        ok: false,
        actions: [],
        diagnostics: [diagnostic],
      };
      appendEvent(job, 'diagnostic', {
        scope: 'cleanup',
        diagnostic,
      });
      if (job.pendingTerminalStatus === 'succeeded') {
        job.pendingTerminalStatus = 'failed';
      }
    }
  };

  const runJob = async job => {
    if (job.runningPromise) return job.runningPromise;
    const run = async () => {
      if (job.cancelRequestedAt) {
        job.pendingTerminalStatus = 'cancelled';
      } else {
        job.status = 'running';
        job.startedAt = now();
        job.updatedAt = job.startedAt;
        job.deadlineAt = job.startedAt + job.jobTimeoutMs;
        job.phase = 'starting';
        appendEvent(job, 'job-started', {
          progress: {
            completed: 0,
            total: job.steps.length,
            phase: job.phase,
          },
        });
      }

      const timeout = setTimeout(() => {
        if (TERMINAL_STATUSES.has(job.status)) return;
        job.timeoutRequestedAt = now();
        job.abortController.abort(makeCancellationError(job));
      }, job.jobTimeoutMs);
      if (timeout && typeof timeout.unref === 'function') timeout.unref();

      try {
        for (let index = 0; index < job.steps.length; index++) {
          const step = job.steps[index];
          step.index = index;
          if (job.cancelRequestedAt || job.timeoutRequestedAt) {
            throw makeCancellationError(job, step);
          }

          const stepMeta = cloneStepMetadata(step, index);
          job.phase = stepMeta.phase;
          appendEvent(job, 'progress', {
            step: stepMeta,
            progress: {
              completed: job.completedSteps,
              total: job.steps.length,
              phase: job.phase,
            },
          });

          const stepStartedAt = now();
          try {
            const execution = await job.executeStep(step, {
              jobId: job.jobId,
              stepIndex: index,
              signal: job.abortController.signal,
              identity: { ...job.identity },
              targeting: { ...job.targeting },
              resources: job.resources,
              traceId: job.traceId,
            });
            const stepCompletedAt = now();
            job.completedSteps += 1;
            job.succeededSteps += 1;
            appendEvent(job, 'step-result', {
              step: stepMeta,
              ok: true,
              startedAt: stepStartedAt,
              completedAt: stepCompletedAt,
              durationMs: Math.max(0, stepCompletedAt - stepStartedAt),
              result: execution,
            });
            appendEvent(job, 'progress', {
              step: stepMeta,
              progress: {
                completed: job.completedSteps,
                total: job.steps.length,
                phase: job.phase,
              },
            });
            if (job.cancelRequestedAt || job.timeoutRequestedAt) {
              throw makeCancellationError(job, step);
            }
          } catch (error) {
            if (
              job.cancelRequestedAt ||
              job.timeoutRequestedAt ||
              isAbortError(error)
            ) {
              const cancellationError = makeCancellationError(job, step);
              appendEvent(job, 'diagnostic', {
                scope: 'step',
                step: stepMeta,
                diagnostic: normalizeError(cancellationError, job.traceId),
              });
              throw cancellationError;
            }

            const stepCompletedAt = now();
            const diagnostic = normalizeError(error, job.traceId);
            job.completedSteps += 1;
            job.failedSteps += 1;
            appendEvent(job, 'step-result', {
              step: stepMeta,
              ok: false,
              startedAt: stepStartedAt,
              completedAt: stepCompletedAt,
              durationMs: Math.max(0, stepCompletedAt - stepStartedAt),
              error: diagnostic,
            });
            appendEvent(job, 'diagnostic', {
              scope: 'step',
              step: stepMeta,
              diagnostic,
            });
            appendEvent(job, 'progress', {
              step: stepMeta,
              progress: {
                completed: job.completedSteps,
                total: job.steps.length,
                phase: job.phase,
              },
            });
            if (job.policy === 'fail-fast') {
              job.skippedSteps = job.steps.length - job.completedSteps;
              break;
            }
          }
        }

        if (job.cancelRequestedAt) {
          job.pendingTerminalStatus = 'cancelled';
          job.skippedSteps = job.steps.length - job.completedSteps;
        } else if (job.timeoutRequestedAt) {
          job.pendingTerminalStatus = 'timed_out';
          job.skippedSteps = job.steps.length - job.completedSteps;
        } else if (job.failedSteps > 0) {
          job.pendingTerminalStatus = 'failed';
          if (job.policy === 'fail-fast') {
            job.skippedSteps = job.steps.length - job.completedSteps;
          }
        } else {
          job.pendingTerminalStatus = 'succeeded';
        }
      } catch (error) {
        if (job.timeoutRequestedAt) {
          job.pendingTerminalStatus = 'timed_out';
        } else if (job.cancelRequestedAt || isAbortError(error)) {
          job.pendingTerminalStatus = 'cancelled';
        } else {
          job.pendingTerminalStatus = 'failed';
          const diagnostic = normalizeError(error, job.traceId);
          appendEvent(job, 'diagnostic', {
            scope: 'job',
            diagnostic,
          });
        }
        job.skippedSteps = job.steps.length - job.completedSteps;
      } finally {
        clearTimeout(timeout);
        await runCleanup(job);
        job.status = job.pendingTerminalStatus || 'failed';
        job.phase = job.status;
        job.completedAt = now();
        job.updatedAt = job.completedAt;
        appendEvent(job, 'job-completed', {
          status: job.status,
          progress: {
            completed: job.completedSteps,
            total: job.steps.length,
            phase: job.phase,
          },
          counts: {
            succeeded: job.succeededSteps,
            failed: job.failedSteps,
            skipped: job.skippedSteps,
          },
          cleanup: { ...job.cleanupStatus },
        });
      }
    };

    job.runningPromise = run().finally(() => {
      job.runningPromise = null;
    });
    return job.runningPromise;
  };

  const trim = () => {
    if (jobs.size < maxJobs) return;
    for (const [jobId, job] of jobs) {
      if (!TERMINAL_STATUSES.has(job.status)) continue;
      jobs.delete(jobId);
      if (jobs.size < maxJobs) return;
    }
    if (jobs.size >= maxJobs) {
      throw makeError('async_job_capacity_reached', {
        maximum: maxJobs,
        active: Array.from(jobs.values()).filter(
          job => !TERMINAL_STATUSES.has(job.status)
        ).length,
      });
    }
  };

  const capabilities = () => ({
    supported: true,
    serverSessionId,
    lifecycle: ['start', 'status', 'result', 'cancel'],
    statuses: [
      'queued',
      'running',
      'cancelling',
      'succeeded',
      'failed',
      'cancelled',
      'timed_out',
    ],
    policies: ['fail-fast', 'continue-on-error'],
    polling: {
      mode: 'sequence-cursor',
      defaultLimit: DEFAULT_POLL_LIMIT,
      maxLimit: MAX_POLL_LIMIT,
    },
    progress: {
      fields: ['completed', 'total', 'phase'],
      timestamps: true,
    },
    ownership: {
      ownerKey: 'agentId::sessionId',
      taskAssociation: true,
      reconnectWithinSameEditorSession: true,
      crossOwnerAccessRejected: true,
    },
    timeouts: {
      jobTimeoutMs: {
        default: DEFAULT_JOB_TIMEOUT_MS,
        minimum: MIN_JOB_TIMEOUT_MS,
        maximum: MAX_JOB_TIMEOUT_MS,
      },
      separateFromTransportRequest: true,
      cooperativeCancellation: true,
    },
    cleanup: {
      hostManaged: true,
      deterministic: true,
      runsOn: ['success', 'failure', 'cancel', 'timeout', 'host-dispose'],
    },
    maxSteps: MAX_JOB_STEPS,
    maxJobs,
    eligibleCommands: ASYNC_JOB_STEP_COMMANDS.slice(),
    executionModel: 'host-event-loop-no-unmanaged-processes',
  });

  const start = ({
    input = {},
    requestContext = {},
    targeting = {},
    traceId = null,
    executeStep,
    cleanup,
    createResources = () => ({}),
  }) => {
    if (disposed) throw makeError('async_job_registry_disposed');
    trim();
    if (typeof executeStep !== 'function') {
      throw makeError('async_job_executor_unavailable');
    }
    const identity = normalizeIdentity(requestContext);
    const steps = Array.isArray(input.steps) ? input.steps : [];
    if (steps.length < 1 || steps.length > MAX_JOB_STEPS) {
      throw makeError('invalid_async_job_steps', {
        count: steps.length,
        minimum: 1,
        maximum: MAX_JOB_STEPS,
      });
    }
    steps.forEach((step, index) => {
      if (!step || typeof step.command !== 'string' || !step.command) {
        throw makeError('invalid_async_job_step', { index });
      }
      if (!isAsyncJobStepCommandAllowed(step.command)) {
        throw makeError('async_job_command_not_eligible', {
          index,
          command: step.command,
          eligibleCommands: ASYNC_JOB_STEP_COMMANDS,
        });
      }
    });
    const policy =
      input.policy === 'continue-on-error' ? 'continue-on-error' : 'fail-fast';
    const createdAt = now();
    const job = {
      jobId: makeJobId(),
      label:
        typeof input.label === 'string' && input.label ? input.label : null,
      policy,
      jobTimeoutMs: normalizeJobTimeout(input.jobTimeoutMs),
      steps: steps.map(step => ({
        stepId: step.stepId,
        phase: step.phase,
        command: step.command,
        input: step.input && typeof step.input === 'object' ? step.input : {},
      })),
      identity,
      targeting:
        targeting && typeof targeting === 'object' ? { ...targeting } : {},
      traceId,
      executeStep,
      cleanup,
      resources: createResources(),
      abortController: new AbortController(),
      events: [],
      eventsTruncated: false,
      lastSequence: 0,
      status: 'queued',
      phase: 'queued',
      createdAt,
      startedAt: null,
      updatedAt: createdAt,
      completedAt: null,
      cancelRequestedAt: null,
      timeoutRequestedAt: null,
      deadlineAt: null,
      completedSteps: 0,
      succeededSteps: 0,
      failedSteps: 0,
      skippedSteps: 0,
      cleanupStatus: {
        attempted: false,
        completed: false,
        ok: false,
        actions: [],
        diagnostics: [],
      },
      pendingTerminalStatus: null,
      runningPromise: null,
      scheduledPromise: null,
    };
    jobs.set(job.jobId, job);
    appendEvent(job, 'job-queued', {
      progress: {
        completed: 0,
        total: job.steps.length,
        phase: job.phase,
      },
    });
    job.scheduledPromise = new Promise(resolve => {
      schedule(() => {
        Promise.resolve(runJob(job)).then(
          () => resolve(),
          error => {
            const diagnostic = normalizeError(error, job.traceId);
            appendEvent(job, 'diagnostic', {
              scope: 'runner',
              diagnostic,
            });
            resolve();
          }
        );
      });
    });
    return {
      accepted: true,
      job: publicSummary(job),
    };
  };

  const status = (input = {}, requestContext = {}) => {
    const job = assertOwnedJob(input.jobId, requestContext);
    const polled = pollEvents(job, input);
    return {
      job: publicSummary(job),
      events: polled.events,
      cursor: polled.cursor,
    };
  };

  const result = (input = {}, requestContext = {}) => {
    const job = assertOwnedJob(input.jobId, requestContext);
    const polled = pollEvents(job, input);
    const resultEvents = polled.events.filter(
      event =>
        event.type === 'step-result' ||
        event.type === 'diagnostic' ||
        event.type === 'job-completed'
    );
    return {
      job: publicSummary(job),
      complete: TERMINAL_STATUSES.has(job.status),
      results: resultEvents.filter(event => event.type === 'step-result'),
      diagnostics: resultEvents.filter(event => event.type === 'diagnostic'),
      terminal:
        resultEvents.find(event => event.type === 'job-completed') || null,
      cursor: polled.cursor,
    };
  };

  const cancel = (input = {}, requestContext = {}) => {
    const job = assertOwnedJob(input.jobId, requestContext);
    if (TERMINAL_STATUSES.has(job.status)) {
      return {
        cancelRequested: false,
        alreadyTerminal: true,
        job: publicSummary(job),
      };
    }
    if (!job.cancelRequestedAt) {
      job.cancelRequestedAt = now();
      job.status = 'cancelling';
      job.phase = 'cancelling';
      appendEvent(job, 'cancel-requested', {
        progress: {
          completed: job.completedSteps,
          total: job.steps.length,
          phase: job.phase,
        },
      });
      job.abortController.abort(makeCancellationError(job));
    }
    return {
      cancelRequested: true,
      alreadyTerminal: false,
      job: publicSummary(job),
    };
  };

  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    const running = [];
    for (const job of jobs.values()) {
      if (TERMINAL_STATUSES.has(job.status)) continue;
      if (!job.cancelRequestedAt) {
        job.cancelRequestedAt = now();
        job.status = 'cancelling';
        job.phase = 'host-dispose';
        appendEvent(job, 'cancel-requested', {
          reason: 'host-dispose',
          progress: {
            completed: job.completedSteps,
            total: job.steps.length,
            phase: job.phase,
          },
        });
        job.abortController.abort(makeCancellationError(job));
      }
      if (job.runningPromise) running.push(job.runningPromise);
      else if (job.scheduledPromise) running.push(job.scheduledPromise);
    }
    await Promise.allSettled(running);
  };

  const snapshotOwned = requestContext => {
    const identity = normalizeIdentity(requestContext);
    return Array.from(jobs.values())
      .filter(job => job.identity.ownerKey === identity.ownerKey)
      .filter(
        job =>
          !job.identity.taskId ||
          (identity.taskId && identity.taskId === job.identity.taskId)
      )
      .map(publicSummary)
      .sort(
        (left, right) => right.timestamps.createdAt - left.timestamps.createdAt
      );
  };

  return {
    serverSessionId,
    capabilities,
    start,
    status,
    result,
    cancel,
    dispose,
    snapshotOwned,
  };
};

module.exports = {
  DEFAULT_JOB_TIMEOUT_MS,
  MIN_JOB_TIMEOUT_MS,
  MAX_JOB_TIMEOUT_MS,
  MAX_JOB_STEPS,
  DEFAULT_MAX_JOBS,
  ASYNC_JOB_STEP_COMMANDS,
  ASYNC_JOB_DESCRIPTORS,
  TERMINAL_STATUSES,
  isAsyncJobStepCommandAllowed,
  createAsyncJobRegistry,
};
