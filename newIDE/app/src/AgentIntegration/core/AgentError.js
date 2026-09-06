// @flow

export const AGENT_ERROR_CODES = Object.freeze({
  AGENT_INTERNAL_ERROR: 'agent_internal_error',
  INVALID_COMMAND_INPUT: 'invalid_command_input',
  NO_PROJECT_OPEN: 'no_project_open',
  REVISION_CONFLICT: 'revision_conflict',
  IDEMPOTENCY_CONFLICT: 'idempotency_conflict',
});

export type AgentErrorOptions = {|
  code: string,
  message?: string,
  retryable?: boolean,
  hint?: string,
  recovery?: string,
  details?: any,
  currentRevision?: string | number,
  traceId?: string,
  cause?: any,
|};

export class AgentError extends Error {
  code: string;
  retryable: boolean;
  hint: ?string;
  recovery: ?string;
  details: any;
  currentRevision: ?(string | number);
  traceId: ?string;
  cause: any;

  constructor({
    code,
    message,
    retryable = false,
    hint,
    recovery,
    details,
    currentRevision,
    traceId,
    cause,
  }: AgentErrorOptions) {
    super(message || code);
    this.name = 'AgentError';
    this.code = code;
    this.retryable = retryable;
    this.hint = hint || null;
    this.recovery = recovery || null;
    this.details = details;
    this.currentRevision =
      currentRevision === undefined ? null : currentRevision;
    this.traceId = traceId || null;
    this.cause = cause;
  }
}

export const normalizeAgentError = (
  error: any,
  fallbackCode: string = AGENT_ERROR_CODES.AGENT_INTERNAL_ERROR
): AgentError => {
  if (error instanceof AgentError) return error;

  const code =
    error && typeof error.code === 'string' && error.code
      ? error.code
      : fallbackCode;
  const message =
    error && typeof error.message === 'string' && error.message
      ? error.message
      : String(error || fallbackCode);

  return new AgentError({
    code,
    message,
    retryable: !!(error && error.retryable),
    hint:
      error && typeof error.hint === 'string' && error.hint
        ? error.hint
        : undefined,
    recovery:
      error && typeof error.recovery === 'string' && error.recovery
        ? error.recovery
        : undefined,
    details: error && error.details !== undefined ? error.details : undefined,
    currentRevision:
      error && error.currentRevision !== undefined
        ? error.currentRevision
        : undefined,
    traceId:
      error && typeof error.traceId === 'string' && error.traceId
        ? error.traceId
        : undefined,
    cause: error,
  });
};

export const serializeAgentError = (error: any) => {
  const normalized = normalizeAgentError(error);
  return {
    code: normalized.code,
    message: normalized.message,
    retryable: normalized.retryable,
    ...(normalized.hint ? { hint: normalized.hint } : {}),
    ...(normalized.recovery ? { recovery: normalized.recovery } : {}),
    ...(normalized.details !== undefined
      ? { details: normalized.details }
      : {}),
    ...(normalized.currentRevision !== null
      ? { currentRevision: normalized.currentRevision }
      : {}),
    ...(normalized.traceId ? { traceId: normalized.traceId } : {}),
  };
};
