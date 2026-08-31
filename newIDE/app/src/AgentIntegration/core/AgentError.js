// @flow

export type AgentErrorOptions = {|
  code: string,
  message?: string,
  retryable?: boolean,
  hint?: string,
  details?: any,
  currentRevision?: string | number,
  traceId?: string,
  cause?: any,
|};

export class AgentError extends Error {
  code: string;
  retryable: boolean;
  hint: ?string;
  details: any;
  currentRevision: ?(string | number);
  traceId: ?string;
  cause: any;

  constructor({
    code,
    message,
    retryable = false,
    hint,
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
    this.details = details;
    this.currentRevision =
      currentRevision === undefined ? null : currentRevision;
    this.traceId = traceId || null;
    this.cause = cause;
  }
}

export const normalizeAgentError = (
  error: any,
  fallbackCode: string = 'agent_internal_error'
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
    ...(normalized.details !== undefined
      ? { details: normalized.details }
      : {}),
    ...(normalized.currentRevision !== null
      ? { currentRevision: normalized.currentRevision }
      : {}),
    ...(normalized.traceId ? { traceId: normalized.traceId } : {}),
  };
};
